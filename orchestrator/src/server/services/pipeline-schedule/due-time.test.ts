import { SCHEDULE_WEEKDAY_VALUES } from "@shared/pipeline-schedule";
import { describe, expect, it } from "vitest";
import {
  type DailySchedule,
  findDueOccurrence,
  findNextOccurrence,
  listOccurrences,
} from "./due-time";

const MINUTE = 60_000;
const at = (iso: string) => Date.parse(iso);
const iso = (entry: { instantMs: number } | null) =>
  entry === null ? null : new Date(entry.instantMs).toISOString();
const everyDay = [...SCHEDULE_WEEKDAY_VALUES];

type Options = {
  catchUpMinutes?: number;
  /** Last claimed occurrence (ISO). */
  lastFired?: string | null;
  /** Its local date, "YYYY-MM-DD". */
  lastFiredDate?: string | null;
  /** When the schedule settings were last saved (ISO). */
  savedAt?: string | null;
};

function args(schedule: DailySchedule, now: string, options: Options) {
  return {
    schedule,
    nowMs: at(now),
    catchUpMs: (options.catchUpMinutes ?? 15) * MINUTE,
    lastFiredMs: options.lastFired ? at(options.lastFired) : null,
    lastFiredLocalDate: options.lastFiredDate ?? null,
    notBeforeMs: options.savedAt ? at(options.savedAt) : null,
  };
}

function due(schedule: DailySchedule, now: string, options: Options = {}) {
  return iso(findDueOccurrence(args(schedule, now, options)));
}

function next(schedule: DailySchedule, now: string, options: Options = {}) {
  return iso(findNextOccurrence(args(schedule, now, options)));
}

