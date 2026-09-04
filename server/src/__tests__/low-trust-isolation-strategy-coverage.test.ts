import { describe, expect, it } from "vitest";
import {
  buildExecutionWorkspaceAdapterConfig,
  resolveEffectiveWorkspaceStrategyType,
  resolveExecutionWorkspaceMode,
} from "../services/execution-workspace-policy.ts";
import { stripHostWorkspaceProvisionForLowTrustSandbox } from "../services/heartbeat.ts";
import { assertLowTrustWorkspaceIsolation } from "../services/low-trust-runtime-containment.ts";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.ts";
import type { TrustPresetResolution } from "../services/trust-preset-resolver.ts";

// ELL-2282 asks whether assertLowTrustWorkspaceIsolation should additionally require a
// provably isolating workspace strategy, and picks between two shapes: an allowlist at
// the assert, or pinning git_worktree upstream at the low-trust mode upgrade
// (heartbeat.ts:17852).
//
// The parent issue's evidence (branch invest/ell2281-lowtrust-strategy-gate) pins ONE
// route to "mode says isolated_workspace, realization is project_primary": the
// hasWorkspaceControl === false path. These cases pin the two OTHER routes. They are
// what separates the two design options, because both of the routes below reach the
// assert with the mode already equal to isolated_workspace — so the upstream upgrade
// branch is never taken and an upstream pin cannot fire.

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

/** The assert exactly as heartbeat.ts calls it today, with every other gate satisfied. */
function assertToday(effectiveExecutionWorkspaceMode: string) {
  return assertLowTrustWorkspaceIsolation({
    resolution: lowTrustResolution(),
    isolatedWorkspacesEnabled: true,
    effectiveExecutionWorkspaceMode,
    selectedEnvironmentDriver: "sandbox",
    issue: BOUNDARY_ISSUE,
  });
}

