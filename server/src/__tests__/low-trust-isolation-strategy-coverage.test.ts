import { describe, expect, it } from "vitest";
import {
  buildExecutionWorkspaceAdapterConfig,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveEffectiveWorkspaceStrategyType,
  resolveExecutionWorkspaceMode,
} from "../services/execution-workspace-policy.ts";
import { stripHostWorkspaceProvisionForLowTrustSandbox } from "../services/heartbeat.ts";
import {
  LOW_TRUST_ISOLATING_WORKSPACE_STRATEGY_TYPES,
  assertLowTrustWorkspaceIsolation,
  isLowTrustIsolatingWorkspaceStrategy,
} from "../services/low-trust-runtime-containment.ts";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.ts";
import type { TrustPresetResolution } from "../services/trust-preset-resolver.ts";

// ELL-2283 implements the ELL-2282 decision: assertLowTrustWorkspaceIsolation now
// additionally requires a provably isolating workspace strategy, as an allowlist
// (["git_worktree"]) checked LAST — after the sandbox-driver gate, so every pre-existing
// refusal code keeps reporting first.
//
// Five routes reach "mode says isolated_workspace, realization is project_primary". R1 is
// the hasWorkspaceControl === false path pinned on ELL-2281. R2-R5 all arrive with the
// mode ALREADY isolated_workspace, so the low-trust upgrade at heartbeat.ts:17852 is a
// no-op on them and no upstream pin at that site could have closed them. That coverage
// difference is why the allowlist sits at the assert.
//
//   R1  no policy, no overrides                          -> strategy project_primary
//   R2  agent adapterConfig.workspaceStrategy pin        -> strategy project_primary
//   R3  per-issue assigneeAdapterOverrides.adapterConfig -> strategy project_primary
//   R4  project policy pins a non-isolating strategy     -> strategy project_primary
//   R5  issue workspace settings pin one                 -> strategy project_primary

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

const AGENT_REF = { id: "agent-1", name: "Verifier", companyId: "company-1" };
const ISSUE_REF = { id: "issue-1", identifier: "PAP-1", title: "Blind verification" };
const BOUNDARY_ISSUE = { companyId: "company-1", id: "issue-1", projectId: "project-1" };

function sharedProjectCheckout(baseCwd: string) {
  // requestedExecutionWorkspaceMode !== "agent_default" sets useProjectWorkspace=true
  // (heartbeat.ts:18484-18485), so the anchor for every case here is the shared
  // project checkout — the directory the low-trust check exists to keep a reviewer out of.
  return {
    baseCwd,
    source: "project_primary" as const,
    projectId: "project-1",
    workspaceId: "workspace-1",
    repoUrl: null,
    repoRef: null,
  };
}

/**
 * The assert exactly as heartbeat.ts:18460 calls it, with every gate other than the two
 * workspace gates satisfied.
 */
function assertIsolation(
  effectiveExecutionWorkspaceMode: string,
  effectiveExecutionWorkspaceStrategyType: string | null | undefined,
) {
  return assertLowTrustWorkspaceIsolation({
    resolution: lowTrustResolution(),
    isolatedWorkspacesEnabled: true,
    effectiveExecutionWorkspaceMode,
    effectiveExecutionWorkspaceStrategyType,
    selectedEnvironmentDriver: "sandbox",
    issue: BOUNDARY_ISSUE,
  });
}

const REFUSES_STRATEGY = {
  status: 422,
  details: { code: "low_trust_requires_isolating_workspace_strategy" },
};

