---
id: agent-access
title: Agent Access (MCP)
description: Connect Claude Code or another MCP client to JobOps with a personal access token.
sidebar_position: 15
---

## What it is

Agent access lets an AI agent such as Claude Code use JobOps for you. JobOps runs an authenticated [Model Context Protocol](https://modelcontextprotocol.io) (MCP) endpoint at `/mcp`, and the agent signs in with a **personal access token** you create in Settings.

A token acts as the user who created it. It sees only that user's jobs, profile and pipeline runs, exactly like that user's own browser session.

Available tools:

| Tool | What it does |
| --- | --- |
| `list_jobs` | Search and filter jobs (statuses, free text over title/employer/location, score range, sources, employer, target company, posted or discovered since, has PDF), sorted and paginated. Returns compact summaries with `isTargetCompany`, `total` and `nextOffset`. |
| `get_job` | Full detail for one job: description, score and reason, target-company flag (`isTargetCompany`), tailored resume fields, PDF state. `descriptionMaxChars` truncates the description; `includeDescription: false` leaves it out. |
| `get_job_counts` | Number of jobs per status and in total. |
| `get_pipeline_status` | Whether a pipeline run is active, its progress, and the last five runs. |
| `get_profile` | Summary of your master resume: headline, summary, skills, experience and project ids. Email, phone and photo are left out. |
| `get_app_status` | App mode and version, who the token acts as, its scope, and whether a master resume exists. |

Tools marked read-only never change data, never call the AI model and never run job searches (`get_profile` and `get_settings` may read your resume from Reactive Resume). Write tools need a read and write token.

These tools call the AI model or outside services: `start_pipeline_run` (job sites and the model), `plan_search` and `ghostwriter_send_message` (the model), `check_source_health` (job sites, including billed Apify runs for Seek) and `set_watchlist_sources` (fetches custom career pages). `plan_search` works with a read-only token because it changes no data, but it is not marked read-only because it uses the model.

### Job and application tools

These tools change data and need a **Read and write** token, except the three marked *read*. They call the same code as the buttons on the job page, so the results match the web UI.

| Tool | What it does |
| --- | --- |
| `rescore_job` | Re-run the suitability model for one job. Returns the new score and reason. |
| `tailor_job` | Generate the tailored summary, headline, skills and project selection. `fields` limits it to some of them; existing content is kept unless `force: true`. Does not render the PDF. |
| `generate_job_pdf` | Render the resume PDF from the job's tailored content. Returns the job and the PDF URL. |
| `process_job` | Tailor, then render the PDF, and move a **discovered** job to Ready (the **Move to Ready** button). |
| `skip_job` | Skip a discovered or ready job. |
| `update_job` | Edit title, employer, URLs, location, salary, deadline, description, status, tailored headline/summary/skills/projects, or turn tracer links on or off. Only the fields you pass change. |
| `delete_job` | Delete a job with its notes, history, PDF and documents. Marked destructive. |
| `bulk_job_action` | `skip`, `rescore` or `move_to_ready` over at most 100 job ids, 4 at a time. The call waits until every job is done (it does not return early to poll) and returns a result per job. |
| `import_job` | Add a job from a public posting URL (fetched the same way as in the manual import dialog) or pasted text. The fetched or pasted text is sent to your configured model, which fills in title, employer and the rest; values you pass win. `process: true` tailors and renders it right away; the default follows the **Auto-tailor manually imported jobs** setting. |
| `check_job_sponsor` | Look the employer up in the visa sponsor registers and store the match on the job. |
| `get_job_pdf_link` | *read.* The PDF download URL and whether the PDF is `current`, `stale`, `uploaded`, `regenerating` or `missing`. |
| `list_job_notes` | *read.* A job's notes, newest first, paginated with `limit`/`offset`. Each note's content is cut to `previewChars` (default 500) unless `fullContent: true`; `contentLength` gives the full length. |
| `add_job_note`, `update_job_note`, `delete_job_note` | Add, edit or delete a note on a job (title up to 120 characters, content up to 20,000). |
| `mark_job_applied` | Record that you applied now: adds an Applied stage, sets status `applied`, and sends the job-complete webhook. Refused (`CONFLICT`) if the job is already applied or in progress, unlike the web UI's **Mark applied**, which records another Applied event. |
| `transition_job_stage` | Move an application to a stage (`recruiter_screen`, `technical_interview`, `offer`, `closed`, …) or add a timeline note (`toStage: "no_change"`, `eventType: "note"`). Dates are ISO strings. |
| `set_job_outcome` | Set the outcome (`rejected`, `offer_accepted`, `ghosted`, …) and close the application, or pass `null` to reopen it. |
| `get_job_timeline` | *read.* The application's stage events (oldest first, paginated with `limit`/`offset`) and up to 50 tasks (`tasksTruncated` says when there are more). |

Things to know:

- Model and PDF tools (`rescore_job`, `tailor_job`, `generate_job_pdf`, `process_job`, `import_job` with processing) wait for the work and can take up to a minute. They return the updated job, including `pdfFreshness`.
- A job that is already being processed, or whose PDF is rendering, is refused with a `CONFLICT` error. Wait, check `get_job`, and try again.
- `bulk_job_action` takes at most 100 ids and waits for all of them before it answers. With `move_to_ready` it runs the model and renderer for every job, so keep those batches to about 10 jobs or the call may outlast your client's timeout.
- A failed tailoring or render step comes back with its own code and message, for example `UPSTREAM_ERROR` "LLM is not configured", or `CONFLICT` while a PDF is already rendering. Tool error messages are cut to 500 characters.
- The PDF link is a REST URL. Download it with the same token, for example:

  ```bash
  curl -H 'Authorization: Bearer jo_pat_xxxxxxxxxxxx_xxxxxxxx' \
    -o resume.pdf 'https://your-jobops-host/api/jobs/<job id>/pdf'
  ```

- `import_job` cannot fetch LinkedIn or Indeed pages. Paste the posting text as `description` and pass `jobUrl`.
- `import_job` (and the manual import dialog) fetches only public web pages: `http`/`https` URLs whose host resolves to public addresses. Loopback, private, link-local (including cloud metadata), unique-local and other reserved addresses are refused with `UNPROCESSABLE_ENTITY`, also when a redirect points there. At most 5 redirects are followed and the first 5 MB of a page are read.
- Everything `import_job` reads, fetched page or pasted text, is sent to the model you configured in Settings, like the manual import dialog does.

### Pipeline, search and settings tools

| Tool | Access | What it does |
| --- | --- | --- |
| `start_pipeline_run` | write | Start a discovery run with chosen `sources`, `searchTerms`, `country`, `cityLocations`, workplace types, `topN`, `minSuitabilityScore`, `runBudget` and `scoringInstructions`. Omitted fields use your saved search settings. Returns immediately. |
| `get_pipeline_progress` | read | Current step, counters, the last run, and `actionRequired` when the run is paused. |
| `cancel_pipeline_run` | write | Stop the active run. Jobs already imported are kept. |
| `resume_pipeline_scoring` | write | Continue a run paused because no AI model was configured. |
| `list_pipeline_runs` | read | Past runs, newest first, paginated. |
| `get_pipeline_run` | read | One run: requested and effective settings, result summary, duration and job counts. |
| `plan_search` | read (not marked read-only) | Turn a request such as "remote backend roles in Indonesia" into run settings with the AI model. Starts from `currentConfig`, a saved search (`presetId`), or your most recently used saved search. Saves nothing. |
| `list_sources` | read | Source ids and labels, whether each is available on this server, supported countries, whether a country or city is required, and whether its credentials are configured. |
| `check_source_health` | write | Run a small live test search on up to 5 sources to see whether they work right now. |
| `list_search_presets` | read | Saved searches with their full settings. |
| `save_search_preset` | write | Create a saved search, or rename or change one by `id`. |
| `delete_search_preset` | write | Delete a saved search. |
| `get_settings` | read | Your settings, without credentials (see [What agents can see and change in settings](#what-agents-can-see-and-change-in-settings)). `keys` limits the output. |
| `update_settings` | write | Change agent-editable settings with the same validation and permissions as the Settings page. Users who are not system admins can change only search settings. |
| `get_watchlist_sources` | read | Your Watchlist career pages, the built-in company catalog, and the source types that accept custom URLs. |
| `set_watchlist_sources` | write | Replace the whole Watchlist source list. Sources you leave out are removed. |
| `ghostwriter_list_messages` | read | The Ghostwriter conversation for a job. |
| `ghostwriter_send_message` | write | Ask Ghostwriter something about a job and wait for the complete reply. |
| `search_visa_sponsors` | read | Look up an employer in the visa sponsor registers. |
| `list_inbox_items` | read | Recruiter emails waiting for review in the post-application inbox, with the suggested job and stage change. |
| `resolve_inbox_item` | write | Approve (link to the job and record the stage change) or deny one inbox item. |

#### Start, then poll

A pipeline run takes minutes, so `start_pipeline_run` does not wait for it:

1. Call `start_pipeline_run`. It answers at once with `started: true`, or with a tool error: `CONFLICT` when a run is already active, `INVALID_REQUEST` when a source does not support the chosen country (check `list_sources` first).
2. Call `get_pipeline_progress` every 15 to 30 seconds until `step` is `completed`, `cancelled` or `failed`.
3. If `paused` is `true`, read `actionRequired`:
   - `challenge`: a job site showed a bot check. Only a person can solve it, in the JobOps web UI. The run continues by itself afterwards.
   - `llm_configuration`: no AI model is configured. Only a person can set the provider and key, in Settings. Then call `resume_pipeline_scoring`.
4. Use `list_jobs` to review what the run found.

Example request to Claude Code: "Use jobops to search LinkedIn for backend engineer roles in London, wait for the run to finish, then list the new jobs scoring above 70."

#### What agents can see and change in settings

An agent reads untrusted text (job descriptions, web pages, emails), so settings that hold credentials or decide where your data goes are web-app only.

| Settings | `get_settings` shows | `update_settings` |
| --- | --- | --- |
| Search terms, cities and location, workplace types, per-source limits, blocked companies | Value | Allowed |
| Scoring instructions and salary penalty, auto-skip threshold | Value | Allowed |
| Models (`model`, `modelScorer`, `modelTailoring`, `modelProjectSelection`), project selection, prompt templates, writing style, PDF and display options | Value | Allowed |
| LLM provider, Reactive Resume base resume, backup schedule, onboarding state | Value | Web app only |
| LLM base URL, per-purpose LLM overrides, Reactive Resume URL | URL without user info, query string or fragment | Web app only |
| Pipeline and job-complete webhook URLs | Host only | Web app only |
| API keys, passwords, tokens, webhook secret, UK Visa Jobs email, Adzuna app id | Only whether it is set (`hidden`) | Web app only |

`get_settings` also returns `webOnly`, the full list of settings an agent cannot change. `update_settings` refuses them with a `FORBIDDEN` tool error that names the setting. A setting added in a later version is hidden and web-app only until it is classified.

#### Limits

- `ghostwriter_send_message` waits at most 3 minutes, then cancels the generation and returns `REQUEST_TIMEOUT`. Set `JOBOPS_MCP_GHOSTWRITER_TIMEOUT_MS` to change the limit. If the agent disconnects first, the generation is cancelled too.
- `list_inbox_items` reads at most 500 pending items.
- Not available as tools: wiping the database, user and workspace administration, backups, sign-in flows for AI providers or mailboxes, billing, and access token management.

## Why it exists

Clicking through the web UI takes time. With agent access, Claude Code can answer questions like "which new backend jobs scored above 75 this week?" or "summarise the job at Grab" directly, and act on the answer: "tailor my resume for the top three and give me the PDFs", "skip everything from that employer", "I just applied to the Grab job, log it". It uses the same data and rules as the app.

Tokens are separate from your password, can be read-only, can expire, and can be revoked at any time.

## How to use it

1. Open **Settings → Workspaces & Security → Agent access**.
2. Enter a name (for example `Claude Code on laptop`), choose **Access** and **Expires**, then click **Create token**.
   - **Read only** tokens can call read tools and make `GET` requests to the JobOps API.
   - **Read and write** tokens can also call tools that change data.
   - Expiry defaults to 90 days. Choose **Never** for a token that does not expire.
3. Copy the token now. JobOps shows it once and stores only a SHA-256 hash of it.
4. Copy the **Claude Code command** shown under the token and run it in a terminal:

   ```bash
   claude mcp add --transport http jobops 'https://your-jobops-host/mcp' \
     --header 'Authorization: Bearer jo_pat_xxxxxxxxxxxx_xxxxxxxx'
   ```

5. Start Claude Code and ask, for example, "Use jobops to list my ready jobs with a score above 70."

To share the configuration in a project without committing the token, use an environment variable in `.mcp.json`:

```json
{
  "mcpServers": {
    "jobops": {
      "type": "http",
      "url": "https://your-jobops-host/mcp",
      "headers": { "Authorization": "Bearer ${JOBOPS_MCP_TOKEN}" }
    }
  }
}
```

Use a custom variable name such as `JOBOPS_MCP_TOKEN`; Claude Code reads credential-style names such as `ANTHROPIC_API_KEY` as empty in remote headers.

### Token rules

- Format: `jo_pat_<12 hex characters>_<43 characters>`. The `jo_pat_<prefix>` part is shown in Settings so you can tell tokens apart.
- A token works on `/mcp` and on the REST API (`Authorization: Bearer …`), for example to download a job PDF.
- A token cannot create, list or revoke tokens. Manage tokens from a signed-in browser session.
- Each user can have up to 25 active tokens.
- **Last used** updates at most once a minute.
- Disabling a user blocks all of their tokens. Changing a password does not revoke tokens; revoke them in Settings.

### Endpoint behaviour

- `POST /mcp` only (Streamable HTTP, stateless, JSON responses). Every method, including `GET`, requires a valid token; an authenticated `GET` or `DELETE` returns `405`.
- Errors from a tool come back as tool results with `isError: true` and `{ "error": { "code": "NOT_FOUND", "message": "Job not found" } }`. A read-only token calling a write tool gets a `FORBIDDEN` tool error.
- Agent access is disabled in the public demo.

### Host and Origin checks

To block DNS-rebinding and cross-site requests, `/mcp` checks the `Host` header when an allowlist exists:

- `JOBOPS_PUBLIC_BASE_URL` adds its host, and `localhost`/`127.0.0.1`/`::1` are always allowed.
- `JOBOPS_MCP_ALLOWED_HOSTS` adds more hostnames (comma-separated, ports ignored), for example `jobops.lan,192.168.1.20`. Set it to `*` to turn the check off.
- With neither variable set, any host is accepted (the token is still required).

Browser requests that send an `Origin` header must come from an allowed host, or from the same host when no allowlist exists. Claude Code sends no `Origin`.

## Common problems

### `401 Unauthorized`

- The token was revoked, has expired, or was copied incompletely. Create a new one.
- The header must be exactly `Authorization: Bearer <token>`.
- The user who owns the token was disabled.

### `403 Host not allowed for the MCP endpoint`

You reach JobOps through a hostname that is not on the allowlist, for example a LAN IP while `JOBOPS_PUBLIC_BASE_URL` points to your public domain. Add the hostname to `JOBOPS_MCP_ALLOWED_HOSTS` and restart JobOps.

### The command in Settings shows the wrong URL

The URL comes from `JOBOPS_PUBLIC_BASE_URL`, or from the address your browser used when it is not set. Set `JOBOPS_PUBLIC_BASE_URL` when JobOps runs behind a reverse proxy, or edit the URL in the command before running it.

### `403 This access token is read-only`

A read-only token tried to change data through the REST API. Create a read and write token if the agent should make changes.

### A tool returns `CONFLICT`

The job is busy: it is being processed, its PDF is rendering, or Ghostwriter is replying. Wait a moment, check the job with `get_job` (`status` is no longer `processing` and `pdfRegenerating` is `false`), then try again. `mark_job_applied` also returns `CONFLICT` for a job that is already applied; use `transition_job_stage` for later steps.

### `import_job` says the URL points to a private or local address

JobOps refuses to fetch addresses on your own network, so a posting on an intranet or `localhost` cannot be fetched. Open it yourself and pass the text as `description` with `jobUrl`.

### `import_job` says it could not determine the title, employer or jobUrl

The model could not read those fields from the posting, or the LLM is not configured. Pass the missing fields (`title`, `employer`, `jobUrl`) yourself.

### `start_pipeline_run` returns `CONFLICT`

A run is already active for your account (only one runs at a time). Poll `get_pipeline_progress` until it finishes, or stop it with `cancel_pipeline_run`.

### `update_settings` returns `FORBIDDEN: System admin access is required`

The token belongs to a user who is not a system admin, and the update includes a setting other than search settings (terms, locations, workplace types and per-source limits). Ask an admin to change it, or use an admin's token.

### `update_settings` returns `FORBIDDEN: … can only be changed in the JobOps web app`

The setting is web-app only for agents (credentials, LLM provider and endpoints, webhooks, Reactive Resume connection, backups). Change it on the Settings page.

### `get_profile` says no master resume is configured

Create a resume in **Design Resume**, or select a Reactive Resume base resume in **Settings → Reactive Resume**.

## Related pages

- [Settings](/docs/next/features/settings)
- [Orchestrator](/docs/next/features/orchestrator)
- [Pipeline Run](/docs/next/features/pipeline-run)
- [Multi-Select and Bulk Actions](/docs/next/features/multi-select-and-bulk-actions)
- [Post-Application Tracking](/docs/next/features/post-application-tracking)
- [Self-Hosting](/docs/next/getting-started/self-hosting)
