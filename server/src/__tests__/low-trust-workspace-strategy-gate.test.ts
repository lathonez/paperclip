import { describe, expect, it } from "vitest";
import {
  buildExecutionWorkspaceAdapterConfig,
  resolveEffectiveWorkspaceStrategyType,
  resolveExecutionWorkspaceMode,
} from "../services/execution-workspace-policy.ts";
import { stripHostWorkspaceProvisionForLowTrustSandbox } from "../services/heartbeat.ts";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.ts";
import type { TrustPresetResolution } from "../services/trust-preset-resolver.ts";

// ELL-2281 asks whether assertLowTrustWorkspaceIsolation should gate on the resolved
// workspace *strategy* instead of the mode string, so that adapter-native
// `cloud_sandbox` isolation is not refused. These cases pin the three facts that
// decision turns on, so the answer stops depending on anyone re-reading the resolver.

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

function agentHomeBase(baseCwd: string) {
  // agent_default resolves useProjectWorkspace=false (heartbeat.ts:18484-18485), so the
  // anchor is the reused per-agent home, not a project checkout.
  return {
    baseCwd,
    source: "agent_home" as const,
    projectId: null,
    workspaceId: null,
    repoUrl: null,
    repoRef: null,
  };
}

describe("ELL-2281: mode agent_default spans two strategies", () => {
  it("resolves adapter_managed when the agent sets no workspaceStrategy.type", () => {
    // Both Verifiers on this instance have adapterConfig = {}.
    expect(resolveEffectiveWorkspaceStrategyType("agent_default", {})).toBe("adapter_managed");
    expect(resolveEffectiveWorkspaceStrategyType("agent_default", null)).toBe("adapter_managed");
    expect(resolveEffectiveWorkspaceStrategyType("agent_default", undefined)).toBe("adapter_managed");
  });

  it("returns cloud_sandbox as-is when the agent pins it, so one mode covers both", () => {
    expect(
      resolveEffectiveWorkspaceStrategyType("agent_default", {
        workspaceStrategy: { type: "cloud_sandbox" },
      }),
    ).toBe("cloud_sandbox");
  });
});

