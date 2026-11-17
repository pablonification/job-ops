import { describe, expect, it, vi } from "vitest";
import { matchJobLocationIntent } from "../../job-matching";
import { normalizeLocationIntent } from "../../location-domain";
import {
  getSourceSupportedCountryKeys,
  isSourceAllowedForCountry,
} from "../../location-support";
import {
  BROWSER_USER_AGENT,
  buildIndonesianLocation,
  buildSalaryFields,
  canonicalIndonesianPlaceName,
  createPoliteJsonClient,
  formatRange,
  indonesianSearchCity,
  jobMatchesIndonesianCities,
  matchesIndonesianPlace,
  namesOf,
  normalizeSalaryInterval,
  TimeBudgetExceededError,
  toWorkplaceType,
} from "./index";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

const intent = (cityLocations: string[] = []) =>
  normalizeLocationIntent({ selectedCountry: "indonesia", cityLocations });

describe("Indonesian places", () => {
  it("gates the Indonesian boards to Indonesia in the static country map", () => {
    for (const source of ["techinasia", "kalibrr", "dealls"]) {
      expect(getSourceSupportedCountryKeys(source)).toEqual(["indonesia"]);
      expect(isSourceAllowedForCountry(source, "indonesia")).toBe(true);
      expect(isSourceAllowedForCountry(source, "united kingdom")).toBe(false);
    }
  });

  it("resolves English, Indonesian and short place names", () => {
    expect(canonicalIndonesianPlaceName("South Jakarta")).toBe(
      "Jakarta Selatan",
    );
    expect(canonicalIndonesianPlaceName("Kota Jakarta Selatan")).toBe(
      "Jakarta Selatan",
    );
    expect(canonicalIndonesianPlaceName("jaksel")).toBe("Jakarta Selatan");
    expect(canonicalIndonesianPlaceName("DKI Jakarta")).toBe("Jakarta");
    expect(canonicalIndonesianPlaceName("Jogja")).toBe("Yogyakarta");
    expect(canonicalIndonesianPlaceName("Bandung")).toBe("Bandung");
    expect(indonesianSearchCity("Central Jakarta")).toBe("Jakarta");
    expect(indonesianSearchCity("Tangsel")).toBe("Tangerang");
    expect(indonesianSearchCity("Surabaya")).toBe("Surabaya");
  });

  it("matches a job place within the requested place across languages", () => {
    expect(matchesIndonesianPlace("South Jakarta", "Jakarta Selatan")).toBe(
      true,
    );
    expect(matchesIndonesianPlace("Jakarta Selatan", "South Jakarta")).toBe(
      true,
    );
    expect(matchesIndonesianPlace("Central Jakarta", "Jakarta")).toBe(true);
    expect(matchesIndonesianPlace("DKI Jakarta", "Jakarta")).toBe(true);
    expect(matchesIndonesianPlace("Kota Bandung", "Bandung")).toBe(true);
    expect(matchesIndonesianPlace("Jakarta", "Jakarta Selatan")).toBe(false);
    expect(matchesIndonesianPlace("West Jakarta", "Jakarta Selatan")).toBe(
      false,
    );
    expect(matchesIndonesianPlace("Surabaya", "Jakarta")).toBe(false);
  });

  it("keeps city-only Indonesian locations through the shared location filter", () => {
    const { location, locationEvidence } = buildIndonesianLocation({
      city: "Jakarta Selatan",
      workplaceType: "onsite",
      source: "dealls",
    });

    expect(location).toBe("Jakarta Selatan, Indonesia");
    expect(locationEvidence).toMatchObject({
      location: "Jakarta Selatan, Indonesia (South Jakarta, Jaksel)",
      country: "Indonesia",
      countryKey: "indonesia",
      city: "Jakarta Selatan",
      workplaceType: "onsite",
      isRemote: false,
      evidenceQuality: "exact",
      source: "dealls",
    });

    const job = { location, locationEvidence, isRemote: false };
    for (const city of [
      [],
      ["Jakarta"],
      ["Jakarta Selatan"],
      ["South Jakarta"],
    ]) {
      expect(matchJobLocationIntent(job, intent(city)).matched).toBe(true);
    }
    expect(matchJobLocationIntent(job, intent(["Surabaya"])).matched).toBe(
      false,
    );
    expect(
      matchJobLocationIntent(
        job,
        normalizeLocationIntent({ selectedCountry: "singapore" }),
      ).matched,
    ).toBe(false);
  });

  it("keeps English district names for an Indonesian city filter", () => {
    const job = {
      ...buildIndonesianLocation({
        city: "South Jakarta",
        region: "DKI Jakarta",
        source: "kalibrr",
      }),
      isRemote: false,
    };
    expect(job.location).toBe("South Jakarta, DKI Jakarta, Indonesia");
    expect(job.locationEvidence.city).toBe("Jakarta Selatan");
    expect(
      matchJobLocationIntent(job, intent(["Jakarta Selatan"])).matched,
    ).toBe(true);
    expect(jobMatchesIndonesianCities(job, ["Jakarta Selatan"])).toBe(true);
    expect(jobMatchesIndonesianCities(job, ["Jakarta"])).toBe(true);
    expect(jobMatchesIndonesianCities(job, ["Bandung"])).toBe(false);
    expect(jobMatchesIndonesianCities(job, [])).toBe(true);
    expect(
      jobMatchesIndonesianCities({ ...job, isRemote: true }, ["Bandung"]),
    ).toBe(true);
  });

  it("does not repeat location parts and defaults the country", () => {
    expect(
      buildIndonesianLocation({
        city: "Jakarta",
        region: "Jakarta Raya",
        workplaceType: "remote",
        source: "techinasia",
      }),
    ).toMatchObject({
      location: "Jakarta, Jakarta Raya, Indonesia",
      locationEvidence: { isRemote: true, regionHints: ["Jakarta Raya"] },
    });
    expect(buildIndonesianLocation({ source: "kalibrr" })).toMatchObject({
      location: "Indonesia",
      locationEvidence: {
        location: "Indonesia",
        city: null,
        evidenceQuality: "approximate",
      },
    });
  });
});

