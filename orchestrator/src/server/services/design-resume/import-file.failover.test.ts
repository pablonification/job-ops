import type { DesignResumeJson } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDefaultReactiveResumeDocument } from "../rxresume/document";

const modelSelection = vi.hoisted(() => ({
  resolveLlmRuntimeSettings: vi.fn(),
}));

const designResumeService = vi.hoisted(() => ({
  replaceCurrentDesignResumeDocument: vi.fn(),
}));

const requestContext = vi.hoisted(() => ({
  getRequestContext: vi.fn(() => ({ requestId: "req-failover" })),
  getRequestId: vi.fn(() => "req-failover"),
  getTenantId: vi.fn(() => "tenant-1"),
}));

const { callJsonMock, MockClaudeAgentSdkClass } = vi.hoisted(() => {
  const callJson = vi.fn();
  class MockClaudeAgentSdkClass {
    callJson = callJson;
  }
  return { callJsonMock: callJson, MockClaudeAgentSdkClass };
});

vi.mock("@server/services/modelSelection", () => modelSelection);
vi.mock("./index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./index")>()),
  ...designResumeService,
}));
vi.mock("@server/infra/request-context", () => requestContext);
vi.mock("pdf-parse", () => ({
  default: vi.fn().mockResolvedValue({ text: "Jane Doe\nSoftware Engineer" }),
}));
vi.mock("@server/services/llm/claude-agent-sdk/client", () => ({
  ClaudeAgentSdkClient: MockClaudeAgentSdkClass,
}));

import { llmCircuitBreaker } from "../llm/failover/breaker";
import { importDesignResumeFromFile } from "./import-file";

const FALLBACK_URL = "https://fallback.example/v1";
const PDF_INPUT = {
  fileName: "resume.pdf",
  mediaType: "application/pdf",
  dataBase64: Buffer.from("%PDF-1.4 fake").toString("base64"),
};

function setFallbackEnv() {
  process.env.LLM_FALLBACK_PROVIDER = "openai_compatible";
  process.env.LLM_FALLBACK_MODEL = "muse-spark-1.2";
  process.env.LLM_FALLBACK_BASE_URL = FALLBACK_URL;
  process.env.LLM_FALLBACK_API_KEY = "fallback-secret-key";
}

function mockFallbackFetch(response: () => Response) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => response());
}

describe("importDesignResumeFromFile failover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    llmCircuitBreaker.reset();
    modelSelection.resolveLlmRuntimeSettings.mockResolvedValue({
      provider: "claude_agent_sdk",
      model: "sonnet",
      baseUrl: null,
      apiKey: null,
    });
    designResumeService.replaceCurrentDesignResumeDocument.mockImplementation(
      async ({ resumeJson }: { resumeJson: DesignResumeJson }) => ({
        id: "primary",
        title: "Imported",
        resumeJson,
        revision: 1,
        sourceResumeId: null,
        sourceMode: null,
        importedAt: "2026-04-27T00:00:00.000Z",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
        assets: [],
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LLM_FALLBACK_PROVIDER;
    delete process.env.LLM_FALLBACK_MODEL;
    delete process.env.LLM_FALLBACK_BASE_URL;
    delete process.env.LLM_FALLBACK_API_KEY;
  });

  it("imports through the fallback when Claude (subscription) hits its usage limit", async () => {
    setFallbackEnv();
    callJsonMock.mockRejectedValue(
      new Error("Claude (subscription) usage limit reached: resets 5pm"),
    );
    const fetchSpy = mockFallbackFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify(buildDefaultReactiveResumeDocument()),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    await importDesignResumeFromFile(PDF_INPUT);

    expect(callJsonMock).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${FALLBACK_URL}/chat/completions`);
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("muse-spark-1.2");
    expect(JSON.stringify(body.messages)).toContain("Jane Doe");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer fallback-secret-key",
    );
    expect(
      designResumeService.replaceCurrentDesignResumeDocument,
    ).toHaveBeenCalledOnce();
  });

  it("throws the fallback's own error when the fallback also fails", async () => {
    setFallbackEnv();
    callJsonMock.mockRejectedValue(
      new Error("Claude (subscription) is not authenticated."),
    );
    mockFallbackFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "fallback down" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(importDesignResumeFromFile(PDF_INPUT)).rejects.toMatchObject({
      status: 502,
      message: "fallback down",
    });
  });

  it("keeps today's behaviour with no fallback configured", async () => {
    callJsonMock.mockRejectedValue(
      new Error("Claude (subscription) usage limit reached: resets 5pm"),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(importDesignResumeFromFile(PDF_INPUT)).rejects.toMatchObject({
      status: 502,
      message: "Claude (subscription) usage limit reached: resets 5pm",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
