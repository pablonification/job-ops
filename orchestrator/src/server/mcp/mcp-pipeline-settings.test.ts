import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "../api/routes/test-utils";
import {
  callTool,
  createAccessToken,
  createUserSession,
  expectToolError,
  expectToolOk,
  jsonHeaders,
  listTools,
  login,
  MCP_AUTH_ENV,
  runAsUser,
} from "./test-helpers";

const { callJsonMock } = vi.hoisted(() => ({ callJsonMock: vi.fn() }));

// No test may reach a real model: every LLM call goes to this mock.
vi.mock("@server/services/llm/service", () => ({
  LlmService: vi.fn().mockImplementation(function MockLlmService(this: {
    callJson: typeof callJsonMock;
  }) {
    this.callJson = callJsonMock;
  }),
}));

const READ_TOOLS = [
  "get_pipeline_progress",
  "list_pipeline_runs",
  "get_pipeline_run",
  "list_sources",
  "list_search_presets",
  "get_settings",
  "get_watchlist_sources",
  "ghostwriter_list_messages",
  "search_visa_sponsors",
  "list_inbox_items",
];

const WRITE_TOOLS = [
  "start_pipeline_run",
  "cancel_pipeline_run",
  "resume_pipeline_scoring",
  "check_source_health",
  "save_search_preset",
  "delete_search_preset",
  "update_settings",
  "set_watchlist_sources",
  "ghostwriter_send_message",
  "resolve_inbox_item",
];

const DESTRUCTIVE_TOOLS = ["delete_search_preset", "set_watchlist_sources"];

/** Read scope, but not annotated read-only because they spend model usage. */
const READ_SCOPE_COSTLY_TOOLS = ["plan_search"];

/** Tools that must never exist: admin, backups, billing, login flows. */
const FORBIDDEN_TOOL_PATTERN =
  /database|wipe|backup|billing|workspace|user_admin|codex|oauth|login|sso|token/i;

const SEARCH_CONFIG = {
  searchTerms: ["backend engineer"],
  sources: ["linkedin"],
  country: "united kingdom",
  cityLocations: ["London"],
  workplaceTypes: ["remote", "hybrid"],
  searchScope: "selected_only",
  matchStrictness: "exact_only",
  topN: 10,
  minSuitabilityScore: 55,
  runBudget: 250,
  scoringInstructions: "",
  automaticPresetId: "custom",
};

async function importJob(
  baseUrl: string,
  session: string,
  title: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/manual-jobs/import`, {
    method: "POST",
    headers: jsonHeaders(session),
    body: JSON.stringify({
      job: {
        title,
        employer: "Acme",
        jobUrl: `https://example.com/jobs/${randomUUID()}`,
        jobDescription: `${title} at Acme. ${"Details. ".repeat(50)}`,
      },
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).data.id as string;
}

