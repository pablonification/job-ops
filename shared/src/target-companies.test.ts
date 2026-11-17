import { describe, expect, it } from "vitest";
import {
  createTargetCompanyMatcher,
  normalizeTargetCompanyLines,
  parseTargetCompanyLine,
} from "./target-companies";

const OWNER_LIST = [
  "GoTo | Gojek | Tokopedia",
  "Grab",
  "TikTok | ByteDance",
  "Shopee | Sea Limited | SPX Express",
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
    ["GoTo", "GoTo"],
    ["Goto", "GoTo"],
    ["GOTO", "GoTo"],
    ["GoTo Group", "GoTo"],
    ["GoTo Financial", "GoTo"],
    ["Grab", "Grab"],
    ["Grab Indonesia", "Grab"],
    ["GrabTaxi Holdings", "Grab"],
    ["GrabFood", "Grab"],
    ["GrabExpress", "Grab"],
    ["Grab Holdings Inc.", "Grab"],
    ["PT Shopee International Indonesia", "Shopee"],
    ["Shopee", "Shopee"],
    ["Shopee Indonesia", "Shopee"],
    ["ShopeePay", "Shopee"],
    ["ShopeeFood", "Shopee"],
    ["Sea Limited", "Shopee"],
    ["SPX Express", "Shopee"],
    ["TikTok", "TikTok"],
    ["TIKTOK", "TikTok"],
    ["TikTok Shop", "TikTok"],
    ["Tiktok Indonesia", "TikTok"],
    ["Tiktok Pte. Ltd.", "TikTok"],
    ["ByteDance", "TikTok"],
    ["tiket.com", "tiket.com"],
    ["PT Global Tiket Network", "tiket.com"],
    ["Traveloka Indonesia", "Traveloka"],
    ["Traveloka Services Pte Ltd", "Traveloka"],
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
    "Go To Market Specialist Agency",
    "Go To Group",
    "Sea Food Restaurant",
    "Red Sea Shipping",
    "SeaBank",
    "Seabank",
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
    ["PT Shopee", "Shopee Indonesia"],
    ["Tokopedia, PT", "Tokopedia"],
    ["Xendit Pte. Ltd.", "Xendit"],
    ["PT GoTo Gojek Tokopedia Tbk", "PT GoTo Gojek Tokopedia Tbk"],
  ])("ignores legal forms in the typed name %j (employer %j)", (typed, employer) => {
    expect(createTargetCompanyMatcher([typed]).matches(employer)).toBe(true);
  });

  it("keeps other typed words, so a full name does not shrink to one word", () => {
    const bank = createTargetCompanyMatcher(["Bank Indonesia"]);
    expect(bank.matches("Bank Indonesia")).toBe(true);
    expect(bank.matches("PT Bank Mandiri Tbk")).toBe(false);

    const airline = createTargetCompanyMatcher(["Singapore Airlines"]);
    expect(airline.matches("Singapore Airlines Ltd")).toBe(true);
    expect(airline.matches("Garuda Airlines")).toBe(false);

    const sea = createTargetCompanyMatcher(["Sea Limited"]);
    expect(sea.matches("Sea Limited")).toBe(true);
    expect(sea.matches("Sea Food Restaurant")).toBe(false);
  });

  it("matches a short name as a whole word only", () => {
    const short = createTargetCompanyMatcher(["Sea", "Pay", "OVO"]);
    expect(short.matches("Sea Limited")).toBe(true);
    expect(short.matches("OVO (PT Visionet Internasional)")).toBe(true);
    expect(short.matches("SeaBank")).toBe(false);
    expect(short.matches("PayPal")).toBe(false);
  });

  it("matches case-insensitively and across spacing you typed", () => {
    expect(createTargetCompanyMatcher(["goto"]).matches("GoTo")).toBe(true);
    expect(createTargetCompanyMatcher(["Go To"]).matches("Goto")).toBe(true);
    expect(createTargetCompanyMatcher(["Go To"]).matches("Go To Group")).toBe(
      true,
    );
    expect(createTargetCompanyMatcher(["Tik Tok"]).matches("TikTok")).toBe(
      true,
    );
    expect(createTargetCompanyMatcher(["Grab Taxi"]).matches("GrabTaxi")).toBe(
      true,
    );
    // One typed word never spans separate employer words.
    expect(createTargetCompanyMatcher(["tiktok"]).matches("Tik Tok")).toBe(
      false,
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
