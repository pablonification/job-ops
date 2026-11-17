/**
 * Server instructions sent at `initialize`. Clients may truncate long text,
 * so the essentials come first.
 */
export const MCP_SERVER_INSTRUCTIONS = `JobOps is the user's self-hosted job search assistant. It discovers job postings from job boards (pipeline runs), scores each job's suitability against the user's master resume (0-100), tailors the resume per job and generates PDFs, and tracks applications through stages and outcomes.

How the tools fit together:
- Start with get_app_status to see who you act as, your token scope (read or write) and whether a master resume exists.
- Find jobs with list_jobs (filters: statuses, query, score range, sources, employer, dates, hasPdf; paginate with limit/offset and nextOffset). It returns compact summaries; call get_job for the full description, score reason and tailored fields.
- Job statuses: discovered (new), processing, ready (tailored PDF exists), applied, in_progress (interviewing), skipped, expired.
- Acting on jobs (write scope): rescore_job, tailor_job then generate_job_pdf (or process_job for both, discovered jobs only), skip_job, update_job, delete_job, bulk_job_action, import_job, notes tools, and for applications mark_job_applied, transition_job_stage, set_job_outcome; get_job_timeline and get_job_pdf_link read. Model and PDF tools take up to a minute and return the updated job; a busy job gives a CONFLICT error, so wait and poll get_job. Only call mark_job_applied after the user really applied.
- get_job_counts gives totals per status; get_pipeline_status shows whether discovery is running and recent run results; get_profile summarises the master resume and lists project ids.
- Tools marked read-only never change data. Write tools need a token with write scope; a read token gets a FORBIDDEN tool error.
- Errors come back as tool results with isError and { error: { code, message } }. NOT_FOUND means the id does not exist for this user.`;
