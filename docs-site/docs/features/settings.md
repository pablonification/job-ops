---
id: settings
title: Settings
description: Configure models, webhooks, workspaces, backup behavior, scoring, and safety controls.
sidebar_position: 2
---

## What it is

The Settings page is the control center for app-wide behavior.

![Settings page sections](/img/features/settings.png)

It lets you configure:

- LLM provider and models
- Webhook destinations and secret
- Display and writing-style defaults
- Editable prompt templates for core AI workflows
- Service credentials and workspace users
- Reactive Resume project selection
- Tracer Links readiness verification
- Backup and scoring rules
- Hosted plan, billing, and monthly usage
- Data-clearing actions in the Danger Zone

## Why it exists

Most teams want stable defaults for repeated workflows, without editing environment variables every time.

Settings gives you runtime overrides for the key parts of discovery, scoring, tailoring, and post-application automation.

## How to use it

1. Open **Settings**.
2. Expand each section you want to change.
3. Update values and click **Save Changes**.
4. Re-run the workflow that uses those settings (for example pipeline runs, Ghostwriter, or resume tailoring) to verify behavior.

## Section-by-section guide

### Plan & Billing

This section appears in hosted deployments. It shows your current Free or Pro plan, subscription controls, and monthly usage for job-source searches, pipeline runs, AI operations, Ghostwriter generations, and PDF exports.

Each meter includes completed usage and work currently in progress. Limits reset monthly. If hosted quotas are disabled for the workspace, the section says so instead of showing meters.

### Model

![Model settings section](/img/features/settings-model-section.png)

- In hosted deployments with platform-managed LLM enabled, this section is hidden because provider, API key, and model selection are managed by the hosted platform.
- Choose provider (`atlascloud`, `litellm`, `openrouter`, `orcarouter`, `requesty`, `api_route`, `lmstudio`, `ollama`, `openai`, `glm`, `gemini`, `gemini_cli`, `claude_cli`, `claude_agent_sdk`, `codex`)
- Set provider-specific base URL/API key when required
- Configure the default model/runtime, plus purpose-specific overrides for:
  - Scoring
  - Tailoring
  - Project selection
- Purpose overrides can inherit the default provider or use a different provider, base URL, API key, and model. For example, you can use `ollama` locally by default and route tailoring to `openai` or `openrouter`.
- Purpose API keys are stored as secrets. The settings response shows only redacted hints.
- Provider defaults are applied automatically when the model fields are left blank:
  - `atlascloud` defaults to `deepseek-ai/deepseek-v3.2`
  - `api_route` defaults to `gpt-6.1-sol`; select a different model if your key cannot access it
  - `openai` defaults to `gpt-5.4-mini`
  - `codex` defaults to `gpt-5.4-mini`
  - `glm` defaults to `glm-5.1`
  - `gemini` and `gemini_cli` default to `google/gemini-3-flash-preview`
  - `claude_cli` defaults to `claude-sonnet-5`
  - `claude_agent_sdk` defaults to `sonnet`
  - `litellm` and `ollama` have no default; pick one of the models the server offers
