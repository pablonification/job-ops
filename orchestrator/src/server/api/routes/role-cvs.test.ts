import { mkdir, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

const state = vi.hoisted(() => ({
  baseResumeId: "base-resume-1" as string | null,
  pdfDelayMs: 0,
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
      resumeId: state.baseResumeId,
    })),
  };
});

vi.mock("@server/services/summary", () => ({
  generateTailoring: vi.fn(async () => ({
    success: true,
    data: {
      headline: "Backend Engineer",
      summary: "Builds reliable payment APIs.",
      skills: [{ name: "Backend", keywords: ["Go", "PostgreSQL"] }],
    },
  })),
}));

vi.mock("@server/services/projectSelection", () => ({
  pickProjectIdsForJob: vi.fn(async () => []),
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
        if (state.pdfDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, state.pdfDelayMs));
        }
        const outputPath = options?.outputPath;
        if (!outputPath) throw new Error("outputPath is required");
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, "%PDF-1.4\n%EOF\n");
        return { success: true, pdfPath: outputPath };
      },
    ),
  };
});

const AUTH_ENV = {
  BASIC_AUTH_USER: "admin",
  BASIC_AUTH_PASSWORD: "secret",
  JWT_SECRET: "an-explicit-jwt-secret-with-at-least-32-chars",
  JOBOPS_TEST_AUTH_BYPASS: "0",
};

const jsonHeaders = { "Content-Type": "application/json" };

