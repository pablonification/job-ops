import { requestTimeout } from "@infra/errors";
import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { sanitizeUnknown } from "@infra/sanitize";
import {
  defineTool,
  defineToolGroup,
  paginateArray,
  paginationShape,
} from "@server/mcp/kit";
import * as ghostwriterService from "@server/services/ghostwriter";
import { z } from "zod";

/** Default upper bound for one Ghostwriter reply over MCP. */
export const DEFAULT_GHOSTWRITER_MCP_TIMEOUT_MS = 180_000;

function resolveGhostwriterTimeoutMs(): number {
  const raw = Number(process.env.JOBOPS_MCP_GHOSTWRITER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_GHOSTWRITER_MCP_TIMEOUT_MS;
}

const jobIdInput = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("Job id from list_jobs.");

const contextIdsInput = (what: string) =>
  z
    .array(z.string().trim().min(1).max(200))
    .max(50)
    .optional()
    .describe(
      `${what} ids to give Ghostwriter as context. Omit to keep the current selection.`,
    );

const listMessagesTool = defineTool({
  name: "ghostwriter_list_messages",
  title: "List Ghostwriter messages",
  description:
    "The Ghostwriter conversation for one job (oldest first): the user's prompts and the assistant's replies, plus which notes, emails and documents are selected as context.",
  scope: "read",
  maxResultSizeChars: 200_000,
  input: z.object({ jobId: jobIdInput, ...paginationShape }).strict(),
  handler: async ({ jobId, limit, offset }) => {
    const result = await runWithRequestContext({ jobId }, () =>
      ghostwriterService.listMessagesForJob({ jobId }),
    );
    const { items, page } = paginateArray(result.messages, { limit, offset });
    return {
      messages: items,
      ...page,
      selectedNoteIds: result.selectedNoteIds,
      selectedEmailIds: result.selectedEmailIds,
      selectedDocumentIds: result.selectedDocumentIds,
    };
  },
});

const sendMessageTool = defineTool({
  name: "ghostwriter_send_message",
  title: "Ask Ghostwriter",
  description:
    "Send a message to Ghostwriter, the job-specific writing assistant (cover letters, answers to application questions, outreach), and wait for the complete reply. It knows the job, the master resume and the selected context. Times out after about 3 minutes with REQUEST_TIMEOUT; the generation is then cancelled.",
  scope: "write",
  openWorld: true,
  input: z
    .object({
      jobId: jobIdInput,
      content: z
        .string()
        .trim()
        .min(1)
        .max(20_000)
        .describe("The message to send."),
      selectedNoteIds: contextIdsInput("Job note"),
      selectedEmailIds: contextIdsInput("Job email"),
      selectedDocumentIds: contextIdsInput("Job document"),
    })
    .strict(),
  handler: async (input) =>
    runWithRequestContext({ jobId: input.jobId }, async () => {
      const timeoutMs = resolveGhostwriterTimeoutMs();
      let runId: string | null = null;
      let timedOut = false;

      const cancelRun = (id: string) => {
        void ghostwriterService
          .cancelRunForJob({ jobId: input.jobId, runId: id })
          .catch((error) => {
            logger.warn("MCP could not cancel a timed-out Ghostwriter run", {
              jobId: input.jobId,
              runId: id,
              error: sanitizeUnknown(error),
            });
          });
      };

      const send = ghostwriterService.sendMessageForJob({
        jobId: input.jobId,
        content: input.content,
        selectedNoteIds: input.selectedNoteIds,
        selectedEmailIds: input.selectedEmailIds,
        selectedDocumentIds: input.selectedDocumentIds,
        stream: {
          onReady: (payload) => {
            runId = payload.runId;
            if (timedOut) cancelRun(payload.runId);
          },
          onDelta: () => {},
          onCompleted: () => {},
          onCancelled: () => {},
          onError: () => {},
        },
      });
      // After a timeout the send keeps settling in the background.
      send.catch(() => {});

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          if (runId) cancelRun(runId);
          reject(
            requestTimeout(
              `Ghostwriter did not finish within ${Math.round(timeoutMs / 1000)} seconds, so the generation was cancelled. Try a shorter request or try again.`,
            ),
          );
        }, timeoutMs);
      });

      try {
        const result = await Promise.race([send, timeout]);
        return {
          runId: result.runId,
          reply: result.assistantMessage?.content ?? "",
          assistantMessage: result.assistantMessage,
          userMessage: result.userMessage,
        };
      } finally {
        clearTimeout(timer);
      }
    }),
});

export const ghostwriterToolGroup = defineToolGroup({
  id: "ghostwriter",
  tools: [listMessagesTool, sendMessageTool],
});
