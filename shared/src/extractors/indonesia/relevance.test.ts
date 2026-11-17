import { describe, expect, it } from "vitest";
import { canonicalTitleTokens, isRelevantJobTitle } from "./relevance";

// [title, term, expected]
const CASES: ReadonlyArray<readonly [string, string, boolean]> = [
  // Synonyms and separators.
  ["Back-End Engineer", "backend engineer", true],
  ["Backend Engineer", "back-end engineer", true],
  ["Back End Developer", "backend engineer", true],
  ["Golang Developer", "go developer", true],
  ["Senior Go Engineer", "golang developer", true],
  ["Site Reliability Engineer", "sre", true],
  ["SRE Lead", "site reliability", true],
  ["Quality Assurance Engineer", "qa engineer", true],
  ["QA Tester", "quality assurance", true],
  ["Software Test Engineer", "qa engineer", true],
  ["Front-End Developer (FE)", "frontend engineer", true],
  ["FE Engineer", "front end engineer", true],
  ["BE Engineer", "backend developer", true],
  ["Full-Stack Developer", "fullstack engineer", true],
  ["Fullstack Engineer", "full stack developer", true],
  ["iOS Developer", "ios engineer", true],
  ["Android Engineer", "android developer", true],
  ["Dev Ops Engineer", "devops", true],
  ["DevOps Engineer", "devops engineer", true],
  ["Data Engineer", "data", true],
  ["Machine Learning Engineer", "ml engineer", true],
  ["ML Engineer", "machine learning", true],
  ["Product Manager", "pm", true],
  ["Senior PM", "product manager", true],
  ["Tax & Audit Staff", "tax & audit", true],
  ["Anything", "and", true],
  ["Software Engineer", "software", true],
  ["Java Developer", "go developer", false],
  ["Data Analyst", "data engineer", false],
  ["Google Ads Specialist", "go", false],
  ["Marketing Staff", "go developer", false],
  ["Tax & Audit Staff", "data", false],

  // Levels: intern family.
  ["Software Engineering Internship", "intern", true],
  ["Internship Program", "intern", true],
  ["Interns - Product Design", "intern", true],
  ["Magang Software Developer", "intern", true],
  ["Data Analyst Trainee", "intern", true],
  ["Apprentice Engineer", "intern", true],
  ["Software Engineer Intern (2027 Start)", "intern", true],
  ["Software Engineer", "intern", false],
  ["Internal Auditor", "intern", false],

  // Levels: graduate family.
  ["Fresh Graduate", "new grad", true],
  ["Graduate Software Engineer", "new grad", true],
  ["Graduates Programme 2027", "graduate", true],
  ["Campus Hiring - Backend Engineer", "new grad", true],
  ["Early Career Software Engineer", "graduate", true],
  ["Entry Level Developer", "fresh graduate", true],
  ["Software Engineer", "new grad", false],

  // Levels: junior family.
  ["Associate Software Engineer", "junior software engineer", true],
  ["Jr. Backend Developer", "junior", true],
  ["Senior Software Engineer", "junior software engineer", false],

  // Level and role together need both.
  ["Software Engineer Intern (2027 Start)", "software engineer intern", true],
  ["Software Engineering Internship", "software engineer intern", true],
  ["SDE Intern", "software engineer intern", true],
  ["Data Scientist Intern", "software engineer intern", false],
  ["Software Engineer", "software engineer intern", false],
  ["Graduate Software Engineer", "software engineer new grad", true],

  // Generic software role.
  ["Software Engineer", "software engineer", true],
  ["Engineer", "software engineer", true],
  ["Software Developer", "software engineer", true],
  ["Backend Developer", "software engineer", true],
  ["Mobile Programmer", "software engineer", true],
  ["SDE Intern", "software engineer", true],
  ["Software Engineer, Backend (Payments)", "software engineer", true],
  ["Backend Engineer - Golang", "software engineer", true],
  ["Senior Software Development Engineer", "software engineer", true],
  ["Software Engineer Intern (2027 Start)", "software engineer", true],
  ["Associate Software Engineer", "software engineer", true],
  ["Site Reliability Engineer", "software engineer", true],
  ["Machine Learning Engineer", "software engineer", true],
  ["Data Engineer, Analytics Platform", "software engineer", true],
  ["Cybersecurity Engineer (Redteam)", "software engineer", true],
  [
    "Senior Software Engineer, Flutter - Merchant Experience",
    "developer",
    true,
  ],
  ["Property Operations – ME Engineer", "software engineer", false],
  ["Property Operations - ME Engineer", "developer", false],
  ["Project Engineer", "software engineer", false],
  [
    "TikTok Shop - GTL Logistics - Project Engineer- Indonesia",
    "software engineer",
    false,
  ],
  ["SAP Technical Engineer", "software engineer", false],
  ["Civil Engineer", "software engineer", false],
  ["Mechanical Maintenance Engineer", "developer", false],
  ["Field Sales Engineer", "software engineer", false],
  ["Process Engineer", "software engineer", false],
  ["Engineering Manager", "software engineer", false],
  ["Mobile Engineering Manager", "software engineer", false],
  ["Product Manager", "software engineer", false],
  ["Tech Lead", "software engineer", false],
  ["Tax & Audit Staff", "software engineer", false],
  // A plain "engineer" is taken literally.
  ["Project Engineer", "engineer", true],

  // Mobile family.
  ["Android Developer", "mobile engineer", true],
  ["iOS Engineer", "mobile engineer", true],
  ["Senior Software Engineer, Flutter", "mobile engineer", true],
  ["React Native Developer", "mobile developer", true],
  ["Kotlin Engineer", "mobile", true],
  ["Backend Engineer", "mobile engineer", false],
  ["React Developer", "mobile developer", false],

  // Review round 2: domain words, places, early careers, exclusion list.
  ["Backend Engineer - Order Management", "software engineer", true],
  ["Software Engineer (Head Office)", "software engineer", true],
  ["Data Engineer - Master Data Management", "software engineer", true],
  ["Identity & Access Management Engineer", "software engineer", true],
  ["IT Support - Head Office", "it support", true],
  ["Data Analyst - Risk Management", "data analyst", true],
  ["Early Careers Program - Software Engineering", "graduate", true],
  ["Early Careers Program", "new grad", true],
  ["Trust & Safety Engineer", "software engineer", true],
  ["Production Engineer", "software engineer", true],
  ["SAP ABAP Developer", "software engineer", true],
  ["SAP Technical Engineer", "developer", false],
  ["Manager, Software Engineering", "software engineer", false],
  ["Senior Manager - Platform", "platform", false],
  ["Head of Engineering", "software engineer", false],
  ["Director of Engineering", "software engineer", false],
  ["VP Engineering", "software engineer", false],
  ["Head of Engineering", "head of engineering", true],

  // Management is its own family.
  ["Engineering Manager", "engineering manager", true],
  ["Product Manager", "product manager", true],
  ["Tech Lead", "tech lead", true],
  ["Software Engineer", "engineering manager", false],

  // Review round 3: Indonesian forms.
  ["Pengembang Perangkat Lunak", "software developer", true],
  ["Pengembang Perangkat Lunak", "software engineer", true],
  ["Insinyur Perangkat Lunak", "software engineer", true],
  ["Lulusan Baru - Software Developer", "fresh graduate", true],
  ["Program Lulusan Baru", "new grad", true],
  ["Staf IT", "it staff", true],
  ["IT Staff", "staf it", true],
  ["Programmer", "software engineer", true],
  ["Magang IT", "intern", true],
  ["Fresh Graduate - IT Developer", "new grad", true],
  ["Fresh Graduate - IT Developer", "software engineer", true],
  // Still tight: business developers and IT staff are not software roles.
  ["Pengembang Bisnis", "software engineer", false],
  ["Staf IT", "software engineer", false],
  ["Pengembang Perangkat Lunak", "intern", false],

  // Trainee programmes take interns and graduates.
  ["Management Trainee", "graduate", true],
  ["Management Trainee", "intern", true],
  ["Graduate Trainee", "intern", true],
  ["Graduate Trainee", "new grad", true],
  ["Management Trainee", "software engineer", false],
  ["Management Trainee", "junior", false],

  // Backend and frontend specialisations.
  ["Golang Developer", "backend engineer", true],
  ["Java Developer", "backend engineer", true],
  ["Node.js Engineer", "backend engineer", true],
  [".NET Developer", "backend engineer", true],
  ["PHP Developer", "backend engineer", true],
  ["React Developer", "frontend engineer", true],
  ["Vue.js Developer", "frontend engineer", true],
  ["Angular Developer", "frontend engineer", true],
  ["Web Developer", "frontend engineer", true],
  ["Full Stack Developer", "backend engineer", true],
  ["Full Stack Developer", "frontend engineer", true],
  ["React Developer", "backend engineer", false],
  ["Golang Developer", "frontend engineer", false],
  ["React Native Developer", "frontend engineer", false],
  ["Java Developer", "backend engineer intern", false],
  ["Data Engineer", "backend engineer", false],
];