async function api(
  baseUrl: string,
  path: string,
  init?: RequestInit & { token?: string },
) {
  const { token, ...rest } = init ?? {};
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...rest,
    headers: {
      ...jsonHeaders,
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

async function createRoleCv(
  baseUrl: string,
  input: { name: string; roleDescription?: string },
  token?: string,
) {
  const { res, body } = await api(baseUrl, "/role-cvs", {
    method: "POST",
    body: JSON.stringify(input),
    token,
  });
  expect(res.status, JSON.stringify(body)).toBe(201);
  return body.data as { id: string; name: string };
}

describe.sequential("Role CV routes", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    state.baseResumeId = "base-resume-1";
    state.pdfDelayMs = 0;
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  it("creates, lists, updates and deletes Role CVs with the API envelope", async () => {
    const created = await api(baseUrl, "/role-cvs", {
      method: "POST",
      body: JSON.stringify({
        name: " Backend Engineer ",
        roleDescription: "Go and payments",
      }),
    });
    expect(created.res.status).toBe(201);
    expect(created.body.ok).toBe(true);
    expect(created.body.meta.requestId).toEqual(expect.any(String));
    expect(created.body.data).toMatchObject({
      name: "Backend Engineer",
      roleDescription: "Go and payments",
      tailoredHeadline: null,
      generatedAt: null,
      isStale: false,
      pdfFreshness: "missing",
    });
    const id = created.body.data.id as string;

    const list = await api(baseUrl, "/role-cvs");
    expect(list.res.status).toBe(200);
    expect(list.body.data.roleCvs.map((cv: { id: string }) => cv.id)).toEqual([
      id,
    ]);

    const updated = await api(baseUrl, `/role-cvs/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        tailoredHeadline: "Senior Backend Engineer",
        tailoredSkills: JSON.stringify([{ name: "Go", keywords: ["gRPC"] }]),
        selectedProjectIds: "p1,p2",
      }),
    });
    expect(updated.res.status).toBe(200);
    expect(updated.body.data).toMatchObject({
      tailoredHeadline: "Senior Backend Engineer",
      tailoredSkills: JSON.stringify([{ name: "Go", keywords: ["gRPC"] }]),
      selectedProjectIds: "p1,p2",
    });

    const invalidSkills = await api(baseUrl, `/role-cvs/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ tailoredSkills: "not json" }),
    });
    expect(invalidSkills.res.status).toBe(400);
    expect(invalidSkills.body.error.code).toBe("INVALID_REQUEST");

    const deleted = await api(baseUrl, `/role-cvs/${id}`, {
      method: "DELETE",
    });
    expect(deleted.res.status).toBe(200);
    expect(deleted.body.data).toEqual({ id, deleted: true });

    const missing = await api(baseUrl, `/role-cvs/${id}`);
    expect(missing.res.status).toBe(404);
    expect(missing.body.ok).toBe(false);
    expect(missing.body.error.code).toBe("NOT_FOUND");
    expect(missing.body.meta.requestId).toEqual(expect.any(String));
  });

  it("rejects invalid input and duplicate names", async () => {
    const empty = await api(baseUrl, "/role-cvs", {
      method: "POST",
      body: JSON.stringify({ name: "   " }),
    });
    expect(empty.res.status).toBe(400);
    expect(empty.body.error.code).toBe("INVALID_REQUEST");

    await createRoleCv(baseUrl, { name: "Data Analyst" });
    const duplicate = await api(baseUrl, "/role-cvs", {
      method: "POST",
      body: JSON.stringify({ name: "data analyst" }),
    });
    expect(duplicate.res.status).toBe(409);
    expect(duplicate.body.error.code).toBe("CONFLICT");

    const other = await createRoleCv(baseUrl, { name: "Product Analyst" });
    const rename = await api(baseUrl, `/role-cvs/${other.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Data Analyst" }),
    });
    expect(rename.res.status).toBe(409);
  });

  it("generates content and reports staleness when the master resume changes", async () => {
    const { generateTailoring } = await import("@server/services/summary");
    const roleCv = await createRoleCv(baseUrl, {
      name: "Backend Engineer",
      roleDescription: "Go and payments",
    });

    const generated = await api(baseUrl, `/role-cvs/${roleCv.id}/generate`, {
      method: "POST",
    });
    expect(generated.res.status).toBe(200);
    expect(generated.body.data).toMatchObject({
      tailoredHeadline: "Backend Engineer",
      tailoredSummary: "Builds reliable payment APIs.",
      tailoredSkills: JSON.stringify([
        { name: "Backend", keywords: ["Go", "PostgreSQL"] },
      ]),
      selectedProjectIds: "",
      masterResumeRevision: "rxresume:base-resume-1",
      isStale: false,
    });
    expect(vi.mocked(generateTailoring)).toHaveBeenCalledWith(
      "Go and payments",
      expect.anything(),
      { target: { kind: "role", roleName: "Backend Engineer" } },
    );

    state.baseResumeId = "base-resume-2";
    const stale = await api(baseUrl, `/role-cvs/${roleCv.id}`);
    expect(stale.body.data.isStale).toBe(true);

    const regenerated = await api(baseUrl, `/role-cvs/${roleCv.id}/generate`, {
      method: "POST",
    });
    expect(regenerated.body.data.isStale).toBe(false);
  });

  it("refuses to generate without a master resume", async () => {
    state.baseResumeId = null;
    const roleCv = await createRoleCv(baseUrl, {
      name: "Backend Engineer",
      roleDescription: "Go",
    });
    const result = await api(baseUrl, `/role-cvs/${roleCv.id}/generate`, {
      method: "POST",
    });
    expect(result.res.status).toBe(400);
    expect(result.body.error.code).toBe("INVALID_REQUEST");
  });

  it("generates and serves a PDF and rejects concurrent regeneration", async () => {
    const { generatePdf } = await import("@server/services/pdf");
    const roleCv = await createRoleCv(baseUrl, {
      name: "Backend Engineer",
      roleDescription: "Go",
    });

    const noPdf = await api(baseUrl, `/role-cvs/${roleCv.id}/pdf`);
    expect(noPdf.res.status).toBe(404);

    const pdf = await api(baseUrl, `/role-cvs/${roleCv.id}/generate-pdf`, {
      method: "POST",
    });
    expect(pdf.res.status).toBe(200);
    expect(pdf.body.data.pdfFreshness).toBe("current");
    expect(pdf.body.data.pdfGeneratedAt).toEqual(expect.any(String));
    const outputPath = vi.mocked(generatePdf).mock.calls[0]?.[5]?.outputPath;
    expect(outputPath).toContain(`role_cv_${roleCv.id}.pdf`);
    expect(outputPath).toContain(tempDir);

    const download = await fetch(`${baseUrl}/api/role-cvs/${roleCv.id}/pdf`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("application/pdf");
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(await download.text()).toContain("%PDF");

    await api(baseUrl, `/role-cvs/${roleCv.id}`, {
      method: "PATCH",
      body: JSON.stringify({ tailoredSummary: "Edited summary" }),
    });
    const afterEdit = await api(baseUrl, `/role-cvs/${roleCv.id}`);
    expect(afterEdit.body.data.pdfFreshness).toBe("stale");

    state.pdfDelayMs = 300;
    const [first, second] = await Promise.all([
      api(baseUrl, `/role-cvs/${roleCv.id}/generate-pdf`, { method: "POST" }),
      new Promise((resolve) => setTimeout(resolve, 50)).then(() =>
        api(baseUrl, `/role-cvs/${roleCv.id}/generate-pdf`, {
          method: "POST",
        }),
      ),
    ]);
    expect([first.res.status, second.res.status].sort()).toEqual([200, 409]);
    expect([first.body, second.body].find((body) => !body.ok)?.error.code).toBe(
      "CONFLICT",
    );

    state.pdfDelayMs = 0;
    const again = await api(baseUrl, `/role-cvs/${roleCv.id}/generate-pdf`, {
      method: "POST",
    });
    expect(again.res.status).toBe(200);
  });
});

describe.sequential("Role CV tenant isolation", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    state.baseResumeId = "base-resume-1";
    state.pdfDelayMs = 0;
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

  it("keeps Role CVs and their PDFs private to each workspace", async () => {
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

    const adminCv = await createRoleCv(
      baseUrl,
      { name: "Backend Engineer", roleDescription: "Go" },
      adminToken,
    );
    const pdf = await api(baseUrl, `/role-cvs/${adminCv.id}/generate-pdf`, {
      method: "POST",
      token: adminToken,
    });
    expect(pdf.res.status).toBe(200);

    // Names are unique per workspace, not globally.
    const adamCv = await createRoleCv(
      baseUrl,
      { name: "Backend Engineer", roleDescription: "Rust" },
      adamToken,
    );

    const adamList = await api(baseUrl, "/role-cvs", { token: adamToken });
    expect(
      adamList.body.data.roleCvs.map((cv: { id: string }) => cv.id),
    ).toEqual([adamCv.id]);

    const crossRequests = [
      api(baseUrl, `/role-cvs/${adminCv.id}`, { token: adamToken }),
      api(baseUrl, `/role-cvs/${adminCv.id}`, {
        method: "PATCH",
        token: adamToken,
        body: JSON.stringify({ tailoredSummary: "hijacked" }),
      }),
      api(baseUrl, `/role-cvs/${adminCv.id}/generate`, {
        method: "POST",
        token: adamToken,
      }),
      api(baseUrl, `/role-cvs/${adminCv.id}/generate-pdf`, {
        method: "POST",
        token: adamToken,
      }),
      api(baseUrl, `/role-cvs/${adminCv.id}/pdf`, { token: adamToken }),
      api(baseUrl, `/role-cvs/${adminCv.id}`, {
        method: "DELETE",
        token: adamToken,
      }),
    ];
    for (const { res, body } of await Promise.all(crossRequests)) {
      expect(res.status).toBe(404);
      expect(body.error.code).toBe("NOT_FOUND");
    }

    const adminView = await api(baseUrl, `/role-cvs/${adminCv.id}`, {
      token: adminToken,
    });
    expect(adminView.res.status).toBe(200);
    expect(adminView.body.data.tailoredSummary).toBeNull();
    expect(adminView.body.data.pdfFreshness).toBe("current");

    const adminPdf = await fetch(`${baseUrl}/api/role-cvs/${adminCv.id}/pdf`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(adminPdf.status).toBe(200);
  });
});