describe("Indonesian job-board parsing helpers", () => {
  it("builds rupiah salary fields and ignores unpublished amounts", () => {
    expect(
      buildSalaryFields({
        min: 7_000_000,
        max: 10_000_000,
        currency: "idr",
        interval: "MONTHLY",
      }),
    ).toEqual({
      salary: "IDR 7,000,000–10,000,000 / month",
      salaryMinAmount: 7_000_000,
      salaryMaxAmount: 10_000_000,
      salaryCurrency: "IDR",
      salaryInterval: "monthly",
    });
    expect(buildSalaryFields({ min: 0, max: 0, currency: "IDR" })).toEqual({});
    expect(buildSalaryFields({ min: null, max: undefined })).toEqual({});
    expect(buildSalaryFields({ max: 5_000_000, currency: "IDR" }).salary).toBe(
      "IDR up to 5,000,000",
    );
    expect(normalizeSalaryInterval("Per Month")).toBe("monthly");
    expect(normalizeSalaryInterval("tahun")).toBe("yearly");
    expect(normalizeSalaryInterval("yearly")).toBe("yearly");
    expect(normalizeSalaryInterval("fortnight")).toBeUndefined();
  });

  it("maps workplace labels, name lists and ranges", () => {
    expect(toWorkplaceType("on-site")).toBe("onsite");
    expect(toWorkplaceType("onSite")).toBe("onsite");
    expect(toWorkplaceType("Remote")).toBe("remote");
    expect(toWorkplaceType("hybrid")).toBe("hybrid");
    expect(toWorkplaceType("flexible")).toBeNull();
    expect(
      namesOf([{ name: "Go" }, { name: " " }, null, { name: "SQL" }]),
    ).toEqual(["Go", "SQL"]);
    expect(formatRange(1, 4, "years")).toBe("1–4 years");
    expect(formatRange(3, 3, "years")).toBe("3 years");
    expect(formatRange(100, undefined, "employees")).toBe("100+ employees");
    expect(formatRange(undefined, undefined, "years")).toBeUndefined();
  });
});

describe("polite JSON client", () => {
  it("sends a browser user agent and pauses between requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: 1 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = createPoliteJsonClient({
      label: "Board",
      fetchImpl: fetchMock,
      delayMs: 1_000,
      sleep,
    });

    await client.getJson("https://example.com/a");
    await client.getJson("https://example.com/b");

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(client.requestCount).toBe(2);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(
      BROWSER_USER_AGENT,
    );
  });

  it("refuses to start a request past its deadline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    let clock = 0;
    const client = createPoliteJsonClient({
      label: "Board",
      fetchImpl: fetchMock,
      delayMs: 100,
      sleep: vi.fn().mockResolvedValue(undefined),
      deadline: 150,
      now: () => clock,
    });

    await client.getJson("https://example.com/a");
    clock = 60;
    await expect(client.getJson("https://example.com/b")).rejects.toThrow(
      TimeBudgetExceededError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports sanitised errors without upstream bodies", async () => {
    const failing = createPoliteJsonClient({
      label: "Board",
      delayMs: 0,
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ secret: "upstream body" }),
      } as Response),
    });
    await expect(failing.getJson("https://example.com")).rejects.toThrow(
      /^Board request failed with status 429$/,
    );

    const offline = createPoliteJsonClient({
      label: "Board",
      delayMs: 0,
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    });
    await expect(offline.getJson("https://example.com")).rejects.toThrow(
      "Board request failed (network error)",
    );
  });
});
