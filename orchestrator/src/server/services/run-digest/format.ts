/**
 * Text of the run digest. Pure functions, no I/O.
 *
 * Messages are plain text (no Telegram parse mode), so job titles with `_`,
 * `*`, `[`, `<` or `&` need no escaping. Links sit on their own line, which
 * Telegram turns into tappable links. Long digests drop whole jobs from the
 * end, never part of a line, to stay within Telegram's message limit.
 */
import type { PipelineRunTrigger } from "@shared/types";
import { TELEGRAM_MESSAGE_LIMIT } from "./telegram";

export type DigestJob = {
  id: string;
  title: string;
  employer: string;
  score: number | null;
  isTargetCompany: boolean;
};

export type DigestMessageInput =
  | {
      kind: "completed";
      trigger: PipelineRunTrigger | null;
      counts: { found: number; new: number; scored: number; tailored: number };
      /** The run's new jobs, in any order. */
      jobs: DigestJob[];
      maxJobs: number;
      baseUrl: string | null;
    }
  | {
      kind: "failed";
      trigger: PipelineRunTrigger | null;
      reason: string;
      baseUrl: string | null;
    }
  | {
      kind: "paused";
      trigger: PipelineRunTrigger | null;
      reason: "challenge" | "configuration";
      /** Sources that asked for a bot check. */
      sources?: string[];
      baseUrl: string | null;
    }
  | { kind: "start_failed"; reason: string; baseUrl: string | null };

const MAX_TITLE_CHARS = 120;
const MAX_EMPLOYER_CHARS = 80;
const MAX_REASON_CHARS = 300;
const TARGET_MARKER = "🎯 target company";

/** Collapses whitespace and cuts at a character (not UTF-16 unit) boundary. */
function oneLine(value: string | null | undefined, maxChars: number): string {
  const collapsed = (value ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(collapsed);
  if (chars.length <= maxChars) return collapsed;
  return `${chars
    .slice(0, maxChars - 1)
    .join("")
    .trimEnd()}…`;
}

/**
 * Error text that is safe to send to a phone: one line, short, without URLs
 * (only their host) or anything that looks like a credential.
 */
export function sanitizeDigestReason(value: string | null | undefined): string {
  const scrubbed = (value ?? "")
    .replace(/https?:\/\/[^\s/?#]+[^\s]*/g, (url) => {
      try {
        return new URL(url).host;
      } catch {
        return "[url]";
      }
    })
    .replace(/\d{3,20}:[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .replace(
      /\b(bearer|token|api[_-]?key|key|secret|password)\b(\s*[:=]\s*|\s+)\S+/gi,
      "$1 [redacted]",
    )
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[redacted]");
  return oneLine(scrubbed, MAX_REASON_CHARS) || "Unknown error";
}

function runLabel(trigger: PipelineRunTrigger | null): string {
  return trigger === "schedule" ? "Scheduled run" : "Run";
}

function link(baseUrl: string | null, path: string): string | null {
  return baseUrl ? `${baseUrl}${path}` : null;
}

function joinLines(lines: Array<string | null>): string {
  return lines.filter((line): line is string => line !== null).join("\n");
}

function compareJobs(left: DigestJob, right: DigestJob): number {
  const leftScore = left.score ?? Number.NEGATIVE_INFINITY;
  const rightScore = right.score ?? Number.NEGATIVE_INFINITY;
  if (leftScore !== rightScore) return rightScore - leftScore;
  return left.title.localeCompare(right.title);
}

function formatScore(score: number | null): string {
  return score === null || Number.isNaN(score)
    ? "unscored"
    : String(Math.round(score));
}

function jobBlock(job: DigestJob, rank: number, baseUrl: string | null) {
  const employer = oneLine(job.employer, MAX_EMPLOYER_CHARS) || "Unknown";
  return joinLines([
    `${rank}. ${oneLine(job.title, MAX_TITLE_CHARS) || "Untitled job"}`,
    `${employer} · score ${formatScore(job.score)}${
      job.isTargetCompany ? ` · ${TARGET_MARKER}` : ""
    }`,
    link(baseUrl, `/job/${encodeURIComponent(job.id)}`),
  ]);
}

function buildCompleted(
  input: Extract<DigestMessageInput, { kind: "completed" }>,
  limit: number,
): string | null {
  if (input.jobs.length === 0) return null;
  const { counts } = input;
  const head = joinLines([
    `JobOps: ${runLabel(input.trigger).toLowerCase()} finished`,
    `Found ${counts.found}, ${counts.new} new. Scored ${counts.scored}, tailored ${counts.tailored}.`,
    "",
    "Top new jobs:",
  ]);
  const ranked = [...input.jobs].sort(compareJobs);
  const blocks = ranked
    .slice(0, Math.max(1, input.maxJobs))
    .map((job, index) => jobBlock(job, index + 1, input.baseUrl));

  // Keep as many whole jobs as fit, together with the "more" line.
  for (let shown = blocks.length; shown >= 0; shown -= 1) {
    const remaining = ranked.length - shown;
    const footer =
      remaining > 0
        ? joinLines([
            `+${remaining} more new ${remaining === 1 ? "job" : "jobs"} in JobOps.`,
            link(input.baseUrl, "/jobs/all"),
          ])
        : null;
    const text = joinLines([
      head,
      ...blocks.slice(0, shown).flatMap((block) => ["", block]),
      ...(footer ? ["", footer] : []),
    ]);
    if (text.length <= limit) return text;
  }
  return head.slice(0, limit);
}

/**
 * The message for a digest event, or null when there is nothing to send (a
 * finished run without new jobs).
 */
export function buildDigestMessage(
  input: DigestMessageInput,
  limit = TELEGRAM_MESSAGE_LIMIT,
): string | null {
  switch (input.kind) {
    case "completed":
      return buildCompleted(input, limit);
    case "failed":
      return joinLines([
        `JobOps: ${runLabel(input.trigger).toLowerCase()} failed`,
        `Reason: ${sanitizeDigestReason(input.reason)}`,
        link(input.baseUrl, "/overview"),
      ]);
    case "start_failed":
      return joinLines([
        "JobOps: scheduled run did not start",
        `Reason: ${sanitizeDigestReason(input.reason)}`,
        link(input.baseUrl, "/settings#schedule"),
      ]);
    case "paused": {
      const sources = (input.sources ?? [])
        .map((source) => oneLine(source, 40))
        .filter(Boolean)
        .slice(0, 5);
      const detail =
        input.reason === "challenge"
          ? `A job site asked for a bot check${
              sources.length > 0 ? ` (${sources.join(", ")})` : ""
            }. Open JobOps to solve it or skip that search.`
          : "No AI model is set up, so jobs cannot be scored. Fix it in Settings, then resume the run.";
      return joinLines([
        `JobOps: ${runLabel(input.trigger).toLowerCase()} is paused`,
        detail,
        link(
          input.baseUrl,
          input.reason === "challenge" ? "/jobs/discovered" : "/settings#model",
        ),
      ]);
    }
  }
}