describe("ELL-2283: the allowlist is an allowlist, and fails closed", () => {
  it("names git_worktree and nothing else", () => {
    expect([...LOW_TRUST_ISOLATING_WORKSPACE_STRATEGY_TYPES]).toEqual(["git_worktree"]);
  });

  it("refuses null, undefined, empty and every unrecognized strategy", async () => {
    // Fail-closed is the whole point: an unknown strategy type must refuse rather than
    // be treated as "probably fine". A denylist would admit anything it had not heard of.
    for (const strategyType of [
      null,
      undefined,
      "",
      "project_primary",
      "adapter_managed",
      "cloud_sandbox",
      "GIT_WORKTREE",
      "git_worktree_v2",
      "some_future_strategy",
    ]) {
      expect(isLowTrustIsolatingWorkspaceStrategy(strategyType)).toBe(false);
      await expect(assertIsolation("isolated_workspace", strategyType)).rejects.toMatchObject(
        REFUSES_STRATEGY,
      );
    }
  });

  it("admits git_worktree", async () => {
    expect(isLowTrustIsolatingWorkspaceStrategy("git_worktree")).toBe(true);
    await expect(assertIsolation("isolated_workspace", "git_worktree")).resolves.toBeUndefined();
  });

  it("reports the resolved strategy on the refusal so an operator can tell the two gates apart", async () => {
    // Observability requirement from ELL-2282: "wrong mode" and "mode fine, strategy not
    // isolating" must be distinguishable without reproducing the resolution.
    await expect(assertIsolation("isolated_workspace", "project_primary")).rejects.toMatchObject({
      details: {
        code: "low_trust_requires_isolating_workspace_strategy",
        workspaceStrategyType: "project_primary",
        allowedWorkspaceStrategyTypes: ["git_worktree"],
      },
    });
    await expect(assertIsolation("isolated_workspace", null)).rejects.toMatchObject({
      details: {
        code: "low_trust_requires_isolating_workspace_strategy",
        workspaceStrategyType: null,
      },
    });
  });

  it("leaves standard-trust runs alone", async () => {
    // The gate is inside the kind === "low_trust_review" branch, so a standard-trust run
    // with a non-isolating strategy is untouched.
    await expect(
      assertLowTrustWorkspaceIsolation({
        resolution: { kind: "standard", preset: "standard", sourcePresets: {} } as never,
        isolatedWorkspacesEnabled: false,
        effectiveExecutionWorkspaceMode: "shared_workspace",
        effectiveExecutionWorkspaceStrategyType: "project_primary",
        selectedEnvironmentDriver: "local",
        issue: BOUNDARY_ISSUE,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("ELL-2283: placement is last, so no existing refusal code changed", () => {
  // Measured on ELL-2282 and the reason the check is not next to the mode check: a run
  // that fails more than one gate must keep reporting the gate it reported before.
  // Each case below is non-isolating AND fails an earlier gate.
  it("reports the sandbox gate first when the driver is also wrong", async () => {
    await expect(
      assertLowTrustWorkspaceIsolation({
        resolution: lowTrustResolution(),
        isolatedWorkspacesEnabled: true,
        effectiveExecutionWorkspaceMode: "isolated_workspace",
        effectiveExecutionWorkspaceStrategyType: "project_primary",
        selectedEnvironmentDriver: "local",
        issue: BOUNDARY_ISSUE,
      }),
    ).rejects.toMatchObject({ details: { code: "low_trust_requires_sandbox_environment" } });
  });

  it("reports the mode gate first when the mode is also wrong", async () => {
    await expect(assertIsolation("shared_workspace", "project_primary")).rejects.toMatchObject({
      details: { code: "low_trust_requires_isolated_workspace" },
    });
  });

  it("reports the boundary gate first when the issue is also outside the boundary", async () => {
    await expect(
      assertLowTrustWorkspaceIsolation({
        resolution: lowTrustResolution(),
        isolatedWorkspacesEnabled: true,
        effectiveExecutionWorkspaceMode: "isolated_workspace",
        effectiveExecutionWorkspaceStrategyType: "project_primary",
        selectedEnvironmentDriver: "sandbox",
        issue: { companyId: "company-1", id: "issue-elsewhere", projectId: "project-1" },
      }),
    ).rejects.toMatchObject({ details: { code: "low_trust_boundary_mismatch" } });
  });

  it("reports the flag gate first when isolated workspaces are off", async () => {
    await expect(
      assertLowTrustWorkspaceIsolation({
        resolution: lowTrustResolution(),
        isolatedWorkspacesEnabled: false,
        effectiveExecutionWorkspaceMode: "isolated_workspace",
        effectiveExecutionWorkspaceStrategyType: "project_primary",
        selectedEnvironmentDriver: "sandbox",
        issue: BOUNDARY_ISSUE,
      }),
    ).rejects.toMatchObject({ details: { code: "low_trust_isolation_unavailable" } });
  });
});

describe("ELL-2283: the existing mode check stays necessary", () => {
  // The allowlist is in ADDITION to the mode check, never instead of it. agent_default
  // carrying an agent-pinned git_worktree satisfies a strategy-only gate, so replacing
  // the mode check would reopen ELL-2278.
  it("refuses agent_default even when the strategy is git_worktree", async () => {
    await expect(assertIsolation("agent_default", "git_worktree")).rejects.toMatchObject({
      details: { code: "low_trust_requires_isolated_workspace" },
    });
  });

  it("refuses every non-isolated mode with an isolating strategy", async () => {
    for (const mode of ["shared_workspace", "agent_default", "operator_branch", "", "isolated"]) {
      await expect(assertIsolation(mode, "git_worktree")).rejects.toMatchObject({
        details: { code: "low_trust_requires_isolated_workspace" },
      });
    }
    await expect(assertIsolation(null as never, "git_worktree")).rejects.toMatchObject({
      details: { code: "low_trust_requires_isolated_workspace" },
    });
    await expect(assertIsolation(undefined as never, "git_worktree")).rejects.toMatchObject({
      details: { code: "low_trust_requires_isolated_workspace" },
    });
  });
});

describe("ELL-2283 R2: an agent-pinned strategy beats the git_worktree default", () => {
  // buildExecutionWorkspaceAdapterConfig:382-387 consults the agent's own
  // adapterConfig.workspaceStrategy BEFORE falling back to {type: "git_worktree"}:
  //
  //   issueSettings?.workspaceStrategy
  //     ?? projectPolicy?.workspaceStrategy
  //     ?? parseExecutionWorkspaceStrategy(nextConfig.workspaceStrategy)   <- agent config
  //     ?? { type: "git_worktree" }
  //
  // parseExecutionWorkspaceStrategy accepts "project_primary" verbatim
  // (execution-workspace-policy.ts:33-38), so a low-trust agent carrying that pin keeps
  // it. Unlike R1, workspace control is fully ACTIVE here and the mode is
  // isolated_workspace by explicit project policy rather than by upgrade.
  const agentPinnedProjectPrimary = { workspaceStrategy: { type: "project_primary" } };
  const projectPolicy = { enabled: true, defaultMode: "isolated_workspace" } as never;

  it("resolves isolated_workspace from project policy with no upgrade involved", () => {
    const resolved = resolveExecutionWorkspaceMode({
      projectPolicy,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
    });

    // The load-bearing half of the design argument: the mode is already
    // isolated_workspace, so the low-trust upgrade at heartbeat.ts:17852-17856 — which
    // only rewrites shared_workspace — is a no-op on this route.
    expect(resolved).toBe("isolated_workspace");
    const upgraded = resolved === "shared_workspace" ? "isolated_workspace" : resolved;
    expect(upgraded).toBe(resolved);
  });

  it("keeps the agent's project_primary pin instead of injecting git_worktree", () => {
    const merged = buildExecutionWorkspaceAdapterConfig({
      agentConfig: agentPinnedProjectPrimary,
      projectPolicy,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
      mode: "isolated_workspace",
    });

    expect(merged.workspaceStrategy).toEqual({ type: "project_primary" });
    expect(resolveEffectiveWorkspaceStrategyType("isolated_workspace", merged)).toBe("project_primary");
  });

  it("is now refused by the assert", async () => {
    // Was: "passes the assert as written today". This is the flip ELL-2283 ships.
    const merged = buildExecutionWorkspaceAdapterConfig({
      agentConfig: agentPinnedProjectPrimary,
      projectPolicy,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
      mode: "isolated_workspace",
    });

    await expect(
      assertIsolation("isolated_workspace", resolveEffectiveWorkspaceStrategyType("isolated_workspace", merged)),
    ).rejects.toMatchObject(REFUSES_STRATEGY);
  });

  it("would otherwise have realized in the unchanged shared checkout", async () => {
    // The equality that matters: what the assert used to admit ran in the shared project
    // checkout, byte-identical cwd. This is the assertion the gate exists to prevent, so
    // it stays measured rather than described.
    const base = sharedProjectCheckout("/tmp/ell2283-shared-project-checkout");
    const merged = buildExecutionWorkspaceAdapterConfig({
      agentConfig: agentPinnedProjectPrimary,
      projectPolicy,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
      mode: "isolated_workspace",
    });

    const realized = await realizeExecutionWorkspace({
      base,
      config: merged,
      issue: ISSUE_REF,
      agent: AGENT_REF,
    });

    expect(realized.strategy).toBe("project_primary");
    expect(realized.cwd).toBe(base.baseCwd);
    expect(realized.worktreePath).toBeNull();
  });

  it("does inject git_worktree for the same policy when the agent pins nothing", async () => {
    // Positive control: the difference above is attributable to the agent's pin alone,
    // and the unpinned shape is still admitted.
    const merged = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {},
      projectPolicy,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
      mode: "isolated_workspace",
    });

    expect(merged.workspaceStrategy).toEqual({ type: "git_worktree" });
    expect(resolveEffectiveWorkspaceStrategyType("isolated_workspace", merged)).toBe("git_worktree");
    await expect(assertIsolation("isolated_workspace", "git_worktree")).resolves.toBeUndefined();
  });
});

describe("ELL-2283 R3: an issue adapterConfig override outranks the pinned strategy", () => {
  // The route an upstream fix cannot reach at all. mergedConfig
  // (heartbeat.ts:18270-18273) spreads issueAssigneeOverrides.adapterConfig OVER the
  // workspace-managed config, so whatever buildExecutionWorkspaceAdapterConfig pinned is
  // replaceable by per-issue override — which is exactly the field ELL-2233 showed gets
  // inherited inconsistently by auto-spawned review issues.
  const projectPolicy = { enabled: true, defaultMode: "isolated_workspace" } as never;

  function mergedConfigFor(issueAdapterConfig: Record<string, unknown>) {
    const workspaceManagedConfig = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {},
      projectPolicy,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
      mode: "isolated_workspace",
    });
    // Same spread order as heartbeat.ts:18270.
    return { ...workspaceManagedConfig, ...issueAdapterConfig };
  }

  it("overwrites git_worktree with project_primary via the spread", () => {
    const merged = mergedConfigFor({ workspaceStrategy: { type: "project_primary" } });

    expect(merged.workspaceStrategy).toEqual({ type: "project_primary" });
    expect(resolveEffectiveWorkspaceStrategyType("isolated_workspace", merged)).toBe("project_primary");
  });

  it("is now refused by the assert, and would have realized in the shared checkout", async () => {
    // Was: "still passes the assert, and realizes in the shared checkout".
    const base = sharedProjectCheckout("/tmp/ell2283-shared-project-checkout");
    const merged = mergedConfigFor({ workspaceStrategy: { type: "project_primary" } });

    await expect(
      assertIsolation("isolated_workspace", resolveEffectiveWorkspaceStrategyType("isolated_workspace", merged)),
    ).rejects.toMatchObject(REFUSES_STRATEGY);

    const realized = await realizeExecutionWorkspace({
      base,
      config: merged,
      issue: ISSUE_REF,
      agent: AGENT_REF,
    });
    expect(realized.strategy).toBe("project_primary");
    expect(realized.cwd).toBe(base.baseCwd);
  });

  it("leaves the pin intact when the override touches an unrelated key", async () => {
    // Positive control: the spread only defeats the pin when it carries
    // workspaceStrategy itself, so this route is override-shaped, not universal.
    const merged = mergedConfigFor({ model: "sonnet" });

    expect(merged.workspaceStrategy).toEqual({ type: "git_worktree" });
    expect(resolveEffectiveWorkspaceStrategyType("isolated_workspace", merged)).toBe("git_worktree");
    await expect(assertIsolation("isolated_workspace", "git_worktree")).resolves.toBeUndefined();
  });
});

describe("ELL-2283 R4: project policy pins a non-isolating strategy", () => {
  // Not in the ELL-2282 table. parseProjectExecutionWorkspacePolicy routes
  // workspaceStrategy through parseExecutionWorkspaceStrategy
  // (execution-workspace-policy.ts:111), which accepts "project_primary" verbatim (:36).
  // The policy strategy is the SECOND term of the ?? chain at :382-386, so the
  // git_worktree default never runs.
  //
  // Everything below starts from raw JSON and goes through the real parser, so this pins
  // a genuinely reachable stored configuration rather than a hand-built object shape the
  // parser would have rejected.
  const RAW_POLICY = {
    enabled: true,
    defaultMode: "isolated_workspace",
    workspaceStrategy: { type: "project_primary" },
  };

  it("survives the policy parser rather than being rejected", () => {
    const parsed = parseProjectExecutionWorkspacePolicy(RAW_POLICY);

    expect(parsed).toMatchObject({
      enabled: true,
      defaultMode: "isolated_workspace",
      workspaceStrategy: { type: "project_primary" },
    });
  });

  it("resolves mode isolated_workspace with strategy project_primary", () => {
    const projectPolicy = parseProjectExecutionWorkspacePolicy(RAW_POLICY);
    const mode = resolveExecutionWorkspaceMode({
      projectPolicy,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
    });
    const merged = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {},
      projectPolicy,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
      mode,
    });

    // Mode already isolated_workspace -> the upgrade at :17852 is a no-op here too.
    expect(mode).toBe("isolated_workspace");
    expect(merged.workspaceStrategy).toEqual({ type: "project_primary" });
    expect(resolveEffectiveWorkspaceStrategyType(mode, merged)).toBe("project_primary");
  });

  it("is refused by the assert, and would have realized in the shared checkout", async () => {
    const projectPolicy = parseProjectExecutionWorkspacePolicy(RAW_POLICY);
    const merged = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {},
      projectPolicy,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
      mode: "isolated_workspace",
    });

    await expect(
      assertIsolation("isolated_workspace", resolveEffectiveWorkspaceStrategyType("isolated_workspace", merged)),
    ).rejects.toMatchObject(REFUSES_STRATEGY);

    const base = sharedProjectCheckout("/tmp/ell2283-shared-project-checkout");
    const realized = await realizeExecutionWorkspace({
      base,
      config: merged,
      issue: ISSUE_REF,
      agent: AGENT_REF,
    });
    expect(realized.strategy).toBe("project_primary");
    expect(realized.cwd).toBe(base.baseCwd);
    expect(realized.worktreePath).toBeNull();
  });

  it("beats an agent-level git_worktree pin", async () => {
    // Precedence control: the policy strategy outranks the agent config term, so an
    // agent that pins git_worktree is NOT a remediation for R4.
    const projectPolicy = parseProjectExecutionWorkspacePolicy(RAW_POLICY);
    const merged = buildExecutionWorkspaceAdapterConfig({
      agentConfig: { workspaceStrategy: { type: "git_worktree" } },
      projectPolicy,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
      mode: "isolated_workspace",
    });

    expect(resolveEffectiveWorkspaceStrategyType("isolated_workspace", merged)).toBe("project_primary");
    await expect(assertIsolation("isolated_workspace", "project_primary")).rejects.toMatchObject(
      REFUSES_STRATEGY,
    );
  });

  it("is admitted once the same policy pins git_worktree", async () => {
    // Positive control: the refusal is attributable to the pinned strategy alone, and
    // the remediation for R4 is a one-field policy edit.
    const projectPolicy = parseProjectExecutionWorkspacePolicy({
      ...RAW_POLICY,
      workspaceStrategy: { type: "git_worktree" },
    });
    const merged = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {},
      projectPolicy,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
      mode: "isolated_workspace",
    });

    expect(resolveEffectiveWorkspaceStrategyType("isolated_workspace", merged)).toBe("git_worktree");
    await expect(assertIsolation("isolated_workspace", "git_worktree")).resolves.toBeUndefined();
  });
});

