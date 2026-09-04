import { describe, expect, it } from "vitest";
import {
  issueExecutionWorkspaceSettingsSchema,
  projectExecutionWorkspacePolicySchema,
} from "@paperclipai/shared";
import {
  buildExecutionWorkspaceAdapterConfig,
  defaultIssueExecutionWorkspaceSettingsForProject,
  gateProjectExecutionWorkspacePolicy,
  isUnrunnableWorktreeCombo,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  ManagedSandboxUnavailableError,
  resolveExecutionWorkspaceEnvironmentId,
  resolvePinnedIssueWorkspaceStrategyType,
  resolveExecutionWorkspaceMode,
  resolveRequestedExecutionWorkspaceMode,
  resolveSharedWorkspaceConcurrency,
  selectEnvironmentExecutionWorkspaceSettings,
  type ParsedExecutionWorkspaceMode,
} from "../services/execution-workspace-policy.ts";
import type { TrustPresetResolution } from "../services/trust-preset-resolver.ts";

describe("execution workspace policy helpers", () => {
  it("defaults new issue settings from enabled project policy", () => {
    expect(
      defaultIssueExecutionWorkspaceSettingsForProject({
        enabled: true,
        defaultMode: "isolated_workspace",
      }),
    ).toEqual({ mode: "isolated_workspace" });
    expect(
      defaultIssueExecutionWorkspaceSettingsForProject({
        enabled: true,
        defaultMode: "shared_workspace",
      }),
    ).toEqual({ mode: "shared_workspace" });
    expect(defaultIssueExecutionWorkspaceSettingsForProject(null)).toBeNull();
  });

  it("prefers explicit issue mode over project policy and legacy overrides", () => {
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: { enabled: true, defaultMode: "shared_workspace" },
        issueSettings: { mode: "isolated_workspace" },
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("isolated_workspace");
  });

  it("resolves shared-workspace concurrency from issue override, project policy, then auto", () => {
    expect(
      resolveSharedWorkspaceConcurrency({
        projectPolicy: { enabled: true, sharedWorkspaceConcurrency: "serialize" },
        issueSettings: { sharedWorkspaceConcurrency: "allow" },
      }),
    ).toBe("allow");
    expect(
      resolveSharedWorkspaceConcurrency({
        projectPolicy: { enabled: true, sharedWorkspaceConcurrency: "serialize" },
        issueSettings: null,
      }),
    ).toBe("serialize");
    expect(
      resolveSharedWorkspaceConcurrency({
        projectPolicy: { enabled: false, sharedWorkspaceConcurrency: "serialize" },
        issueSettings: null,
      }),
    ).toBe("auto");
    expect(resolveSharedWorkspaceConcurrency({ projectPolicy: null, issueSettings: null })).toBe("auto");
  });

  it("validates the shared-workspace concurrency enum on project and issue settings", () => {
    expect(projectExecutionWorkspacePolicySchema.parse({
      enabled: true,
      sharedWorkspaceConcurrency: "auto",
    }).sharedWorkspaceConcurrency).toBe("auto");
    expect(issueExecutionWorkspaceSettingsSchema.parse({
      sharedWorkspaceConcurrency: "allow",
    }).sharedWorkspaceConcurrency).toBe("allow");
    expect(projectExecutionWorkspacePolicySchema.safeParse({
      enabled: true,
      sharedWorkspaceConcurrency: "parallel",
    }).success).toBe(false);
  });

  it("accepts an existing-branch pin only with isolated mode and a git_worktree strategy", () => {
    expect(issueExecutionWorkspaceSettingsSchema.parse({
      mode: "isolated_workspace",
      workspaceStrategy: {
        type: "git_worktree",
        existingBranch: "PAP-14380-salvage-pap-9514",
      },
    }).workspaceStrategy?.existingBranch).toBe("PAP-14380-salvage-pap-9514");

    // Fail closed at the contract layer: an exact-branch pin outside an
    // isolated git worktree could silently land in the shared checkout.
    expect(issueExecutionWorkspaceSettingsSchema.safeParse({
      workspaceStrategy: { type: "git_worktree", existingBranch: "some-branch" },
    }).success).toBe(false);
    expect(issueExecutionWorkspaceSettingsSchema.safeParse({
      mode: "shared_workspace",
      workspaceStrategy: { type: "git_worktree", existingBranch: "some-branch" },
    }).success).toBe(false);
    expect(issueExecutionWorkspaceSettingsSchema.safeParse({
      mode: "isolated_workspace",
      workspaceStrategy: { type: "project_primary", existingBranch: "some-branch" },
    }).success).toBe(false);
    expect(issueExecutionWorkspaceSettingsSchema.safeParse({
      mode: "isolated_workspace",
      workspaceStrategy: {
        type: "git_worktree",
        existingBranch: "some-branch",
        branchTemplate: "{{issue.identifier}}-{{slug}}",
      },
    }).success).toBe(false);

    for (const invalidBranch of ["-leading-dash", "a..b", "has space", "ends/", "back\\slash", "a.lock", "../escape"]) {
      expect(issueExecutionWorkspaceSettingsSchema.safeParse({
        mode: "isolated_workspace",
        workspaceStrategy: { type: "git_worktree", existingBranch: invalidBranch },
      }).success).toBe(false);
    }
  });

  it("carries the existing-branch pin through issue settings parsing", () => {
    expect(
      parseIssueExecutionWorkspaceSettings({
        mode: "isolated_workspace",
        workspaceStrategy: { type: "git_worktree", existingBranch: " PAP-14754-run-redaction " },
      })?.workspaceStrategy,
    ).toEqual({ type: "git_worktree", existingBranch: "PAP-14754-run-redaction" });
  });

  it("centralizes unrunnable isolated worktree detection", () => {
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "isolated_workspace",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(true);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: "project-1",
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "isolated_workspace",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(false);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: "workspace-1",
          executionWorkspacePreference: "reuse_existing",
        },
        resolvedMode: "isolated_workspace",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(false);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "shared_workspace",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(false);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "agent_default",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(false);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "operator_branch",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(true);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "isolated_workspace",
        resolvedStrategy: "git_worktree",
        hasResolvablePriorSessionWorkspace: true,
      }),
    ).toBe(false);
  });

  it("mirrors runtime default (project_primary) when pinned settings omit strategy type", () => {
    // Mode-only pin without explicit workspaceStrategy.type → same project_primary default as runtime.
    expect(
      resolvePinnedIssueWorkspaceStrategyType({
        mode: "isolated_workspace",
        issueSettings: { mode: "isolated_workspace" },
      }),
    ).toBe("project_primary");
    // Explicit strategy type is always respected.
    expect(
      resolvePinnedIssueWorkspaceStrategyType({
        mode: "isolated_workspace",
        issueSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree" },
        },
      }),
    ).toBe("git_worktree");
    expect(
      resolvePinnedIssueWorkspaceStrategyType({
        mode: "isolated_workspace",
        issueSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "project_primary" },
        },
      }),
    ).toBe("project_primary");
  });

  it("falls back to project policy before legacy project-workspace compatibility flag", () => {
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        issueSettings: null,
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("isolated_workspace");
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: null,
        issueSettings: null,
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("agent_default");
  });

  it("applies project policy strategy and runtime defaults when isolation is enabled", () => {
    const result = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {
        workspaceStrategy: { type: "project_primary" },
      },
      projectPolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "origin/main",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
          runtimeProvisionCommand: "bash ./scripts/provision-runtime.sh",
        },
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev" }],
        },
      },
      issueSettings: null,
      mode: "isolated_workspace",
      legacyUseProjectWorkspace: null,
    });

    expect(result.workspaceStrategy).toEqual({
      type: "git_worktree",
      baseRef: "origin/main",
      provisionCommand: "bash ./scripts/provision-worktree.sh",
      runtimeProvisionCommand: "bash ./scripts/provision-runtime.sh",
    });
    expect(result.workspaceRuntime).toEqual({
      services: [{ name: "web", command: "pnpm dev" }],
    });
  });

  it("preserves project authorization policy for trust-preset resolution", () => {
    expect(parseProjectExecutionWorkspacePolicy({
      enabled: true,
      authorizationPolicy: {
        trustBoundary: {
          mode: "low_trust_review",
          projectIds: ["33333333-3333-4333-8333-333333333333"],
        },
      },
    })?.authorizationPolicy).toEqual({
      trustBoundary: {
        mode: "low_trust_review",
        projectIds: ["33333333-3333-4333-8333-333333333333"],
      },
    });
  });

  it("clears managed workspace strategy when issue opts out to project primary or agent default", () => {
    const baseConfig = {
      workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}" },
      workspaceRuntime: { services: [{ name: "web" }] },
    };

    expect(
      buildExecutionWorkspaceAdapterConfig({
        agentConfig: baseConfig,
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        issueSettings: { mode: "shared_workspace" },
        mode: "shared_workspace",
        legacyUseProjectWorkspace: null,
      }).workspaceStrategy,
    ).toBeUndefined();

    const agentDefault = buildExecutionWorkspaceAdapterConfig({
      agentConfig: baseConfig,
      projectPolicy: null,
      issueSettings: { mode: "agent_default" },
      mode: "agent_default",
      legacyUseProjectWorkspace: null,
    });
    expect(agentDefault.workspaceStrategy).toBeUndefined();
    expect(agentDefault.workspaceRuntime).toBeUndefined();
  });

  it("parses persisted JSON payloads into typed project and issue workspace settings", () => {
    expect(
      parseProjectExecutionWorkspacePolicy({
        enabled: true,
        sharedWorkspaceConcurrency: "serialize",
        defaultMode: "isolated",
        workspaceStrategy: {
          type: "git_worktree",
          worktreeParentDir: ".paperclip/worktrees",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
          runtimeProvisionCommand: "bash ./scripts/provision-runtime.sh",
          teardownCommand: "bash ./scripts/teardown-worktree.sh",
        },
      }),
    ).toEqual({
      enabled: true,
      sharedWorkspaceConcurrency: "serialize",
      defaultMode: "isolated_workspace",
      workspaceStrategy: {
        type: "git_worktree",
        worktreeParentDir: ".paperclip/worktrees",
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        runtimeProvisionCommand: "bash ./scripts/provision-runtime.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
      },
    });
    expect(
      parseIssueExecutionWorkspaceSettings({
        mode: "project_primary",
        environmentId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      mode: "shared_workspace",
    });
    expect(
      parseIssueExecutionWorkspaceSettings(
        {
          mode: "project_primary",
          environmentId: "11111111-1111-4111-8111-111111111111",
        },
        { includeEnvironmentId: true },
      ),
    ).toEqual({
      mode: "shared_workspace",
      environmentId: "11111111-1111-4111-8111-111111111111",
    });
    expect(
      parseIssueExecutionWorkspaceSettings({
        mode: "isolated_workspace",
        sharedWorkspaceConcurrency: "allow",
        networkEgress: {
          allowFqdns: ["github.com", "pypi.org"],
          allowCidrs: ["203.0.113.0/24"],
        },
      }),
    ).toEqual({
      mode: "isolated_workspace",
      sharedWorkspaceConcurrency: "allow",
      networkEgress: {
        allowFqdns: ["github.com", "pypi.org"],
        allowCidrs: ["203.0.113.0/24"],
      },
    });
  });

  it("keeps egress grants independent from isolated workspace mode", () => {
    const parsedSettings = {
      mode: "isolated_workspace" as const,
      workspaceRuntime: { image: "example/image" },
      networkEgress: {
        allowFqdns: ["github.com"],
        allowCidrs: ["203.0.113.0/24"],
      },
    };

    expect(selectEnvironmentExecutionWorkspaceSettings(parsedSettings, false)).toEqual({
      networkEgress: parsedSettings.networkEgress,
    });
    expect(selectEnvironmentExecutionWorkspaceSettings(parsedSettings, true)).toEqual(parsedSettings);
    expect(selectEnvironmentExecutionWorkspaceSettings({ mode: "isolated_workspace" }, false)).toBeNull();
  });

  it("prefers the agent default environment", () => {
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: "agent-env",
        instanceDefaultEnvironmentId: "instance-env",
        localDefaultEnvironmentId: "local-env",
      }),
    ).toEqual({
      environmentId: "agent-env",
      source: "agent",
    });
  });

  it("falls back to the instance default environment when the agent has none", () => {
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: "instance-env",
        localDefaultEnvironmentId: "local-env",
      }),
    ).toEqual({
      environmentId: "instance-env",
      source: "instance",
    });
  });

  it("falls back to the built-in local environment when neither agent nor instance selects one", () => {
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
      }),
    ).toEqual({
      environmentId: "local-env",
      source: "default",
    });
  });

  it("redirects local-landing selections to the managed sandbox under managed-sandbox-only", () => {
    // The default fallback and an explicit local selection both land on the
    // managed environment; a non-local selection stays untouched.
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: "managed-env",
      }),
    ).toEqual({ environmentId: "managed-env", source: "managed" });
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: "local-env",
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: "managed-env",
      }),
    ).toEqual({ environmentId: "managed-env", source: "managed" });
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: "ssh-env",
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: "managed-env",
      }),
    ).toEqual({ environmentId: "ssh-env", source: "agent" });
  });

  it("fails closed — never local — when managed-sandbox-only has no managed environment", () => {
    expect(() =>
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: null,
      }),
    ).toThrow(ManagedSandboxUnavailableError);
  });

  it("maps persisted execution workspace modes back to issue settings", () => {
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("isolated_workspace")).toBe("isolated_workspace");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("operator_branch")).toBe("operator_branch");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("shared_workspace")).toBe("shared_workspace");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("adapter_managed")).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("cloud_sandbox")).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace(null)).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace(undefined)).toBe("agent_default");
  });

  it("disables project execution workspace policy when the instance flag is off", () => {
    expect(
      gateProjectExecutionWorkspacePolicy(
        { enabled: true, defaultMode: "isolated_workspace" },
        false,
      ),
    ).toBeNull();
    expect(
      gateProjectExecutionWorkspacePolicy(
        { enabled: true, defaultMode: "isolated_workspace" },
        true,
      ),
    ).toEqual({ enabled: true, defaultMode: "isolated_workspace" });
  });
});

