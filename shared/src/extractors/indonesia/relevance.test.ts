import { describe, expect, it } from "vitest";
import { canonicalTitleTokens, isRelevantJobTitle } from "./relevance";

describe("job title relevance", () => {
  it.each([
    ["Back-End Engineer", "backend engineer"],
    ["Backend Engineer", "back-end engineer"],
    ["Back End Developer", "backend engineer"],
    ["Golang Developer", "go developer"],
    ["Senior Go Engineer", "golang developer"],
    ["Site Reliability Engineer", "sre"],
    ["SRE Lead", "site reliability"],
    ["Quality Assurance Engineer", "qa engineer"],
    ["QA Tester", "quality assurance"],
    ["Software Test Engineer", "qa engineer"],
    ["Software Developer", "software engineer"],
    ["Backend Developer", "software engineer"],
    ["Mobile Programmer", "software engineer"],
    ["Software Engineer", "software"],
    ["Front-End Developer (FE)", "frontend engineer"],
    ["FE Engineer", "front end engineer"],
    ["BE Engineer", "backend developer"],
    ["Full-Stack Developer", "fullstack engineer"],
    ["Fullstack Engineer", "full stack developer"],
    ["iOS Developer", "ios engineer"],
    ["Android Engineer", "android developer"],
    ["Dev Ops Engineer", "devops"],
    ["DevOps Engineer", "devops engineer"],
    ["Data Engineer", "data"],
    ["Machine Learning Engineer", "ml engineer"],
    ["ML Engineer", "machine learning"],
    ["Product Manager", "pm"],
    ["Senior PM", "product manager"],
    ["Tax & Audit Staff", "tax & audit"],
    ["Anything", "and"],
  ])("keeps %s for %s", (title, term) => {
    expect(isRelevantJobTitle(title, term)).toBe(true);
  });

  it.each([
    // The recorded loose match: body text mentions "software" and "data".
    ["Tax & Audit Staff", "software engineer"],
    ["Tax & Audit Staff", "data"],
    // Prose would contain "go" and "developer"; the title does not.
    ["Marketing Staff", "go developer"],
    ["Java Developer", "go developer"],
    ["Engineering Manager", "software engineer"],
    ["Software Engineer", "backend engineer"],
    ["Data Analyst", "data engineer"],
    ["Google Ads Specialist", "go"],
  ])("drops %s for %s", (title, term) => {
    expect(isRelevantJobTitle(title, term)).toBe(false);
  });

  it("normalises separators and synonyms into canonical tokens", () => {
    expect(canonicalTitleTokens("Sr. Back-End / Golang Developer")).toEqual([
      "sr",
      "backend",
      "go",
      "engineer",
    ]);
    expect(
      canonicalTitleTokens("Software Developer", { asSearchTerm: true }),
    ).toEqual(["engineer"]);
    expect(canonicalTitleTokens("Software Developer")).toEqual([
      "software",
      "engineer",
    ]);
  });
});
