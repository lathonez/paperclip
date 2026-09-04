import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildExecutionWorkspaceAdapterConfig,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveEffectiveWorkspaceStrategyType,
  resolveExecutionWorkspaceMode,
  resolveLowTrustAssertWorkspaceStrategyType,
} from "../services/execution-workspace-policy.ts";
import {
  preflightLowTrustWorkspaceIsolation,
  resolveWorkspaceAfterLowTrustPreflight,
  stripHostWorkspaceProvisionForLowTrustSandbox,
} from "../services/heartbeat.ts";
import { assertLowTrustWorkspaceIsolation } from "../services/low-trust-runtime-containment.ts";
import type { TrustPresetResolution } from "../services/trust-preset-resolver.ts";

/**
 * ELL-2285: pin the *wiring* that computes the strategy type ELL-2283's gate checks.
 *
 * ELL-2283 pins `assertLowTrustWorkspaceIsolation` thoroughly, but every one of its tests —
 * and the five pre-existing fixtures — inject `effectiveExecutionWorkspaceStrategyType` as an
 * argument. Nothing pinned the expression that *produces* that argument. Replacing the whole
 * call at the dispatch site with the constant `"git_worktree"` disarmed the gate so it admitted
 * every run, including the R1-R5 shared-checkout routes it exists to refuse, with the entire
 * low-trust suite green.
 *
 * The chain from the dispatch site to the gate has three links, and a constant substituted at
 * any of them disarms it identically:
 *
 *   L1  heartbeat dispatch      -> resolveWorkspaceAfterLowTrustPreflight
 *   L2  resolveWorkspaceAfter.. -> preflightLowTrustWorkspaceIsolation
 *   L3  preflightLowTrust..     -> assertLowTrustWorkspaceIsolation
 *
 * L2 and L3 are ordinary exported functions, so they are pinned behaviourally below: a
 * non-isolating strategy handed to either one must reach the refusal. (The pre-existing
 * fixtures all pass `git_worktree`, the admitted value, so they could not catch a
 * `"git_worktree"` constant in the pass-through.)
 *
 * L1 is an expression inside `heartbeatService`, a ~20k-line dispatch function with no seam to
 * call, so no behavioural test can reach it. ELL-2285 extracts it as
 * `resolveLowTrustAssertWorkspaceStrategyType` — tested directly here — and adds the static
 * source guard at the bottom of this file, which is what makes the original mutation fail.
 * That mirrors ELL-2280, which extracted `resolveRequestedExecutionWorkspaceMode` out of the
 * same function for the same reason, and follows the static-guard pattern already used by
 * `authz-existence-oracle-guard.test.ts`.
 */

function lowTrustResolution(): TrustPresetResolution {
  return {
    kind: "low_trust_review",
    preset: "low_trust_review",
    boundary: {
      mode: "low_trust_review",
      companyId: "company-1",
      rootIssueId: "issue-1",
    },
    sourcePresets: { agent: "low_trust_review" },
  };
}

const BOUNDARY_ISSUE = { companyId: "company-1", id: "issue-1", projectId: "project-1" };
const STRATEGY_REFUSAL = "low_trust_requires_isolating_workspace_strategy";
const ACCEPTED_STRATEGY_TYPES = [
  "git_worktree",
  "project_primary",
  "adapter_managed",
  "cloud_sandbox",
] as const;
const PARSED_MODES = [
  "shared_workspace",
  "isolated_workspace",
  "operator_branch",
  "agent_default",
] as const;

