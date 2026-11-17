import type { DesignResumeJson } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDefaultReactiveResumeDocument } from "../rxresume/document";

const modelSelection = vi.hoisted(() => ({
  resolveLlmRuntimeSettings: vi.fn(),
}));

const designResumeService = vi.hoisted(() => ({
  replaceCurrentDesignResumeDocument: vi.fn(),
}));

const requestContext = vi.hoisted(() => ({
  getRequestContext: vi.fn(() => ({ requestId: "req-sdk" })),
  getRequestId: vi.fn(() => "req-sdk"),
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

import pdfParse from "pdf-parse";
import { importDesignResumeFromFile } from "./import-file";

describe("importDesignResumeFromFile (claude_agent_sdk)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callJsonMock.mockResolvedValue({
      text: JSON.stringify(buildDefaultReactiveResumeDocument()),
    });
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

  it("extracts PDF text locally and sends only the text to Claude (subscription)", async () => {
    await importDesignResumeFromFile({
      fileName: "resume.pdf",
      mediaType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4 fake").toString("base64"),
    });

    expect(callJsonMock).toHaveBeenCalledOnce();
    expect(vi.mocked(pdfParse)).toHaveBeenCalledOnce();
    const [request] = callJsonMock.mock.calls[0] as [
      { model: string; messages: Array<{ role: string; content: unknown }> },
    ];
    expect(request.model).toBe("sonnet");
    expect(request.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
    ]);
    expect(typeof request.messages[1].content).toBe("string");
    expect(request.messages[1].content).toContain("Jane Doe");
  });
});
