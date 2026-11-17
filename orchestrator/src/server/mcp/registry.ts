/**
 * MCP tool registry.
 *
 * CONTRACT FOR ADDING TOOLS (tickets 04, 05, ...):
 * 1. Create one module in `./tools/<group>.ts` that exports a group built with
 *    `defineToolGroup({ id, tools: [defineTool({...}), ...] })` from
 *    `@server/mcp/kit`.
 * 2. Add ONE line to `MCP_TOOL_GROUPS` below. Nothing else in this folder
 *    needs to change.
 * 3. Each tool declares:
 *    - `name` (snake_case, unique), `title`, `description` (key terms first);
 *    - `scope: "read" | "write"`. Read tools get `readOnlyHint` (unless
 *      `readOnly: false`, for read tools that call a model or spend money);
 *      a read-scope token calling a write tool gets a FORBIDDEN tool error;
 *    - `destructive: true` for deletes/irreversible changes, `idempotent`,
 *      `openWorld` (calls job sites/LLMs) when they apply;
 *    - `input`: a zod 3 `z.object({...}).strict()` (reuse route schemas where
 *      possible; spread `paginationShape` for list tools);
 *    - `handler(input, context)`: return a plain JSON object. Throw `AppError`s
 *      (`badRequest`, `notFound`, `conflict`, ...) for failures.
 * 4. Shared helpers live in `@server/mcp/kit`: `toCompactJobSummary` (job
 *    list shape), `paginationShape` + `toPageMeta` / `paginateArray`
 *    (pagination), `toolResult` / `toolErrorResult` / `toToolErrorResult`
 *    (result formatting and error mapping; the server applies them for you),
 *    `assertToolScope` / `hasScope` (scope checks).
 * 5. Handlers already run inside the caller's tenant/user request context:
 *    call the same services and repositories the REST routes use.
 * 6. Never expose database wipe, user/workspace admin, backup deletion,
 *    provider login flows or billing.
 */
import type { McpToolDefinition, McpToolGroup } from "./kit";
import { appReadToolGroup } from "./tools/app-read";
import { applicationsToolGroup } from "./tools/applications";
import { ghostwriterToolGroup } from "./tools/ghostwriter";
import { inboxToolGroup } from "./tools/inbox";
import { jobActionsToolGroup } from "./tools/job-actions";
import { jobNotesToolGroup } from "./tools/job-notes";
import { jobsReadToolGroup } from "./tools/jobs-read";
import { pipelineToolGroup } from "./tools/pipeline";
import { settingsToolGroup } from "./tools/settings";
import { visaSponsorsToolGroup } from "./tools/visa-sponsors";

export const MCP_TOOL_GROUPS: readonly McpToolGroup[] = [
  pipelineToolGroup,
  settingsToolGroup,
  ghostwriterToolGroup,
  visaSponsorsToolGroup,
  inboxToolGroup,
  jobsReadToolGroup,
  appReadToolGroup,
  jobActionsToolGroup,
  jobNotesToolGroup,
  applicationsToolGroup,
];

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function collectTools(
  groups: readonly McpToolGroup[],
): ReadonlyMap<string, McpToolDefinition> {
  const tools = new Map<string, McpToolDefinition>();
  for (const group of groups) {
    for (const tool of group.tools) {
      if (!TOOL_NAME_PATTERN.test(tool.name)) {
        throw new Error(`MCP tool name must be snake_case: ${tool.name}`);
      }
      if (tools.has(tool.name)) {
        throw new Error(
          `Duplicate MCP tool name "${tool.name}" in group "${group.id}"`,
        );
      }
      if (tool.scope === "read" && tool.destructive) {
        throw new Error(`Read tool "${tool.name}" cannot be destructive`);
      }
      tools.set(tool.name, tool);
    }
  }
  return tools;
}

let registeredTools: ReadonlyMap<string, McpToolDefinition> | null = null;

export function getRegisteredTools(): ReadonlyMap<string, McpToolDefinition> {
  registeredTools ??= collectTools(MCP_TOOL_GROUPS);
  return registeredTools;
}
