import type { AccessTokenScope } from "@shared/types";
import { z } from "zod";

/**
 * What a playbook receives when it is rendered. Prompts are text: they read
 * no user data, but they are fetched by an authenticated caller and adapt to
 * that caller's token scope and the instance's public origin.
 */
export type McpPromptContext = {
  scope: AccessTokenScope;
  /** Public origin of this instance (JOBOPS_PUBLIC_BASE_URL or request host). */
  requestOrigin: string | null;
  now: Date;
};

/**
 * Prompt arguments always arrive as strings (Claude Code passes slash command
 * words in the declared order). Each field parses a string into its typed
 * value; `.describe()` text becomes the argument description and optional
 * fields (or fields with defaults) are listed as not required.
 */
export type McpPromptInputSchema = z.AnyZodObject;

export type McpPromptDefinition<
  Schema extends McpPromptInputSchema = McpPromptInputSchema,
> = {
  /** snake_case, unique; Claude Code shows it as /<server>:<name>. */
  name: string;
  title: string;
  /** One or two sentences: what the playbook does and what it saves. */
  description: string;
  input: Schema;
  render: (input: z.infer<Schema>, context: McpPromptContext) => string;
};

/** Identity helper that keeps `render`'s input type tied to its schema. */
export function definePrompt<Schema extends McpPromptInputSchema>(
  definition: McpPromptDefinition<Schema>,
): McpPromptDefinition {
  return definition as unknown as McpPromptDefinition;
}

/** Blank strings count as "not given", so defaults apply. */
function blankToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

/**
 * A required job id argument. Ids are UUIDs; the pattern also refuses
 * anything that could change the meaning of the text it is placed in.
 */
export function promptJobIdArg() {
  return z
    .string()
    .trim()
    .min(1, "jobId is required")
    .regex(
      /^[A-Za-z0-9_-]{1,64}$/,
      "jobId must be a job id: letters, digits, - and _ only (at most 64)",
    )
    .describe("Job id (from list_jobs or the job page URL in JobOps).");
}

/** An optional whole number within a range, with a default. */
export function promptIntArg(options: {
  min: number;
  max: number;
  default: number;
  description: string;
}) {
  return z
    .preprocess(
      blankToUndefined,
      z.coerce
        .number({ invalid_type_error: "Expected a whole number" })
        .int("Expected a whole number")
        .min(options.min)
        .max(options.max)
        .default(options.default),
    )
    .describe(
      `${options.description} ${options.min}-${options.max}, default ${options.default}.`,
    );
}

/**
 * An optional choice among `values`. Matching ignores case, and `aliases`
 * maps friendlier words (e.g. "english") to a value.
 */
export function promptChoiceArg<
  const Values extends readonly [string, ...string[]],
>(options: {
  values: Values;
  aliases?: Record<string, Values[number]>;
  description: string;
}) {
  return z
    .preprocess((value) => {
      const blank = blankToUndefined(value);
      if (typeof blank !== "string") return blank;
      const key = blank.trim().toLowerCase();
      return options.aliases?.[key] ?? key;
    }, z.enum(options.values).optional())
    .describe(options.description);
}

/** MCP `prompts/list` argument entries, derived from the input schema. */
export function toPromptArguments(schema: McpPromptInputSchema): Array<{
  name: string;
  description?: string;
  required: boolean;
}> {
  return Object.entries(schema.shape as Record<string, z.ZodTypeAny>).map(
    ([name, field]) => ({
      name,
      ...(field.description ? { description: field.description } : {}),
      required: !field.isOptional(),
    }),
  );
}
