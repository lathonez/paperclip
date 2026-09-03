import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, projects as projectsTable } from "@paperclipai/db";
import { updateProjectSchema } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectService } from "../services/projects.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres legacy policy-key tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// ELL-2240 removed `allowIssueOverride` from the project execution-workspace
// policy. There is no migration and no backfill, so rows written before the
// removal still carry the key in their `execution_workspace_policy` jsonb. The
// key must stay inert extra jsonb: a stored value must not become a load
// failure on read or a validation error when the row is patched back.
describeEmbeddedPostgres("project execution-workspace policy legacy keys", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let prefixCounter = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-policy-legacy-keys-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(projectsTable);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedProjectWithLegacyPolicy() {
    prefixCounter += 1;
    const [company] = await db
      .insert(companies)
      .values({ name: "Legacy Policy Co", issuePrefix: `LPC${prefixCounter}` })
      .returning();
    const [project] = await db
      .insert(projectsTable)
      .values({
        companyId: company.id,
        name: "Legacy policy project",
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          // Written by a build that still had the field.
          allowIssueOverride: false,
        },
      })
      .returning();
    return { companyId: company.id, projectId: project.id };
  }

  it("loads a stored policy that still carries allowIssueOverride", async () => {
    const { projectId } = await seedProjectWithLegacyPolicy();
    const projects = projectService(db);

    const fetched = await projects.getById(projectId);
    expect(fetched?.executionWorkspacePolicy).toEqual({
      enabled: true,
      defaultMode: "shared_workspace",
    });
  });

  it("patches such a project cleanly when the client echoes the stored key back", async () => {
    const { projectId } = await seedProjectWithLegacyPolicy();
    const projects = projectService(db);

    // The read-modify-write shape a client sends: the whole stored policy plus
    // the edited field. `updateProjectSchema` is the PATCH /projects/:id
    // validator, and its policy object is strict, so the removed key has to be
    // stripped there rather than rejected.
    const parsed = updateProjectSchema.safeParse({
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        allowIssueOverride: false,
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.executionWorkspacePolicy).not.toHaveProperty("allowIssueOverride");

    const updated = await projects.update(projectId, {
      executionWorkspacePolicy: parsed.data?.executionWorkspacePolicy ?? undefined,
    });
    expect(updated?.executionWorkspacePolicy).toEqual({
      enabled: true,
      defaultMode: "isolated_workspace",
    });

    const refetched = await projects.getById(projectId);
    expect(refetched?.executionWorkspacePolicy).toEqual({
      enabled: true,
      defaultMode: "isolated_workspace",
    });
  });
});
