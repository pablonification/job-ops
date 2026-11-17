/**
 * Values and validators for scheduled pipeline runs and the run digest.
 * Shared by the settings registry, the server scheduler and the Settings UI.
 */

/** Weekday ids in calendar order, Monday first. */
export const SCHEDULE_WEEKDAY_VALUES = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;
export type ScheduleWeekday = (typeof SCHEDULE_WEEKDAY_VALUES)[number];

/** `Date#getUTCDay()` index (0 = Sunday) to weekday id. */
export const SCHEDULE_WEEKDAY_BY_UTC_DAY: readonly ScheduleWeekday[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

/**
 * When the digest is sent: after scheduled runs only, after every run, or
 * never.
 */
export const DIGEST_MODE_VALUES = ["scheduled", "all", "off"] as const;
export type DigestMode = (typeof DIGEST_MODE_VALUES)[number];

export const DEFAULT_SCHEDULE_TIME = "08:00";
export const DEFAULT_SCHEDULE_TIME_ZONE = "UTC";
export const DEFAULT_SCHEDULE_CATCH_UP_MINUTES = 15;
export const MAX_SCHEDULE_CATCH_UP_MINUTES = 720;
export const DEFAULT_DIGEST_MAX_JOBS = 5;
export const MAX_DIGEST_MAX_JOBS = 20;

const SCHEDULE_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parses "HH:MM" (24-hour) into hour and minute, or null. */
export function parseScheduleTime(
  value: string | null | undefined,
): { hour: number; minute: number } | null {
  const match = value?.trim().match(SCHEDULE_TIME_PATTERN);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function isValidScheduleTime(value: string): boolean {
  return parseScheduleTime(value) !== null;
}

/**
 * True when the platform's `Intl` knows this IANA time zone. Offsets such as
 * "+07:00" and empty strings are rejected; the scheduler needs a named zone
 * so daylight-saving changes are followed.
 */
export function isValidTimeZone(value: string | null | undefined): boolean {
  const zone = value?.trim();
  if (!zone || !/^[A-Za-z]/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Telegram bot tokens look like `123456789:AAH...`. */
export const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{3,20}:[A-Za-z0-9_-]{20,100}$/;

/** A numeric chat id (groups are negative) or a public `@channelname`. */
export const TELEGRAM_CHAT_ID_PATTERN =
  /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
