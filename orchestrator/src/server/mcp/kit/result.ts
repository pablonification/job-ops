import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type McpToolErrorPayload = {
  error: { code: string; message: string; details?: unknown };
};

/** Success result: the same JSON as text (for every client) and structured content. */
export function toolResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

/** Tool-level error the agent can read and act on (not a protocol error). */
export function toolErrorResult(
  error: McpToolErrorPayload["error"],
): CallToolResult {
  const payload: McpToolErrorPayload = { error };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
