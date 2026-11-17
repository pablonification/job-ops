/**
 * Shared building blocks for MCP tool groups. Tool modules import from here
 * (`@server/mcp/kit`) and never from each other.
 */
export { invalidToolInput, toToolErrorResult } from "./errors";
export {
  assertJobIdle,
  type CompactJobState,
  jobIdInput,
  loadCompactJobState,
  toCompactJobState,
} from "./job-state";
export {
  type CompactJobSummary,
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
export { toolErrorResult, toolResult } from "./result";
export { assertToolScope, hasScope } from "./scope";
export {
  defineTool,
  defineToolGroup,
  type McpToolContext,
  type McpToolDefinition,
  type McpToolGroup,
} from "./tool";