describe("ELL-2283 R5: issue workspace settings pin a non-isolating strategy", () => {
  // Also not in the ELL-2282 table. Same construction in the issue-settings parser
  // (execution-workspace-policy.ts:177), and issueSettings?.workspaceStrategy is the
  // HIGHEST-precedence term of the ?? chain at :382-386 — so this route defeats both a
  // project policy pin and an agent pin.
  const RAW_SETTINGS = {
    mode: "isolated_workspace",
    workspaceStrategy: { type: "project_primary" },
  };

  it("survives the issue-settings parser rather than being rejected", () => {
    expect(parseIssueExecutionWorkspaceSettings(RAW_SETTINGS)).toMatchObject({
      mode: "isolated_workspace",
      workspaceStrategy: { type: "project_primary" },
    });
  });

  it("resolves mode isolated_workspace with strategy project_primary and no policy at all", () => {
    const issueSettings = parseIssueExecutionWorkspaceSettings(RAW_SETTINGS);
    const mode = resolveExecutionWorkspaceMode({
      projectPolicy: null,
      issueSettings,
      legacyUseProjectWorkspace: null,
    });
    const merged = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {},
      projectPolicy: null,
      issueSettings,
      legacyUseProjectWorkspace: null,
      mode,
    });

    expect(mode).toBe("isolated_workspace");
    expect(resolveEffectiveWorkspaceStrategyType(mode, merged)).toBe("project_primary");
  });

  it("outranks a project policy that pins git_worktree", () => {
    // Highest-precedence term, measured. So neither a policy edit nor an agent edit
    // remediates R5 — only the issue's own settings do.
    const issueSettings = parseIssueExecutionWorkspaceSettings(RAW_SETTINGS);
    const projectPolicy = parseProjectExecutionWorkspacePolicy({
      enabled: true,
      defaultMode: "isolated_workspace",
      workspaceStrategy: { type: "git_worktree" },
    });
    const merged = buildExecutionWorkspaceAdapterConfig({
      agentConfig: { workspaceStrategy: { type: "git_worktree" } },
      projectPolicy,
      issueSettings,
      legacyUseProjectWorkspace: null,
      mode: "isolated_workspace",
    });

    expect(resolveEffectiveWorkspaceStrategyType("isolated_workspace", merged)).toBe("project_primary");
  });

  it("is refused by the assert, and would have realized in the shared checkout", async () => {
    const issueSettings = parseIssueExecutionWorkspaceSettings(RAW_SETTINGS);
    const merged = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {},
      projectPolicy: null,
      issueSettings,
      legacyUseProjectWorkspace: null,
      mode: "isolated_workspace",
    });

    await expect(
      assertIsolation("isolated_workspace", resolveEffectiveWorkspaceStrategyType("isolated_workspace", merged)),
    ).rejects.toMatchObject(REFUSES_STRATEGY);

    const base = sharedProjectCheckout("/tmp/ell2283-shared-project-checkout");
    const realized = await realizeExecutionWorkspace({
      base,
      config: merged,
      issue: ISSUE_REF,
      agent: AGENT_REF,
    });
    expect(realized.strategy).toBe("project_primary");
    expect(realized.cwd).toBe(base.baseCwd);
    expect(realized.worktreePath).toBeNull();
  });

  it("is admitted once the same issue settings pin git_worktree", async () => {
    const issueSettings = parseIssueExecutionWorkspaceSettings({
      ...RAW_SETTINGS,
      workspaceStrategy: { type: "git_worktree" },
    });
    const merged = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {},
      projectPolicy: null,
      issueSettings,
      legacyUseProjectWorkspace: null,
      mode: "isolated_workspace",
    });

    expect(resolveEffectiveWorkspaceStrategyType("isolated_workspace", merged)).toBe("git_worktree");
    await expect(assertIsolation("isolated_workspace", "git_worktree")).resolves.toBeUndefined();
  });
});