describe.sequential("MCP pipeline, settings and inbox tools", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;
  let adminSession: string;
  let writeToken: string;

  beforeEach(async () => {
    callJsonMock.mockReset();
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: MCP_AUTH_ENV,
    }));
    adminSession = await login(baseUrl, "admin", "secret");
    writeToken = (await createAccessToken(baseUrl, adminSession, "write"))
      .secret;
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  it("lists the new tools with scope annotations and nothing off-limits", async () => {
    const tools = await listTools(baseUrl, writeToken);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const name of READ_TOOLS) {
      expect(byName.get(name)?.annotations.readOnlyHint, name).toBe(true);
    }
    for (const name of READ_SCOPE_COSTLY_TOOLS) {
      expect(byName.get(name)?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      });
    }
    for (const name of WRITE_TOOLS) {
      const annotations = byName.get(name)?.annotations;
      expect(annotations?.readOnlyHint, name).toBe(false);
      expect(annotations?.destructiveHint, name).toBe(
        DESTRUCTIVE_TOOLS.includes(name),
      );
    }
    for (const tool of tools) {
      expect(tool.name).not.toMatch(FORBIDDEN_TOOL_PATTERN);
    }
  });

  it("refuses every write tool for a read-scope token", async () => {
    const { secret } = await createAccessToken(baseUrl, adminSession, "read");
    const tools = await listTools(baseUrl, secret);
    const writeTools = tools
      .filter(
        (tool) =>
          tool.annotations.readOnlyHint === false &&
          !READ_SCOPE_COSTLY_TOOLS.includes(tool.name),
      )
      .map((tool) => tool.name);
    expect(writeTools).toEqual(expect.arrayContaining(WRITE_TOOLS));

    for (const name of writeTools) {
      const error = expectToolError(
        await callTool(baseUrl, secret, name, {}),
        "FORBIDDEN",
      );
      expect(error.message).toContain("write scope");
    }
    const { runPipeline } = await import("@server/pipeline/index");
    expect(runPipeline).not.toHaveBeenCalled();

    // plan_search needs no write scope: it fails on input, not on scope.
    expectToolError(
      await callTool(baseUrl, secret, "plan_search", {}),
      "INVALID_REQUEST",
    );
  });

  it("starts a run, refuses a second one and invalid sources, then cancels", async () => {
    const pipeline = await import("@server/pipeline/index");

    const incompatible = expectToolError(
      await callTool(baseUrl, writeToken, "start_pipeline_run", {
        sources: ["naukri"],
        country: "united kingdom",
        searchTerms: ["backend engineer"],
      }),
      "INVALID_REQUEST",
    );
    expect(incompatible.message).toContain("incompatible");
    expect(incompatible.details).toMatchObject({
      incompatibleSources: [expect.objectContaining({ source: "naukri" })],
    });

    const unknownField = expectToolError(
      await callTool(baseUrl, writeToken, "start_pipeline_run", {
        sources: ["linkedin"],
        notAField: true,
      }),
      "INVALID_REQUEST",
    );
    expect(unknownField.message).toContain("notAField");
    expect(pipeline.runPipeline).not.toHaveBeenCalled();

    const started = expectToolOk(
      await callTool(baseUrl, writeToken, "start_pipeline_run", {
        sources: ["linkedin"],
        country: "united kingdom",
        cityLocations: ["London"],
        searchTerms: ["platform engineer"],
        topN: 5,
      }),
    );
    expect(started).toMatchObject({ started: true, message: "Search started" });
    expect(pipeline.runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        topN: 5,
        sources: ["linkedin"],
        locationIntent: expect.objectContaining({
          selectedCountry: "united kingdom",
          cityLocations: ["London"],
        }),
      }),
      expect.objectContaining({ hostedUsageReservationId: null }),
    );
    // Requested search terms become the saved defaults, as over REST.
    const settings = expectToolOk(
      await callTool(baseUrl, writeToken, "get_settings", {
        keys: ["searchTerms"],
      }),
    );
    expect(settings.settings.searchTerms.value).toEqual(["platform engineer"]);

    vi.mocked(pipeline.getPipelineStatus).mockReturnValue({ isRunning: true });
    const busy = expectToolError(
      await callTool(baseUrl, writeToken, "start_pipeline_run", {
        sources: ["linkedin"],
        country: "united kingdom",
      }),
      "CONFLICT",
    );
    expect(busy.message).toBe("Pipeline is already running");
    expect(pipeline.runPipeline).toHaveBeenCalledTimes(1);

    expectToolError(
      await callTool(baseUrl, writeToken, "cancel_pipeline_run"),
      "CONFLICT",
    );
    vi.mocked(pipeline.requestPipelineCancel).mockReturnValueOnce({
      accepted: true,
      pipelineRunId: "run-1",
      alreadyRequested: false,
    });
    expect(
      expectToolOk(await callTool(baseUrl, writeToken, "cancel_pipeline_run")),
    ).toEqual({
      message: "Pipeline cancellation requested",
      pipelineRunId: "run-1",
      alreadyRequested: false,
    });

    expectToolError(
      await callTool(baseUrl, writeToken, "resume_pipeline_scoring"),
      "CONFLICT",
    );
    vi.mocked(pipeline.resumePipelineScoring).mockReturnValueOnce({
      resolved: true,
    });
    expect(
      expectToolOk(
        await callTool(baseUrl, writeToken, "resume_pipeline_scoring"),
      ),
    ).toEqual({ resolved: true });
  });

  it("reports progress and what a human must do when a run is paused", async () => {
    const pipeline = await import("@server/pipeline/index");
    const idle = expectToolOk(
      await callTool(baseUrl, writeToken, "get_pipeline_progress"),
    );
    expect(idle).toMatchObject({
      isRunning: false,
      step: "idle",
      paused: false,
      actionRequired: null,
      lastRun: null,
    });
    expect(idle.progress.jobsDiscovered).toBe(0);

    const base = pipeline.getProgress();
    vi.mocked(pipeline.getPipelineStatus).mockReturnValue({ isRunning: true });
    vi.mocked(pipeline.getProgress).mockReturnValueOnce({
      ...base,
      step: "configuration_required",
      message: "Waiting for LLM configuration",
    });
    const needsLlm = expectToolOk(
      await callTool(baseUrl, writeToken, "get_pipeline_progress"),
    );
    expect(needsLlm).toMatchObject({
      isRunning: true,
      step: "configuration_required",
      paused: true,
      actionRequired: { kind: "llm_configuration" },
    });
    expect(needsLlm.actionRequired.message).toContain(
      "resume_pipeline_scoring",
    );

    vi.mocked(pipeline.getProgress).mockReturnValueOnce({
      ...base,
      step: "challenge_required",
    });
    vi.mocked(pipeline.getPendingChallenges).mockReturnValueOnce([
      {
        extractorId: "hiringcafe",
        extractorName: "Hiring Cafe",
        url: "https://hiring.cafe/",
        sources: ["hiringcafe"],
        resumeState: { cursor: "internal" },
      },
    ]);
    const challenged = expectToolOk(
      await callTool(baseUrl, writeToken, "get_pipeline_progress"),
    );
    expect(challenged.actionRequired).toMatchObject({
      kind: "challenge",
      who: "human",
      challenges: [{ extractorId: "hiringcafe", extractorName: "Hiring Cafe" }],
    });
    expect(challenged.actionRequired.message).toContain("Hiring Cafe");
    expect(challenged.actionRequired.challenges[0]).not.toHaveProperty(
      "resumeState",
    );
  });

  it("lists past runs with paging and returns one run", async () => {
    const pipelineRepo = await import("@server/repositories/pipeline");
    const [first, second] = await runAsUser("admin", async () => {
      const older = await pipelineRepo.createPipelineRun();
      await pipelineRepo.updatePipelineRun(older.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        jobsDiscovered: 12,
        jobsProcessed: 3,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const newer = await pipelineRepo.createPipelineRun();
      return [older, newer];
    });

    const page = expectToolOk(
      await callTool(baseUrl, writeToken, "list_pipeline_runs", { limit: 1 }),
    );
    expect(page).toMatchObject({ total: 2, hasMore: true, nextOffset: 1 });
    expect(page.runs.map((run: { id: string }) => run.id)).toEqual([
      second?.id,
    ]);
    expect(page.runs[0]).not.toHaveProperty("configSnapshot");

    const detail = expectToolOk(
      await callTool(baseUrl, writeToken, "get_pipeline_run", {
        runId: first?.id,
      }),
    );
    expect(detail.run).toMatchObject({
      id: first?.id,
      status: "completed",
      jobsDiscovered: 12,
    });
    expect(detail.inferredMetrics).toBeDefined();

    expectToolError(
      await callTool(baseUrl, writeToken, "get_pipeline_run", {
        runId: "missing",
      }),
      "NOT_FOUND",
    );

    // Another user's token sees none of these runs.
    const adamSession = await createUserSession(baseUrl, adminSession, "adam");
    const adamToken = (await createAccessToken(baseUrl, adamSession, "read"))
      .secret;
    const adamRuns = expectToolOk(
      await callTool(baseUrl, adamToken, "list_pipeline_runs"),
    );
    expect(adamRuns.total).toBe(0);
    expectToolError(
      await callTool(baseUrl, adamToken, "get_pipeline_run", {
        runId: first?.id,
      }),
      "NOT_FOUND",
    );
  });

  it("saves, plans from and deletes search presets", async () => {
    expect(
      expectToolOk(await callTool(baseUrl, writeToken, "list_search_presets")),
    ).toMatchObject({ presets: [], total: 0 });

    const noBase = expectToolError(
      await callTool(baseUrl, writeToken, "plan_search", {
        prompt: "remote backend roles",
      }),
      "INVALID_REQUEST",
    );
    expect(noBase.message).toContain("save_search_preset");

    expectToolError(
      await callTool(baseUrl, writeToken, "save_search_preset", {
        name: "Missing config",
      }),
      "INVALID_REQUEST",
    );
    const created = expectToolOk(
      await callTool(baseUrl, writeToken, "save_search_preset", {
        name: "UK backend",
        config: SEARCH_CONFIG,
      }),
    );
    expect(created).toMatchObject({
      created: true,
      preset: { name: "UK backend" },
    });
    const presetId = created.preset.id as string;

    expectToolError(
      await callTool(baseUrl, writeToken, "save_search_preset", {
        name: "UK backend",
        config: SEARCH_CONFIG,
      }),
      "CONFLICT",
    );
    const renamed = expectToolOk(
      await callTool(baseUrl, writeToken, "save_search_preset", {
        id: presetId,
        name: "UK backend (remote)",
      }),
    );
    expect(renamed).toMatchObject({
      created: false,
      preset: { id: presetId, name: "UK backend (remote)" },
    });

    callJsonMock.mockResolvedValueOnce({
      success: true,
      data: {
        config: { ...SEARCH_CONFIG, searchTerms: ["Platform Engineer"] },
        summary: "The search was updated to platform roles.",
        warnings: [],
      },
    });
    const plan = expectToolOk(
      await callTool(baseUrl, writeToken, "plan_search", {
        prompt: "platform roles instead",
      }),
    );
    expect(plan).toMatchObject({
      source: "ai",
      config: { searchTerms: ["Platform Engineer"], sources: ["linkedin"] },
    });
    const prompt = callJsonMock.mock.calls.at(-1)?.[0]?.messages?.[0]?.content;
    expect(prompt).toContain("platform roles instead");
    expect(prompt).toContain("backend engineer");

    // Saved searches are per user.
    const adamSession = await createUserSession(baseUrl, adminSession, "adam");
    const adamToken = (await createAccessToken(baseUrl, adamSession, "write"))
      .secret;
    expect(
      expectToolOk(await callTool(baseUrl, adamToken, "list_search_presets"))
        .total,
    ).toBe(0);
    expectToolError(
      await callTool(baseUrl, adamToken, "delete_search_preset", {
        id: presetId,
      }),
      "NOT_FOUND",
    );

    expect(
      expectToolOk(
        await callTool(baseUrl, writeToken, "delete_search_preset", {
          id: presetId,
        }),
      ),
    ).toEqual({ deleted: true, id: presetId });
    expectToolError(
      await callTool(baseUrl, writeToken, "delete_search_preset", {
        id: presetId,
      }),
      "NOT_FOUND",
    );
  });

  it("lists sources with countries and credential needs, and checks health", async () => {
    const result = expectToolOk(
      await callTool(baseUrl, writeToken, "list_sources"),
    );
    const byId = new Map(
      result.sources.map((source: { id: string }) => [source.id, source]),
    );
    expect(byId.get("naukri")).toMatchObject({
      label: "Naukri",
      availableAtRuntime: true,
      supportedCountries: expect.arrayContaining(["india"]),
    });
    expect(byId.get("adzuna")).toMatchObject({
      requiresCountry: true,
      credentials: {
        required: true,
        settings: ["adzunaAppId", "adzunaAppKey"],
        configured: false,
      },
    });
    expect(byId.get("linkedin")).toMatchObject({
      credentials: { required: false, settings: [], configured: true },
    });
    expect(byId.get("linkedin")).not.toHaveProperty("health");

    // Every source that needs credentials names the settings it needs, so a
    // new credentialed source cannot report configured by accident.
    const { EXTRACTOR_SOURCE_METADATA, PIPELINE_EXTRACTOR_SOURCE_IDS } =
      await import("@shared/extractors");
    for (const source of PIPELINE_EXTRACTOR_SOURCE_IDS) {
      if (!EXTRACTOR_SOURCE_METADATA[source].requiresCredentials) continue;
      const entry = byId.get(source) as {
        credentials: { settings: string[] };
      };
      expect(entry.credentials.settings.length, source).toBeGreaterThan(0);
    }

    // Credentials count from stored settings (and the environment).
    const settingsRepo = await import("@server/repositories/settings");
    await runAsUser("admin", async () => {
      await settingsRepo.setSetting("adzunaAppId", "app-id");
      await settingsRepo.setSetting("adzunaAppKey", "app-key");
    });
    const configured = expectToolOk(
      await callTool(baseUrl, writeToken, "list_sources", {
        sources: ["adzuna"],
      }),
    );
    expect(configured.sources[0].credentials.configured).toBe(true);
    expect(JSON.stringify(configured)).not.toContain("app-key");

    const probed = expectToolOk(
      await callTool(baseUrl, writeToken, "check_source_health", {
        sources: ["linkedin"],
      }),
    );
    expect(probed.sources).toHaveLength(1);
    expect(probed.sources[0]).toMatchObject({
      id: "linkedin",
      availableAtRuntime: true,
      health: { healthy: expect.any(Boolean), status: expect.any(String) },
    });

    expectToolError(
      await callTool(baseUrl, writeToken, "list_sources", {
        sources: ["not-a-source"],
      }),
      "INVALID_REQUEST",
    );
    expectToolError(
      await callTool(baseUrl, writeToken, "list_sources", {
        probeHealth: true,
      }),
      "INVALID_REQUEST",
    );
  });

  it("classifies every registry setting for agents and hides new ones", async () => {
    const { settingsRegistry } = await import("@shared/settings-registry");
    const access = await import("@server/services/settings-agent-access");
    const unclassified = Object.keys(settingsRegistry).filter(
      (key) => !access.isAgentSettingClassified(key),
    );
    // Add each new setting to AGENT_SETTING_POLICIES.
    expect(unclassified).toEqual([]);

    expect(access.getAgentSettingPolicy("aSettingAddedLater")).toEqual({
      read: "hidden",
      agentEditable: false,
    });
    for (const [key, definition] of Object.entries(settingsRegistry)) {
      if (definition.kind !== "secret") continue;
      expect(access.getAgentSettingPolicy(key), key).toEqual({
        read: "hidden",
        agentEditable: false,
      });
    }
  });

  it("never returns credentials from settings tools", async () => {
    const { settingsRegistry } = await import("@shared/settings-registry");
    const settingsRepo = await import("@server/repositories/settings");
    const serialize = (key: string, value: unknown): string => {
      const definition = settingsRegistry[key as keyof typeof settingsRegistry];
      return "serialize" in definition &&
        typeof definition.serialize === "function"
        ? ((definition.serialize as (input: unknown) => string | null)(value) ??
            "")
        : (value as string);
    };

    // A distinct value per secret; hints expose the first 4 characters.
    const markers = new Map<string, string>();
    const seeds = new Map<string, unknown>();
    for (const [index, [key, definition]] of Object.entries(settingsRegistry)
      .filter(([, entry]) => entry.kind === "secret")
      .entries()) {
      const marker = `Q${index}Zx`.slice(0, 4);
      markers.set(key, marker);
      const secret = `${marker}-never-leak-${key}`;
      const schema = definition.schema as unknown as {
        shape?: Record<string, unknown>;
      };
      seeds.set(
        key,
        schema.shape
          ? Object.fromEntries(
              Object.keys(schema.shape).map((part) => [
                part,
                `${secret}-${part}`,
              ]),
            )
          : secret,
      );
    }
    expect(markers.size).toBeGreaterThan(0);

    // Credential material outside secret-kind settings.
    seeds.set(
      "pipelineWebhookUrl",
      "https://hooks.slack.com/services/T0/B0/WHPATHSECRET?token=WHQUERY",
    );
    seeds.set(
      "jobCompleteWebhookUrl",
      "https://discord.com/api/webhooks/123/DCPATHSECRET",
    );
    seeds.set(
      "llmBaseUrl",
      "https://llmuser:LLMPASS@llm.example.com/v1?key=LLMQUERY#frag",
    );
    seeds.set(
      "rxresumeUrl",
      "https://rxuser:RXPASS@rx.example.com/app?token=RXQUERY",
    );
    seeds.set("llmPurposeOverrides", {
      scoring: {
        provider: "openai",
        baseUrl: "https://pouser:POPASS@po.example.com/v1?k=POQUERY",
        model: "gpt-test",
      },
    });
    seeds.set("ukvisajobsEmail", "ukvj.login@example.com");
    seeds.set("adzunaAppId", "ADZAPPID123");
    const leaks = [
      ...markers.values(),
      "WHPATHSECRET",
      "WHQUERY",
      "DCPATHSECRET",
      "llmuser",
      "LLMPASS",
      "LLMQUERY",
      "rxuser",
      "RXPASS",
      "RXQUERY",
      "pouser",
      "POPASS",
      "POQUERY",
      "ukvj.login",
      "ADZAPPID123",
    ];

    await runAsUser("admin", async () => {
      for (const [key, value] of seeds) {
        await settingsRepo.setSetting(
          key as Parameters<typeof settingsRepo.setSetting>[0],
          serialize(key, value),
        );
      }
    });

    // Sanity check: the REST payload (unchanged) carries the material, so
    // the seeds landed where this user's requests read.
    const rest = await fetch(`${baseUrl}/api/settings`, {
      headers: jsonHeaders(adminSession),
    }).then((res) => res.text());
    for (const marker of markers.values()) expect(rest).toContain(marker);
    expect(rest).toContain("WHPATHSECRET");
    expect(rest).toContain("LLMPASS");

    const result = await callTool(baseUrl, writeToken, "get_settings");
    const text = result.content[0]?.text ?? "";
    for (const leak of leaks) expect(text, leak).not.toContain(leak);

    const view = expectToolOk(result);
    for (const key of [...markers.keys(), "ukvisajobsEmail", "adzunaAppId"]) {
      expect(view.hidden[key]?.set, key).toBe(true);
      expect(view.settings, key).not.toHaveProperty(key);
      expect(view.webOnly, key).toContain(key);
    }
    expect(view.hidden.llmPurposeApiKeys.parts).toMatchObject({
      scoring: true,
    });
    for (const field of Object.keys(view.settings)) {
      expect(field).not.toMatch(/Hints?$/);
    }
    expect(view.settings.pipelineWebhookUrl.value).toBe("hooks.slack.com");
    expect(view.settings.jobCompleteWebhookUrl.value).toBe("discord.com");
    expect(view.settings.llmBaseUrl.value).toBe("https://llm.example.com/v1");
    expect(view.settings.rxresumeUrl).toBe("https://rx.example.com/app");
    expect(view.settings.llmPurposeOverrides.value.scoring).toEqual({
      provider: "openai",
      baseUrl: "https://po.example.com/v1",
      model: "gpt-test",
    });
    expect(view.reduced).toEqual(
      expect.arrayContaining([
        "pipelineWebhookUrl",
        "jobCompleteWebhookUrl",
        "llmBaseUrl",
        "llmPurposeOverrides",
        "rxresumeUrl",
      ]),
    );

    const filtered = expectToolOk(
      await callTool(baseUrl, writeToken, "get_settings", {
        keys: ["searchTerms", "llmApiKey"],
      }),
    );
    expect(Object.keys(filtered.settings)).toEqual(["searchTerms"]);
    expect(filtered.hidden).toEqual({ llmApiKey: { set: true } });
  });

  it("lets agents change only agent-editable settings", async () => {
    const allWebOnly = expectToolOk(
      await callTool(baseUrl, writeToken, "get_settings"),
    ).webOnly as string[];
    expect(allWebOnly).toEqual(
      expect.arrayContaining([
        "llmProvider",
        "llmBaseUrl",
        "llmApiKey",
        "llmPurposeOverrides",
        "llmPurposeApiKeys",
        "pipelineWebhookUrl",
        "jobCompleteWebhookUrl",
        "webhookSecret",
        "rxresumeUrl",
        "rxresumeApiKey",
        "backupEnabled",
        "backupHour",
        "backupMaxCount",
        "ukvisajobsEmail",
        "adzunaAppId",
      ]),
    );

    // Every web-only setting is refused by name, even for an admin token.
    for (const key of allWebOnly) {
      const error = expectToolError(
        await callTool(baseUrl, writeToken, "update_settings", {
          updates: { searchTerms: ["ignored"], [key]: null },
        }),
        "FORBIDDEN",
      );
      expect(error.message, key).toContain(key);
      expect(error.message, key).toContain("web app");
      expect(error.details).toEqual({ settings: [key] });
    }
    const evil = expectToolError(
      await callTool(baseUrl, writeToken, "update_settings", {
        updates: { llmBaseUrl: "https://evil.example.com" },
      }),
      "FORBIDDEN",
    );
    expect(evil.message).toContain("llmBaseUrl");
    const afterRefusals = expectToolOk(
      await callTool(baseUrl, writeToken, "get_settings", {
        keys: ["llmBaseUrl", "searchTerms"],
      }),
    );
    expect(afterRefusals.settings.llmBaseUrl.override).toBeNull();
    expect(afterRefusals.settings.searchTerms.value).not.toEqual(["ignored"]);

    // Agent-editable settings still change.
    const allowed = expectToolOk(
      await callTool(baseUrl, writeToken, "update_settings", {
        updates: {
          searchTerms: ["data engineer"],
          scoringInstructions: "Prefer fintech.",
          model: "test-model-2",
          showSponsorInfo: false,
          chatStyleTone: "direct",
        },
      }),
    );
    expect(allowed.updatedSettingKeys).toEqual(
      expect.arrayContaining(["searchTerms", "scoringInstructions"]),
    );
    expect(allowed.settings).toMatchObject({
      searchTerms: { value: ["data engineer"] },
      scoringInstructions: { value: "Prefer fintech." },
    });

    // REST is unchanged: the web app (an admin session) may change them.
    const restBackup = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: jsonHeaders(adminSession),
      body: JSON.stringify({ backupMaxCount: 3 }),
    });
    expect(restBackup.status).toBe(200);
  });

  it("applies the REST validation and permission rules to update_settings", async () => {
    const unknown = expectToolError(
      await callTool(baseUrl, writeToken, "update_settings", {
        updates: { notASetting: 1 },
      }),
      "INVALID_REQUEST",
    );
    expect(unknown.message).toContain("notASetting");
    const invalid = expectToolError(
      await callTool(baseUrl, writeToken, "update_settings", {
        updates: { jobspyResultsWanted: 0 },
      }),
      "INVALID_REQUEST",
    );
    expect(invalid.message).toContain("jobspyResultsWanted");

    // A non-admin may change search settings only, exactly as over REST.
    const adamSession = await createUserSession(baseUrl, adminSession, "adam");
    const adamToken = (await createAccessToken(baseUrl, adamSession, "write"))
      .secret;
    expectToolOk(
      await callTool(baseUrl, adamToken, "update_settings", {
        updates: { searchTerms: ["designer"] },
      }),
    );
    const denied = expectToolError(
      await callTool(baseUrl, adamToken, "update_settings", {
        updates: { searchTerms: ["designer"], scoringInstructions: "x" },
      }),
      "FORBIDDEN",
    );
    expect(denied.message).toBe("System admin access is required");
    const restDenied = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: jsonHeaders(adamSession),
      body: JSON.stringify({ scoringInstructions: "x" }),
    });
    expect(restDenied.status).toBe(403);
    expect((await restDenied.json()).error.message).toBe(denied.message);
  });

  it("keeps each user's settings to themselves", async () => {
    expectToolOk(
      await callTool(baseUrl, writeToken, "update_settings", {
        updates: { searchTerms: ["admin-only-term"] },
      }),
    );
    const adamSession = await createUserSession(baseUrl, adminSession, "adam");
    const adamToken = (await createAccessToken(baseUrl, adamSession, "write"))
      .secret;

    const adamView = await callTool(baseUrl, adamToken, "get_settings");
    expect(adamView.content[0]?.text).not.toContain("admin-only-term");

    expectToolOk(
      await callTool(baseUrl, adamToken, "update_settings", {
        updates: { searchTerms: ["adam-only-term"] },
      }),
    );
    const adminView = expectToolOk(
      await callTool(baseUrl, writeToken, "get_settings", {
        keys: ["searchTerms"],
      }),
    );
    expect(adminView.settings.searchTerms.value).toEqual(["admin-only-term"]);
    const adamAfter = expectToolOk(
      await callTool(baseUrl, adamToken, "get_settings", {
        keys: ["searchTerms"],
      }),
    );
    expect(adamAfter.settings.searchTerms.value).toEqual(["adam-only-term"]);
  });

  it("reads and replaces Watchlist sources", async () => {
    const initial = expectToolOk(
      await callTool(baseUrl, writeToken, "get_watchlist_sources"),
    );
    expect(initial.selectedSources).toEqual([]);
    expect(initial.catalogSources.length).toBeGreaterThan(0);
    const [catalog] = initial.catalogSources as Array<{
      id: string;
      sourceType: string;
      careersUrl: string;
      label: string;
    }>;
    const selection = {
      catalogSourceId: catalog?.id,
      sourceType: catalog?.sourceType,
      careersUrl: catalog?.careersUrl,
    };

    const saved = expectToolOk(
      await callTool(baseUrl, writeToken, "set_watchlist_sources", {
        selections: [selection],
      }),
    );
    expect(saved.selectedSources).toHaveLength(1);
    expect(saved.selectedSources[0]).toMatchObject({
      label: catalog?.label,
      careersUrl: catalog?.careersUrl,
    });

    expectToolError(
      await callTool(baseUrl, writeToken, "set_watchlist_sources", {
        selections: [selection, selection],
      }),
      "UNPROCESSABLE_ENTITY",
    );
    expectToolError(
      await callTool(baseUrl, writeToken, "set_watchlist_sources", {
        selections: [{ ...selection, catalogSourceId: "missing" }],
      }),
      "UNPROCESSABLE_ENTITY",
    );
    expect(
      expectToolOk(await callTool(baseUrl, writeToken, "get_watchlist_sources"))
        .selectedSources,
    ).toHaveLength(1);
  });

  it("sends Ghostwriter messages, waits for the reply and times out", async () => {
    const jobId = await importJob(baseUrl, adminSession, "Backend Engineer");

    callJsonMock.mockResolvedValueOnce({
      success: true,
      data: { response: "Dear hiring team, ..." },
    });
    const sent = expectToolOk(
      await callTool(baseUrl, writeToken, "ghostwriter_send_message", {
        jobId,
        content: "Draft a short cover letter.",
      }),
    );
    expect(sent.reply).toBe("Dear hiring team, ...");
    expect(sent.assistantMessage).toMatchObject({ status: "complete" });
    // The reply text is returned once.
    expect(sent.assistantMessage).not.toHaveProperty("content");

    const listed = expectToolOk(
      await callTool(baseUrl, writeToken, "ghostwriter_list_messages", {
        jobId,
      }),
    );
    expect(listed.total).toBe(2);
    expect(
      listed.messages.map((message: { role: string }) => message.role),
    ).toEqual(["user", "assistant"]);

    expectToolError(
      await callTool(baseUrl, writeToken, "ghostwriter_send_message", {
        jobId: "missing-job",
        content: "Hello",
      }),
      "NOT_FOUND",
    );

    process.env.JOBOPS_MCP_GHOSTWRITER_TIMEOUT_MS = "300";
    callJsonMock.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () =>
            resolve({ success: false, error: "aborted" }),
          );
        }),
    );
    const timedOut = expectToolError(
      await callTool(baseUrl, writeToken, "ghostwriter_send_message", {
        jobId,
        content: "Write something very long.",
      }),
      "REQUEST_TIMEOUT",
    );
    expect(timedOut.message).toContain("cancelled");

    // The timed-out generation is cancelled, so the thread is free again.
    callJsonMock.mockResolvedValue({
      success: true,
      data: { response: "Second reply" },
    });
    let retry = await callTool(
      baseUrl,
      writeToken,
      "ghostwriter_send_message",
      {
        jobId,
        content: "Try again.",
      },
    );
    for (let attempt = 0; attempt < 20 && retry.isError; attempt += 1) {
      expect(retry.structuredContent.error.code).toBe("CONFLICT");
      await new Promise((resolve) => setTimeout(resolve, 50));
      retry = await callTool(baseUrl, writeToken, "ghostwriter_send_message", {
        jobId,
        content: "Try again.",
      });
    }
    expect(expectToolOk(retry).reply).toBe("Second reply");

    // Another user can neither read nor write this job's conversation.
    const adamSession = await createUserSession(baseUrl, adminSession, "adam");
    const adamToken = (await createAccessToken(baseUrl, adamSession, "write"))
      .secret;
    const callsBefore = callJsonMock.mock.calls.length;
    expectToolError(
      await callTool(baseUrl, adamToken, "ghostwriter_list_messages", {
        jobId,
      }),
      "NOT_FOUND",
    );
    expectToolError(
      await callTool(baseUrl, adamToken, "ghostwriter_send_message", {
        jobId,
        content: "Show me their cover letter.",
      }),
      "NOT_FOUND",
    );
    expect(callJsonMock.mock.calls.length).toBe(callsBefore);
    expect(
      expectToolOk(
        await callTool(baseUrl, writeToken, "ghostwriter_list_messages", {
          jobId,
        }),
      ).total,
    ).toBe(6);
  });

  it("cancels the Ghostwriter generation when the client disconnects", async () => {
    const jobId = await importJob(baseUrl, adminSession, "Data Engineer");
    let generationAborted = false;
    callJsonMock.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            generationAborted = true;
            resolve({ success: false, error: "aborted" });
          });
        }),
    );

    const client = new AbortController();
    const pending = fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: jsonHeaders(writeToken),
      signal: client.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "ghostwriter_send_message",
          arguments: { jobId, content: "Write a long essay." },
        },
      }),
    }).catch((error: unknown) => error);

    for (let i = 0; i < 100 && callJsonMock.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(callJsonMock).toHaveBeenCalledTimes(1);
    client.abort();
    await pending;

    // The default limit is minutes; only the disconnect can stop it this fast.
    for (let i = 0; i < 100 && !generationAborted; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(generationAborted).toBe(true);
  });

  it("searches visa sponsors", async () => {
    const visaSponsors = await import("@server/services/visa-sponsors/index");
    vi.mocked(visaSponsors.searchSponsors).mockResolvedValueOnce([
      {
        providerId: "uk",
        countryKey: "united kingdom",
        sponsor: { organisationName: "Acme Ltd" },
        score: 92,
        matchedName: "acme",
      } as never,
    ]);
    const result = expectToolOk(
      await callTool(baseUrl, writeToken, "search_visa_sponsors", {
        query: "Acme",
        country: "United Kingdom",
        limit: 5,
      }),
    );
    expect(result).toMatchObject({ query: "Acme", total: 1 });
    expect(visaSponsors.searchSponsors).toHaveBeenCalledWith("Acme", {
      limit: 5,
      minScore: undefined,
      countryKey: "united kingdom",
    });
    expectToolError(
      await callTool(baseUrl, writeToken, "search_visa_sponsors", {
        query: "",
      }),
      "INVALID_REQUEST",
    );
  });

  it("lists and resolves post-application inbox items", async () => {
    const { createJob } = await import("@server/repositories/jobs");
    const { upsertPostApplicationMessage } = await import(
      "@server/repositories/post-application-messages"
    );
    const seed = (jobId: string) =>
      upsertPostApplicationMessage({
        provider: "gmail",
        accountKey: "default",
        integrationId: null,
        syncRunId: null,
        externalMessageId: randomUUID(),
        fromAddress: "recruiter@acme.example",
        fromDomain: "acme.example",
        senderName: "Acme",
        subject: "Interview invitation",
        receivedAt: Date.now(),
        snippet: "Please schedule an interview.",
        classificationLabel: "interview",
        classificationConfidence: 0.97,
        classificationPayload: { reason: "High confidence" },
        relevanceLlmScore: 97,
        relevanceDecision: "relevant",
        matchConfidence: 97,
        stageTarget: "technical_interview",
        messageType: "interview",
        stageEventPayload: { note: "from test" },
        processingStatus: "pending_user",
        matchedJobId: jobId,
      });
    const [denyId, approveId] = await runAsUser("admin", async () => {
      const job = await createJob({
        source: "manual",
        title: "Frontend Developer",
        employer: "Acme",
        jobUrl: `https://example.com/jobs/${randomUUID()}`,
      });
      const first = await seed(job.id);
      const second = await seed(job.id);
      return [first.message.id, second.message.id];
    });

    const listed = expectToolOk(
      await callTool(baseUrl, writeToken, "list_inbox_items"),
    );
    expect(listed.total).toBe(2);
    expect(listed.items[0].matchedJob).toMatchObject({
      title: "Frontend Developer",
    });

    // Another user sees and decides none of these items.
    const adamSession = await createUserSession(baseUrl, adminSession, "adam");
    const adamToken = (await createAccessToken(baseUrl, adamSession, "write"))
      .secret;
    expect(
      expectToolOk(await callTool(baseUrl, adamToken, "list_inbox_items"))
        .total,
    ).toBe(0);
    expectToolError(
      await callTool(baseUrl, adamToken, "resolve_inbox_item", {
        messageId: denyId,
        decision: "deny",
      }),
      "NOT_FOUND",
    );
    expect(
      expectToolOk(await callTool(baseUrl, writeToken, "list_inbox_items"))
        .total,
    ).toBe(2);

    const denied = expectToolOk(
      await callTool(baseUrl, writeToken, "resolve_inbox_item", {
        messageId: denyId,
        decision: "deny",
      }),
    );
    expect(denied).toMatchObject({
      decision: "deny",
      message: { processingStatus: "ignored", decidedBy: "agent:admin" },
    });
    expectToolError(
      await callTool(baseUrl, writeToken, "resolve_inbox_item", {
        messageId: denyId,
        decision: "deny",
      }),
      "CONFLICT",
    );

    const approved = expectToolOk(
      await callTool(baseUrl, writeToken, "resolve_inbox_item", {
        messageId: approveId,
        decision: "approve",
      }),
    );
    expect(approved.decision).toBe("approve");
    expect(approved.message.processingStatus).not.toBe("pending_user");
    expect(
      expectToolOk(await callTool(baseUrl, writeToken, "list_inbox_items"))
        .total,
    ).toBe(0);

    expectToolError(
      await callTool(baseUrl, writeToken, "resolve_inbox_item", {
        messageId: randomUUID(),
        decision: "approve",
      }),
      "NOT_FOUND",
    );
  });
});
