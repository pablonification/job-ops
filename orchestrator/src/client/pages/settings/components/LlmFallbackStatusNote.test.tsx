import type { LlmFallbackStatus } from "@shared/types.js";
import { render, screen } from "@testing-library/react";
import { LlmFallbackStatusNote } from "./LlmFallbackStatusNote";

const BASE: LlmFallbackStatus = {
  configured: true,
  active: true,
  provider: "openai_compatible",
  model: "muse-spark-1.2",
  forced: false,
  tripped: false,
  trippedUntil: null,
  inactiveReason: null,
  lastFailover: null,
};

describe("LlmFallbackStatusNote", () => {
  it("renders nothing without a fallback", () => {
    const { container } = render(
      <LlmFallbackStatusNote
        status={{
          ...BASE,
          configured: false,
          active: false,
          provider: null,
          model: null,
        }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("names the standby fallback model", () => {
    render(<LlmFallbackStatusNote status={BASE} />);
    expect(screen.getByTestId("llm-fallback-status")).toHaveTextContent(
      "Fallback model: OpenAI-compatible · muse-spark-1.2",
    );
  });

  it("says when every request is forced to the fallback", () => {
    render(<LlmFallbackStatusNote status={{ ...BASE, forced: true }} />);
    expect(screen.getByTestId("llm-fallback-status")).toHaveTextContent(
      "All AI requests are using the fallback model",
    );
    expect(screen.getByTestId("llm-fallback-status")).toHaveTextContent(
      "LLM_FORCE_FALLBACK",
    );
  });

  it("says when the fallback is in use because the primary is tripped", () => {
    render(
      <LlmFallbackStatusNote
        status={{
          ...BASE,
          tripped: true,
          trippedUntil: "2026-11-17T10:05:00.000Z",
        }}
      />,
    );
    expect(screen.getByTestId("llm-fallback-status")).toHaveTextContent(
      "AI requests are currently using the fallback model",
    );
  });

  it("mentions the last failover and why", () => {
    render(
      <LlmFallbackStatusNote
        status={{
          ...BASE,
          lastFailover: {
            at: "2026-11-17T09:00:00.000Z",
            reason: "usage_limit",
          },
        }}
      />,
    );
    expect(screen.getByTestId("llm-fallback-status")).toHaveTextContent(
      "because the primary hit a usage limit",
    );
  });

  it("explains why a configured fallback is not active", () => {
    render(
      <LlmFallbackStatusNote
        status={{
          ...BASE,
          configured: false,
          active: false,
          inactiveReason: "LLM_FALLBACK_MODEL is not set.",
        }}
      />,
    );
    expect(screen.getByTestId("llm-fallback-status")).toHaveTextContent(
      "Fallback model is not active.",
    );
    expect(screen.getByTestId("llm-fallback-status")).toHaveTextContent(
      "LLM_FALLBACK_MODEL is not set.",
    );
  });
});