// [title, term, level hint, expected]
const LEVEL_HINT_CASES: ReadonlyArray<
  readonly [string, string, string, boolean]
> = [
  ["Software Engineer", "intern", "INTERNSHIP", true],
  ["Software Engineer", "software engineer intern", "Internship", true],
  ["Backend Developer", "backend intern", "Magang", true],
  ["Software Engineer", "intern", "FULL_TIME", false],
  ["Software Engineer", "new grad", "INTERNSHIP", false],
  // A hint gives a level, never the role.
  ["Data Analyst", "software engineer intern", "INTERNSHIP", false],
];

describe("job title relevance", () => {
  it.each(CASES)("%s for %s: %s", (title, term, expected) => {
    expect(isRelevantJobTitle(title, term)).toBe(expected);
  });

  it.each(
    LEVEL_HINT_CASES,
  )("%s for %s with level hint %s: %s", (title, term, levelHint, expected) => {
    expect(isRelevantJobTitle(title, term, { levelHint })).toBe(expected);
  });

  it("ignores upstream words that name object properties", () => {
    expect(canonicalTitleTokens("constructor toString")).toEqual([
      "constructor",
      "tostring",
    ]);
    expect(isRelevantJobTitle("Constructor Engineer", "constructor")).toBe(
      true,
    );
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
    expect(canonicalTitleTokens("Fresh Graduate Internship")).toEqual([
      "graduate",
      "intern",
    ]);
  });
});
