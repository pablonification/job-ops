import type { AccessTokenScope } from "@shared/types";
import type { z } from "zod";

/** Route label for logs written by MCP tools and the services they call. */
export const MCP_ROUTE = "POST /mcp";

/**
 * What every tool handler receives besides its parsed input. Tenant and user
 * scoping is NOT passed here on purpose: handlers run inside the caller's
 * request context, so repositories and services scope themselves exactly as
 * they do for REST routes.
 */
export type McpToolContext = {
  /** Effective scope of the caller (a signed-in session counts as `write`). */
  scope: AccessTokenScope;
  requestId: string | null;
  /** Public origin of this instance (JOBOPS_PUBLIC_BASE_URL or request host). */
  requestOrigin: string | null;
  /** Aborted when the client disconnects before the result is sent. */
  signal?: AbortSignal;
};

/**
 * Tool input schemas are zod 3 objects (the orchestrator's own `zod`), so
 * existing route schemas can be reused. The server validates with
 * `safeParse` and lists them via `zod-to-json-schema`.
 */
export type McpToolInputSchema = z.AnyZodObject;

export type McpToolDefinition<
  Schema extends McpToolInputSchema = McpToolInputSchema,
> = {
  /** snake_case, unique across all groups. */
  name: string;
  title: string;
  /** Put the key terms first: clients truncate long descriptions. */
  description: string;
  /** `read` tools are callable by every token; `write` tools need write scope. */
  scope: AccessTokenScope;
  /**
   * Read tools only: `false` drops the read-only annotation for tools that
   * change no data but spend money or call a model (e.g. search planning).
   */
  readOnly?: false;
  /** Write tools only: marks deletes and other irreversible changes. */
  destructive?: boolean;
  /** Write tools only: repeating the call with the same input has no extra effect. */
  idempotent?: boolean;
  /** The tool reaches the outside world (job sites, LLMs, webhooks). */
  openWorld?: boolean;
  /** Raise Claude Code's per-result size limit for tools with large output. */
  maxResultSizeChars?: number;
  input: Schema;
  /**
   * Return a plain JSON object; it becomes both the text and the structured
   * content of the result. Throw an `AppError` (badRequest, notFound,
   * conflict, ...) for failures; it becomes a tool error with that code.
   */
  handler: (
    input: z.infer<Schema>,
    context: McpToolContext,
  ) => Promise<Record<string, unknown>>;
};

export type McpToolGroup = {
  /** Short id used in logs, e.g. `jobs-read`. */
  id: string;
  tools: readonly McpToolDefinition[];
};

/** Identity helper that keeps the handler's input type tied to its schema. */
export function defineTool<Schema extends McpToolInputSchema>(
  definition: McpToolDefinition<Schema>,
): McpToolDefinition {
  return definition as unknown as McpToolDefinition;
}

export function defineToolGroup(group: McpToolGroup): McpToolGroup {
  return group;
}
