import { getRequestContext } from "@infra/request-context";
import {
  defineTool,
  defineToolGroup,
  paginateArray,
  paginationShape,
} from "@server/mcp/kit";
import {
  approvePostApplicationInboxItem,
  denyPostApplicationInboxItem,
  listPostApplicationInbox,
} from "@server/services/post-application/review";
import {
  APPLICATION_STAGES,
  POST_APPLICATION_PROVIDERS,
  POST_APPLICATION_ROUTER_STAGE_TARGETS,
} from "@shared/types";
import { z } from "zod";

/** Pending items read per call; the inbox is a review queue, not an archive. */
const INBOX_SCAN_LIMIT = 500;

const mailboxShape = {
  provider: z
    .enum(POST_APPLICATION_PROVIDERS)
    .default("gmail")
    .describe("Mailbox provider. Default gmail."),
  accountKey: z
    .string()
    .min(1)
    .max(255)
    .default("default")
    .describe("Mailbox account key. Default 'default'."),
};

const listInboxItemsTool = defineTool({
  name: "list_inbox_items",
  title: "List the application inbox",
  description:
    "Recruiter emails waiting for review in the post-application inbox (interview invites, rejections, offers), each with its suggested job and stage change. Approve or deny them with resolve_inbox_item. total counts at most 500 pending items.",
  scope: "read",
  input: z.object({ ...mailboxShape, ...paginationShape }).strict(),
  handler: async ({ provider, accountKey, limit, offset }) => {
    const items = await listPostApplicationInbox({
      provider,
      accountKey,
      limit: INBOX_SCAN_LIMIT,
    });
    const page = paginateArray(items, { limit, offset });
    return { items: page.items, ...page.page };
  },
});

const resolveInboxItemTool = defineTool({
  name: "resolve_inbox_item",
  title: "Approve or deny an inbox item",
  description:
    "Decide one post-application inbox item. approve links the email to a job (the suggested one unless jobId is given) and records the stage change; deny ignores the email. Fails with CONFLICT if the item was already decided.",
  scope: "write",
  input: z
    .object({
      messageId: z.string().uuid().describe("Inbox item message id."),
      decision: z.enum(["approve", "deny"]),
      ...mailboxShape,
      jobId: z
        .string()
        .uuid()
        .optional()
        .describe("approve only: link to this job instead of the suggestion."),
      stageTarget: z
        .enum(POST_APPLICATION_ROUTER_STAGE_TARGETS)
        .optional()
        .describe("approve only: override the suggested stage change."),
      toStage: z
        .enum(APPLICATION_STAGES)
        .optional()
        .describe("approve only: application stage to move the job to."),
      note: z
        .string()
        .max(2000)
        .optional()
        .describe("approve only: note saved with the stage event."),
    })
    .strict(),
  handler: async (input) => {
    const username = getRequestContext()?.username;
    const decidedBy = username ? `agent:${username}` : "agent";
    if (input.decision === "deny") {
      return {
        decision: "deny",
        ...(await denyPostApplicationInboxItem({
          messageId: input.messageId,
          provider: input.provider,
          accountKey: input.accountKey,
          decidedBy,
        })),
      };
    }
    return {
      decision: "approve",
      ...(await approvePostApplicationInboxItem({
        messageId: input.messageId,
        provider: input.provider,
        accountKey: input.accountKey,
        jobId: input.jobId,
        stageTarget: input.stageTarget,
        toStage: input.toStage,
        note: input.note,
        decidedBy,
      })),
    };
  },
});

export const inboxToolGroup = defineToolGroup({
  id: "inbox",
  tools: [listInboxItemsTool, resolveInboxItemTool],
});
