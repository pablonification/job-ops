import type { Server } from "node:http";
import { APPLICATION_TASK_TYPES } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "../api/routes/test-utils";
import {
  callTool,
  createAccessToken,
  expectToolOk,
  type ListedTool,
  listTools,
  login,
  MCP_AUTH_ENV,
  rpc,
} from "./test-helpers";

vi.mock("@server/services/rxresume/baseResumeId", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@server/services/rxresume/baseResumeId")
    >();
  return {
    ...actual,
    getConfiguredRxResumeBaseResumeId: vi.fn(async () => ({
      mode: "v5" as const,
      resumeId: "base-resume-1",
    })),
  };
});

const INVALID_PARAMS = -32602;

const EXPECTED_ARGUMENTS: Record<
  string,
  Array<{ name: string; required: boolean }>
> = {
  daily_triage: [
    { name: "prepareLimit", required: false },
    { name: "minScore", required: false },
  ],
  evaluate_job: [{ name: "jobId", required: true }],
  outreach_drafts: [
    { name: "jobId", required: true },
    { name: "language", required: false },
  ],
  interview_prep: [
    { name: "jobId", required: true },
    { name: "round", required: false },
  ],
  follow_ups: [{ name: "days", required: false }],
  weekly_review: [{ name: "periodDays", required: false }],
};

/** Arguments that exercise each playbook's text, including optional branches. */
const SAMPLE_ARGUMENTS: Array<[string, Record<string, string>]> = [
  ["daily_triage", {}],
  ["evaluate_job", { jobId: "job-123" }],
  ["outreach_drafts", { jobId: "job-123" }],
  ["outreach_drafts", { jobId: "job-123", language: "id" }],
  ["interview_prep", { jobId: "job-123" }],
  ["interview_prep", { jobId: "job-123", round: "technical_interview" }],
  ["follow_ups", {}],
  ["weekly_review", {}],
];

type PromptMessage = { role: string; content: { type: string; text: string } };

/**
 * Names in playbook text that are not tools but are real values: enum values
 * of tool inputs (statuses, stages, sort orders, modes...), the pipeline's
 * paused-run kind, task types, and the playbooks themselves.
 */
function buildVocabulary(tools: ListedTool[], promptNames: string[]) {
  const values = new Set<string>([
    ...promptNames,
    ...APPLICATION_TASK_TYPES,
    "llm_configuration",
  ]);
  const collect = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) collect(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "enum" && Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") values.add(item);
        }
      } else {
        collect(value);
      }
    }
  };
  for (const tool of tools) collect(tool.inputSchema);
  return values;
}

