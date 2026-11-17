import { describe, expect, it, vi } from "vitest";
import type { CreateJobInput } from "../../types/jobs";
import { TimeBudgetExceededError } from "./client";
import {
  acceptWithDetails,
  createDetailCandidates,
  createKnownJobUrls,
} from "./details";
import { buildIndonesianLocation } from "./places";
import { resolveWorkplaceTypes, runJobBoard } from "./runner";

function job(id: string, city = "Jakarta Selatan"): CreateJobInput {
  return {
    source: "glints",
    title: "Engineer",
    employer: "Acme",
    jobUrl: `https://example.com/${id}`,
    ...buildIndonesianLocation({ city, source: "glints" }),
  };
}

describe("workplace types for board filters", () => {
  it("reads the run's choice and treats all three or none as any", () => {
    const settings = {};
    expect(
      resolveWorkplaceTypes({
        settings,
        locationIntent: { workplaceTypes: ["hybrid", "remote"] } as never,
      }),
    ).toEqual(["remote", "hybrid"]);
    expect(
      resolveWorkplaceTypes({
        settings,
        locationIntent: {
          workplaceTypes: ["remote", "hybrid", "onsite"],
        } as never,
      }),
    ).toEqual([]);
    expect(
      resolveWorkplaceTypes({ settings: { workplaceTypes: '["onsite"]' } }),
    ).toEqual(["onsite"]);
    expect(
      resolveWorkplaceTypes({ settings: { workplaceTypes: "not json" } }),
    ).toEqual([]);
    expect(resolveWorkplaceTypes({ settings })).toEqual([]);
  });
});

describe("detail step helpers", () => {
  it("loads known URLs once and treats a failed lookup as none known", async () => {
    const lookup = vi.fn().mockResolvedValue(["https://example.com/1"]);
    const known = createKnownJobUrls(lookup);
    expect(await known()).toEqual(new Set(["https://example.com/1"]));
    await known();
    expect(lookup).toHaveBeenCalledTimes(1);

    const failing = createKnownJobUrls(
      vi.fn().mockRejectedValue(new Error("db down")),
    );
    expect(await failing()).toEqual(new Set());
    expect(await createKnownJobUrls()()).toEqual(new Set());
  });

  it("collects candidates once, filters cities and fetches details only for new jobs", async () => {
    const fetchDetail = vi.fn(async ({ job: candidate }) =>
      candidate.jobUrl.endsWith("/3")
        ? null
        : { ...candidate, jobDescription: "full" },
    );
    const result = await runJobBoard({
      label: "Board",
      maxPageSize: 20,
      options: { searchTerms: ["a"], cities: ["Jakarta"] },
      runTerm: async (context) => {
        const { candidates, consume } = createDetailCandidates(context);
        expect(consume(job("1"), { id: 1 })).toBe("added");
        expect(consume(job("1"), { id: 1 })).toBe("duplicate");
        expect(consume(job("2", "Bandung"), { id: 2 })).toBe("filtered");
        expect(consume(job("3"), { id: 3 })).toBe("added");
        expect(consume(job("4"), { id: 4 })).toBe("added");
        expect(candidates.map(({ item }) => item)).toEqual([
          { id: 1 },
          { id: 3 },
          { id: 4 },
        ]);
        await acceptWithDetails(context, candidates, {
          label: "Board",
          knownUrls: async () => new Set(["https://example.com/4"]),
          fetchDetail,
        });
      },
    });

    expect(fetchDetail).toHaveBeenCalledTimes(2);
    expect(
      result.jobs.map((item) => [item.jobUrl, item.jobDescription]),
    ).toEqual([
      ["https://example.com/1", "full"],
      ["https://example.com/4", undefined],
    ]);
  });

  it("rethrows a spent time budget instead of counting it as a failed detail", async () => {
    const result = await runJobBoard({
      label: "Board",
      maxPageSize: 20,
      options: { searchTerms: ["a"] },
      runTerm: async (context) => {
        const { candidates, consume } = createDetailCandidates(context);
        consume(job("1"), {});
        await acceptWithDetails(context, candidates, {
          label: "Board",
          knownUrls: async () => new Set(),
          fetchDetail: async () => {
            throw new TimeBudgetExceededError("Board");
          },
        });
      },
    });

    expect(result.sourceErrors ?? [result.error]).toEqual([
      expect.stringContaining("Board: stopped after 8 minutes"),
    ]);
  });
});
