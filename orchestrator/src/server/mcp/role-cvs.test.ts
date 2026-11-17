import { mkdir, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "../api/routes/test-utils";
import {
  callTool,
  createAccessToken,
  createUserSession,
  expectToolError,
  expectToolOk,
  jsonHeaders,
  listTools,
  login,
  MCP_AUTH_ENV,
  runAsUser,
} from "./test-helpers";

const state = vi.hoisted(() => ({ matchedRoleCvId: null as string | null }));

vi.mock("@server/services/rxresume/baseResumeId", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@server/services/rxresume/baseResumeId")
    >();
  return {
    ...actual,
    getConfiguredRxResumeBaseResumeId: vi.fn(async () => ({
      mode: "v5" as const,
      resumeId: "base-resume-1",
    })),
  };
});

vi.mock("@server/services/summary", () => ({
  generateTailoring: vi.fn(async () => ({
    success: true,
    data: {
      headline: "Backend Engineer Intern",
      summary: "Builds Go services for payments.",
      skills: [{ name: "Backend", keywords: ["Go", "PostgreSQL"] }],
    },
  })),
}));

vi.mock("@server/services/projectSelection", () => ({
  pickProjectIdsForJob: vi.fn(async () => []),
}));

vi.mock("@server/services/role-cv-matching", () => ({
  pickRoleCvForJob: vi.fn(async () => ({
    roleCvId: state.matchedRoleCvId,
    method: "model" as const,
  })),
}));

vi.mock("@server/services/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@server/services/pdf")>();
  return {
    ...actual,
    generatePdf: vi.fn(
      async (
        _id: string,
        _content: unknown,
        _description: string,
        _base: unknown,
        _projects: unknown,
        options?: { outputPath?: string },
      ) => {
        const outputPath = options?.outputPath;
        if (!outputPath) throw new Error("outputPath is required");
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, "%PDF-1.4\n%EOF\n");
        return { success: true, pdfPath: outputPath };
      },
    ),
  };
});

const READ_TOOLS = ["list_role_cvs", "get_role_cv"];
const WRITE_TOOLS = [
  "create_role_cv",
  "update_role_cv",
  "generate_role_cv",
  "generate_role_cv_pdf",
  "delete_role_cv",
  "match_job_role_cv",
  "set_job_role_cv",
  "apply_role_cv_to_job",
];

/** Creates a discovered job through the REST import (no tailoring). */
async function createJob(
  baseUrl: string,
  session: string,
  slug: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/manual-jobs/import`, {
    method: "POST",
    headers: jsonHeaders(session),
    body: JSON.stringify({
      skipTailoring: true,
      job: {
        title: "Backend Engineer Intern",
        employer: "Xendit",
        jobUrl: `https://example.com/jobs/${slug}`,
        jobDescription: "Backend internship. Go, PostgreSQL, payments.",
      },
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).data.id as string;
}

async function createRoleCvWithContent(
  baseUrl: string,
  token: string,
  name: string,
): Promise<string> {
  const created = expectToolOk(
    await callTool(baseUrl, token, "create_role_cv", {
      name,
      roleDescription: "Backend internships: Go, PostgreSQL, payments.",
    }),
  );
  const roleCvId = created.roleCv.id as string;
  expectToolOk(
    await callTool(baseUrl, token, "update_role_cv", {
      roleCvId,
      headline: `${name} headline`,
      summary: `${name} summary`,
      skills: [{ name: "Backend", keywords: ["Go"] }],
      selectedProjectIds: ["payments"],
    }),
  );
  return roleCvId;
}