describe("ELL-2285: resolveLowTrustAssertWorkspaceStrategyType reads the run's own config", () => {
  it("returns the config's strategy type for every accepted type and every mode", () => {
    // The core property a constant cannot satisfy: the output tracks mergedConfig.
    for (const type of ACCEPTED_STRATEGY_TYPES) {
      for (const requestedExecutionWorkspaceMode of PARSED_MODES) {
        expect(
          resolveLowTrustAssertWorkspaceStrategyType({
            requestedExecutionWorkspaceMode,
            mergedConfig: { workspaceStrategy: { type } },
          }),
        ).toBe(type);
      }
    }
  });

  it("distinguishes the admitted type from every refused one", () => {
    // Sharper than the loop above: a function stuck on any single value fails here, because
    // git_worktree and project_primary must come back different from the SAME call shape.
    const resolvedTypes = ACCEPTED_STRATEGY_TYPES.map((type) =>
      resolveLowTrustAssertWorkspaceStrategyType({
        requestedExecutionWorkspaceMode: "isolated_workspace",
        mergedConfig: { workspaceStrategy: { type } },
      }),
    );

    expect(new Set(resolvedTypes).size).toBe(ACCEPTED_STRATEGY_TYPES.length);
    expect(resolvedTypes).toEqual([...ACCEPTED_STRATEGY_TYPES]);
  });

  it("delegates to resolveEffectiveWorkspaceStrategyType rather than reimplementing it", () => {
    // Keeps the two from drifting: whatever realization consumes, the gate certifies.
    const configs: (Record<string, unknown> | null | undefined)[] = [
      null,
      undefined,
      {},
      { workspaceStrategy: null },
      { workspaceStrategy: {} },
      { workspaceStrategy: { type: "" } },
      { workspaceStrategy: { type: "not_a_strategy" } },
      { workspaceStrategy: { type: "GIT_WORKTREE" } },
      { workspaceStrategy: "git_worktree" },
      { workspaceStrategy: { type: "git_worktree", provisionCommand: "bash ./provision.sh" } },
      ...ACCEPTED_STRATEGY_TYPES.map((type) => ({ workspaceStrategy: { type } })),
    ];

    for (const mergedConfig of configs) {
      for (const requestedExecutionWorkspaceMode of PARSED_MODES) {
        expect(
          resolveLowTrustAssertWorkspaceStrategyType({
            requestedExecutionWorkspaceMode,
            mergedConfig,
          }),
        ).toBe(
          resolveEffectiveWorkspaceStrategyType(requestedExecutionWorkspaceMode, mergedConfig),
        );
      }
    }
  });

  it("fails closed on a missing, malformed or unrecognized strategy, and the gate refuses", async () => {
    // Nothing here is isolating, so each one must resolve to a refused type and be refused.
    for (const mergedConfig of [
      null,
      undefined,
      {},
      { workspaceStrategy: null },
      { workspaceStrategy: {} },
      { workspaceStrategy: { type: "" } },
      { workspaceStrategy: { type: "git_worktree_v2" } },
      { workspaceStrategy: { type: "some_future_strategy" } },
    ]) {
      const strategyType = resolveLowTrustAssertWorkspaceStrategyType({
        requestedExecutionWorkspaceMode: "isolated_workspace",
        mergedConfig,
      });

      expect(strategyType).toBe("project_primary");
      await expect(
        assertLowTrustWorkspaceIsolation({
          resolution: lowTrustResolution(),
          isolatedWorkspacesEnabled: true,
          effectiveExecutionWorkspaceMode: "isolated_workspace",
          effectiveExecutionWorkspaceStrategyType: strategyType,
          selectedEnvironmentDriver: "sandbox",
          issue: BOUNDARY_ISSUE,
        }),
      ).rejects.toMatchObject({ status: 422, details: { code: STRATEGY_REFUSAL } });
    }
  });

  it("keeps agent_default's adapter_managed default, so its refusal code stays the mode gate", () => {
    // ELL-2278 decided agent_default stays refused by the MODE check. The resolver must not
    // quietly hand it an isolating type, and must not change which code it reports.
    expect(
      resolveLowTrustAssertWorkspaceStrategyType({
        requestedExecutionWorkspaceMode: "agent_default",
        mergedConfig: {},
      }),
    ).toBe("adapter_managed");
  });
});

describe("ELL-2285: the resolved type agrees with the config realization consumes", () => {
  // The property ELL-2283 depends on, and the reason the wiring may read mergedConfig even
  // though hostExecutionWorkspaceConfig is what realizeExecutionWorkspace gets:
  // stripHostWorkspaceProvisionForLowTrustSandbox (heartbeat.ts:1948) deletes only
  // provisionCommand and runtimeProvisionCommand, carrying `type` through the spread.
  //
  // ELL-2283 pins this agreement for resolveEffectiveWorkspaceStrategyType. What was unpinned
  // is that the wiring reads one of those two configs at all — hence the resolver here.
  function hostConfigFor(mergedConfig: Record<string, unknown>) {
    return stripHostWorkspaceProvisionForLowTrustSandbox({
      config: mergedConfig,
      trustPreset: lowTrustResolution(),
      selectedEnvironmentDriver: "sandbox",
    });
  }

  it("agrees across the provision strip for every accepted type", () => {
    for (const type of ACCEPTED_STRATEGY_TYPES) {
      for (const workspaceStrategy of [
        { type, provisionCommand: "bash ./provision.sh" },
        { type, runtimeProvisionCommand: "bash ./runtime.sh" },
        {
          type,
          provisionCommand: "bash ./provision.sh",
          runtimeProvisionCommand: "bash ./runtime.sh",
        },
        { type },
      ]) {
        const mergedConfig = { workspaceStrategy };

        expect(
          resolveLowTrustAssertWorkspaceStrategyType({
            requestedExecutionWorkspaceMode: "isolated_workspace",
            mergedConfig,
          }),
        ).toBe(
          resolveEffectiveWorkspaceStrategyType(
            "isolated_workspace",
            hostConfigFor(mergedConfig),
          ),
        );
      }
    }
  });

  it("strips the provision commands without touching the strategy type", () => {
    // Positive control that the strip actually ran on the fixtures above — otherwise the
    // agreement would hold trivially because nothing was ever removed.
    const hostConfig = hostConfigFor({
      workspaceStrategy: {
        type: "project_primary",
        provisionCommand: "bash ./provision.sh",
        runtimeProvisionCommand: "bash ./runtime.sh",
      },
    });

    expect(hostConfig.workspaceStrategy).toEqual({ type: "project_primary" });
  });
});