describe("ELL-2281: cloud_sandbox is not an isolating strategy at realization", () => {
  // This is the decisive fact. `cloud_sandbox` is accepted by the validators and
  // returned by the resolver, but realizeExecutionWorkspace has no branch for it:
  // workspace-runtime.ts:3217 tests `strategyType !== "git_worktree"` and everything
  // that is not a worktree collapses to project_primary at the unmodified base cwd.
  // So a low-trust run admitted on strategy `cloud_sandbox` would execute in the very
  // directory the mode check exists to keep it out of.
  it("collapses cloud_sandbox to project_primary at the unchanged base cwd", async () => {
    const base = agentHomeBase("/tmp/ell2281-agent-home");

    const realized = await realizeExecutionWorkspace({
      base,
      config: { workspaceStrategy: { type: "cloud_sandbox" } },
      issue: ISSUE_REF,
      agent: AGENT_REF,
    });

    expect(realized.strategy).toBe("project_primary");
    expect(realized.cwd).toBe(base.baseCwd);
    expect(realized.worktreePath).toBeNull();
    expect(realized.branchName).toBeNull();
    expect(realized.created).toBe(false);
  });

  it("realizes cloud_sandbox and adapter_managed identically, so the two are not different realities", async () => {
    const base = agentHomeBase("/tmp/ell2281-agent-home");

    const [cloudSandbox, adapterManaged] = await Promise.all([
      realizeExecutionWorkspace({
        base,
        config: { workspaceStrategy: { type: "cloud_sandbox" } },
        issue: ISSUE_REF,
        agent: AGENT_REF,
      }),
      realizeExecutionWorkspace({
        base,
        config: { workspaceStrategy: { type: "adapter_managed" } },
        issue: ISSUE_REF,
        agent: AGENT_REF,
      }),
    ]);

    expect(cloudSandbox).toEqual(adapterManaged);
  });

  it("keeps git_worktree as the only strategy that actually moves the run off the base cwd", async () => {
    // Paired control on identical input: the same non-repo base cwd is inert for
    // cloud_sandbox and fatal for git_worktree, so the difference is attributable to
    // the strategy alone rather than to the fixture. If cloud_sandbox ever starts
    // taking a provisioning path of its own, the first assertion breaks and the
    // strategy-allowlist question genuinely reopens.
    const base = agentHomeBase("/tmp/ell2281-not-a-repo");

    const cloudSandbox = await realizeExecutionWorkspace({
      base,
      config: { workspaceStrategy: { type: "cloud_sandbox" } },
      issue: ISSUE_REF,
      agent: AGENT_REF,
    });
    expect(cloudSandbox.cwd).toBe(base.baseCwd);
    expect(cloudSandbox.strategy).toBe("project_primary");

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

describe("ELL-2281: the resolved strategy is computable at the assert's call site", () => {
  // The layering worry in the issue is that the strategy is unknown where the check
  // runs. For the strategy *type* it is knowable: mergedConfig (heartbeat.ts:18270)
  // predates the assert (heartbeat.ts:18460), and the only transform applied between
  // them strips provision commands without touching the type.
  it("preserves workspaceStrategy.type while stripping provision commands", () => {
    for (const type of ["cloud_sandbox", "adapter_managed", "git_worktree", "project_primary"]) {
      const config = {
        workspaceStrategy: {
          type,
          provisionCommand: "bash ./provision.sh",
          runtimeProvisionCommand: "bash ./runtime-provision.sh",
        },
      };

      const stripped = stripHostWorkspaceProvisionForLowTrustSandbox({
        config,
        trustPreset: lowTrustResolution(),
        selectedEnvironmentDriver: "sandbox",
      });

      expect(stripped.workspaceStrategy).toEqual({ type });
      expect(resolveEffectiveWorkspaceStrategyType("agent_default", stripped)).toBe(
        resolveEffectiveWorkspaceStrategyType("agent_default", config),
      );
    }
  });

  it("erases an agent's cloud_sandbox pin for agent_default whenever workspace control is active", () => {
    // buildExecutionWorkspaceAdapterConfig:388-390 deletes workspaceStrategy for every
    // mode that is not isolated_workspace. So an agent that pins cloud_sandbox cannot
    // carry it into the effective config while a project policy is enabled, and the
    // effective strategy for agent_default is adapter_managed regardless.
    const agentConfig = { workspaceStrategy: { type: "cloud_sandbox" } };

    const merged = buildExecutionWorkspaceAdapterConfig({
      agentConfig,
      projectPolicy: { enabled: true, defaultMode: "adapter_default" } as never,
      issueSettings: null,
      mode: "agent_default",
      legacyUseProjectWorkspace: null,
    });

    expect(merged.workspaceStrategy).toBeUndefined();
    expect(resolveEffectiveWorkspaceStrategyType("agent_default", merged)).toBe("adapter_managed");
  });

  it("agrees on the strategy type before and after the low-trust strip when no type is set", () => {
    const config = { workspaceStrategy: { provisionCommand: "bash ./provision.sh" } };
    const stripped = stripHostWorkspaceProvisionForLowTrustSandbox({
      config,
      trustPreset: lowTrustResolution(),
      selectedEnvironmentDriver: "sandbox",
    });

    expect(resolveEffectiveWorkspaceStrategyType("agent_default", stripped)).toBe("adapter_managed");
    expect(resolveEffectiveWorkspaceStrategyType("agent_default", config)).toBe("adapter_managed");
  });
});

describe("ELL-2281: mode isolated_workspace is not itself proof of isolation", () => {
  // The gap runs the other way from the one the issue asks about. The git_worktree
  // default at execution-workspace-policy.ts:386 only applies inside the
  // `hasWorkspaceControl` branch (:380). An agent with no project policy, no issue
  // workspace overrides and no legacy override resolves mode `shared_workspace`
  // (:348), which the low-trust guard at heartbeat.ts:17852-17856 upgrades to
  // `isolated_workspace`. That upgraded mode satisfies the assert at
  // low-trust-runtime-containment.ts:65, but nothing ever pins a strategy, so
  // realization falls back to project_primary in the shared checkout.
  it("resolves shared_workspace when nothing configures workspace control", () => {
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: null,
        issueSettings: null,
        legacyUseProjectWorkspace: null,
      }),
    ).toBe("shared_workspace");
  });

  it("injects no strategy for the low-trust upgrade when workspace control is inactive", () => {
    // The mode the low-trust guard hands downstream is isolated_workspace, but the
    // inputs that would trigger the git_worktree default are all absent.
    const merged = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {},
      projectPolicy: null,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
      mode: "isolated_workspace",
    });

    expect(merged.workspaceStrategy).toBeUndefined();
    expect(resolveEffectiveWorkspaceStrategyType("isolated_workspace", merged)).toBe("project_primary");
  });

  it("realizes that upgraded isolated_workspace run in the unchanged shared checkout", async () => {
    const base = {
      baseCwd: "/tmp/ell2281-shared-project-checkout",
      source: "project_primary" as const,
      projectId: "project-1",
      workspaceId: "workspace-1",
      repoUrl: null,
      repoRef: null,
    };

    const realized = await realizeExecutionWorkspace({
      base,
      config: {},
      issue: ISSUE_REF,
      agent: AGENT_REF,
    });

    expect(realized.strategy).toBe("project_primary");
    expect(realized.cwd).toBe(base.baseCwd);
    expect(realized.worktreePath).toBeNull();
  });

  it("does inject git_worktree once a project policy turns workspace control on", () => {
    // Positive control for the branch above: with a policy present the same mode
    // does get an isolating strategy, which is why this gap is configuration-shaped
    // rather than universal.
    const merged = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {},
      projectPolicy: { enabled: true, defaultMode: "isolated_workspace" } as never,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
      mode: "isolated_workspace",
    });

    expect(merged.workspaceStrategy).toEqual({ type: "git_worktree" });
    expect(resolveEffectiveWorkspaceStrategyType("isolated_workspace", merged)).toBe("git_worktree");
  });
});
