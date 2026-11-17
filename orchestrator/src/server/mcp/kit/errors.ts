import { AppError, badRequest } from "@infra/errors";
import { logger } from "@infra/logger";
import { sanitizeUnknown } from "@infra/sanitize";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { toolErrorResult } from "./result";
import { MCP_ROUTE } from "./tool";

const INTERNAL_ERROR_MESSAGE = "JobOps could not complete the request.";

/** Longest error message a tool returns; longer text is cut. */
export const MAX_TOOL_MESSAGE_CHARS = 500;

/**
 * Cuts a message to `MAX_TOOL_MESSAGE_CHARS`, so upstream text (a model or
 * renderer error, a web page) cannot flood the agent's context.
 */
export function truncateToolMessage(message: string): string {
  if (message.length <= MAX_TOOL_MESSAGE_CHARS) return message;
  return `${message.slice(0, MAX_TOOL_MESSAGE_CHARS - 1)}…`;
}

/** Readable one-line summary of zod issues, e.g. `limit: Number must be ...`. */
export function formatZodIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return parts.join("; ") || "Invalid tool input.";
}

export function invalidToolInput(error: z.ZodError): AppError {
  return badRequest(formatZodIssues(error), { issues: error.issues });
}

function isZodError(error: unknown): error is z.ZodError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ZodError" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

/**
 * Maps anything a tool throws to a tool error result. App errors keep their
 * code and message (details are sanitised); unknown errors are logged and
 * reported generically so internals never reach the agent.
 */
export function toToolErrorResult(
  error: unknown,
  meta: { tool: string },
): CallToolResult {
  const appError = isZodError(error)
    ? invalidToolInput(error)
    : error instanceof AppError
      ? error
      : null;

  if (!appError || appError.status >= 500) {
    logger.error("MCP tool failed", {
      route: MCP_ROUTE,
      tool: meta.tool,
      error: sanitizeUnknown(error),
    });
  } else {
    logger.info("MCP tool returned an error", {
      route: MCP_ROUTE,
      tool: meta.tool,
      status: appError.status,
      code: appError.code,
    });
  }

  if (!appError) {
    return toolErrorResult({
      code: "INTERNAL_ERROR",
      message: INTERNAL_ERROR_MESSAGE,
    });
  }
  return toolErrorResult({
    code: appError.code,
    message:
      appError.status >= 500 && appError.code === "INTERNAL_ERROR"
        ? INTERNAL_ERROR_MESSAGE
        : truncateToolMessage(appError.message),
    ...(appError.details === undefined
      ? {}
      : { details: sanitizeUnknown(appError.details) }),
  });
}