describe("ELL-2285: the resolved type reaches the gate through both pass-throughs", () => {
  // L3 and L2. Every pre-existing fixture passes git_worktree — the admitted value — so a
  // "git_worktree" constant substituted in either pass-through was invisible to the suite.
  const NON_ISOLATING = resolveLowTrustAssertWorkspaceStrategyType({
    requestedExecutionWorkspaceMode: "isolated_workspace",
    mergedConfig: { workspaceStrategy: { type: "project_primary" } },
  });

  it("L3: preflightLowTrustWorkspaceIsolation forwards it to the assert", async () => {
    await expect(
      preflightLowTrustWorkspaceIsolation({
        trustPreset: lowTrustResolution(),
        isolatedWorkspacesEnabled: true,
        effectiveExecutionWorkspaceMode: "isolated_workspace",
        effectiveExecutionWorkspaceStrategyType: NON_ISOLATING,
        issue: BOUNDARY_ISSUE,
        resolveSelectedEnvironmentDriver: async () => "sandbox",
      }),
    ).rejects.toMatchObject({ status: 422, details: { code: STRATEGY_REFUSAL } });
  });

  it("L2: resolveWorkspaceAfterLowTrustPreflight refuses before resolving a workspace", async () => {
    // The refusal has to land before resolveWorkspace runs, or the low-trust run has already
    // been handed the shared project checkout by the time the gate speaks.
    let workspaceResolverReached = false;

    await expect(
      resolveWorkspaceAfterLowTrustPreflight({
        trustPreset: lowTrustResolution(),
        isolatedWorkspacesEnabled: true,
        effectiveExecutionWorkspaceMode: "isolated_workspace",
        effectiveExecutionWorkspaceStrategyType: NON_ISOLATING,
        issue: BOUNDARY_ISSUE,
        resolveSelectedEnvironmentDriver: async () => "sandbox",
        resolveWorkspace: async () => {
          workspaceResolverReached = true;
          return {} as never;
        },
      }),
    ).rejects.toMatchObject({ status: 422, details: { code: STRATEGY_REFUSAL } });

    expect(workspaceResolverReached).toBe(false);
  });

  it("still admits an isolating strategy through the same two pass-throughs", async () => {
    // Positive control: the refusals above are attributable to the strategy type alone.
    const workspace = { cwd: "/tmp/ell2285-worktree" };

    await expect(
      resolveWorkspaceAfterLowTrustPreflight({
        trustPreset: lowTrustResolution(),
        isolatedWorkspacesEnabled: true,
        effectiveExecutionWorkspaceMode: "isolated_workspace",
        effectiveExecutionWorkspaceStrategyType: resolveLowTrustAssertWorkspaceStrategyType({
          requestedExecutionWorkspaceMode: "isolated_workspace",
          mergedConfig: { workspaceStrategy: { type: "git_worktree" } },
        }),
        issue: BOUNDARY_ISSUE,
        resolveSelectedEnvironmentDriver: async () => "sandbox",
        resolveWorkspace: async () => workspace as never,
      }),
    ).resolves.toEqual({ selectedEnvironmentDriver: "sandbox", workspace });
  });
});

