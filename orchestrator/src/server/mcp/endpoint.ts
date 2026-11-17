import { resolveRequestOrigin } from "@infra/request-origin";
import type { Request } from "express";

/** Path of the authenticated agent MCP endpoint. */
export const MCP_PATH = "/mcp";

export function isMcpRoute(path: string): boolean {
  // Express matches routes case-insensitively, so `/MCP` must count too.
  const normalizedPath = (path.split("?")[0] || path).toLowerCase();
  return (
    normalizedPath === MCP_PATH || normalizedPath.startsWith(`${MCP_PATH}/`)
  );
}

/**
 * Absolute MCP URL for this instance, preferring JOBOPS_PUBLIC_BASE_URL and
 * falling back to the request's own origin.
 */
export function resolveMcpEndpointUrl(req: Request): string | null {
  const origin = resolveRequestOrigin(req);
  return origin ? `${origin}${MCP_PATH}` : null;
}