describe("ELL-2282: an agent-pinned strategy beats the git_worktree default", () => {
  // Route 2. buildExecutionWorkspaceAdapterConfig:382-387 consults the agent's own
  // adapterConfig.workspaceStrategy BEFORE falling back to {type: "git_worktree"}:
  //
  //   issueSettings?.workspaceStrategy
  //     ?? projectPolicy?.workspaceStrategy
  //     ?? parseExecutionWorkspaceStrategy(nextConfig.workspaceStrategy)   <- agent config
  //     ?? { type: "git_worktree" }
  //
  // parseExecutionWorkspaceStrategy accepts "project_primary" verbatim
  // (execution-workspace-policy.ts:33-38), so a low-trust agent carrying that pin keeps
  // it. Unlike the parent issue's route, workspace control is fully ACTIVE here and the
  // mode is isolated_workspace by explicit project policy rather than by upgrade.
  const agentPinnedProjectPrimary = { workspaceStrategy: { type: "project_primary" } };
  const projectPolicy = { enabled: true, defaultMode: "isolated_workspace" } as never;

  it("resolves isolated_workspace from project policy with no upgrade involved", () => {
    const resolved = resolveExecutionWorkspaceMode({
      projectPolicy,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
    });

    // This is the load-bearing half of the design argument: the mode is already
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

  it("passes the assert as written today", async () => {
    await expect(assertToday("isolated_workspace")).resolves.toBeUndefined();
  });

  it("realizes in the unchanged shared checkout", async () => {
    const base = sharedProjectCheckout("/tmp/ell2282-shared-project-checkout");
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

  it("does inject git_worktree for the same policy when the agent pins nothing", () => {
    // Positive control: the difference above is attributable to the agent's pin alone.
    const merged = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {},
      projectPolicy,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
      mode: "isolated_workspace",
    });

    expect(merged.workspaceStrategy).toEqual({ type: "git_worktree" });
    expect(resolveEffectiveWorkspaceStrategyType("isolated_workspace", merged)).toBe("git_worktree");
  });
});

describe("ELL-2282: an issue adapterConfig override outranks the pinned strategy", () => {
  // Route 3, and the one an upstream fix cannot reach at all. mergedConfig
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

  it("still passes the assert, and realizes in the shared checkout", async () => {
    const base = sharedProjectCheckout("/tmp/ell2282-shared-project-checkout");
    const merged = mergedConfigFor({ workspaceStrategy: { type: "project_primary" } });

    await expect(assertToday("isolated_workspace")).resolves.toBeUndefined();

    const realized = await realizeExecutionWorkspace({
      base,
      config: merged,
      issue: ISSUE_REF,
      agent: AGENT_REF,
    });
    expect(realized.strategy).toBe("project_primary");
    expect(realized.cwd).toBe(base.baseCwd);
  });

  it("leaves the pin intact when the override touches an unrelated key", () => {
    // Positive control: the spread only defeats the pin when it carries
    // workspaceStrategy itself, so this route is override-shaped, not universal.
    const merged = mergedConfigFor({ model: "sonnet" });

    expect(merged.workspaceStrategy).toEqual({ type: "git_worktree" });
    expect(resolveEffectiveWorkspaceStrategyType("isolated_workspace", merged)).toBe("git_worktree");
  });
});

describe("ELL-2282: the assert can read the strategy realization will use", () => {
  // Feasibility of the allowlist option. realizeExecutionWorkspace consumes
  // hostExecutionWorkspaceConfig = stripHostWorkspaceProvisionForLowTrustSandbox(mergedConfig)
  // (heartbeat.ts:18495-18499 -> :18707-18710), and mergedConfig exists at :18270, before
  // the assert at :18460. So the assert can be handed the same value realization gets.
  it("agrees on the strategy type across the strip, for every accepted type", () => {
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
    // The allowlist ["git_worktree"] is exhaustive because realization has exactly one
    // non-project_primary branch (workspace-runtime.ts:3217). A non-repo base cwd is
    // inert for the other three and fatal for git_worktree, which attributes the
    // difference to the strategy rather than the fixture. If any other type ever grows a
    // provisioning path, the first half of this fails and the allowlist must be revisited.
    const base = sharedProjectCheckout("/tmp/ell2282-not-a-repo");

    for (const type of ["project_primary", "adapter_managed", "cloud_sandbox"]) {
      const realized = await realizeExecutionWorkspace({
        base,
        config: { workspaceStrategy: { type } },
        issue: ISSUE_REF,
        agent: AGENT_REF,
      });
      expect(realized.strategy).toBe("project_primary");
      expect(realized.cwd).toBe(base.baseCwd);
      expect(realized.worktreePath).toBeNull();
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

describe("ELL-2282: an upstream pin at the upgrade site cannot reach routes 2 and 3", () => {
  // Coverage limit of the alternative design. Transcribed verbatim from
  // heartbeat.ts:17853-17856 on origin/master b5f86237. ELL-2280 has since lifted this
  // same expression into the exported resolveRequestedExecutionWorkspaceMode
  // (execution-workspace-policy.ts, branch refactor/ell2280-lowtrust-workspace-mode-guard
  // d91033e9, not yet on origin/master), so once that merges this transcription should be
  // replaced by a direct call. The condition is unchanged either way.
  function upgradeApplies(resolvedExecutionWorkspaceMode: string) {
    return resolvedExecutionWorkspaceMode === "shared_workspace";
  }

  it("applies to the parent issue's route, where nothing configures workspace control", () => {
    const resolved = resolveExecutionWorkspaceMode({
      projectPolicy: null,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
    });

    expect(resolved).toBe("shared_workspace");
    expect(upgradeApplies(resolved)).toBe(true);
  });

  it("does not apply once project policy already names isolated_workspace", () => {
    // Routes 2 and 3 both arrive here. The upgrade is the only place an upstream pin
    // could attach, and on these routes it does not run at all — so an upstream pin
    // closes route 1 and leaves the other two exactly as they are today.
    const resolved = resolveExecutionWorkspaceMode({
      projectPolicy: { enabled: true, defaultMode: "isolated_workspace" } as never,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
    });

    expect(resolved).toBe("isolated_workspace");
    expect(upgradeApplies(resolved)).toBe(false);
  });

  it("is defeated by the issue adapterConfig spread even on route 1", () => {
    // Second, independent limit: the spread at heartbeat.ts:18270 lands AFTER anything
    // the upgrade site could pin, so a per-issue override outranks an upstream pin too.
    const upstreamPinned = { workspaceStrategy: { type: "git_worktree" } };
    const merged = { ...upstreamPinned, workspaceStrategy: { type: "project_primary" } };

    expect(resolveEffectiveWorkspaceStrategyType("isolated_workspace", merged)).toBe("project_primary");
  });
});

describe("ELL-2282: which configurations a git_worktree allowlist would admit", () => {
  // The operator-facing consequence of the allowlist option, measured rather than
  // described. `admissibility` composes the real resolver, the real low-trust upgrade
  // condition and the real config builder, then reports the pair the assert would see.
  // A run is admitted only when the mode is isolated_workspace AND the strategy is
  // git_worktree, which is exactly the proposed rule.
  function admissibility(input: {
    projectPolicy: unknown;
    issueSettings: unknown;
    legacyUseProjectWorkspace: boolean | null;
    agentConfig: Record<string, unknown>;
  }) {
    const resolved = resolveExecutionWorkspaceMode(input as never);
    const requested = resolved === "shared_workspace" ? "isolated_workspace" : resolved;
    const merged = buildExecutionWorkspaceAdapterConfig({ ...(input as never), mode: requested });
    const strategy = resolveEffectiveWorkspaceStrategyType(requested, merged);
    return {
      requested,
      strategy,
      admitted: requested === "isolated_workspace" && strategy === "git_worktree",
    };
  }

  const NOTHING = {
    projectPolicy: null,
    issueSettings: null,
    legacyUseProjectWorkspace: null,
    agentConfig: {},
  };

  it("refuses only when no workspace control and no agent-level worktree pin exist", () => {
    // The exposure this issue is about, and the two shapes adjacent to it.
    expect(admissibility(NOTHING)).toMatchObject({
      requested: "isolated_workspace",
      strategy: "project_primary",
      admitted: false,
    });
    expect(
      admissibility({ ...NOTHING, projectPolicy: { enabled: false, defaultMode: "isolated_workspace" } }),
    ).toMatchObject({ strategy: "project_primary", admitted: false });
    expect(
      admissibility({
        ...NOTHING,
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        agentConfig: { workspaceStrategy: { type: "project_primary" } },
      }),
    ).toMatchObject({ strategy: "project_primary", admitted: false });
  });

  it("admits an agent-level git_worktree pin even with no project policy", () => {
    // Not obvious, and it matters for remediation: hasWorkspaceControl is false here so
    // the builder never runs, but the agent's own pin survives untouched and resolves
    // git_worktree. So the refusal above has TWO independent one-line fixes — project
    // policy, or the agent's own adapterConfig.workspaceStrategy.
    expect(
      admissibility({ ...NOTHING, agentConfig: { workspaceStrategy: { type: "git_worktree" } } }),
    ).toMatchObject({ requested: "isolated_workspace", strategy: "git_worktree", admitted: true });
  });

  it("admits both policy default modes that reach isolated_workspace", () => {
    for (const defaultMode of ["isolated_workspace", "shared_workspace"]) {
      expect(admissibility({ ...NOTHING, projectPolicy: { enabled: true, defaultMode } })).toMatchObject({
        requested: "isolated_workspace",
        strategy: "git_worktree",
        admitted: true,
      });
    }
    expect(admissibility({ ...NOTHING, issueSettings: { mode: "isolated_workspace" } })).toMatchObject({
      strategy: "git_worktree",
      admitted: true,
    });
  });

  it("still refuses the two modes ELL-2278 decided to leave refused", () => {
    // cc724d38's shape and the legacy override both resolve agent_default, which the
    // mode check already refuses. The allowlist does not change that, and must not.
    expect(
      admissibility({ ...NOTHING, projectPolicy: { enabled: true, defaultMode: "adapter_default" } }),
    ).toMatchObject({ requested: "agent_default", strategy: "adapter_managed", admitted: false });
    expect(admissibility({ ...NOTHING, legacyUseProjectWorkspace: false })).toMatchObject({
      requested: "agent_default",
      strategy: "adapter_managed",
      admitted: false,
    });
  });
});

describe("ELL-2282: the existing mode check stays necessary", () => {
  // Whatever is added must be in ADDITION to the mode check, never instead of it.
  // agent_default with an agent-pinned git_worktree would satisfy a strategy-only gate,
  // so dropping the mode check would admit a mode the resolver treats as metadata-only.
  it("refuses every non-isolated mode today", async () => {
    for (const mode of ["shared_workspace", "agent_default", "operator_branch", "", "isolated"]) {
      await expect(assertToday(mode)).rejects.toMatchObject({
        details: { code: "low_trust_requires_isolated_workspace" },
      });
    }
  });

  it("refuses a null or undefined mode", async () => {
    await expect(assertToday(null as never)).rejects.toMatchObject({
      details: { code: "low_trust_requires_isolated_workspace" },
    });
    await expect(assertToday(undefined as never)).rejects.toMatchObject({
      details: { code: "low_trust_requires_isolated_workspace" },
    });
  });

  it("refuses before the mode is even consulted while the flag is off", async () => {
    await expect(
      assertLowTrustWorkspaceIsolation({
        resolution: lowTrustResolution(),
        isolatedWorkspacesEnabled: false,
        effectiveExecutionWorkspaceMode: "isolated_workspace",
        selectedEnvironmentDriver: "sandbox",
        issue: BOUNDARY_ISSUE,
      }),
    ).rejects.toMatchObject({ details: { code: "low_trust_isolation_unavailable" } });
  });
});
