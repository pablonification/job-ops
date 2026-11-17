/**
 * Helpers shared by the Indonesian job-board extractors (Tech in Asia, Kalibrr,
 * Dealls, and the ones that follow): defensive JSON readers, a polite JSON
 * client, Indonesian place names and location evidence, salary fields, a
 * title relevance check, and a per-term runner with caps, city filtering,
 * cancellation and a time budget. Board-specific mapping stays in each
 * extractor.
 */
export * from "./client";
export * from "./parse";
export * from "./places";
export * from "./relevance";
export * from "./runner";
export * from "./salary";
