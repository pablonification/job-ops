import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { McpToolInputSchema } from "./tool";

type ZodToJsonSchemaInput = Parameters<typeof zodToJsonSchema>[0];

/**
 * Converts a zod 3 tool input schema to the JSON Schema `tools/list` needs.
 *
 * Why not `McpServer.registerTool`: the orchestrator's schemas are zod 3
 * (`orchestrator/node_modules/zod`) while the hoisted `zod` the SDK sees is
 * zod 4. Validating with our own `safeParse` and converting with
 * `zod-to-json-schema` (which reads zod 3 `_def` trees) keeps a single zod
 * instance in the validation path.
 */
export function toToolInputSchema(
  schema: McpToolInputSchema,
): Tool["inputSchema"] {
  // zod-to-json-schema is typed against the hoisted zod's `zod/v3` types.
  // Comparing those structurally with our zod 3 types is very expensive for
  // tsc, so hand it the schema as its own parameter type. At runtime it only
  // reads `_def` trees, which zod 3.25 produces.
  const converted = zodToJsonSchema(schema as unknown as ZodToJsonSchemaInput, {
    $refStrategy: "none",
    target: "jsonSchema7",
    // Defaults are applied by safeParse, so inputs with defaults are optional.
    effectStrategy: "input",
  }) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = converted;
  return { ...rest, type: "object" } as Tool["inputSchema"];
}
