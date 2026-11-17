import { describe, expect, it } from "vitest";
import { DEFAULT_LLM_BREAKER_POLICY } from "./breaker";
import { parseFallbackProvider, resolveLlmFallbackConfig } from "./config";

function env(values: Record<string, string>) {
  return (key: string) => values[key];
}

const local = () => false;

const MUSE = {
  LLM_FALLBACK_PROVIDER: "openai-compatible",
  LLM_FALLBACK_MODEL: "muse-spark-1.2",
  LLM_FALLBACK_BASE_URL: "https://api.meta.ai/v1",
  LLM_FALLBACK_API_KEY: "muse-key",
};

describe("resolveLlmFallbackConfig", () => {
  it("is absent when nothing is set", () => {
    expect(resolveLlmFallbackConfig(env({}), local)).toEqual({
      state: "absent",
      forced: false,
    });
  });

  it("reads a complete OpenAI-compatible fallback with default breaker policy", () => {
    expect(resolveLlmFallbackConfig(env(MUSE), local)).toEqual({
      state: "ready",
      forced: false,
      target: {
        provider: "openai_compatible",
        model: "muse-spark-1.2",
        baseUrl: "https://api.meta.ai/v1",
        apiKey: "muse-key",
      },
      breaker: DEFAULT_LLM_BREAKER_POLICY,
    });
  });

  it("reads the force flag and breaker overrides", () => {
    const config = resolveLlmFallbackConfig(
      env({
        ...MUSE,
        LLM_FORCE_FALLBACK: "true",
        LLM_FALLBACK_BREAKER_THRESHOLD: "5",
        LLM_FALLBACK_BREAKER_COOLDOWN_MS: "60000",
      }),
      local,
    );
    expect(config).toMatchObject({
      state: "ready",
      forced: true,
      breaker: { threshold: 5, cooldownMs: 60_000 },
    });
  });

  it("falls back to default breaker values for junk numbers", () => {
    const config = resolveLlmFallbackConfig(
      env({
        ...MUSE,
        LLM_FALLBACK_BREAKER_THRESHOLD: "-1",
        LLM_FALLBACK_BREAKER_COOLDOWN_MS: "soon",
      }),
      local,
    );
    expect(config).toMatchObject({ breaker: DEFAULT_LLM_BREAKER_POLICY });
  });

  it.each([
    [
      { ...MUSE, LLM_FALLBACK_PROVIDER: "" },
      "LLM_FALLBACK_PROVIDER is not set.",
    ],
    [
      { ...MUSE, LLM_FALLBACK_PROVIDER: "muse" },
      'LLM_FALLBACK_PROVIDER "muse" is not a known provider. Use one of: atlascloud, litellm, openrouter, orcarouter, requesty, api_route, lmstudio, ollama, openai, anthropic, openai_compatible, glm, gemini, gemini_cli, claude_cli, claude_agent_sdk, codex.',
    ],
    [{ ...MUSE, LLM_FALLBACK_MODEL: "" }, "LLM_FALLBACK_MODEL is not set."],
    [
      { ...MUSE, LLM_FALLBACK_BASE_URL: "" },
      "LLM_FALLBACK_BASE_URL is required for an OpenAI-compatible fallback.",
    ],
    [
      { ...MUSE, LLM_FALLBACK_API_KEY: "" },
      "LLM_FALLBACK_API_KEY is required for the openai_compatible fallback.",
    ],
  ])("reports a misconfiguration instead of throwing (%#)", (values, reason) => {
    const config = resolveLlmFallbackConfig(env(values), local);
    expect(config).toMatchObject({ state: "invalid", reason });
    expect(JSON.stringify(config)).not.toContain("muse-key");
  });

  it("says why when forced without a fallback", () => {
    expect(
      resolveLlmFallbackConfig(env({ LLM_FORCE_FALLBACK: "1" }), local),
    ).toMatchObject({
      state: "invalid",
      forced: true,
    });
  });

  it("accepts a CLI provider without key or base URL", () => {
    expect(
      resolveLlmFallbackConfig(
        env({
          LLM_FALLBACK_PROVIDER: "claude_agent_sdk",
          LLM_FALLBACK_MODEL: "sonnet",
        }),
        local,
      ),
    ).toMatchObject({
      state: "ready",
      target: { provider: "claude_agent_sdk", apiKey: null },
    });
  });

  it("is disabled in hosted mode, including the force flag", () => {
    expect(
      resolveLlmFallbackConfig(
        env({ ...MUSE, LLM_FORCE_FALLBACK: "true" }),
        () => true,
      ),
    ).toEqual({ state: "absent", forced: false });
  });

  it("is disabled when the app mode cannot be read", () => {
    expect(resolveLlmFallbackConfig(env(MUSE), () => null)).toEqual({
      state: "absent",
      forced: false,
    });
  });
});

describe("parseFallbackProvider", () => {
  it.each([
    ["openai-compatible", "openai_compatible"],
    ["Claude_Agent_SDK", "claude_agent_sdk"],
    ["openrouter", "openrouter"],
  ])("%s → %s", (raw, expected) => {
    expect(parseFallbackProvider(raw)).toBe(expected);
  });

  it("rejects unknown names and aliases instead of guessing", () => {
    expect(parseFallbackProvider("muse")).toBeNull();
    expect(parseFallbackProvider("claude")).toBeNull();
    expect(parseFallbackProvider("atlas_cloud")).toBeNull();
  });
});
