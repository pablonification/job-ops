import { badRequest, notFound } from "@infra/errors";
import { jobNoteSchema } from "@server/api/routes/jobs/shared";
import {
  defineTool,
  defineToolGroup,
  jobIdInput,
  paginateArray,
  paginationShape,
} from "@server/mcp/kit";
import * as jobsRepo from "@server/repositories/jobs";
import { requireJob } from "@server/services/jobs/common";
import { z } from "zod";

const noteIdInput = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("Note id from list_job_notes.");
const noteTitleInput = z
  .string()
  .describe("Short title, 1-120 characters after trimming.");
const noteContentInput = z
  .string()
  .describe("Note text (Markdown is fine), 1-20000 characters.");

const listJobNotes = defineTool({
  name: "list_job_notes",
  title: "List a job's notes",
  description:
    "The user's notes on one job (title and content), most recently updated first, with pagination.",
  scope: "read",
  input: z.object({ jobId: jobIdInput, ...paginationShape }).strict(),
  handler: async ({ jobId, limit, offset }) => {
    await requireJob(jobId);
    const { items, page } = paginateArray(await jobsRepo.listJobNotes(jobId), {
      limit,
      offset,
    });
    return { notes: items, ...page };
  },
});

const addJobNote = defineTool({
  name: "add_job_note",
  title: "Add a note to a job",
  description:
    "Add a note to a job, for example research on the company, interview prep or contacts.",
  scope: "write",
  input: z
    .object({
      jobId: jobIdInput,
      title: noteTitleInput,
      content: noteContentInput,
    })
    .strict(),
  handler: async ({ jobId, title, content }) => {
    await requireJob(jobId);
    const note = await jobsRepo.createJobNote({
      jobId,
      ...jobNoteSchema.parse({ title, content }),
    });
    return { note };
  },
});

const updateJobNote = defineTool({
  name: "update_job_note",
  title: "Edit a job note",
  description:
    "Change a note's title and/or content. Fields left out keep their current value.",
  scope: "write",
  idempotent: true,
  input: z
    .object({
      jobId: jobIdInput,
      noteId: noteIdInput,
      title: noteTitleInput.optional(),
      content: noteContentInput.optional(),
    })
    .strict(),
  handler: async ({ jobId, noteId, title, content }) => {
    if (title === undefined && content === undefined) {
      throw badRequest("Provide title, content or both.");
    }
    await requireJob(jobId);
    const [existing] = await jobsRepo.listJobNotesByIds(jobId, [noteId]);
    if (!existing) throw notFound("Job note not found");
    const note = await jobsRepo.updateJobNote({
      jobId,
      noteId,
      ...jobNoteSchema.parse({
        title: title ?? existing.title,
        content: content ?? existing.content,
      }),
    });
    if (!note) throw notFound("Job note not found");
    return { note };
  },
});

const deleteJobNote = defineTool({
  name: "delete_job_note",
  title: "Delete a job note",
  description: "Permanently delete one note from a job.",
  scope: "write",
  destructive: true,
  input: z.object({ jobId: jobIdInput, noteId: noteIdInput }).strict(),
  handler: async ({ jobId, noteId }) => {
    await requireJob(jobId);
    const deletedCount = await jobsRepo.deleteJobNote({ jobId, noteId });
    if (deletedCount === 0) throw notFound("Job note not found");
    return { deleted: true, jobId, noteId };
  },
});

export const jobNotesToolGroup = defineToolGroup({
  id: "job-notes",
  tools: [listJobNotes, addJobNote, updateJobNote, deleteJobNote],
});
