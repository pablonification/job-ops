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

All tools in this release only read data.

## Why it exists

Clicking through the web UI takes time. With agent access, Claude Code can answer questions like "which new backend jobs scored above 75 this week?" or "summarise the job at Grab" directly, using the same data and rules as the app.

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

### `get_profile` says no master resume is configured

Create a resume in **Design Resume**, or select a Reactive Resume base resume in **Settings → Reactive Resume**.

## Related pages

- [Settings](/docs/next/features/settings)
- [Orchestrator](/docs/next/features/orchestrator)
- [Pipeline Run](/docs/next/features/pipeline-run)
- [Self-Hosting](/docs/next/getting-started/self-hosting)
