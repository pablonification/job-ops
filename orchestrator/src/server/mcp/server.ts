import { logger } from "@infra/logger";
import {
  type RequestContext,
  runWithRequestContext,
} from "@infra/request-context";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { MCP_SERVER_INSTRUCTIONS } from "./instructions";
import {
  assertToolScope,
  invalidToolInput,
  MCP_ROUTE,
  type McpToolContext,
  type McpToolDefinition,
  toolResult,
  toToolErrorResult,
} from "./kit";
import { toToolInputSchema } from "./kit/json-schema";
import { getRegisteredTools } from "./registry";

export const MCP_SERVER_NAME = "jobops";
export const MCP_SERVER_VERSION = "1.0.0";

const descriptorCache = new WeakMap<
  ReadonlyMap<string, McpToolDefinition>,
  Tool[]
>();

export function toToolDescriptor(tool: McpToolDefinition): Tool {
  const isRead = tool.scope === "read";
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: toToolInputSchema(tool.input),
    annotations: {
      title: tool.title,
      readOnlyHint: isRead,
      // The MCP default for non-read-only tools is destructive, so write
      // tools state it explicitly.
      ...(isRead ? {} : { destructiveHint: tool.destructive === true }),
      ...(tool.idempotent === undefined
        ? {}
        : { idempotentHint: tool.idempotent }),
      openWorldHint: tool.openWorld === true,
    },
    ...(tool.maxResultSizeChars
      ? { _meta: { "anthropic/maxResultSizeChars": tool.maxResultSizeChars } }
      : {}),
  };
}

function listToolDescriptors(
  tools: ReadonlyMap<string, McpToolDefinition>,
): Tool[] {
  let descriptors = descriptorCache.get(tools);
  if (!descriptors) {
    descriptors = [...tools.values()].map(toToolDescriptor);
    descriptorCache.set(tools, descriptors);
  }
  return descriptors;
}

export async function executeTool(
  tool: McpToolDefinition,
  rawArguments: unknown,
  context: McpToolContext,
): Promise<CallToolResult> {
  const startedAt = Date.now();
  let result: CallToolResult;
  try {
    assertToolScope(tool, context.scope);
    const parsed = tool.input.safeParse(rawArguments ?? {});
    if (!parsed.success) throw invalidToolInput(parsed.error);
    result = toolResult(await tool.handler(parsed.data, context));
  } catch (error) {
    result = toToolErrorResult(error, { tool: tool.name });
  }
  logger.info("MCP tool call completed", {
    route: MCP_ROUTE,
    tool: tool.name,
    isError: result.isError === true,
    durationMs: Date.now() - startedAt,
  });
  return result;
}

/**
 * Builds a fresh, stateless MCP server for one HTTP request. Tool handlers run
 * inside `requestContext`, i.e. the caller's tenant and user.
 */
export function createJobOpsMcpServer(input: {
  toolContext: McpToolContext;
  requestContext: Partial<RequestContext>;
  tools?: ReadonlyMap<string, McpToolDefinition>;
}): Server {
  const tools = input.tools ?? getRegisteredTools();
  const server = new Server(
    { name: MCP_SERVER_NAME, title: "JobOps", version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: MCP_SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listToolDescriptors(tools),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.get(request.params.name);
    if (!tool) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown tool: ${request.params.name}`,
      );
    }
    return runWithRequestContext(input.requestContext, () =>
      executeTool(tool, request.params.arguments, input.toolContext),
    );
  });

  return server;
}