describe("ELL-2285: the R1-R5 routes stay refused when the resolver produces the type", () => {
  // ELL-2283's admissibility table calls resolveEffectiveWorkspaceStrategyType itself, which
  // is a transcription of the wiring rather than the wiring. Re-running the same five routes
  // through the extracted resolver ties the shipped refusals to the function the dispatch
  // site actually calls.
  async function admissibility(input: {
    projectPolicy: unknown;
    issueSettings: unknown;
    legacyUseProjectWorkspace: boolean | null;
    agentConfig: Record<string, unknown>;
    issueAdapterConfig?: Record<string, unknown>;
  }) {
    const resolved = resolveExecutionWorkspaceMode(input as never);
    const requestedExecutionWorkspaceMode =
      resolved === "shared_workspace" ? "isolated_workspace" : resolved;
    const workspaceManaged = buildExecutionWorkspaceAdapterConfig({
      ...(input as never),
      mode: requestedExecutionWorkspaceMode,
    });
    // Same spread order as heartbeat.ts:18277-18280.
    const mergedConfig = { ...workspaceManaged, ...(input.issueAdapterConfig ?? {}) };
    const strategy = resolveLowTrustAssertWorkspaceStrategyType({
      requestedExecutionWorkspaceMode,
      mergedConfig,
    });
    const refusal = await assertLowTrustWorkspaceIsolation({
      resolution: lowTrustResolution(),
      isolatedWorkspacesEnabled: true,
      effectiveExecutionWorkspaceMode: requestedExecutionWorkspaceMode,
      effectiveExecutionWorkspaceStrategyType: strategy,
      selectedEnvironmentDriver: "sandbox",
      issue: BOUNDARY_ISSUE,
    }).then(
      () => null,
      (error: { details?: { code?: string } }) => error.details?.code ?? "unknown",
    );
    return { strategy, admitted: refusal === null, refusal };
  }

  const NOTHING = {
    projectPolicy: null,
    issueSettings: null,
    legacyUseProjectWorkspace: null,
    agentConfig: {},
  };

  it("REFUSE R1 - no workspace control and no agent-level worktree pin", async () => {
    await expect(admissibility(NOTHING)).resolves.toMatchObject({
      strategy: "project_primary",
      refusal: STRATEGY_REFUSAL,
    });
  });

  it("REFUSE R2 - policy isolated, agent pins project_primary", async () => {
    await expect(
      admissibility({
        ...NOTHING,
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        agentConfig: { workspaceStrategy: { type: "project_primary" } },
      }),
    ).resolves.toMatchObject({ strategy: "project_primary", refusal: STRATEGY_REFUSAL });
  });

  it("REFUSE R3 - per-issue adapterConfig override pins project_primary", async () => {
    await expect(
      admissibility({
        ...NOTHING,
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        issueAdapterConfig: { workspaceStrategy: { type: "project_primary" } },
      }),
    ).resolves.toMatchObject({ strategy: "project_primary", refusal: STRATEGY_REFUSAL });
  });

  it("REFUSE R4 - project policy pins project_primary", async () => {
    await expect(
      admissibility({
        ...NOTHING,
        projectPolicy: parseProjectExecutionWorkspacePolicy({
          enabled: true,
          defaultMode: "isolated_workspace",
          workspaceStrategy: { type: "project_primary" },
        }),
      }),
    ).resolves.toMatchObject({ strategy: "project_primary", refusal: STRATEGY_REFUSAL });
  });

  it("REFUSE R5 - issue workspace settings pin project_primary", async () => {
    await expect(
      admissibility({
        ...NOTHING,
        issueSettings: parseIssueExecutionWorkspaceSettings({
          mode: "isolated_workspace",
          workspaceStrategy: { type: "project_primary" },
        }),
      }),
    ).resolves.toMatchObject({ strategy: "project_primary", refusal: STRATEGY_REFUSAL });
  });

  it("ADMIT - the one-field remediations still start the run", async () => {
    // Without these the five refusals above would also be satisfied by a resolver that
    // refused everything, which would be a different bug rather than a fix.
    await expect(
      admissibility({ ...NOTHING, agentConfig: { workspaceStrategy: { type: "git_worktree" } } }),
    ).resolves.toMatchObject({ strategy: "git_worktree", admitted: true });
    await expect(
      admissibility({ ...NOTHING, projectPolicy: { enabled: true, defaultMode: "isolated_workspace" } }),
    ).resolves.toMatchObject({ strategy: "git_worktree", admitted: true });
  });
});