// ELL-2280. This guard used to be an inline expression inside the heartbeat dispatch function, so no
// test could reach it: the low-trust workspace tests inject effectiveExecutionWorkspaceMode directly.
// It was possible to widen the guard in a one-line change with the whole suite still green, which is
// what these cases exist to stop.
//
// The decision they pin (ELL-2278): only shared_workspace is upgraded. agent_default and
// operator_branch are deliberately NOT upgraded. assertLowTrustWorkspaceIsolation
// (low-trust-runtime-containment.ts) accepts only isolated_workspace and runs before the workspace is
// resolved, so a low-trust run arriving as agent_default or operator_branch is refused with
// low_trust_requires_isolated_workspace instead of getting a workspace. That refusal is the intended
// outcome, not a gap: widening the guard would replace a fail-closed refusal with a silent workspace
// substitution that overrides an explicit project policy. If you are here because you want to add a
// mode, reopen ELL-2278 rather than editing these expectations.
describe("resolveRequestedExecutionWorkspaceMode (low-trust workspace-mode guard)", () => {
  // Derived from the shared zod enum rather than from ParsedExecutionWorkspaceMode, because a
  // type-level exhaustiveness check would not be enforced anywhere: server/tsconfig.json excludes
  // src/__tests__, so tsc never sees this file. Comparing the runtime list against the hand-written
  // keys below fails if the two ever diverge, in either direction.
  const PARSED_MODES = issueExecutionWorkspaceSettingsSchema.shape.mode
    .unwrap()
    .options.filter(
      (mode): mode is ParsedExecutionWorkspaceMode => mode !== "inherit" && mode !== "reuse_existing",
    );
  const LOW_TRUST_EXPECTATIONS: Record<ParsedExecutionWorkspaceMode, ParsedExecutionWorkspaceMode> = {
    shared_workspace: "isolated_workspace",
    isolated_workspace: "isolated_workspace",
    agent_default: "agent_default",
    operator_branch: "operator_branch",
  };
  // "denied" reaches the guard too: it runs before assertLowTrustWorkspaceIsolation rejects the run.
  const NON_LOW_TRUST_KINDS: TrustPresetResolution["kind"][] = ["standard", "denied"];

  it("asserts every parsed execution workspace mode", () => {
    expect([...PARSED_MODES].sort()).toEqual(Object.keys(LOW_TRUST_EXPECTATIONS).sort());
    expect(PARSED_MODES).toHaveLength(4);
  });

  it.each(PARSED_MODES)("low_trust_review + %s resolves as decided in ELL-2278", (mode) => {
    expect(
      resolveRequestedExecutionWorkspaceMode({
        trustPresetKind: "low_trust_review",
        resolvedExecutionWorkspaceMode: mode,
      }),
    ).toBe(LOW_TRUST_EXPECTATIONS[mode]);
  });

  it("upgrades low_trust_review + shared_workspace to isolated_workspace", () => {
    expect(
      resolveRequestedExecutionWorkspaceMode({
        trustPresetKind: "low_trust_review",
        resolvedExecutionWorkspaceMode: "shared_workspace",
      }),
    ).toBe("isolated_workspace");
  });

  it("does NOT upgrade low_trust_review + agent_default (deliberate: the downstream refusal is intended)", () => {
    expect(
      resolveRequestedExecutionWorkspaceMode({
        trustPresetKind: "low_trust_review",
        resolvedExecutionWorkspaceMode: "agent_default",
      }),
    ).toBe("agent_default");
  });

  it("does NOT upgrade low_trust_review + operator_branch (deliberate: an explicit operator choice)", () => {
    expect(
      resolveRequestedExecutionWorkspaceMode({
        trustPresetKind: "low_trust_review",
        resolvedExecutionWorkspaceMode: "operator_branch",
      }),
    ).toBe("operator_branch");
  });

  it.each(
    NON_LOW_TRUST_KINDS.flatMap((kind) => PARSED_MODES.map((mode) => [kind, mode] as const)),
  )("passes %s + %s through untouched", (kind, mode) => {
    expect(
      resolveRequestedExecutionWorkspaceMode({
        trustPresetKind: kind,
        resolvedExecutionWorkspaceMode: mode,
      }),
    ).toBe(mode);
  });
});
