import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

const state = vi.hoisted(() => ({
  matchedRoleCvId: null as string | null,
}));

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
  generateTailoring: vi.fn(),
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

const AUTH_ENV = {
  BASIC_AUTH_USER: "admin",
  BASIC_AUTH_PASSWORD: "secret",
  JWT_SECRET: "an-explicit-jwt-secret-with-at-least-32-chars",
  JOBOPS_TEST_AUTH_BYPASS: "0",
};

const ROLE_CV_CONTENT = {
  tailoredHeadline: "Backend Engineer",
  tailoredSummary: "Builds reliable payment APIs.",
  tailoredSkills: JSON.stringify([
    { name: "Backend", keywords: ["Go", "PostgreSQL"] },
  ]),
  selectedProjectIds: "payments,search",
};

async function api(
  baseUrl: string,
  path: string,
  init?: RequestInit & { token?: string },
) {
  const { token, ...rest } = init ?? {};
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await res.json()
    : null;
  return { res, body };
}

async function createRoleCvWithContent(
  baseUrl: string,
  name: string,
  token?: string,
): Promise<string> {
  const created = await api(baseUrl, "/role-cvs", {
    method: "POST",
    body: JSON.stringify({ name, roleDescription: "Go and payments" }),
    token,
  });
  expect(created.res.status).toBe(201);
  const id = created.body.data.id as string;
  const patched = await api(baseUrl, `/role-cvs/${id}`, {
    method: "PATCH",
    body: JSON.stringify(ROLE_CV_CONTENT),
    token,
  });
  expect(patched.res.status).toBe(200);
  return id;
}

async function createTestJob(overrides: Record<string, unknown> = {}) {
  const { createJob, updateJob } = await import("@server/repositories/jobs");
  const job = await createJob({
    source: "manual",
    title: "Senior Backend Engineer",
    employer: "Example Co",
    jobUrl: `https://example.com/jobs/${Math.random().toString(36).slice(2)}`,
    jobDescription: "Build payment APIs in Go.",
  });
  if (Object.keys(overrides).length === 0) return job;
  const updated = await updateJob(job.id, overrides);
  if (!updated) throw new Error("job vanished");
  return updated;
}