/**
 * L1: the dispatch site itself.
 *
 * `heartbeatService` is a ~20k-line function with no seam to call, so this is a static guard
 * on the source text — the same approach `authz-existence-oracle-guard.test.ts` takes, and the
 * only thing that catches a constant substituted at the dispatch site. It is deliberately an
 * exact-match on the full set of sites rather than a "contains" check, so that adding a new
 * unguarded site fails too.
 *
 * Note: the TypeScript compiler API is not an option here. `typescript@7.0.2` in this repo
 * exports only `version` and `versionMajorMinor` — `createSourceFile`, `forEachChild` and the
 * `isXxx` predicates are all undefined (this is what has broken
 * `scripts/extract-proposed-events.test.mjs`, which is a pre-existing failure unrelated to
 * ELL-2285). Hence text scanning, made brace-aware below so a multi-line call argument is
 * captured whole and reformatting cannot break the assertion.
 */
const HEARTBEAT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "services",
  "heartbeat.ts",
);
const STRATEGY_TYPE_PROPERTY = "effectiveExecutionWorkspaceStrategyType:";

/** The two `input:` type declarations, which carry no value expression. */
const TYPE_DECLARATION = "string | null | undefined";

function strategyTypePropertyValues(source: string): string[] {
  const values: string[] = [];
  for (
    let index = source.indexOf(STRATEGY_TYPE_PROPERTY);
    index !== -1;
    index = source.indexOf(STRATEGY_TYPE_PROPERTY, index + 1)
  ) {
    const start = index + STRATEGY_TYPE_PROPERTY.length;
    let depth = 0;
    let cursor = start;
    for (; cursor < source.length; cursor += 1) {
      const char = source[cursor]!;
      if (char === "(" || char === "{" || char === "[") depth += 1;
      else if (char === ")" || char === "}" || char === "]") {
        if (depth === 0) break;
        depth -= 1;
      } else if ((char === "," || char === ";") && depth === 0) break;
    }
    values.push(
      source
        .slice(start, cursor)
        .replace(/\s+/g, " ")
        // Prettier's trailing commas are formatting, not meaning.
        .replace(/,(\s*[)}\]])/g, "$1")
        .trim(),
    );
  }
  return values;
}

describe("ELL-2285 L1: the dispatch site computes the strategy type from the run's config", () => {
  const source = readFileSync(HEARTBEAT_PATH, "utf8");

  it("passes the extracted resolver, never a constant, at every site in the chain", () => {
    const values = strategyTypePropertyValues(source).filter(
      (value) => value !== TYPE_DECLARATION,
    );

    expect(
      values,
      "A constant (or anything that does not read the run's mergedConfig) substituted for any "
        + "of these values disarms the ELL-2283 isolating-strategy gate completely: the assert "
        + "certifies a strategy the run is not configured for and the R1-R5 shared-checkout "
        + "routes are all admitted again. Hardcoding \"git_worktree\" at the dispatch site left "
        + "the whole low-trust suite green, which is why ELL-2285 exists. If you are moving this "
        + "wiring on purpose, update this list; do not delete the assertion.",
    ).toEqual([
      // preflightLowTrustWorkspaceIsolation -> assertLowTrustWorkspaceIsolation (L3)
      "input.effectiveExecutionWorkspaceStrategyType",
      // resolveWorkspaceAfterLowTrustPreflight -> preflightLowTrustWorkspaceIsolation (L2)
      "input.effectiveExecutionWorkspaceStrategyType",
      // heartbeatService dispatch -> resolveWorkspaceAfterLowTrustPreflight (L1)
      "resolveLowTrustAssertWorkspaceStrategyType({ requestedExecutionWorkspaceMode, mergedConfig })",
    ]);
  });

  it("imports the resolver from execution-workspace-policy, so it cannot be shadowed locally", () => {
    // Without this, `const resolveLowTrustAssertWorkspaceStrategyType = () => "git_worktree"`
    // inside heartbeat.ts would satisfy the assertion above.
    const importBlock = source.slice(0, source.indexOf('} from "./execution-workspace-policy.js";'));

    expect(importBlock).toContain("resolveLowTrustAssertWorkspaceStrategyType");
    expect(source).not.toMatch(
      /(const|let|var|function)\s+resolveLowTrustAssertWorkspaceStrategyType/,
    );
  });

  it("keeps the scanner honest about what it is reading", () => {
    // Positive control for the guard itself. If the property were ever renamed, the filtered
    // list above would go empty and toEqual would still be comparing something — this pins
    // that the scanner found all five real sites, two of them the type declarations.
    const all = strategyTypePropertyValues(source);

    expect(all).toHaveLength(5);
    expect(all.filter((value) => value === TYPE_DECLARATION)).toHaveLength(2);
  });
});
