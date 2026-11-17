/**
 * Shared building blocks for MCP tool groups. Tool modules import from here
 * (`@server/mcp/kit`) and never from each other.
 */
export {
  formatZodIssues,
  invalidToolInput,
  MAX_TOOL_MESSAGE_CHARS,
  toSafeErrorPayload,
  toToolErrorResult,
  truncateToolMessage,
} from "./errors";
export {
  assertJobIdle,
  type CompactJobState,
  jobIdInput,
  loadCompactJobState,
  toCompactJobState,
} from "./job-state";
export {
  type CompactJobSummary,
  type CompactJobSummaryOptions,
  type CompactJobSummarySource,
  JOB_STATUS_VALUES,
  toCompactJobSummary,
} from "./job-summary";
export {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  type PageMeta,
  type PaginationInput,
  paginateArray,
  paginationShape,
  toPageMeta,
} from "./pagination";
export {
  definePrompt,
  type McpPromptContext,
  type McpPromptDefinition,
  type McpPromptInputSchema,
  promptChoiceArg,
  promptIntArg,
  promptJobIdArg,
  toPromptArguments,
} from "./prompt";
export { toolErrorResult, toolResult } from "./result";
export { assertToolScope, hasScope } from "./scope";
export { parseJsonArray, splitIdList } from "./stored-lists";
export { loadTargetCompanyMatcher } from "./target-companies";
export {
  defineTool,
  defineToolGroup,
  MCP_ROUTE,
  type McpToolContext,
  type McpToolDefinition,
  type McpToolGroup,
} from "./tool";
