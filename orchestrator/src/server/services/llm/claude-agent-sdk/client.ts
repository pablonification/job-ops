import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { logger } from "@infra/logger";
import { DEFAULT_CLAUDE_AGENT_SDK_MODEL } from "@shared/settings-registry";
import {
  getLlmMessageText,
  type JsonSchemaDefinition,
  type LlmMessage,
  type LlmRequestOptions,
  type LlmValidationResult,
} from "../types";
import { truncate } from "../utils/string";
import { ConcurrencyLimiter } from "./concurrency";
import { ClaudeAgentSdkError, classifyClaudeAgentSdkError } from "./errors";

/** Aliases resolve to the newest model of each family on the subscription. */
export const CLAUDE_AGENT_SDK_SUGGESTED_MODELS: string[] = [
  "sonnet",
  "opus",
  "haiku",
];

const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_VALIDATION_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_MAX_TURNS = 4;
const VALIDATION_SUCCESS_TTL_MS = 30 * 60_000;
const VALIDATION_FAILURE_TTL_MS = 60_000;
const MAX_STDERR_LINES = 20;
const VALIDATION_MODEL = "haiku";

const DEFAULT_SYSTEM_PROMPT =
  "You are generating a structured JSON response for JobOps.";

/** Built-in Claude Code tools, removed from the model's context. */
const DISALLOWED_TOOLS = [
  "Agent",
  "Bash",
  "BashOutput",
  "Edit",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "KillShell",
  "ListMcpResources",
  "MultiEdit",
  "NotebookEdit",
  "Read",
  "ReadMcpResource",
  "Skill",
  "SlashCommand",
  "Task",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
];

/**
 * Environment variables passed through to the Claude Code subprocess. The SDK
 * replaces the child environment with `options.env`, so this is an allowlist:
 * app secrets (LLM_API_KEY, JWT secrets, ...) never reach the subprocess, and
 * neither do API-key style Anthropic variables, which would silently take
 * precedence over the subscription token.
 */
const PASSTHROUGH_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
];

/** Never forwarded, even if a future allowlist change would match them. */
const BLOCKED_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
]);

type ProcessEnv = Record<string, string | undefined>;

function getPositiveIntEnv(
  env: ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

const sharedLimiter = new ConcurrencyLimiter(() =>
  getPositiveIntEnv(
    process.env,
    "CLAUDE_AGENT_SDK_MAX_CONCURRENCY",
    DEFAULT_MAX_CONCURRENCY,
  ),
);

export function buildClaudeAgentSdkEnv(
  source: ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV_KEYS) {
    if (BLOCKED_ENV_KEYS.has(key)) continue;
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  // Settings sources are disabled, but auto memory is read independently.
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  return env;
}

export type ClaudeAgentSdkQueryFn = (args: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

const defaultQueryFn: ClaudeAgentSdkQueryFn = async function* (args) {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  yield* sdk.query(args);
};

type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";

type UserContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: ImageMediaType; data: string };
    };

function hasImageInput(messages: LlmMessage[]): boolean {
  return messages.some(
    (message) =>
      typeof message.content !== "string" &&
      message.content.some((part) => part.type === "image"),
  );
}

function buildSystemPrompt(messages: LlmMessage[]): string {
  const text = messages
    .filter((message) => message.role === "system")
    .map((message) => getLlmMessageText(message.content).trim())
    .filter(Boolean)
    .join("\n\n");
  return text || DEFAULT_SYSTEM_PROMPT;
}

function conversationMessages(messages: LlmMessage[]): LlmMessage[] {
  return messages.filter((message) => message.role !== "system");
}

/**
 * A single user turn is sent as-is. Multi-turn history (Ghostwriter) has no
 * native representation in a one-shot query, so it is flattened into a
 * labelled transcript, like the Claude CLI provider does.
 */
function needsTranscript(messages: LlmMessage[]): boolean {
  return !(messages.length === 1 && messages[0].role === "user");
}