describe("ELL-2283: the assert reads the strategy realization will use", () => {
  // Why the wiring at heartbeat.ts:18460 reads mergedConfig (:18270) rather than
  // hostExecutionWorkspaceConfig, which is only derived at :18495 — after the assert.
  // realizeExecutionWorkspace consumes the stripped config, so the two must agree on the
  // strategy type or the assert would be certifying a different value than the one used.
  it("agrees on the strategy type across the provision strip, for every accepted type", () => {
    for (const type of ["git_worktree", "project_primary", "adapter_managed", "cloud_sandbox"]) {
      const mergedConfig = {
        workspaceStrategy: { type, provisionCommand: "bash ./provision.sh" },
      };
      const hostConfig = stripHostWorkspaceProvisionForLowTrustSandbox({
        config: mergedConfig,
        trustPreset: lowTrustResolution(),
        selectedEnvironmentDriver: "sandbox",
      });

      expect(resolveEffectiveWorkspaceStrategyType("isolated_workspace", hostConfig)).toBe(
        resolveEffectiveWorkspaceStrategyType("isolated_workspace", mergedConfig),
      );
    }
  });

  it("treats git_worktree as the only type that leaves the base cwd", async () => {
    // Exhaustiveness of the allowlist. realizeExecutionWorkspace dispatches binarily on
    // git_worktree (workspace-runtime.ts:3216-3217; :3664 and :8664 binarize the same
    // way), so every other type realizes as project_primary in the unchanged base cwd. A
    // non-repo base cwd is inert for the other three and fatal for git_worktree, which
    // attributes the difference to the strategy rather than the fixture.
    //
    // If any other strategy type ever grows a provisioning path, the first half of this
    // fails loudly and LOW_TRUST_ISOLATING_WORKSPACE_STRATEGY_TYPES must be revisited.
    const base = sharedProjectCheckout("/tmp/ell2283-not-a-repo");
    const nonIsolating = ["project_primary", "adapter_managed", "cloud_sandbox"];

    // The allowlist and this enumeration must together cover every type the parser
    // accepts, or a newly accepted type would go unexamined.
    expect([...nonIsolating, ...LOW_TRUST_ISOLATING_WORKSPACE_STRATEGY_TYPES].sort()).toEqual(
      ["adapter_managed", "cloud_sandbox", "git_worktree", "project_primary"],
    );

    for (const type of nonIsolating) {
      const realized = await realizeExecutionWorkspace({
        base,
        config: { workspaceStrategy: { type } },
        issue: ISSUE_REF,
        agent: AGENT_REF,
      });
      expect(realized.strategy).toBe("project_primary");
      expect(realized.cwd).toBe(base.baseCwd);
      expect(realized.worktreePath).toBeNull();
      expect(isLowTrustIsolatingWorkspaceStrategy(type)).toBe(false);
    }

    await expect(
      realizeExecutionWorkspace({
        base,
        config: { workspaceStrategy: { type: "git_worktree" } },
        issue: ISSUE_REF,
        agent: AGENT_REF,
      }),
    ).rejects.toThrow(/git|repo/i);
  });
});