describe.sequential("Job Role CV routes", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    state.matchedRoleCvId = null;
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  it("exposes the Role CV reference on job payloads and auto-matches it", async () => {
    const roleCvId = await createRoleCvWithContent(baseUrl, "Backend Engineer");
    const job = await createTestJob();

    const before = await api(baseUrl, `/jobs/${job.id}`);
    expect(before.body.data).toMatchObject({
      roleCvId: null,
      roleCvMatchSource: null,
    });

    state.matchedRoleCvId = roleCvId;
    const matched = await api(baseUrl, `/jobs/${job.id}/role-cv/match`, {
      method: "POST",
    });
    expect(matched.res.status).toBe(200);
    expect(matched.body.ok).toBe(true);
    expect(matched.body.meta.requestId).toEqual(expect.any(String));
    expect(matched.body.data).toMatchObject({
      roleCvId,
      roleCvMatchSource: "auto",
    });

    state.matchedRoleCvId = null;
    const none = await api(baseUrl, `/jobs/${job.id}/role-cv/match`, {
      method: "POST",
    });
    expect(none.body.data).toMatchObject({
      roleCvId: null,
      roleCvMatchSource: "auto",
    });
  });

  it("sets the Role CV by hand and validates the choice", async () => {
    const roleCvId = await createRoleCvWithContent(baseUrl, "Backend Engineer");
    const job = await createTestJob();

    const set = await api(baseUrl, `/jobs/${job.id}/role-cv`, {
      method: "PUT",
      body: JSON.stringify({ roleCvId }),
    });
    expect(set.res.status).toBe(200);
    expect(set.body.data).toMatchObject({
      roleCvId,
      roleCvMatchSource: "manual",
    });

    const cleared = await api(baseUrl, `/jobs/${job.id}/role-cv`, {
      method: "PUT",
      body: JSON.stringify({ roleCvId: null }),
    });
    expect(cleared.body.data).toMatchObject({
      roleCvId: null,
      roleCvMatchSource: "manual",
    });

    const unknown = await api(baseUrl, `/jobs/${job.id}/role-cv`, {
      method: "PUT",
      body: JSON.stringify({ roleCvId: "missing" }),
    });
    expect(unknown.res.status).toBe(404);
    expect(unknown.body.error.code).toBe("NOT_FOUND");

    const invalid = await api(baseUrl, `/jobs/${job.id}/role-cv`, {
      method: "PUT",
      body: JSON.stringify({}),
    });
    expect(invalid.res.status).toBe(400);
    expect(invalid.body.error.code).toBe("INVALID_REQUEST");

    const missingJob = await api(baseUrl, "/jobs/missing/role-cv", {
      method: "PUT",
      body: JSON.stringify({ roleCvId }),
    });
    expect(missingJob.res.status).toBe(404);
  });

  it("applies a Role CV as-is without a model call", async () => {
    const { generateTailoring } = await import("@server/services/summary");
    const { summarizeJob } = await import("@server/pipeline/index");
    const roleCvId = await createRoleCvWithContent(baseUrl, "Backend Engineer");
    const job = await createTestJob({ tailoredSummary: "Old summary." });

    const noChoice = await api(baseUrl, `/jobs/${job.id}/role-cv/apply`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(noChoice.res.status).toBe(400);

    const applied = await api(baseUrl, `/jobs/${job.id}/role-cv/apply`, {
      method: "POST",
      body: JSON.stringify({ roleCvId }),
    });
    expect(applied.res.status).toBe(200);
    expect(applied.body.data).toMatchObject({
      roleCvId,
      roleCvMatchSource: "manual",
      ...ROLE_CV_CONTENT,
    });
    expect(generateTailoring).not.toHaveBeenCalled();
    expect(summarizeJob).not.toHaveBeenCalled();

    // Editing the Role CV afterwards never rewrites the job.
    await api(baseUrl, `/role-cvs/${roleCvId}`, {
      method: "PATCH",
      body: JSON.stringify({ tailoredSummary: "Edited Role CV summary." }),
    });
    const after = await api(baseUrl, `/jobs/${job.id}`);
    expect(after.body.data.tailoredSummary).toBe(
      ROLE_CV_CONTENT.tailoredSummary,
    );
  });

  it("refuses to apply or refine an empty Role CV", async () => {
    const created = await api(baseUrl, "/role-cvs", {
      method: "POST",
      body: JSON.stringify({ name: "Empty" }),
    });
    const job = await createTestJob();

    for (const action of ["apply", "refine"]) {
      const result = await api(baseUrl, `/jobs/${job.id}/role-cv/${action}`, {
        method: "POST",
        body: JSON.stringify({ roleCvId: created.body.data.id }),
      });
      expect(result.res.status).toBe(400);
      expect(result.body.error.message).toMatch(/Generate it first/);
    }
  });

  it("marks a generated PDF stale and queues regeneration, like a manual edit", async () => {
    const { createJobPdfFingerprint, resolvePdfFingerprintContext } =
      await import("@server/services/pdf-fingerprint");
    const { generateFinalPdf } = await import("@server/pipeline/index");
    const { updateJob } = await import("@server/repositories/jobs");
    const roleCvId = await createRoleCvWithContent(baseUrl, "Backend Engineer");
    const job = await createTestJob({
      status: "ready",
      tailoredSummary: "Old summary.",
      tailoredHeadline: "Old headline",
      pdfPath: "/tmp/resume.pdf",
      pdfSource: "generated",
    });
    await updateJob(job.id, {
      pdfFingerprint: createJobPdfFingerprint(
        job,
        await resolvePdfFingerprintContext(),
      ),
    });
    const before = await api(baseUrl, `/jobs/${job.id}`);
    expect(before.body.data.pdfFreshness).toBe("current");

    const applied = await api(baseUrl, `/jobs/${job.id}/role-cv/apply`, {
      method: "POST",
      body: JSON.stringify({ roleCvId }),
    });
    expect(applied.res.status).toBe(200);
    expect(applied.body.data.pdfFreshness).toBe("stale");

    await vi.waitFor(() => {
      expect(generateFinalPdf).toHaveBeenCalledWith(
        job.id,
        expect.objectContaining({ analyticsOrigin: "auto_pdf_regeneration" }),
      );
    });
  });

  it("refines the job with the Role CV as the tailoring baseline", async () => {
    const { summarizeJob } = await import("@server/pipeline/index");
    const roleCvId = await createRoleCvWithContent(baseUrl, "Backend Engineer");
    const job = await createTestJob();
    await api(baseUrl, `/jobs/${job.id}/role-cv`, {
      method: "PUT",
      body: JSON.stringify({ roleCvId }),
    });

    const refined = await api(baseUrl, `/jobs/${job.id}/role-cv/refine`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(refined.res.status).toBe(200);
    expect(summarizeJob).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        force: true,
        tailoringBaseline: {
          headline: "Backend Engineer",
          summary: "Builds reliable payment APIs.",
          skills: [{ name: "Backend", keywords: ["Go", "PostgreSQL"] }],
        },
      }),
    );

    vi.mocked(summarizeJob).mockResolvedValueOnce({
      success: false,
      error: "Tailoring failed: provider down",
    });
    const failed = await api(baseUrl, `/jobs/${job.id}/role-cv/refine`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(failed.res.status).toBe(400);
    expect(failed.body.error.message).toContain("provider down");
  });

  it("clears job references on Role CV delete and keeps tailored fields", async () => {
    const roleCvId = await createRoleCvWithContent(baseUrl, "Backend Engineer");
    const job = await createTestJob();
    const other = await createTestJob();
    await api(baseUrl, `/jobs/${job.id}/role-cv/apply`, {
      method: "POST",
      body: JSON.stringify({ roleCvId }),
    });
    const keptCvId = await createRoleCvWithContent(baseUrl, "Data Analyst");
    await api(baseUrl, `/jobs/${other.id}/role-cv`, {
      method: "PUT",
      body: JSON.stringify({ roleCvId: keptCvId }),
    });

    const deleted = await api(baseUrl, `/role-cvs/${roleCvId}`, {
      method: "DELETE",
    });
    expect(deleted.res.status).toBe(200);

    const after = await api(baseUrl, `/jobs/${job.id}`);
    expect(after.body.data).toMatchObject({
      roleCvId: null,
      roleCvMatchSource: null,
      ...ROLE_CV_CONTENT,
    });
    const untouched = await api(baseUrl, `/jobs/${other.id}`);
    expect(untouched.body.data.roleCvId).toBe(keptCvId);
  });
});

