/**
 * Helpers for MCP tests that drive the real server over HTTP (see
 * `api/routes/test-utils.ts` for the server harness).
 */
import { expect } from "vitest";

export const MCP_AUTH_ENV = {
  BASIC_AUTH_USER: "admin",
  BASIC_AUTH_PASSWORD: "secret",
  JWT_SECRET: "an-explicit-jwt-secret-with-at-least-32-chars",
  JOBOPS_TEST_AUTH_BYPASS: "0",
};

export type ToolCallResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  // biome-ignore lint/suspicious/noExplicitAny: tool payloads vary per tool
  structuredContent: Record<string, any>;
};

export type ListedTool = {
  name: string;
  inputSchema: { type: string; properties?: Record<string, unknown> };
  annotations: Record<string, unknown>;
};

export function jsonHeaders(token?: string): Record<string, string> {
  return {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function rpc(
  baseUrl: string,
  token: string | undefined,
  method: string,
  params?: Record<string, unknown>,
) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export async function listTools(
  baseUrl: string,
  token: string,
): Promise<ListedTool[]> {
  const { status, body } = await rpc(baseUrl, token, "tools/list");
  expect(status).toBe(200);
  return body.result.tools as ListedTool[];
}

export async function callTool(
  baseUrl: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolCallResult> {
  const { status, body } = await rpc(baseUrl, token, "tools/call", {
    name,
    arguments: args,
  });
  expect(status).toBe(200);
  expect(body.error).toBeUndefined();
  const result = body.result as ToolCallResult;
  // Every result carries the same JSON as text and as structured content.
  expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual(
    result.structuredContent,
  );
  return result;
}

/** Asserts a tool error and returns its `{ code, message, details }`. */
export function expectToolError(result: ToolCallResult, code: string) {
  expect(result.isError, JSON.stringify(result.structuredContent)).toBe(true);
  expect(result.structuredContent.error.code).toBe(code);
  return result.structuredContent.error as {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** Asserts success and returns the structured content. */
export function expectToolOk(result: ToolCallResult) {
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(
    true,
  );
  return result.structuredContent;
}

export async function login(
  baseUrl: string,
  username: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).data.token as string;
}

export async function createAccessToken(
  baseUrl: string,
  session: string,
  scope: "read" | "write",
): Promise<{ id: string; secret: string }> {
  const res = await fetch(`${baseUrl}/api/auth/tokens`, {
    method: "POST",
    headers: jsonHeaders(session),
    body: JSON.stringify({ name: `${scope} agent`, scope }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  return { id: body.data.token.id, secret: body.data.secret };
}

/** Creates a non-admin user through the admin API and signs them in. */
export async function createUserSession(
  baseUrl: string,
  adminSession: string,
  username: string,
): Promise<string> {
  const password = `${username}-secret`;
  const res = await fetch(`${baseUrl}/api/workspaces/users`, {
    method: "POST",
    headers: jsonHeaders(adminSession),
    body: JSON.stringify({ username, displayName: username, password }),
  });
  expect(res.status).toBe(201);
  return login(baseUrl, username, password);
}

/**
 * Runs `fn` inside a user's tenant/user request context, for seeding data
 * with repositories exactly where that user's requests will look.
 */
export async function runAsUser<T>(
  username: string,
  fn: () => Promise<T>,
): Promise<T> {
  const { db, schema } = await import("@server/db");
  const { eq } = await import("drizzle-orm");
  const { runWithRequestContext } = await import("@infra/request-context");
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username));
  if (!user) throw new Error(`No user ${username}`);
  const [membership] = await db
    .select()
    .from(schema.tenantMemberships)
    .where(eq(schema.tenantMemberships.userId, user.id));
  return runWithRequestContext(
    {
      requestId: `seed-${username}`,
      tenantId: membership?.tenantId ?? "tenant_default",
      userId: user.id,
      username,
    },
    fn,
  );
}