function transcriptHeader(index: number, role: LlmMessage["role"]): string {
  return `Message ${index + 1} (${role.toUpperCase()}):`;
}

function buildTextPrompt(messages: LlmMessage[]): string {
  const conversation = conversationMessages(messages);
  if (conversation.length === 0) {
    return "Return the structured output exactly as instructed.";
  }
  if (!needsTranscript(conversation)) {
    return getLlmMessageText(conversation[0].content).trim();
  }
  return [
    "Conversation transcript (reply to the final message):",
    "",
    conversation
      .map(
        (message, index) =>
          `${transcriptHeader(index, message.role)}\n${getLlmMessageText(message.content).trim()}`,
      )
      .join("\n\n"),
  ].join("\n");
}

function parseImageDataUrl(imageUrl: string): {
  mediaType: ImageMediaType;
  data: string;
} {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s.exec(imageUrl);
  if (!match) {
    throw new ClaudeAgentSdkError(
      "other",
      "Image input must be a PNG, JPEG, or WebP base64 data URL",
    );
  }
  return { mediaType: match[1] as ImageMediaType, data: match[2] };
}

function buildContentBlocks(messages: LlmMessage[]): UserContentBlock[] {
  const conversation = conversationMessages(messages);
  const transcript = needsTranscript(conversation);
  const blocks: UserContentBlock[] = [];
  if (transcript) {
    blocks.push({
      type: "text",
      text: "Conversation transcript (reply to the final message):",
    });
  }
  conversation.forEach((message, index) => {
    if (transcript) {
      blocks.push({
        type: "text",
        text: transcriptHeader(index, message.role),
      });
    }
    if (typeof message.content === "string") {
      blocks.push({ type: "text", text: message.content.trim() });
      return;
    }
    for (const part of message.content) {
      if (part.type === "text") {
        blocks.push({ type: "text", text: part.text });
        continue;
      }
      const image = parseImageDataUrl(part.imageUrl);
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: image.mediaType,
          data: image.data,
        },
      });
    }
  });
  return blocks.filter((block) => block.type !== "text" || block.text);
}