/** Splits `a: 1, b: ["x", "y"], c: { d: 1 }` at top-level commas. */
function splitTopLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index] ?? "";
    current += char;
    if (inString) {
      if (char === "\\") current += args[++index] ?? "";
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if ("[{(".includes(char)) depth += 1;
    else if ("]})".includes(char)) depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(current.slice(0, -1));
      current = "";
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * Problems in a playbook's text: tool calls written as
 * `tool_name(argument: value)` must name a registered tool and only its
 * arguments, and every other snake_case name must be a tool or a known value.
 */
function findUnknownNames(
  text: string,
  toolArguments: Map<string, Set<string>>,
  vocabulary: Set<string>,
): string[] {
  const problems: string[] = [];
  for (const [, name = "", args = ""] of text.matchAll(
    /`([a-z][a-z0-9_]*)\(([^`]*)\)`/g,
  )) {
    const known = toolArguments.get(name);
    if (!known) {
      problems.push(`unknown tool ${name}`);
      continue;
    }
    for (const part of splitTopLevel(args)) {
      const arg = /^\s*([A-Za-z][A-Za-z0-9]*)\s*(?::|$)/.exec(part)?.[1];
      if (!arg) problems.push(`${name}: cannot read argument "${part.trim()}"`);
      else if (!known.has(arg)) problems.push(`${name} has no argument ${arg}`);
    }
  }
  for (const word of text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []) {
    if (!toolArguments.has(word) && !vocabulary.has(word)) {
      problems.push(`unknown name ${word}`);
    }
  }
  return [...new Set(problems)];
}

describe.sequential("MCP playbooks (prompts)", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;
  let session: string;
  let writeToken: string;
  let readToken: string;

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: MCP_AUTH_ENV,
    }));
    session = await login(baseUrl, "admin", "secret");
    writeToken = (await createAccessToken(baseUrl, session, "write")).secret;
    readToken = (await createAccessToken(baseUrl, session, "read")).secret;
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  async function getPrompt(
    token: string,
    name: string,
    args?: Record<string, string>,
  ) {
    return rpc(baseUrl, token, "prompts/get", {
      name,
      ...(args ? { arguments: args } : {}),
    });
  }

  async function promptText(
    token: string,
    name: string,
    args?: Record<string, string>,
  ): Promise<string> {
    const { status, body } = await getPrompt(token, name, args);
    expect(status).toBe(200);
    expect(body.error, JSON.stringify(body.error)).toBeUndefined();
    const messages = body.result.messages as PromptMessage[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content.type).toBe("text");
    return messages[0]?.content.text ?? "";
  }

  it("advertises prompts and lists the six playbooks with their arguments", async () => {
    const init = await rpc(baseUrl, readToken, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    expect(init.body.result.capabilities.prompts).toBeDefined();
    expect(init.body.result.instructions).toContain("daily_triage");

    const list = await rpc(baseUrl, readToken, "prompts/list");
    expect(list.status).toBe(200);
    const prompts = list.body.result.prompts as Array<{
      name: string;
      title: string;
      description: string;
      arguments: Array<{
        name: string;
        description: string;
        required: boolean;
      }>;
    }>;
    expect(prompts.map((prompt) => prompt.name)).toEqual(
      Object.keys(EXPECTED_ARGUMENTS),
    );
    for (const prompt of prompts) {
      expect(prompt.title, prompt.name).toBeTruthy();
      expect(prompt.description, prompt.name).toBeTruthy();
      expect(
        prompt.arguments.map(({ name, required }) => ({ name, required })),
        prompt.name,
      ).toEqual(EXPECTED_ARGUMENTS[prompt.name]);
      for (const argument of prompt.arguments) {
        expect(argument.description, argument.name).toBeTruthy();
      }
    }
  });

  it("renders playbooks with defaults, the given arguments and the caller's scope", async () => {
    const defaults = await promptText(readToken, "daily_triage");
    expect(defaults).toContain("the best 3");
    expect(defaults).toContain("minScore: 70");
    expect(defaults).toContain("This connection uses a read-only token");
    expect(defaults).toContain(`${baseUrl}/job/<jobId>`);
    expect(defaults).toContain("Never invent");

    // Blank values (a slash command with fewer words) fall back to defaults.
    expect(
      await promptText(writeToken, "daily_triage", {
        prepareLimit: "",
        minScore: " ",
      }),
    ).toContain("the best 3");

    const custom = await promptText(writeToken, "daily_triage", {
      prepareLimit: "5",
      minScore: "82",
    });
    expect(custom).toContain("the best 5");
    expect(custom).toContain("minScore: 82");
    expect(custom).toContain("read-and-write token");
    expect(custom).not.toContain("This connection uses a read-only token");

    const evaluation = await promptText(writeToken, "evaluate_job", {
      jobId: "job-123",
    });
    expect(evaluation).toContain('get_job(jobId: "job-123")');
    expect(evaluation).toContain("Evaluation — YYYY-MM-DD");

    const indonesian = await promptText(writeToken, "outreach_drafts", {
      jobId: "job-123",
      language: "Indonesian",
    });
    expect(indonesian).toContain("Bahasa Indonesia");
    expect(
      await promptText(writeToken, "outreach_drafts", { jobId: "job-123" }),
    ).toContain("written in English");

    expect(
      await promptText(writeToken, "interview_prep", {
        jobId: "job-123",
        round: "Technical",
      }),
    ).toContain("ready for the technical interview");

    const followUps = await promptText(writeToken, "follow_ups", {
      days: "14",
    });
    expect(followUps).toContain("no movement for 14 days");

    expect(await promptText(writeToken, "weekly_review")).toContain(
      "over the last 7 days",
    );
  });

  it("rejects invalid, missing and unknown arguments and unknown prompts", async () => {
    for (const [name, args] of [
      ["daily_triage", { prepareLimit: "11" }],
      ["daily_triage", { prepareLimit: "two" }],
      ["daily_triage", { minScore: "70.5" }],
      ["daily_triage", { unknown: "1" }],
      ["evaluate_job", {}],
      ["evaluate_job", { jobId: "  " }],
      ["outreach_drafts", { jobId: "job-123", language: "fr" }],
      ["interview_prep", { jobId: "job-123", round: "lunch" }],
      ["follow_ups", { days: "0" }],
      ["weekly_review", { periodDays: "365" }],
    ] as const) {
      const { status, body } = await getPrompt(writeToken, name, args);
      expect(status, name).toBe(200);
      expect(body.error?.code, `${name} ${JSON.stringify(args)}`).toBe(
        INVALID_PARAMS,
      );
      expect(body.error.message).toContain(`prompt ${name}`);
    }

    const unknown = await getPrompt(writeToken, "apply_everywhere");
    expect(unknown.body.error?.code).toBe(INVALID_PARAMS);
    expect(unknown.body.error.message).toContain("Unknown prompt");
  });

  it("refuses prompts without a valid token", async () => {
    for (const token of [undefined, "jo_pat_000000000000_not-a-real-token"]) {
      expect((await rpc(baseUrl, token, "prompts/list")).status).toBe(401);
      const get = await rpc(baseUrl, token, "prompts/get", {
        name: "daily_triage",
      });
      expect(get.status).toBe(401);
      expect(JSON.stringify(get.body ?? {})).not.toContain("Daily triage");
    }
  });

  it("names only registered tools, tool arguments and known values in every playbook", async () => {
    const tools = await listTools(baseUrl, readToken);
    const toolArguments = new Map(
      tools.map((tool) => [
        tool.name,
        new Set(Object.keys(tool.inputSchema.properties ?? {})),
      ]),
    );
    const list = await rpc(baseUrl, readToken, "prompts/list");
    const prompts = list.body.result.prompts as Array<{
      name: string;
      description: string;
      arguments: Array<{ description: string }>;
    }>;
    const vocabulary = buildVocabulary(
      tools,
      prompts.map((prompt) => prompt.name),
    );

    // The checker itself catches a misspelt tool, a wrong argument and an
    // unknown name.
    expect(
      findUnknownNames(
        '`list_jobz(limit: 1)` then `get_job(jobId: "x", job_id: "y")` and `get_job(id: "x")` with move_to_reddy',
        toolArguments,
        vocabulary,
      ),
    ).toEqual([
      "unknown tool list_jobz",
      'get_job: cannot read argument "job_id: "y""',
      "get_job has no argument id",
      "unknown name list_jobz",
      "unknown name job_id",
      "unknown name move_to_reddy",
    ]);

    for (const prompt of prompts) {
      const listed = [
        prompt.description,
        ...prompt.arguments.map((argument) => argument.description),
      ].join("\n");
      expect(
        findUnknownNames(listed, toolArguments, vocabulary),
        prompt.name,
      ).toEqual([]);
    }

    for (const [name, args] of SAMPLE_ARGUMENTS) {
      for (const token of [writeToken, readToken]) {
        const text = await promptText(token, name, args);
        expect(findUnknownNames(text, toolArguments, vocabulary), name).toEqual(
          [],
        );
        // Every playbook actually calls tools in the checked form.
        expect(
          [...text.matchAll(/`([a-z][a-z0-9_]*)\(/g)].length,
          name,
        ).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it("returns the longer resume content from get_profile only when asked", async () => {
    const { getProfile } = await import("@server/services/profile");
    vi.mocked(getProfile).mockResolvedValue({
      basics: { name: "Rina", email: "rina@example.com", headline: "Student" },
      sections: {
        experience: {
          items: [
            {
              id: "exp-1",
              company: "Startup",
              position: "Backend Intern",
              location: "Jakarta",
              date: "2025",
              summary: "<p>Built a <b>Go</b> payments service.</p>",
              visible: true,
            },
            {
              id: "exp-2",
              company: "Hidden Co",
              position: "Hidden",
              location: "",
              date: "",
              summary: "Hidden",
              visible: false,
            },
          ],
        },
        education: {
          items: [
            {
              id: "edu-1",
              institution: "Universitas Indonesia",
              studyType: "Bachelor",
              area: "Computer Science",
              date: "2022 - 2026",
              visible: true,
            },
          ],
        },
      },
    });

    const brief = expectToolOk(
      await callTool(baseUrl, readToken, "get_profile"),
    );
    expect(brief.configured).toBe(true);
    expect(brief).not.toHaveProperty("details");

    const full = expectToolOk(
      await callTool(baseUrl, readToken, "get_profile", {
        includeDetails: true,
      }),
    );
    expect(full.details.experience).toEqual([
      {
        company: "Startup",
        position: "Backend Intern",
        location: "Jakarta",
        date: "2025",
        summary: "Built a Go payments service.",
      },
    ]);
    expect(full.details.education).toEqual([
      {
        institution: "Universitas Indonesia",
        studyType: "Bachelor",
        area: "Computer Science",
        date: "2022 - 2026",
      },
    ]);
    expect(JSON.stringify(full)).not.toContain("rina@example.com");
  });
});