describe.sequential("MCP Role CV tools", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;
  let session: string;
  let writeToken: string;
  let readToken: string;

  beforeEach(async () => {
    state.matchedRoleCvId = null;
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: MCP_AUTH_ENV,
    }));
    session = await login(baseUrl, "admin", "secret");
    writeToken = (await createAccessToken(baseUrl, session, "write")).secret;
    readToken = (await createAccessToken(baseUrl, session, "read")).secret;
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  it("lists the Role CV tools with read-only, destructive and open-world annotations", async () => {
    const byName = new Map(
      (await listTools(baseUrl, readToken)).map((tool) => [tool.name, tool]),
    );
    for (const name of READ_TOOLS) {
      expect(byName.get(name)?.annotations.readOnlyHint, name).toBe(true);
    }
    for (const name of WRITE_TOOLS) {
      const tool = byName.get(name);
      expect(tool?.annotations.readOnlyHint, name).toBe(false);
      expect(tool?.annotations.destructiveHint, name).toBe(
        name === "delete_role_cv",
      );
    }
    for (const name of [
      "generate_role_cv",
      "match_job_role_cv",
      "apply_role_cv_to_job",
    ]) {
      expect(byName.get(name)?.annotations.openWorldHint, name).toBe(true);
    }
    expect(
      Object.keys(
        byName.get("apply_role_cv_to_job")?.inputSchema.properties ?? {},
      ).sort(),
    ).toEqual(["jobId", "mode", "roleCvId"]);
  });

  it("creates, generates, edits, renders and deletes a Role CV", async () => {
    const { generateTailoring } = await import("@server/services/summary");
    const created = expectToolOk(
      await callTool(baseUrl, writeToken, "create_role_cv", {
        name: "Backend Intern",
        roleDescription: "Backend internships in Go.",
      }),
    );
    const roleCvId = created.roleCv.id as string;
    expect(created.roleCv).toMatchObject({
      name: "Backend Intern",
      headline: null,
      hasContent: false,
      skills: [],
      selectedProjectIds: [],
      pdfFreshness: "missing",
      pdfUrl: null,
    });
    expectToolError(
      await callTool(baseUrl, writeToken, "create_role_cv", {
        name: "Backend Intern",
      }),
      "CONFLICT",
    );

    const generated = expectToolOk(
      await callTool(baseUrl, writeToken, "generate_role_cv", { roleCvId }),
    );
    expect(generated.roleCv).toMatchObject({
      headline: "Backend Engineer Intern",
      summary: "Builds Go services for payments.",
      skills: [{ name: "Backend", keywords: ["Go", "PostgreSQL"] }],
      hasContent: true,
      isStale: false,
    });
    expect(vi.mocked(generateTailoring)).toHaveBeenCalledWith(
      "Backend internships in Go.",
      expect.anything(),
      { target: { kind: "role", roleName: "Backend Intern" } },
    );

    const listed = expectToolOk(
      await callTool(baseUrl, readToken, "list_role_cvs"),
    );
    expect(listed).toMatchObject({ total: 1, hasMore: false });
    expect(listed.roleCvs[0]).toMatchObject({
      id: roleCvId,
      headline: "Backend Engineer Intern",
      hasContent: true,
    });
    expect(listed.roleCvs[0]).not.toHaveProperty("summary");

    const updated = expectToolOk(
      await callTool(baseUrl, writeToken, "update_role_cv", {
        roleCvId,
        summary: "Edited by hand.",
        skills: [{ name: "Data", keywords: ["SQL"] }],
        selectedProjectIds: ["proj-a", "proj-b"],
      }),
    );
    expect(updated.updatedFields).toEqual([
      "summary",
      "skills",
      "selectedProjectIds",
    ]);
    expect(updated.roleCv).toMatchObject({
      headline: "Backend Engineer Intern",
      summary: "Edited by hand.",
      skills: [{ name: "Data", keywords: ["SQL"] }],
      selectedProjectIds: ["proj-a", "proj-b"],
    });
    expectToolError(
      await callTool(baseUrl, writeToken, "update_role_cv", { roleCvId }),
      "INVALID_REQUEST",
    );

    const rendered = expectToolOk(
      await callTool(baseUrl, writeToken, "generate_role_cv_pdf", {
        roleCvId,
      }),
    );
    expect(rendered.pdfUrl).toBe(`${baseUrl}/api/role-cvs/${roleCvId}/pdf`);
    expect(rendered.roleCv.pdfFreshness).toBe("current");
    const detail = expectToolOk(
      await callTool(baseUrl, readToken, "get_role_cv", { roleCvId }),
    );
    expect(detail.roleCv.pdfUrl).toBe(rendered.pdfUrl);
    const download = await fetch(rendered.pdfUrl, {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toContain("%PDF");

    expect(
      expectToolOk(
        await callTool(baseUrl, writeToken, "delete_role_cv", { roleCvId }),
      ),
    ).toEqual({ deleted: true, roleCvId });
    expectToolError(
      await callTool(baseUrl, readToken, "get_role_cv", { roleCvId }),
      "NOT_FOUND",
    );
  });

  it("matches, chooses and applies a Role CV to a job as-is or refined", async () => {
    const pipeline = await import("@server/pipeline/index");
    const jobId = await createJob(baseUrl, session, "apply");
    const roleCvId = await createRoleCvWithContent(
      baseUrl,
      writeToken,
      "Backend Intern",
    );

    const noChoice = expectToolError(
      await callTool(baseUrl, writeToken, "apply_role_cv_to_job", {
        jobId,
        mode: "as_is",
      }),
      "INVALID_REQUEST",
    );
    expect(noChoice.message).toContain("Choose a Role CV");

    state.matchedRoleCvId = roleCvId;
    const matched = expectToolOk(
      await callTool(baseUrl, writeToken, "match_job_role_cv", { jobId }),
    );
    expect(matched).toMatchObject({
      job: { id: jobId, status: "discovered" },
      roleCv: { id: roleCvId, name: "Backend Intern" },
      roleCvMatchSource: "auto",
    });

    const applied = expectToolOk(
      await callTool(baseUrl, writeToken, "apply_role_cv_to_job", {
        jobId,
        mode: "as_is",
      }),
    );
    expect(applied).toMatchObject({
      mode: "as_is",
      roleCv: { id: roleCvId },
      roleCvMatchSource: "auto",
      tailoring: {
        headline: "Backend Intern headline",
        summary: "Backend Intern summary",
        skills: [{ name: "Backend", keywords: ["Go"] }],
        selectedProjectIds: ["payments"],
      },
    });

    vi.mocked(pipeline.summarizeJob).mockClear();
    const refined = expectToolOk(
      await callTool(baseUrl, writeToken, "apply_role_cv_to_job", {
        jobId,
        mode: "refine",
        roleCvId,
      }),
    );
    expect(refined).toMatchObject({ mode: "refine", roleCv: { id: roleCvId } });
    expect(vi.mocked(pipeline.summarizeJob)).toHaveBeenCalledWith(
      jobId,
      expect.objectContaining({
        force: true,
        tailoringBaseline: {
          headline: "Backend Intern headline",
          summary: "Backend Intern summary",
          skills: [{ name: "Backend", keywords: ["Go"] }],
        },
      }),
    );

    const empty = expectToolOk(
      await callTool(baseUrl, writeToken, "create_role_cv", {
        name: "Empty",
        roleDescription: "Nothing yet",
      }),
    );
    const noContent = expectToolError(
      await callTool(baseUrl, writeToken, "apply_role_cv_to_job", {
        jobId,
        mode: "as_is",
        roleCvId: empty.roleCv.id,
      }),
      "INVALID_REQUEST",
    );
    expect(noContent.message).toContain("no headline or summary");

    const cleared = expectToolOk(
      await callTool(baseUrl, writeToken, "set_job_role_cv", {
        jobId,
        roleCvId: null,
      }),
    );
    expect(cleared).toMatchObject({
      roleCv: null,
      roleCvMatchSource: "manual",
    });

    // A busy job is refused before any model call.
    const jobsRepo = await import("@server/repositories/jobs");
    await runAsUser("admin", () =>
      jobsRepo.updateJob(jobId, { status: "processing" }),
    );
    for (const [name, args] of [
      ["match_job_role_cv", { jobId }],
      ["apply_role_cv_to_job", { jobId, mode: "refine", roleCvId }],
    ] as const) {
      const busy = expectToolError(
        await callTool(baseUrl, writeToken, name, args),
        "CONFLICT",
      );
      expect(busy.message, name).toContain("being processed");
    }
  });

  it("refuses write tools to a read-only token and keeps Role CVs and jobs per user", async () => {
    const jobId = await createJob(baseUrl, session, "scope");
    const roleCvId = await createRoleCvWithContent(
      baseUrl,
      writeToken,
      "Admin Role",
    );

    for (const name of WRITE_TOOLS) {
      const error = expectToolError(
        await callTool(baseUrl, readToken, name, {
          roleCvId,
          jobId,
          name: "X",
          mode: "as_is",
        }),
        "FORBIDDEN",
      );
      expect(error.message, name).toContain("write scope");
    }
    expectToolOk(await callTool(baseUrl, readToken, "list_role_cvs"));
    expectToolOk(
      await callTool(baseUrl, readToken, "get_role_cv", { roleCvId }),
    );

    const adamSession = await createUserSession(baseUrl, session, "adam");
    const adamToken = (await createAccessToken(baseUrl, adamSession, "write"))
      .secret;
    const adamJobId = await createJob(baseUrl, adamSession, "adam-own");

    const adamList = expectToolOk(
      await callTool(baseUrl, adamToken, "list_role_cvs"),
    );
    expect(adamList).toMatchObject({ roleCvs: [], total: 0 });

    for (const [name, args] of [
      ["get_role_cv", { roleCvId }],
      ["update_role_cv", { roleCvId, summary: "Mine now" }],
      ["generate_role_cv", { roleCvId }],
      ["generate_role_cv_pdf", { roleCvId }],
      ["delete_role_cv", { roleCvId }],
      ["match_job_role_cv", { jobId }],
      ["set_job_role_cv", { jobId, roleCvId: null }],
      ["apply_role_cv_to_job", { jobId, mode: "as_is" }],
      // Another user's Role CV through one's own job is not found either.
      ["set_job_role_cv", { jobId: adamJobId, roleCvId }],
      ["apply_role_cv_to_job", { jobId: adamJobId, mode: "as_is", roleCvId }],
    ] as const) {
      expectToolError(
        await callTool(baseUrl, adamToken, name, args),
        "NOT_FOUND",
      );
    }

    const intact = expectToolOk(
      await callTool(baseUrl, writeToken, "get_role_cv", { roleCvId }),
    );
    expect(intact.roleCv.summary).toBe("Admin Role summary");
    const adamJob = expectToolOk(
      await callTool(baseUrl, adamToken, "get_job", { jobId: adamJobId }),
    );
    expect(adamJob.job.roleCvId ?? null).toBeNull();
    expect(adamJob.job.tailoredSummary ?? null).toBeNull();
  });
});
