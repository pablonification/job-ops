import { describe, expect, it } from "vitest";
import {
  createTargetCompanyMatcher,
  normalizeTargetCompanyLines,
  parseTargetCompanyLine,
} from "./target-companies";

const OWNER_LIST = [
  "GoTo | Gojek | Tokopedia",
  "Grab",
  "TikTok",
  "Shopee | Sea",
  "Traveloka",
  "tiket.com",
  "Blibli",
  "Xendit",
];

describe("createTargetCompanyMatcher", () => {
  const matcher = createTargetCompanyMatcher(OWNER_LIST);

  it.each([
    ["PT GoTo Gojek Tokopedia Tbk", "GoTo"],
    ["Gojek", "GoTo"],
    ["GOJEK", "GoTo"],
    ["Tokopedia", "GoTo"],
    ["PT Tokopedia", "GoTo"],
    ["GoTo Financial", "GoTo"],
    ["Go To Group", "GoTo"],
    ["Grab", "Grab"],
    ["GrabTaxi Holdings", "Grab"],
    ["Grab Holdings Inc.", "Grab"],
    ["PT Shopee International Indonesia", "Shopee"],
    ["Shopee", "Shopee"],
    ["Sea Limited", "Shopee"],
    ["TikTok", "TikTok"],
    ["Tiktok Pte. Ltd.", "TikTok"],
    ["tiket.com", "tiket.com"],
    ["PT Global Tiket Network", "tiket.com"],
    ["Traveloka Indonesia", "Traveloka"],
    ["traveloka", "Traveloka"],
    ["Blibli.com", "Blibli"],
    ["PT Global Digital Niaga (Blibli)", "Blibli"],
    ["Xendit", "Xendit"],
  ])("matches %j to %j", (employer, label) => {
    expect(matcher.match(employer)?.label).toBe(label);
    expect(matcher.matches(employer)).toBe(true);
  });

  it.each([
    "Grabango",
    "Telegraph Media",
    "Research Partners",
    "Overseas Staffing",
    "Gotoh Industries",
    "Shopeefy",
    "Travel Okay",
    "Bukalapak",
    "PT Bank Central Asia Tbk",
    "",
  ])("does not match %j", (employer) => {
    expect(matcher.match(employer)).toBeNull();
    expect(matcher.matches(employer)).toBe(false);
  });

  it("does not match null or undefined employers", () => {
    expect(matcher.matches(null)).toBe(false);
    expect(matcher.matches(undefined)).toBe(false);
  });

  it.each([
    ["PT Shopee Indonesia", "Shopee"],
    ["Traveloka Indonesia", "Traveloka"],
    ["GrabTaxi Holdings Pte Ltd", "Grab Taxi"],
    ["Tokopedia, PT", "Tokopedia"],
  ])("ignores affixes in the typed name %j (employer %j)", (typed, employer) => {
    expect(createTargetCompanyMatcher([typed]).matches(employer)).toBe(true);
  });

  it("matches case-insensitively and across spacing", () => {
    expect(createTargetCompanyMatcher(["goto"]).matches("GoTo")).toBe(true);
    expect(createTargetCompanyMatcher(["Go To"]).matches("Goto")).toBe(true);
    expect(createTargetCompanyMatcher(["tiktok"]).matches("Tik Tok")).toBe(
      true,
    );
  });

  it("ignores accents", () => {
    expect(createTargetCompanyMatcher(["Societe"]).matches("Société")).toBe(
      true,
    );
  });

  it("treats a group's aliases as one company", () => {
    const groupMatcher = createTargetCompanyMatcher([
      "GoTo | Gojek | Tokopedia",
    ]);
    expect(groupMatcher.groups).toEqual([
      { label: "GoTo", names: ["GoTo", "Gojek", "Tokopedia"] },
    ]);
    expect(groupMatcher.match("Tokopedia")?.label).toBe("GoTo");
  });

  it("ignores blank lines and names made only of affixes", () => {
    const emptyMatcher = createTargetCompanyMatcher([
      "",
      "  ",
      " | ",
      "PT",
      "Holdings",
      "PT Indonesia",
    ]);
    expect(emptyMatcher.isEmpty).toBe(true);
    expect(emptyMatcher.groups).toEqual([]);
    expect(emptyMatcher.matches("PT Holdings Indonesia")).toBe(false);
  });

  it("is empty for a missing setting", () => {
    expect(createTargetCompanyMatcher(null).isEmpty).toBe(true);
    expect(createTargetCompanyMatcher(undefined).matches("Grab")).toBe(false);
    expect(createTargetCompanyMatcher([]).matches("Grab")).toBe(false);
  });
});

describe("parseTargetCompanyLine", () => {
  it("splits aliases on | and trims them", () => {
    expect(parseTargetCompanyLine(" GoTo |Gojek|  | Tokopedia ")).toEqual([
      "GoTo",
      "Gojek",
      "Tokopedia",
    ]);
  });
});

describe("normalizeTargetCompanyLines", () => {
  it("trims, drops blanks and duplicate lines", () => {
    expect(
      normalizeTargetCompanyLines([
        " Grab ",
        "",
        "GoTo|Gojek",
        "grab",
        "  |  ",
      ]),
    ).toEqual(["Grab", "GoTo | Gojek"]);
  });
});
