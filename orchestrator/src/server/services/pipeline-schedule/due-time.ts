/**
 * When a daily schedule ("08:00 in Asia/Jakarta on weekdays") comes due.
 *
 * Pure functions over instants (epoch milliseconds); no clock and no
 * dependence on the server's own time zone. Wall-clock time in the
 * schedule's zone comes from `Intl.DateTimeFormat`.
 *
 * One occurrence per selected local date. Around daylight-saving changes:
 * - a time that does not exist that day (spring forward) fires once, at the
 *   same distance past the jump (02:30 in a 02:00→03:00 gap fires at 03:30);
 * - a time that exists twice (fall back) fires once, at the first of the two.
 */
import {
  isValidTimeZone,
  parseScheduleTime,
  SCHEDULE_WEEKDAY_BY_UTC_DAY,
  type ScheduleWeekday,
} from "@shared/pipeline-schedule";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Look this many days around "now"; covers any weekday selection. */
const SEARCH_DAYS = 8;

export type DailySchedule = {
  /** "HH:MM", 24-hour. */
  time: string;
  /** IANA time zone, e.g. "Asia/Jakarta". */
  timeZone: string;
  weekdays: readonly ScheduleWeekday[];
};

type LocalDate = { year: number; month: number; day: number };

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock fields of an instant in the zone. */
function wallClock(instantMs: number, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const part of getFormatter(timeZone).formatToParts(instantMs)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    // Some engines print midnight as 24 even with h23.
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Offset of the zone from UTC at an instant, in ms (Jakarta: +7h). */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const wall = wallClock(instantMs, timeZone);
  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  const wholeSecond = Math.floor(instantMs / 1000) * 1000;
  return wallAsUtc - wholeSecond;
}

function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function weekdayOf(date: LocalDate): ScheduleWeekday {
  return SCHEDULE_WEEKDAY_BY_UTC_DAY[
    new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
  ];
}

/**
 * The instant the schedule fires on a local date: the first instant whose
 * wall clock reads hour:minute, or, when that time is skipped by a
 * daylight-saving jump, the instant the same distance past the jump.
 */
export function occurrenceOnLocalDate(
  date: LocalDate,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const wallAsUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // Offsets in force around that day; a zone changes offset at most once in
  // any 48 hours, so these cover both sides of a transition.
  const offsets = [
    zoneOffsetMs(wallAsUtc - DAY_MS, timeZone),
    zoneOffsetMs(wallAsUtc + DAY_MS, timeZone),
  ];
  const matches = offsets
    .map((offset) => wallAsUtc - offset)
    .filter((candidate) => {
      const wall = wallClock(candidate, timeZone);
      return (
        wall.year === date.year &&
        wall.month === date.month &&
        wall.day === date.day &&
        wall.hour === hour &&
        wall.minute === minute
      );
    });
  if (matches.length > 0) return Math.min(...matches);
  // Skipped by a jump forward: use the offset from before the jump.
  return wallAsUtc - offsets[0];
}

/** "YYYY-MM-DD" of a local date. */
function formatLocalDate(date: LocalDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

/** One scheduled run: when it fires and the local date it belongs to. */
export type Occurrence = {
  instantMs: number;
  /** "YYYY-MM-DD" in the schedule's time zone. */
  localDate: string;
};

/**
 * Every occurrence in [fromMs, toMs], oldest first, with its local date.
 * Returns [] for an invalid time, time zone or empty weekday list.
 */
export function listOccurrenceEntries(
  schedule: DailySchedule,
  fromMs: number,
  toMs: number,
): Occurrence[] {
  const time = parseScheduleTime(schedule.time);
  if (!time || !isValidTimeZone(schedule.timeZone)) return [];
  const weekdays = new Set(schedule.weekdays);
  if (weekdays.size === 0) return [];

  const start = wallClock(fromMs, schedule.timeZone);
  let date: LocalDate = addDays(
    { year: start.year, month: start.month, day: start.day },
    -1,
  );
  const lastDate = (() => {
    const end = wallClock(toMs, schedule.timeZone);
    return addDays({ year: end.year, month: end.month, day: end.day }, 1);
  })();

  const out: Occurrence[] = [];
  for (let guard = 0; guard < 400; guard += 1) {
    if (weekdays.has(weekdayOf(date))) {
      const instantMs = occurrenceOnLocalDate(
        date,
        time.hour,
        time.minute,
        schedule.timeZone,
      );
      if (instantMs >= fromMs && instantMs <= toMs) {
        out.push({ instantMs, localDate: formatLocalDate(date) });
      }
    }
    if (
      date.year === lastDate.year &&
      date.month === lastDate.month &&
      date.day === lastDate.day
    ) {
      break;
    }
    date = addDays(date, 1);
  }
  return out.sort((left, right) => left.instantMs - right.instantMs);
}

/** Instants of every occurrence in [fromMs, toMs], oldest first. */
export function listOccurrences(
  schedule: DailySchedule,
  fromMs: number,
  toMs: number,
): number[] {
  return listOccurrenceEntries(schedule, fromMs, toMs).map(
    (entry) => entry.instantMs,
  );
}

/** What has already happened, which limits what may fire next. */
export type ScheduleFiredState = {
  /** The last claimed occurrence. */
  lastFiredMs: number | null;
  /** Its local date: at most one scheduled run per local calendar day. */
  lastFiredLocalDate: string | null;
  /**
   * When the schedule settings were last saved. Occurrences before this
   * never fire: the catch-up window covers restarts, not edits.
   */
  notBeforeMs: number | null;
};

function isAllowed(entry: Occurrence, state: ScheduleFiredState): boolean {
  if (state.lastFiredMs !== null && entry.instantMs <= state.lastFiredMs) {
    return false;
  }
  if (
    state.lastFiredLocalDate !== null &&
    entry.localDate <= state.lastFiredLocalDate
  ) {
    return false;
  }
  if (state.notBeforeMs !== null && entry.instantMs < state.notBeforeMs) {
    return false;
  }
  return true;
}

/**
 * The occurrence that should fire now, if any: the latest occurrence at or
 * before `nowMs` and no older than the catch-up window, provided it is
 * allowed (see `ScheduleFiredState`). Older missed occurrences are skipped,
 * never queued.
 */
export function findDueOccurrence(
  args: {
    schedule: DailySchedule;
    nowMs: number;
    catchUpMs: number;
  } & ScheduleFiredState,
): Occurrence | null {
  const occurrences = listOccurrenceEntries(
    args.schedule,
    args.nowMs - Math.max(0, args.catchUpMs),
    args.nowMs,
  );
  const latest = occurrences.at(-1);
  if (latest === undefined || !isAllowed(latest, args)) return null;
  return latest;
}

/**
 * When the schedule will next start a run: a due occurrence that has not
 * fired yet (it fires on the next tick), else the first allowed future one.
 */
export function findNextOccurrence(
  args: {
    schedule: DailySchedule;
    nowMs: number;
    catchUpMs: number;
  } & ScheduleFiredState,
): Occurrence | null {
  const due = findDueOccurrence(args);
  if (due !== null) return due;
  const upcoming = listOccurrenceEntries(
    args.schedule,
    args.nowMs + 1,
    args.nowMs + SEARCH_DAYS * DAY_MS,
  );
  return upcoming.find((entry) => isAllowed(entry, args)) ?? null;
}