describe("ELL-2283: an upstream pin at the upgrade site could not have reached R2-R5", () => {
  // Coverage limit of the declined alternative (Option B, heartbeat.ts:17852), kept as
  // the record of why the gate sits at the assert. Transcribed verbatim from
  // heartbeat.ts:17853-17856 on origin/master b5f86237. ELL-2280 has since lifted the
  // same expression into the exported resolveRequestedExecutionWorkspaceMode (branch
  // refactor/ell2280-lowtrust-workspace-mode-guard, not yet on origin/master); once that
  // merges this transcription should be replaced by a direct call. The condition is
  // unchanged either way.
  function upgradeApplies(resolvedExecutionWorkspaceMode: string) {
    return resolvedExecutionWorkspaceMode === "shared_workspace";
  }

  it("applies to R1, where nothing configures workspace control", () => {
    const resolved = resolveExecutionWorkspaceMode({
      projectPolicy: null,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
    });

    expect(resolved).toBe("shared_workspace");
    expect(upgradeApplies(resolved)).toBe(true);
  });

  it("does not apply once project policy already names isolated_workspace", () => {
    // R2 and R4 arrive here. The upgrade is the only place an upstream pin could attach,
    // and on these routes it does not run at all.
    const resolved = resolveExecutionWorkspaceMode({
      projectPolicy: { enabled: true, defaultMode: "isolated_workspace" } as never,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
    });

    expect(resolved).toBe("isolated_workspace");
    expect(upgradeApplies(resolved)).toBe(false);
  });

  it("does not apply once issue settings already name isolated_workspace", () => {
    // R5 arrives here.
    const resolved = resolveExecutionWorkspaceMode({
      projectPolicy: null,
      issueSettings: parseIssueExecutionWorkspaceSettings({ mode: "isolated_workspace" }),
      legacyUseProjectWorkspace: null,
    });

    expect(resolved).toBe("isolated_workspace");
    expect(upgradeApplies(resolved)).toBe(false);
  });

  it("is defeated by the issue adapterConfig spread even on R1", () => {
    // Second, independent limit: the spread at heartbeat.ts:18270 lands AFTER anything
    // the upgrade site could pin, so R3 outranks an upstream pin too.
    const upstreamPinned = { workspaceStrategy: { type: "git_worktree" } };
    const merged = { ...upstreamPinned, workspaceStrategy: { type: "project_primary" } };

    expect(resolveEffectiveWorkspaceStrategyType("isolated_workspace", merged)).toBe("project_primary");
  });
});