async function* singleUserMessage(
  content: UserContentBlock[],
): AsyncIterable<SDKUserMessage> {
  const message: SDKUserMessage = {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
  yield message;
}

type ResultLike = {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  errors?: unknown;
  api_error_status?: unknown;
};

function readResultError(message: ResultLike): string {
  const status =
    typeof message.api_error_status === "number"
      ? ` (API error ${message.api_error_status})`
      : "";
  return `${readResultErrorText(message)}${status}`;
}

function readResultErrorText(message: ResultLike): string {
  if (Array.isArray(message.errors)) {
    const joined = message.errors
      .filter((entry): entry is string => typeof entry === "string")
      .join("; ")
      .trim();
    if (joined) return joined;
  }
  if (typeof message.result === "string" && message.result.trim()) {
    return message.result.trim();
  }
  return `Claude Agent SDK reported an error (subtype: ${message.subtype ?? "unknown"})`;
}

function readResultText(message: ResultLike): string {
  if (message.structured_output !== undefined) {
    return JSON.stringify(message.structured_output);
  }
  if (typeof message.result === "string" && message.result.trim()) {
    return message.result.trim();
  }
  throw new ClaudeAgentSdkError(
    "other",
    "The response did not include structured output",
  );
}

/**
 * The SDK marks failed API calls on the assistant message (`error`), e.g.
 * `authentication_failed`, `rate_limit`, `billing_error`, and reports
 * sign-in problems as `auth_status` messages.
 */
function readAssistantError(message: SDKMessage): string | null {
  if (message.type === "assistant") {
    return message.error ?? null;
  }
  if (message.type === "auth_status" && message.error) {
    return `authentication_failed: ${message.error}`;
  }
  return null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ClaudeAgentSdkClientOptions = {
  /** Injected in tests; defaults to the SDK's `query`. */
  queryFn?: ClaudeAgentSdkQueryFn;
  /** Environment to read the token and limits from (default `process.env`). */
  env?: ProcessEnv;
  /** Concurrency limiter (default: one shared, process-wide instance). */
  limiter?: ConcurrencyLimiter;
};

type ValidationCacheEntry = {
  value: LlmValidationResult;
  expiresAtMs: number;
};

// Keyed by a hash of the operator's token (process-level configuration, not
// tenant data), so a status check never re-spends a model request.
const validationCache = new Map<string, ValidationCacheEntry>();
const validationInFlight = new Map<string, Promise<LlmValidationResult>>();

export function clearClaudeAgentSdkValidationCache(): void {
  validationCache.clear();
  validationInFlight.clear();
}

const VALIDATION_SCHEMA: JsonSchemaDefinition = {
  name: "validation",
  schema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
};

export class ClaudeAgentSdkClient {
  private readonly queryFn: ClaudeAgentSdkQueryFn;
  private readonly env: ProcessEnv;
  private readonly limiter: ConcurrencyLimiter;

  constructor(options: ClaudeAgentSdkClientOptions = {}) {
    this.queryFn = options.queryFn ?? defaultQueryFn;
    this.env = options.env ?? process.env;
    this.limiter = options.limiter ?? sharedLimiter;
  }

  listModels(): Promise<string[]> {
    return Promise.resolve([...CLAUDE_AGENT_SDK_SUGGESTED_MODELS]);
  }

  async callJson(
    options: LlmRequestOptions<unknown>,
  ): Promise<{ text: string }> {
    const timeoutMs = getPositiveIntEnv(
      this.env,
      "CLAUDE_AGENT_SDK_REQUEST_TIMEOUT_MS",
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    return this.run({ ...options, timeoutMs });
  }

  /**
   * Checks that a token is configured and, at most once per cache window,
   * that the subscription accepts it with one tiny request.
   */
  async validateCredentials(): Promise<LlmValidationResult> {
    const token = this.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (!token) {
      return {
        valid: false,
        message: new ClaudeAgentSdkError(
          "auth",
          "CLAUDE_CODE_OAUTH_TOKEN is not set",
        ).message,
        username: null,
      };
    }

    const cacheKey = createHash("sha256").update(token).digest("hex");
    const cached = validationCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) return cached.value;

    const inFlight = validationInFlight.get(cacheKey);
    if (inFlight) return inFlight;

    const pending = this.probeCredentials().then((value) => {
      validationCache.set(cacheKey, {
        value,
        expiresAtMs:
          Date.now() +
          (value.valid ? VALIDATION_SUCCESS_TTL_MS : VALIDATION_FAILURE_TTL_MS),
      });
      return value;
    });
    validationInFlight.set(cacheKey, pending);
    try {
      return await pending;
    } finally {
      validationInFlight.delete(cacheKey);
    }
  }

  private async probeCredentials(): Promise<LlmValidationResult> {
    const timeoutMs = getPositiveIntEnv(
      this.env,
      "CLAUDE_AGENT_SDK_VALIDATION_TIMEOUT_MS",
      DEFAULT_VALIDATION_TIMEOUT_MS,
    );
    try {
      await this.run({
        model: VALIDATION_MODEL,
        messages: [{ role: "user", content: 'Reply with {"ok": true}.' }],
        jsonSchema: VALIDATION_SCHEMA,
        timeoutMs,
      });
      return { valid: true, message: null, username: null };
    } catch (error) {
      const message = getErrorMessage(error);
      const kind = classifyClaudeAgentSdkError(message);
      logger.warn("Claude (subscription) credential validation failed", {
        kind,
        message: truncate(message, 200),
      });
      // The token works; the plan is just exhausted or throttled right now.
      if (kind === "usage_limit" || kind === "rate_limit") {
        return { valid: true, message, username: null };
      }
      return { valid: false, message, username: null };
    }
  }

  private async run(
    args: LlmRequestOptions<unknown> & { timeoutMs: number },
  ): Promise<{ text: string }> {
    if (!this.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
      throw new ClaudeAgentSdkError(
        "auth",
        "CLAUDE_CODE_OAUTH_TOKEN is not set",
      );
    }

    const callerSignal = args.signal;
    const abortedError = () => new ClaudeAgentSdkError("aborted");
    if (callerSignal?.aborted) throw abortedError();

    const release = await this.limiter.acquire(callerSignal, abortedError);
    const abortController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, args.timeoutMs);
    const onCallerAbort = () => abortController.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    const stderrLines: string[] = [];
    let workDir: string | null = null;

    try {
      workDir = await mkdtemp(join(tmpdir(), "jobops-claude-sdk-"));
      const options = this.buildOptions({
        model: args.model,
        messages: args.messages,
        jsonSchema: args.jsonSchema,
        cwd: workDir,
        abortController,
        onStderr: (data) => {
          for (const line of data.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            stderrLines.push(trimmed);
            if (stderrLines.length > MAX_STDERR_LINES) stderrLines.shift();
          }
        },
      });
      const prompt = hasImageInput(args.messages)
        ? singleUserMessage(buildContentBlocks(args.messages))
        : buildTextPrompt(args.messages);

      return await this.collect(this.queryFn({ prompt, options }));
    } catch (error) {
      if (timedOut) {
        throw new ClaudeAgentSdkError("timeout", `after ${args.timeoutMs}ms`);
      }
      if (callerSignal?.aborted) throw abortedError();
      if (error instanceof ClaudeAgentSdkError) throw error;
      const message = getErrorMessage(error);
      const stderr = stderrLines.join(" | ");
      const wrapped = ClaudeAgentSdkError.fromMessage(
        stderr && classifyClaudeAgentSdkError(message) === "other"
          ? `${message} (${stderr})`
          : message,
      );
      logger.warn("Claude (subscription) call failed", {
        kind: wrapped.kind,
        model: args.model || DEFAULT_CLAUDE_AGENT_SDK_MODEL,
        jobId: args.jobId ?? null,
        message: truncate(wrapped.message, 300),
      });
      throw wrapped;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      release();
      if (workDir) {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  private async collect(
    stream: AsyncIterable<SDKMessage>,
  ): Promise<{ text: string }> {
    let assistantError: string | null = null;
    let resultError: string | null = null;
    let text: string | null = null;

    try {
      for await (const message of stream) {
        assistantError = readAssistantError(message) ?? assistantError;
        if (message.type !== "result") continue;
        const result = message as unknown as ResultLike;
        if (result.subtype === "success" && !result.is_error) {
          text = readResultText(result);
        } else {
          resultError = readResultError(result);
        }
      }
    } catch (error) {
      // A one-shot query throws after yielding its error result; prefer the
      // more specific information already collected.
      if (!resultError && !assistantError) throw error;
    }

    if (text !== null) return { text };
    const detail = [assistantError, resultError].filter(Boolean).join(": ");
    if (detail) throw ClaudeAgentSdkError.fromMessage(detail);
    throw new ClaudeAgentSdkError(
      "other",
      "The Agent SDK finished without a result",
    );
  }

  private buildOptions(args: {
    model: string;
    messages: LlmMessage[];
    jsonSchema: JsonSchemaDefinition;
    cwd: string;
    abortController: AbortController;
    onStderr: (data: string) => void;
  }): Options {
    const executable = this.env.CLAUDE_AGENT_SDK_EXECUTABLE?.trim();
    return {
      model: args.model?.trim() || DEFAULT_CLAUDE_AGENT_SDK_MODEL,
      systemPrompt: buildSystemPrompt(args.messages),
      tools: [],
      disallowedTools: DISALLOWED_TOOLS,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      persistSession: false,
      maxTurns: getPositiveIntEnv(
        this.env,
        "CLAUDE_AGENT_SDK_MAX_TURNS",
        DEFAULT_MAX_TURNS,
      ),
      cwd: args.cwd,
      abortController: args.abortController,
      env: buildClaudeAgentSdkEnv(this.env),
      outputFormat: { type: "json_schema", schema: args.jsonSchema.schema },
      stderr: args.onStderr,
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    };
  }
}
