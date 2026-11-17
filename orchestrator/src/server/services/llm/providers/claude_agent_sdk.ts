import { createProviderStrategy } from "./factory";

export const claudeAgentSdkStrategy = createProviderStrategy({
  provider: "claude_agent_sdk",
  defaultBaseUrl: "",
  requiresApiKey: false,
  modes: ["none"],
  validationPaths: [],
  buildRequest: () => {
    throw new Error(
      "Claude (subscription) provider does not use HTTP requests.",
    );
  },
  extractText: () => null,
  getValidationUrls: () => [],
});
