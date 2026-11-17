import { logger } from "@infra/logger";
import { getRequestContext } from "@infra/request-context";
import { resolveRequestOrigin } from "@infra/request-origin";
import { sanitizeUnknown } from "@infra/sanitize";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isDemoMode } from "@server/config/demo";
import type { Request, RequestHandler, Response } from "express";
import { createJobOpsMcpServer } from "./server";

const JSON_RPC_SERVER_ERROR = -32000;
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "::1", "[::1]"];

function sendJsonRpcError(res: Response, status: number, message: string) {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code: JSON_RPC_SERVER_ERROR, message },
    id: null,
  });
}

function parseHostname(value: string): string | null {
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname
      .toLowerCase()
      .replace(/^\[(.*)\]$/, "$1");
  } catch {
    return null;
  }
}

/**
 * Hostnames `/mcp` answers to, or null when no allowlist is configured.
 * Sources: JOBOPS_MCP_ALLOWED_HOSTS (comma-separated, `*` disables the
 * check), the JOBOPS_PUBLIC_BASE_URL host, and loopback names.
 */
export function resolveAllowedMcpHostnames(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> | null {
  const configured = (env.JOBOPS_MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (configured.includes("*")) return null;
  const publicHostname = env.JOBOPS_PUBLIC_BASE_URL?.trim()
    ? parseHostname(env.JOBOPS_PUBLIC_BASE_URL.trim())
    : null;
  const allowed = [...configured.map(parseHostname), publicHostname].filter(
    (hostname): hostname is string => Boolean(hostname),
  );
  if (allowed.length === 0) return null;
  return new Set([
    ...allowed,
    ...LOOPBACK_HOSTNAMES.map((name) => parseHostname(name) ?? name),
  ]);
}

/**
 * DNS-rebinding and cross-site protection. Host must be on the allowlist when
 * one is configured. A browser Origin, when sent, must be on the allowlist or
 * (without one) match the request's own host. Non-browser clients such as
 * Claude Code send no Origin.
 */
export function validateMcpHostAndOrigin(req: Request): string | null {
  const allowed = resolveAllowedMcpHostnames();
  const requestHostname = parseHostname(
    req.hostname || req.header("host") || "",
  );
  if (allowed && (!requestHostname || !allowed.has(requestHostname))) {
    return "Host not allowed for the MCP endpoint.";
  }

  const origin = req.header("origin");
  if (origin === undefined) return null;
  const originHostname = origin === "null" ? null : parseHostname(origin);
  if (!originHostname) return "Origin not allowed for the MCP endpoint.";
  if (allowed) {
    return allowed.has(originHostname)
      ? null
      : "Origin not allowed for the MCP endpoint.";
  }
  return originHostname === requestHostname
    ? null
    : "Origin not allowed for the MCP endpoint.";
}

/**
 * `ALL /mcp`: authenticated (by the auth guard, for every method), stateless
 * Streamable HTTP with JSON responses. A fresh server and transport per
 * request; tools run in the caller's request context.
 */
export const mcpHandler: RequestHandler = async (req, res) => {
  if (isDemoMode()) {
    sendJsonRpcError(res, 503, "Agent access is disabled in the public demo.");
    return;
  }

  const rejection = validateMcpHostAndOrigin(req);
  if (rejection) {
    logger.warn("MCP request rejected", {
      route: `${req.method} /mcp`,
      reason: rejection,
    });
    sendJsonRpcError(res, 403, rejection);
    return;
  }

  if (req.method !== "POST") {
    // Stateless server: no standalone SSE stream (GET) and no sessions (DELETE).
    res.setHeader("Allow", "POST");
    sendJsonRpcError(res, 405, "Method not allowed.");
    return;
  }

  const requestContext = getRequestContext();
  if (!requestContext?.userId || !requestContext.tenantId) {
    sendJsonRpcError(res, 401, "Authentication required");
    return;
  }

  // Lets long tools (Ghostwriter) stop when the client goes away.
  const disconnect = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) disconnect.abort();
  });

  const server = createJobOpsMcpServer({
    requestContext,
    toolContext: {
      scope: requestContext.accessTokenScope ?? "write",
      requestId: requestContext.requestId ?? null,
      requestOrigin: resolveRequestOrigin(req),
      signal: disconnect.signal,
    },
  });
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logger.error("MCP request failed", {
      route: "POST /mcp",
      error: sanitizeUnknown(error),
    });
    if (!res.headersSent) {
      sendJsonRpcError(res, 500, "Internal server error.");
    }
  } finally {
    await server.close();
  }
};