describe("ELL-2283: the shipped admissibility table", () => {
  // The operator-facing consequence, measured rather than described. `admissibility`
  // composes the real resolver, the real low-trust upgrade condition, the real config
  // builder and the real assert, then reports whether the run starts.
  async function admissibility(input: {
    projectPolicy: unknown;
    issueSettings: unknown;
    legacyUseProjectWorkspace: boolean | null;
    agentConfig: Record<string, unknown>;
    issueAdapterConfig?: Record<string, unknown>;
  }) {
    const resolved = resolveExecutionWorkspaceMode(input as never);
    const requested = resolved === "shared_workspace" ? "isolated_workspace" : resolved;
    const workspaceManaged = buildExecutionWorkspaceAdapterConfig({
      ...(input as never),
      mode: requested,
    });
    // Same spread order as heartbeat.ts:18270-18273.
    const merged = { ...workspaceManaged, ...(input.issueAdapterConfig ?? {}) };
    const strategy = resolveEffectiveWorkspaceStrategyType(requested, merged);
    const refusal = await assertIsolation(requested, strategy).then(
      () => null,
      (error: { details?: { code?: string } }) => error.details?.code ?? "unknown",
    );
    return { requested, strategy, admitted: refusal === null, refusal };
  }

  const NOTHING = {
    projectPolicy: null,
    issueSettings: null,
    legacyUseProjectWorkspace: null,
    agentConfig: {},
  };
  const STRATEGY_REFUSAL = "low_trust_requires_isolating_workspace_strategy";
  const MODE_REFUSAL = "low_trust_requires_isolated_workspace";

  it("REFUSE R1 — no workspace control and no agent-level worktree pin", async () => {
    await expect(admissibility(NOTHING)).resolves.toMatchObject({
      requested: "isolated_workspace",
      strategy: "project_primary",
      admitted: false,
      refusal: STRATEGY_REFUSAL,
    });
  });

  it("REFUSE — policy present but disabled", async () => {
    await expect(
      admissibility({
        ...NOTHING,
        projectPolicy: { enabled: false, defaultMode: "isolated_workspace" },
      }),
    ).resolves.toMatchObject({ strategy: "project_primary", refusal: STRATEGY_REFUSAL });
  });

  it("REFUSE R2 — policy isolated, agent pins project_primary", async () => {
    await expect(
      admissibility({
        ...NOTHING,
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        agentConfig: { workspaceStrategy: { type: "project_primary" } },
      }),
    ).resolves.toMatchObject({ strategy: "project_primary", refusal: STRATEGY_REFUSAL });
  });

  it("REFUSE R3 — per-issue adapterConfig override pins project_primary", async () => {
    await expect(
      admissibility({
        ...NOTHING,
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        issueAdapterConfig: { workspaceStrategy: { type: "project_primary" } },
      }),
    ).resolves.toMatchObject({ strategy: "project_primary", refusal: STRATEGY_REFUSAL });
  });

  it("REFUSE R4 — project policy pins project_primary", async () => {
    await expect(
      admissibility({
        ...NOTHING,
        projectPolicy: parseProjectExecutionWorkspacePolicy({
          enabled: true,
          defaultMode: "isolated_workspace",
          workspaceStrategy: { type: "project_primary" },
        }),
      }),
    ).resolves.toMatchObject({
      requested: "isolated_workspace",
      strategy: "project_primary",
      refusal: STRATEGY_REFUSAL,
    });
  });

  it("REFUSE R5 — issue workspace settings pin project_primary", async () => {
    await expect(
      admissibility({
        ...NOTHING,
        issueSettings: parseIssueExecutionWorkspaceSettings({
          mode: "isolated_workspace",
          workspaceStrategy: { type: "project_primary" },
        }),
      }),
    ).resolves.toMatchObject({
      requested: "isolated_workspace",
      strategy: "project_primary",
      refusal: STRATEGY_REFUSAL,
    });
  });

  it("ADMIT — an agent-level git_worktree pin, even with no project policy", async () => {
    // Not obvious, and it matters for remediation: hasWorkspaceControl is false here so
    // the builder never runs, but the agent's own pin survives untouched and resolves
    // git_worktree. So R1 has TWO independent one-line fixes — project policy, or the
    // agent's own adapterConfig.workspaceStrategy.
    await expect(
      admissibility({ ...NOTHING, agentConfig: { workspaceStrategy: { type: "git_worktree" } } }),
    ).resolves.toMatchObject({
      requested: "isolated_workspace",
      strategy: "git_worktree",
      admitted: true,
    });
  });

  it("ADMIT — both policy default modes that reach isolated_workspace, and an issue mode", async () => {
    for (const defaultMode of ["isolated_workspace", "shared_workspace"]) {
      await expect(
        admissibility({ ...NOTHING, projectPolicy: { enabled: true, defaultMode } }),
      ).resolves.toMatchObject({
        requested: "isolated_workspace",
        strategy: "git_worktree",
        admitted: true,
      });
    }
    await expect(
      admissibility({ ...NOTHING, issueSettings: { mode: "isolated_workspace" } }),
    ).resolves.toMatchObject({ strategy: "git_worktree", admitted: true });
  });

  it("ADMIT — a policy or issue pin that names git_worktree explicitly", async () => {
    await expect(
      admissibility({
        ...NOTHING,
        projectPolicy: parseProjectExecutionWorkspacePolicy({
          enabled: true,
          defaultMode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree" },
        }),
      }),
    ).resolves.toMatchObject({ strategy: "git_worktree", admitted: true });
    await expect(
      admissibility({
        ...NOTHING,
        issueSettings: parseIssueExecutionWorkspaceSettings({
          mode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree" },
        }),
      }),
    ).resolves.toMatchObject({ strategy: "git_worktree", admitted: true });
  });

  it("REFUSE — the two modes ELL-2278 decided to leave refused, with their codes unchanged", async () => {
    // cc724d38's shape and the legacy override both resolve agent_default, which the MODE
    // check already refuses. The allowlist must not change which code they report.
    await expect(
      admissibility({ ...NOTHING, projectPolicy: { enabled: true, defaultMode: "adapter_default" } }),
    ).resolves.toMatchObject({
      requested: "agent_default",
      strategy: "adapter_managed",
      refusal: MODE_REFUSAL,
    });
    await expect(admissibility({ ...NOTHING, legacyUseProjectWorkspace: false })).resolves.toMatchObject({
      requested: "agent_default",
      strategy: "adapter_managed",
      refusal: MODE_REFUSAL,
    });
  });
});
