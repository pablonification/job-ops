import { conflict } from "@infra/errors";
import { getUserId } from "@infra/request-context";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AccessTokenScope } from "@shared/types";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineTool,
  defineToolGroup,
  paginateArray,
  paginationShape,
} from "./kit";
import { collectTools } from "./registry";
import { createJobOpsMcpServer } from "./server";

const echoUser = defineTool({
  name: "echo_user",
  title: "Echo user",
  description: "Returns the user id the tool runs as.",
  scope: "read",
  input: z.object({ ...paginationShape }).strict(),
  handler: async (input) => ({
    userId: getUserId() ?? null,
    ...paginateArray(["a", "b", "c"], input),
  }),
});

const deleteThing = defineTool({
  name: "delete_thing",
  title: "Delete thing",
  description: "Deletes a thing.",
  scope: "write",
  destructive: true,
  input: z.object({ id: z.string().min(1) }).strict(),
  handler: async ({ id }) => {
    if (id === "busy") throw conflict("Thing is busy");
    if (id === "boom") throw new Error("database file /secret/path is locked");
    return { deleted: id };
  },
});

const testTools = collectTools([
  defineToolGroup({ id: "test", tools: [echoUser, deleteThing] }),
]);

let client: Client | null = null;

async function connect(scope: AccessTokenScope) {
  const server = createJobOpsMcpServer({
    tools: testTools,
    requestContext: { requestId: "req-1", userId: "user-a", tenantId: "t-a" },
    toolContext: { scope, requestId: "req-1", requestOrigin: null },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

afterEach(async () => {
  await client?.close();
  client = null;
});

describe("MCP tool registry", () => {
  it("rejects duplicate and non-snake_case tool names", () => {
    expect(() =>
      collectTools([
        defineToolGroup({ id: "a", tools: [echoUser] }),
        defineToolGroup({ id: "b", tools: [echoUser] }),
      ]),
    ).toThrow(/Duplicate MCP tool name "echo_user"/);
    expect(() =>
      collectTools([
        defineToolGroup({
          id: "a",
          tools: [{ ...echoUser, name: "EchoUser" }],
        }),
      ]),
    ).toThrow(/snake_case/);
  });

  it("derives annotations from scope and destructive flags", async () => {
    const mcp = await connect("write");
    const { tools } = await mcp.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(byName.echo_user?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(byName.delete_thing?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(byName.delete_thing?.inputSchema).toMatchObject({
      type: "object",
      required: ["id"],
      additionalProperties: false,
    });
  });

  it("runs handlers in the caller's request context", async () => {
    const mcp = await connect("read");
    const result = await mcp.callTool({
      name: "echo_user",
      arguments: { limit: 2 },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      userId: "user-a",
      items: ["a", "b"],
      page: { total: 3, hasMore: true, nextOffset: 2 },
    });
  });

  it("refuses write tools for read-scope callers with a clear tool error", async () => {
    const mcp = await connect("read");
    const result = await mcp.callTool({
      name: "delete_thing",
      arguments: { id: "x" },
    });
    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as { error: { code: string; message: string } }
    ).error;
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toContain("write scope");
  });

  it("maps app errors and hides unexpected ones", async () => {
    const mcp = await connect("write");
    expect(
      (await mcp.callTool({ name: "delete_thing", arguments: { id: "ok" } }))
        .structuredContent,
    ).toEqual({ deleted: "ok" });

    const busy = await mcp.callTool({
      name: "delete_thing",
      arguments: { id: "busy" },
    });
    expect(busy.isError).toBe(true);
    expect(busy.structuredContent).toEqual({
      error: { code: "CONFLICT", message: "Thing is busy" },
    });

    const boom = await mcp.callTool({
      name: "delete_thing",
      arguments: { id: "boom" },
    });
    expect(boom.isError).toBe(true);
    expect(boom.structuredContent).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "JobOps could not complete the request.",
      },
    });
    expect(JSON.stringify(boom)).not.toContain("/secret/path");

    const invalid = await mcp.callTool({
      name: "delete_thing",
      arguments: { id: "x", extra: true },
    });
    expect(invalid.isError).toBe(true);
    expect(
      (invalid.structuredContent as { error: { code: string } }).error.code,
    ).toBe("INVALID_REQUEST");
  });
});