- The settings page shows provider-aware model pickers for:
  - `atlascloud`: console-visible text models from the live Atlas Cloud catalog
  - `litellm`: chat models configured on your LiteLLM proxy (embedding, image and audio deployments are filtered out using `/model/info`; keys that cannot read it fall back to `/v1/models`)
  - `openai`: available text-generation models only
  - `glm`: available GLM text-generation models from the configured BigModel-compatible endpoint
  - `gemini`: available Gemini text-generation models only
  - `gemini_cli`: a curated list of Gemini model ids the CLI typically supports (install [Gemini CLI](https://www.npmjs.com/package/@google/gemini-cli), run `gemini` and complete Google sign-in, or set `GEMINI_API_KEY` for the CLI; JobOps spawns headless `gemini -p ...` with `--approval-mode plan` and no JobOps API key field). **Resume import** uses the CLI with extracted text: DOCX is parsed locally; PDF uses local text extraction then JSON extraction via the CLI (scanned PDFs without a text layer may not import well).
  - `claude_cli`: a curated list of Claude model ids (install [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code), run `claude setup-token` to mint a long-lived token from a Claude Pro/Max/Team/Enterprise subscription and set it as `CLAUDE_CODE_OAUTH_TOKEN`, or set `ANTHROPIC_API_KEY` instead; JobOps spawns headless `claude -p ...` with `--permission-mode plan` and no JobOps API key field). **Resume import** uses the CLI with extracted text, same as `gemini_cli`: DOCX is parsed locally; PDF uses local text extraction then JSON extraction via the CLI.
  - `claude_agent_sdk`: the model aliases `sonnet`, `opus`, and `haiku` (see [Claude (subscription) setup](#claude-subscription-setup) below)
  - `ollama`: locally installed Ollama models
  - `orcarouter`: available models from the OrcaRouter gateway
  - `api_route`: model IDs available to your key from `https://global.api-route.com/v1/models`, excluding known image, video, embedding, and audio model families
- `openrouter`, `lmstudio`, and `openai_compatible` stay manual-entry because JobOps cannot safely infer the exact model catalog from those providers
- For LiteLLM, JobOps uses `http://localhost:4000` by default. Point the base URL at your proxy (a trailing `/v1` is accepted) and, if the proxy enforces auth, enter a virtual key; one key then reaches every provider the proxy routes to, with its budgets and fallbacks applied.
- For GLM, JobOps uses `https://api.z.ai/api/paas/v4` by default. Override the base URL only when using another Z.AI-compatible endpoint such as a coding-plan endpoint.
- For [API Route](https://www.api-route.com/), create a key in [API Keys](https://www.api-route.com/api-keys), select API Route, and choose a chat model visible to that key. The endpoint is preset. Use exact IDs without adding an upstream-provider prefix. For environment setup, set `LLM_PROVIDER=api_route`, `API_ROUTE_API_KEY` (or `LLM_API_KEY`), and `MODEL` to the chosen ID. See the [API documentation](https://github.com/DennyHo0917/api-route/blob/main/API.md). JobOps sends the same task prompts and necessary profile/job fields as for its other hosted providers; keys remain in the existing secret storage. Screenshot attachments are not enabled by this integration.
- Changing the provider clears stale model overrides in the form, so inherited fields follow the new provider default unless you explicitly choose a new override
- The preview under each field and the **Resolved config** block reflect the model currently selected in the form, even before you save

#### Claude (subscription) setup

The **Claude (subscription)** provider (`claude_agent_sdk`) runs every AI feature (scoring, tailoring, project selection, search planning, manual job import, tracking-inbox email routing, field suggestions, Ghostwriter including screenshot attachments, and resume import) on your own Claude Pro, Max, Team, or Enterprise plan through the Claude Agent SDK. The SDK and its Claude Code binary ship inside the JobOps Docker image, so you do not install anything in the container.

1. On any computer with [Claude Code](https://code.claude.com/docs/en/authentication) installed, run:

   ```bash
   claude setup-token
   ```

   It opens a browser sign-in and prints a long-lived token. It does not save the token anywhere.
2. Add the token to your `.env` file and restart JobOps:

   ```bash
   LLM_PROVIDER=claude_agent_sdk
   MODEL=sonnet
   CLAUDE_CODE_OAUTH_TOKEN=paste-the-token-here
   ```

3. In **Settings → Models** (or the onboarding model step), choose **Claude (subscription)** and save. If this install already saved a different provider, the saved setting wins over `.env`, so switching here is required.

How it behaves:

- Default model: `sonnet`. Suggested models: `sonnet`, `opus`, `haiku` (aliases that follow the newest model of each family). Full ids that start with `claude-` also work. A `MODEL` value meant for another provider is ignored for this provider.
- Each request uses your JobOps prompts as the system prompt, has every Claude Code tool switched off, loads no settings, `CLAUDE.md`, or MCP servers, keeps no session history on disk, runs in an empty temporary folder, and asks for structured JSON output.
- `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are never passed to this provider, so requests cannot silently move to API billing. Other app secrets are not passed either.
- At most 2 requests run at the same time (pipeline scoring included), to stay inside subscription rate limits.
- Resume import extracts PDF/DOCX text locally first, then sends only the text.
- The connection check sends one tiny request with `haiku` and remembers the result for 30 minutes (1 minute after a failure), so status checks do not use up your plan.
- Not available in hosted mode.

Optional environment variables (defaults shown):

```bash
CLAUDE_AGENT_SDK_MAX_CONCURRENCY=2
CLAUDE_AGENT_SDK_REQUEST_TIMEOUT_MS=180000
CLAUDE_AGENT_SDK_VALIDATION_TIMEOUT_MS=60000
CLAUDE_AGENT_SDK_MAX_TURNS=4
# Only to use a Claude Code binary other than the one bundled with the SDK:
# CLAUDE_AGENT_SDK_EXECUTABLE=/usr/local/bin/claude
```

Anthropic's terms say third-party products should not offer claude.ai sign-in or subscription limits to their users. Use this provider only with your own token, on your own single-user install.

#### Fallback provider

A fallback provider keeps AI features working when the provider you selected above fails. It is configured only in the environment, is ignored in hosted mode, and with none set JobOps behaves exactly as before.

**Your data goes to the fallback when it is used.** Every request the fallback serves carries the same prompt your selected provider would have received, which includes resume and job content. Only configure a fallback provider you are willing to send that data to.

When a request to your selected provider fails for a provider-side reason, JobOps retries that one request once on the fallback, using the fallback's own model, base URL and API key. The model, base URL and key of your selected provider (including any per-purpose model override) are never sent to the fallback. This covers every AI feature, including Ghostwriter and resume import (for resume import the fallback must be a provider import supports, so `atlascloud`, `requesty` and `api_route` fallbacks are not used there).

What fails over and what does not:

| Fails over | Does not fail over |
| --- | --- |
| Not authenticated, rejected key, unknown model or endpoint (`401`, `403`, `404`, and similar) | You cancelled the request |
| Usage, quota or billing limit (`402`, "usage limit reached") | The request itself is wrong: `400`, `413`, `422` (bad schema, prompt or context too long), or Claude (subscription) reporting `invalid_request` or an API error 400/413/422 |
| Rate limit (`429`) | |
| Timeout | |
| Server error (`5xx`, overloaded) or provider unreachable | |
| A CLI or Claude (subscription) process crashing | |
| Output that still is not valid JSON after the request's retries | |

A `400` whose error message starts by naming an unknown model or a bad key counts as a configuration problem and fails over. The fallback is tried once. If it also fails, that failure is what you see (shortened, with keys and credentials removed), and both reasons are written to the server log.

After 3 provider-side failures in a row, your selected provider is skipped for 5 minutes and requests go straight to the fallback. Output that is not valid JSON still fails over but does not count toward those 3, since it does not mean the provider is down. After the cool-down, one request tries your selected provider again; if it works, everything goes back to it. This state is kept per workspace and per provider endpoint in the server process and resets on restart.

With a fallback configured, a "not authenticated" error from your selected provider no longer pauses the pipeline: the run continues on the fallback. If the fallback then fails as well (for any reason), the run pauses, because your selected provider's credentials still need fixing.

**Settings → Models** shows the fallback provider and model under the model fields, and says when the fallback is answering every request (forced, or a provider is being skipped, naming the purpose such as scoring when only a purpose override is affected) and when it last took over and whether that worked. The API key is never shown. `GET /api/settings` returns the same information as `llmFallback`.

**Forced mode never contacts your selected provider.** With `LLM_FORCE_FALLBACK=true`, requests, the connection check in Settings and the onboarding status all use the fallback only; an expired Claude token does not ask you to reconnect while forced.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `LLM_FALLBACK_PROVIDER` | none | Exact provider id, for example `openai_compatible`, `openrouter`, `claude_agent_sdk`. Aliases are not accepted (`claude` is rejected rather than read as `anthropic`) |
| `LLM_FALLBACK_MODEL` | none | Model sent to the fallback. Required |
| `LLM_FALLBACK_BASE_URL` | provider default | Required for `openai_compatible` |
| `LLM_FALLBACK_API_KEY` | none | Required for providers that need a key. `LLM_API_KEY` is never used for the fallback |
| `LLM_FORCE_FALLBACK` | `false` | `true` sends every request to the fallback without trying your selected provider |
| `LLM_FALLBACK_BREAKER_THRESHOLD` | `3` | Provider-side failures in a row before your selected provider is skipped |
| `LLM_FALLBACK_BREAKER_COOLDOWN_MS` | `300000` | How long it is skipped (5 minutes) |

Example: Claude (subscription) with Meta's Muse Spark (an OpenAI-compatible endpoint) behind it. In `.env`:

```bash
LLM_PROVIDER=claude_agent_sdk
MODEL=sonnet
CLAUDE_CODE_OAUTH_TOKEN=paste-the-token-here

LLM_FALLBACK_PROVIDER=openai_compatible
LLM_FALLBACK_BASE_URL=https://api.meta.ai/v1
LLM_FALLBACK_MODEL=muse-spark-1.2-contributor
LLM_FALLBACK_API_KEY=paste-your-meta-api-key-here
```

The Muse Spark model name depends on your Meta account; use the one your account lists (it may not be `muse-spark-1.2-contributor`). Restart JobOps. To go back to Muse Spark for everything, add `LLM_FORCE_FALLBACK=true` and restart; remove it to return to Claude.

If the fallback is set but unusable (unknown provider, missing model, missing key or base URL, or the same provider and endpoint as your selected one), JobOps ignores it and Settings says why. It never stops the app from starting.

### Webhooks

![Webhooks settings section](/img/features/settings-webhooks-section.png)

- Pipeline status webhook: called on run completion/failure
- Job completion webhook: called when a job is marked applied
- Optional webhook secret (sent as bearer token)

### Display Settings

![Display settings section](/img/features/settings-display-section.png)

- Toggle visa sponsor badge visibility in job lists/details
- Toggle `Render Markdown in job descriptions` to control whether expanded job descriptions show formatted headings, lists, bold text, and code blocks
- Default: Markdown rendering is enabled
- Toggle `Auto-tailor manually imported jobs` to control whether jobs created through Manual Import immediately run tailoring + suitability scoring + PDF generation, or land in Discovered so you can tailor them later
- Default: Auto-tailor on import is enabled. The per-import "Tailor automatically after import" checkbox in the Manual Import review step defaults to this setting and can override it for a single import
- `Role CVs when auto-tailoring` controls how pipeline runs, **Move to Ready** and auto-tailored imports use [Role CVs](/docs/next/features/role-cvs): **Refine for each job**, **Use as is** or **Off**
- Default: Refine for each job. It has no effect until you create a Role CV

### Writing Style & Language

![Ghostwriter settings section](/img/features/settings-ghostwriter-section.png)

- Pick a preset for a quick starting point
- Set global writing defaults:
  - Tone
  - Formality
  - Output language mode
  - Manual output language
  - Use Stop Slop for Ghostwriter
  - Constraints
  - Do-not-use terms
- These settings apply to Ghostwriter and resume tailoring
- `Use Stop Slop for Ghostwriter` applies only to Ghostwriter. It adds extra instructions that cut filler, formulaic AI phrasing, passive voice, vague claims, and em dashes.
- Use the output language controls as the primary way to choose generated language
- Choose how AI output language is resolved:
  - `Manual`: always use the language you select, such as English, German, French, or Spanish
  - `Match Resume`: detect the dominant language from your resume/profile content and use that language for generated output
  - `Match job description`: detect the dominant supported language from each job description and use it for job-specific output
- Automatic language detection currently supports English, German, French, and Spanish. If detection is unclear or the text is not in a supported language, JobOps falls back to English.
- Resume tailoring keeps the exact source wording for ATS-sensitive resume headlines and job titles, even when the rest of the tailored content is generated in the selected language
- When using the local LaTeX PDF renderer, fixed resume section titles follow the resolved output language
- Downloaded resume filenames are ASCII-transliterated using the resolved language. For German, umlauts use `ä -> ae`, `ö -> oe`, `ü -> ue`, and `ß -> ss`.
- Summary max words: optional cap on AI-generated summary length (empty = no limit)
- Max keywords per skill: optional cap on keywords per skill category in tailoring (empty = no limit)
- These numeric limits override any similar constraints written in the Constraints text field
- Do-not-use terms are model guidance, not a guaranteed output filter
- `Use Stop Slop for Ghostwriter` is disabled by default and affects only new Ghostwriter responses after you save

#### Writing Style & Language workflow

Use these steps when you want Ghostwriter and resume tailoring to stay in a specific language:

1. Open **Settings**.
2. Expand **Writing Style & Language**.
3. Choose a preset if you want a starting point for tone and formality.
4. Under the language control, choose one of these modes:
   - **Manual**: pick the output language directly.
   - **Match Resume**: let JobOps infer the language from your resume/profile text.
   - **Match job description**: let JobOps infer the language from each job description.
5. If you chose **Manual**, select the language you want the AI to use.
6. Review the rest of the writing defaults such as tone, formality, constraints, and do-not-use terms.
7. Click **Save Changes**.
8. Run Ghostwriter or start resume tailoring again so the new language preference is applied to new output.

Defaults and constraints:

- `Manual` is best when you always want output in one language regardless of the resume source text.
- `Match Resume` is best when your base resume is already written in the language you want to preserve.
- `Match job description` is best when you want each application to follow the job description's language.
- If JobOps cannot determine a reliable supported language, it safely uses English.
- The generated resume content follows the resolved language, but ATS-sensitive headline and job-title wording stays exact so matching and parsing remain safer.
- The local LaTeX PDF renderer uses the resolved language for fixed section headings such as Summary, Experience, Education, Projects, and Technical Skills.

### Prompt Templates

- Edit the base templates for:
  - Ghostwriter system prompt
  - Resume tailoring prompt (its `{{roleCvBaseline}}` placeholder holds the Role CV content when a job is refined from a Role CV)
  - Role CV prompt (see [Role CVs](/docs/next/features/role-cvs))
  - Job scoring prompt
- Each editor starts from the current effective template, not a blank override
- Supported placeholders are shown inline for each template
- Job scoring always appends minified normalized source-job JSON, including `null` values, plus the required output contract
- The same scoring call may propose evidence-backed corrections to existing job facts. JobOps only accepts whitelisted, schema-valid values supported by an excerpt from the listing; these mandatory safety instructions remain appended even when you customize the scoring template
- Use **Reset** to restore a single template, or **Reset all prompts** to restore all of them
- Template editing is intentionally advanced:
  - removing key instructions can degrade output quality
  - removing placeholders can strip important runtime data from the prompt
  - resetting restores the shared default templates
- Existing writing-style, language, and scoring-instructions settings still matter because the default templates consume those values through placeholders

### Reactive Resume

![Reactive Resume settings section](/img/features/settings-reactive-resume-section.png)

- Configure a shared RxResume URL for cloud or self-hosted deployments
- Configure a v5 API key
- Choose the PDF renderer:
  - RxResume export
  - Local LaTeX renderer
  - Local Typst renderer
- When Typst is selected, choose a Typst theme:
  - Classic
  - Compact
- Choose the paper size for generated PDFs:
  - Renderer default: RxResume export keeps the page format saved on the resume, LaTeX renders US Letter, and Typst renders A4
  - A4
  - US Letter
  - With RxResume export, a resume saved as free-form in Reactive Resume stays a single continuous page regardless of this setting
- JobOps uses the selected RxResume resume as the source of truth for import and project data
- Invalid Reactive Resume credentials or other `4xx` config failures block the save and stay visible as an inline error
- Temporary Reactive Resume downtime shows an inline warning, but the save still succeeds
- Changing PDF-affecting settings (`pdfRenderer`, `typstTheme`, `pdfPaperSize`, `rxresumeBaseResumeId`, RxResume URL/key, or resume project policy) auto-queues regeneration for ready jobs that currently use system-generated PDFs
- Select a template/base resume
- Configure project selection behavior:
  - Target project count
  - **Must include**: always available to AI and always included in tailored resumes
  - **AI can select**: available to AI and to per-job automatic/manual selection
  - **Don't include**: excluded from AI prompts and tailored resumes
- The target cannot be lower than the Must-include count. Automatic selection fills available slots; manual selection may use fewer but cannot exceed the target.
- JobOps briefly caches successful Reactive Resume resume data to reduce repeated API calls across settings, profile, and PDF flows

### Tracer Links

- Verify tracer readiness before enabling per-job tracing
- Shows current status (`Ready`, `Unavailable`, `Unconfigured`, or stale state)
- Displays the effective public base URL and last check time
- Provides **Verify now** for an on-demand health check

Readiness requires:

- a valid public JobOps base URL
- successful reachability of `<public-base-url>/health`
- non-localhost/non-private host setup for public redirect usage

### Environment & Workspaces

- Configure service accounts:
  - RxResume API key
  - UKVisaJobs email/password
  - Adzuna app ID/app key
- Manage workspace users when signed in as a system admin:
  - create a user with a private workspace
  - disable a user
  - reset a user's password
- Each created user gets a separate private workspace. Jobs, settings, resume data, integrations, PDFs, pipeline runs, chat, analytics, and post-application data are scoped to that user's workspace.
- `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` are only used as legacy bootstrap credentials during migration. New sign-ins use database users.

**Connected accounts** lists the identity providers linked to your own account, with the email the provider reported and the date it was connected. **Connect** starts the provider's consent flow and adds the identity to your account; **Unlink** removes it after a confirmation. The block is hidden when no provider is configured and nothing is linked. Every user manages their own connections, and admins cannot unlink another user's identity. See [Single Sign-On Setup](/docs/next/getting-started/sso-setup) for the server-side configuration.

**Account password** sets or changes the password of the account you are signed in as. Accounts that already have a password must supply the current one; accounts created through single sign-on have none and can set one directly. Keeping a password is what lets you sign in when an identity provider is unavailable, so JobOps refuses to unlink the last connected account of a password-less user.

### Agent access

Create, list and revoke personal access tokens for Claude Code and other MCP clients. Each new token is shown once together with a ready-to-run `claude mcp add` command. See [Agent Access (MCP)](/docs/next/features/agent-access).

### Backup

![Backup settings section](/img/features/settings-backup-section.png)

- Enable/disable automatic daily backups
- Configure backup hour (UTC) and max retained backups
- Create or delete backups manually
- Backup management is available only to system admins
- See [Database Backups](../getting-started/database-backups) for full backup/restore guidance.

### Scoring Settings

![Scoring settings section](/img/features/settings-scoring-section.png)

- Penalize missing salary data
- Set penalty amount
- Optional auto-skip threshold for low-score jobs
- Block jobs from companies that match configured keyword tokens

Per-search ranking preferences live in **Find jobs**. Add them to the search description, then review or edit them in **Configure your search** before starting.

### Danger Zone

![Danger Zone settings section](/img/features/settings-danger-zone-section.png)

- Clear jobs by selected statuses
- Clear jobs below a score threshold
- In hosted mode, job-clearing actions affect only the signed-in user's jobs
- Clear the full database as a system admin; this affects every workspace

## API examples

```bash
# Get effective settings (defaults + overrides)
curl "http://localhost:3001/api/settings"
```

```bash
# Update settings overrides
curl -X PATCH "http://localhost:3001/api/settings" \
  -H "content-type: application/json" \
  -d '{
    "llmProvider": "openrouter",
    "model": "openai/gpt-4.1-mini",
    "chatStyleTone": "concise",
    "showSponsorInfo": true
  }'
```

```bash
# Override the Ghostwriter base prompt template
curl -X PATCH "http://localhost:3001/api/settings" \
  -H "content-type: application/json" \
  -d '{
    "ghostwriterSystemPromptTemplate": "You are Ghostwriter. Tone: {{tone}}. Output language: {{outputLanguage}}. {{constraintsSentence}}"
  }'
```

```bash
# List and create backups (used by the Backup section)
curl "http://localhost:3001/api/backups"
curl -X POST "http://localhost:3001/api/backups"
```

## Common problems

### Saved value does not seem to apply

- Some settings apply only to new runs/actions after save.
- Re-run scoring/tailoring/pipeline to validate effect.
- In the **Model** section, the field preview and **Resolved config** update immediately when you choose a model, but the change only applies to future actions after you click **Save**.
- Prompt-template changes only affect new Ghostwriter runs, new tailoring generations, and new scoring runs after you save.

### I do not see workspace user controls

- Workspace user management is shown only to system admins.
- The first user created during first-run setup or legacy migration is the system admin.
- Normal users can use their private workspace settings, but cannot create users, reset other passwords, or manage backups.

### AI behavior got worse after editing a prompt template

- Open **Settings → Prompt Templates**.
- Reset the individual template you changed, or use **Reset all prompts**.
- Save settings and rerun the affected workflow.
- If you keep a custom template, make sure required placeholders still exist where you need runtime data such as `{{jobDescription}}`, `{{profileJson}}`, or `{{outputLanguage}}`.

### Tailoring or scoring says the selected model does not exist for the current provider

- Open **Settings -> Model** and confirm the provider and model belong together.
- If you switch providers, leave the model fields blank to use the provider default, or pick a new provider-compatible model from the dropdown.
- JobOps ignores stale Gemini-style overrides under `openai`, stale OpenAI-style overrides under `gemini`, and non-GLM-looking overrides under `glm`, but you still need to save the current form selection for future runs.

### Resume tailoring used English instead of my resume language

- Open **Settings → Writing Style & Language** and confirm whether the language mode is set to **Manual** or **Match Resume**.
- If you want a specific language every time, switch to **Manual** and select that language explicitly.
- If you use **Match Resume**, make sure your resume/profile text has enough content in the target language for detection.
- If detection is ambiguous, JobOps falls back to English by design.

### My headline or target job title did not get translated

- This is expected during resume tailoring.
- JobOps intentionally preserves exact headline and job-title wording for ATS safety, even when other tailored sections are generated in another language.
- If you need a different headline or target title, change the source resume/profile text first and then re-run tailoring.

### RxResume controls are disabled

- JobOps resolves the RxResume URL in this order: the value saved in **Settings → Reactive Resume**, then the `RXRESUME_URL` environment variable (if set), and finally the public cloud default.
- Open **Settings → Reactive Resume** and configure the shared RxResume URL if you use a self-hosted instance.
- If you leave the URL blank, JobOps will fall back to `RXRESUME_URL` when it is configured; otherwise it uses the public cloud default.
- Invalid credentials block the save and remain visible inline until you edit the selected mode's credentials or URL.
- Temporary instance downtime shows a warning inline, but does not block unrelated settings updates.
- Then refresh available resumes from the Reactive Resume section.

### RxResume projects look empty in the RxResume UI

- Root cause: your resume on [rxresu.me](https://rxresu.me) has an empty **Projects** section.
- Fix in RxResume first: add project entries to the base resume you selected in Settings.
- Then return to JobOps, refresh/select the same base resume in **Reactive Resume**, and regenerate the PDF.
- JobOps preserves current visibility state, but it cannot create missing project content if the source resume has no projects.

### Webhook calls fail

- Verify URL reachability from the server host.
- Confirm auth expectations on the receiver side (including secret/bearer token).

### Tracer links cannot be enabled

- Open **Settings → Tracer Links** and click **Verify now**.
- Ensure `JOBOPS_PUBLIC_BASE_URL` is set for background/pipeline usage.
- Ensure the configured host is publicly reachable and `/health` responds.

### Claude (subscription) says "not authenticated"

- Check that `CLAUDE_CODE_OAUTH_TOKEN` is set in the environment JobOps runs with (for Docker, in `.env`), then restart.
- Tokens from `claude setup-token` last about a year. If it expired or was revoked, run `claude setup-token` again and replace the value.
- The pipeline pauses on this error instead of failing every job. Fix the token, then start the run again.
- With a [fallback provider](#fallback-provider) configured, the run continues on the fallback instead of pausing.

### Claude (subscription) says "usage limit reached" or "rate limit reached"

- Your plan's session or weekly limit is used up, or Anthropic is throttling requests. Wait for the limit to reset, or switch provider in **Settings → Models**.
- Lower `CLAUDE_AGENT_SDK_MAX_CONCURRENCY` (for example to `1`) if large pipeline runs hit rate limits often.
- Configure a [fallback provider](#fallback-provider) so requests move to another model automatically until the limit resets.

### Settings says the fallback model is not active

- Read the reason under the model fields. It names the missing or wrong variable, for example `LLM_FALLBACK_MODEL is not set.`
- `openai_compatible` needs `LLM_FALLBACK_BASE_URL` and `LLM_FALLBACK_API_KEY`; the fallback never borrows `LLM_BASE_URL` or `LLM_API_KEY`.
- A fallback with the same provider and endpoint as your selected provider is ignored, because it cannot help.
- Environment changes need a restart. In hosted mode the fallback is always off.

## Related pages

- [Reactive Resume](/docs/next/features/reactive-resume)
- [Database Backups](/docs/next/getting-started/database-backups)
- [Overview](/docs/next/features/overview)
- [Orchestrator](/docs/next/features/orchestrator)
- [Ghostwriter](/docs/next/features/ghostwriter)
- [Self-Hosting](/docs/next/getting-started/self-hosting)
- [Single Sign-On Setup](/docs/next/getting-started/sso-setup)
