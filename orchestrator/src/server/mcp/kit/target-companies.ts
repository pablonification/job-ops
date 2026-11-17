/**
 * Target-company flag for tool results. Load the matcher once per tool call
 * and pass it to `toCompactJobSummary` for every job.
 */
export { loadTargetCompanyMatcher } from "@server/services/target-companies";