describe.sequential("Job Role CV tenant isolation", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: AUTH_ENV,
    }));
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  async function login(username: string, password: string) {
    const { res, body } = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    expect(res.status).toBe(200);
    return body.data.token as string;
  }

  it("never lets one workspace use another workspace's Role CV", async () => {
    const adminToken = await login("admin", "secret");
    const createAdam = await api(baseUrl, "/workspaces/users", {
      method: "POST",
      token: adminToken,
      body: JSON.stringify({
        username: "adam",
        displayName: "Adam",
        password: "adam-secret",
      }),
    });
    expect(createAdam.res.status).toBe(201);
    const adamToken = await login("adam", "adam-secret");

    const adminCvId = await createRoleCvWithContent(
      baseUrl,
      "Backend Engineer",
      adminToken,
    );
    const imported = await api(baseUrl, "/manual-jobs/import", {
      method: "POST",
      token: adamToken,
      body: JSON.stringify({
        job: {
          title: "Backend Engineer",
          employer: "Example Co",
          jobUrl: "https://example.com/jobs/adam-1",
          jobDescription: "Build payment APIs in Go.",
        },
        skipTailoring: true,
      }),
    });
    expect(imported.res.status, JSON.stringify(imported.body)).toBe(200);
    const adamJobId = imported.body.data.id as string;

    for (const [method, path, body] of [
      ["PUT", "", { roleCvId: adminCvId }],
      ["POST", "/apply", { roleCvId: adminCvId }],
      ["POST", "/refine", { roleCvId: adminCvId }],
    ] as const) {
      const result = await api(baseUrl, `/jobs/${adamJobId}/role-cv${path}`, {
        method,
        token: adamToken,
        body: JSON.stringify(body),
      });
      expect(result.res.status).toBe(404);
      expect(result.body.error.code).toBe("NOT_FOUND");
    }

    // Admin cannot touch Adam's job either.
    const crossJob = await api(baseUrl, `/jobs/${adamJobId}/role-cv/match`, {
      method: "POST",
      token: adminToken,
    });
    expect(crossJob.res.status).toBe(404);
  });
});