describe("schedule due times", () => {
  const jakarta: DailySchedule = {
    time: "08:00",
    timeZone: "Asia/Jakarta",
    weekdays: everyDay,
  };

  it("fires at the local time in the schedule's zone, whatever the server zone", () => {
    // 08:00 in Jakarta (UTC+7) is 01:00 UTC.
    expect(due(jakarta, "2026-11-17T01:00:05.000Z")).toBe(
      "2026-11-17T01:00:00.000Z",
    );
    expect(due(jakarta, "2026-11-17T00:59:59.000Z")).toBeNull();
    expect(next(jakarta, "2026-11-17T00:30:00.000Z")).toBe(
      "2026-11-17T01:00:00.000Z",
    );
  });

  it("does not fire the same occurrence twice", () => {
    expect(
      due(jakarta, "2026-11-17T01:00:40.000Z", {
        lastFired: "2026-11-17T01:00:00.000Z",
      }),
    ).toBeNull();
    // The next one is tomorrow.
    expect(
      next(jakarta, "2026-11-17T01:00:40.000Z", {
        lastFired: "2026-11-17T01:00:00.000Z",
      }),
    ).toBe("2026-11-18T01:00:00.000Z");
  });

  it("catches up a missed run only inside the catch-up window", () => {
    expect(due(jakarta, "2026-11-17T01:14:59.000Z")).toBe(
      "2026-11-17T01:00:00.000Z",
    );
    expect(due(jakarta, "2026-11-17T01:15:01.000Z")).toBeNull();
    expect(
      due(jakarta, "2026-11-17T01:44:00.000Z", { catchUpMinutes: 45 }),
    ).toBe("2026-11-17T01:00:00.000Z");
    // Too late: skip to the next occurrence rather than firing late.
    expect(next(jakarta, "2026-11-17T03:00:00.000Z")).toBe(
      "2026-11-18T01:00:00.000Z",
    );
  });

  it("uses the tenant's weekday when it differs from UTC's", () => {
    // 06:30 Monday in Jakarta is 23:30 Sunday UTC.
    const mondays: DailySchedule = {
      time: "06:30",
      timeZone: "Asia/Jakarta",
      weekdays: ["mon"],
    };
    expect(due(mondays, "2026-11-15T23:30:10.000Z")).toBe(
      "2026-11-15T23:30:00.000Z",
    );
    // 23:30 Sunday in Los Angeles is 07:30 Monday UTC: not a Monday there.
    const lateSundays: DailySchedule = {
      time: "23:30",
      timeZone: "America/Los_Angeles",
      weekdays: ["sun"],
    };
    expect(due(lateSundays, "2026-11-16T07:30:10.000Z")).toBe(
      "2026-11-16T07:30:00.000Z",
    );
    expect(
      next(lateSundays, "2026-11-16T07:31:00.000Z", {
        lastFired: "2026-11-16T07:30:00.000Z",
      }),
    ).toBe("2026-11-23T07:30:00.000Z");
  });

  it("skips days that are not selected", () => {
    const weekdays: DailySchedule = {
      ...jakarta,
      weekdays: ["mon", "tue", "wed", "thu", "fri"],
    };
    // Saturday 21 Nov 2026 in Jakarta.
    expect(due(weekdays, "2026-11-21T01:00:10.000Z")).toBeNull();
    expect(next(weekdays, "2026-11-21T01:00:10.000Z")).toBe(
      "2026-11-23T01:00:00.000Z",
    );
  });

  it("fires a time skipped by daylight saving once, just past the jump", () => {
    // New York jumps from 02:00 to 03:00 on 8 March 2026.
    const skipped: DailySchedule = {
      time: "02:30",
      timeZone: "America/New_York",
      weekdays: everyDay,
    };
    const occurrences = listOccurrences(
      skipped,
      at("2026-03-07T00:00:00.000Z"),
      at("2026-03-10T00:00:00.000Z"),
    ).map((ms) => new Date(ms).toISOString());
    expect(occurrences).toEqual([
      "2026-03-07T07:30:00.000Z", // 02:30 EST
      "2026-03-08T07:30:00.000Z", // 03:30 EDT, the day 02:30 does not exist
      "2026-03-09T06:30:00.000Z", // 02:30 EDT
    ]);
  });

  it("fires a time that happens twice only once, at the first", () => {
    // New York repeats 01:00-02:00 on 1 November 2026.
    const repeated: DailySchedule = {
      time: "01:30",
      timeZone: "America/New_York",
      weekdays: everyDay,
    };
    const occurrences = listOccurrences(
      repeated,
      at("2026-10-31T12:00:00.000Z"),
      at("2026-11-02T12:00:00.000Z"),
    ).map((ms) => new Date(ms).toISOString());
    expect(occurrences).toEqual([
      "2026-11-01T05:30:00.000Z", // 01:30 EDT, the first of the two
      "2026-11-02T06:30:00.000Z",
    ]);
    // The second 01:30 (06:30Z) is not due again after the first fired.
    expect(
      due(repeated, "2026-11-01T06:30:10.000Z", {
        catchUpMinutes: 120,
        lastFired: "2026-11-01T05:30:00.000Z",
      }),
    ).toBeNull();
  });

  it("handles zones with half-hour offsets and the day boundary", () => {
    // 00:15 in Kolkata (UTC+5:30) is 18:45 UTC the day before.
    const kolkata: DailySchedule = {
      time: "00:15",
      timeZone: "Asia/Kolkata",
      weekdays: ["wed"],
    };
    expect(due(kolkata, "2026-11-17T18:45:30.000Z")).toBe(
      "2026-11-17T18:45:00.000Z",
    );
  });

  it("gives each occurrence its local date in the schedule's zone", () => {
    // 06:30 Monday 16 Nov in Jakarta is still Sunday 15 Nov in UTC.
    expect(
      findDueOccurrence(
        args(
          { time: "06:30", timeZone: "Asia/Jakarta", weekdays: everyDay },
          "2026-11-15T23:30:10.000Z",
          {},
        ),
      ),
    ).toEqual({
      instantMs: at("2026-11-15T23:30:00.000Z"),
      localDate: "2026-11-16",
    });
  });

  it("runs at most once per local day when the time is moved later", () => {
    // 06:30 fired; the owner then moves the schedule to 07:00 the same day.
    const moved: DailySchedule = { ...jakarta, time: "07:00" };
    const state = {
      lastFired: "2026-11-16T23:30:00.000Z",
      lastFiredDate: "2026-11-17",
      savedAt: "2026-11-16T23:45:00.000Z",
    };
    expect(due(moved, "2026-11-17T00:00:10.000Z", state)).toBeNull();
    // Next run is 07:00 tomorrow, not today.
    expect(next(moved, "2026-11-17T00:00:10.000Z", state)).toBe(
      "2026-11-18T00:00:00.000Z",
    );
    expect(due(moved, "2026-11-18T00:00:10.000Z", state)).toBe(
      "2026-11-18T00:00:00.000Z",
    );
  });

  it("does not catch up times from before the schedule was saved", () => {
    // Turned on at 08:05 with a time of 08:00: no run until tomorrow.
    const savedAt = "2026-11-17T01:05:00.000Z";
    expect(due(jakarta, "2026-11-17T01:05:30.000Z", { savedAt })).toBeNull();
    expect(next(jakarta, "2026-11-17T01:05:30.000Z", { savedAt })).toBe(
      "2026-11-18T01:00:00.000Z",
    );
    // Saved before the time: today's run is still due, and still caught up
    // after a restart inside the window.
    const earlier = "2026-11-17T00:40:00.000Z";
    expect(due(jakarta, "2026-11-17T01:10:00.000Z", { savedAt: earlier })).toBe(
      "2026-11-17T01:00:00.000Z",
    );
    // Moved to a time a few minutes in the past: no surprise run either.
    const backdated: DailySchedule = { ...jakarta, time: "07:55" };
    expect(
      due(backdated, "2026-11-17T01:00:30.000Z", {
        savedAt: "2026-11-17T01:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("never fires for an invalid zone, time or empty weekday list", () => {
    const now = "2026-11-17T01:00:05.000Z";
    expect(due({ ...jakarta, timeZone: "Mars/Olympus_Mons" }, now)).toBeNull();
    expect(next({ ...jakarta, timeZone: "" }, now)).toBeNull();
    expect(due({ ...jakarta, time: "25:00" }, now)).toBeNull();
    expect(due({ ...jakarta, weekdays: [] }, now)).toBeNull();
  });
});
