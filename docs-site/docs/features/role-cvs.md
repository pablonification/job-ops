---
id: role-cvs
title: Role CVs
description: Keep one ready-made CV per target role, generated from your master resume, with its own PDF.
sidebar_position: 5
---

## What it is

A Role CV is a saved CV version for a kind of role you apply to, such as "Backend Engineer" or "Data Analyst".

Each Role CV has:

- a **name** (unique in your workspace, ignoring case)
- a **role description**: what the role does and what it needs
- a **headline**, **summary** and **skills** written for that role
- a **project selection** from your master resume
- its own **PDF**

Role CVs are overlays on your single master resume (Resume Studio, or your Reactive Resume base resume). They change the same parts that per-job tailoring changes: headline, summary, skills and visible projects. Everything else (experience, education, contact details, layout) comes from the master resume.

## Why it exists

Tailoring every application from scratch is slow, and it can drift between applications to similar roles. A Role CV gives you one reviewed version per target role that you can download and send for quick applications outside JobOps, or use as the starting point for a job's CV inside JobOps.

## How to use it

1. Open **Role CVs** from the main navigation.
2. Click **New Role CV**, enter a name and a role description, then click **Create**.
3. Click **Generate**. JobOps writes a headline, summary and skills for the role and picks projects from your master resume.
4. Edit any field by hand, then click **Save**.
5. Click **Make PDF**, then **Open** or **Download**.

A good role description is a few lines about the work and the skills it needs, for example:

```text
Backend engineer for payment and fintech products. Go or Java services,
PostgreSQL, event-driven systems, high-traffic APIs, on-call ownership.
```

### Generation

- Generation uses the **Role CV prompt** in **Settings → Prompt Templates**. You can edit it like the other templates. Its placeholders include `{{roleName}}`, `{{roleDescription}}` and `{{profileJson}}`.
- It uses the same model as resume tailoring (the tailoring model override, if set), plus your writing style and output language settings.
- The model receives the role name and description plus the same trimmed profile fields resume tailoring sends (name, headline, summary, skills, project names and descriptions, and experience positions and summaries). Projects excluded in **Resume Projects** are left out.
- Project selection follows your **Resume Projects** settings: must-include projects are always shown, and the AI picks from the projects marked as AI-selectable, up to your project limit.
- **Regenerate** replaces the headline, summary, skills and project selection. Unsaved edits to the name or role description are saved first.
- In demo mode no AI model is called; generation returns sample content.

### Use a Role CV on a job

Open a job and go to the **Tailoring** tab. When you have at least one Role CV, a **Role CV** box appears above the tailoring fields:

- The dropdown shows the job's Role CV. A badge says how it was chosen: **Auto** (picked by JobOps), **Auto: no match** (JobOps found none that fits) or **Manual** (picked by you). Choose another Role CV, or **None**, to override it.
- **Auto-pick** asks JobOps to choose again.
- **Apply as is** copies the Role CV's headline, summary, skills and project selection into the job. No AI call. It replaces the job's current tailoring.
- **Refine for this job** tailors the job's CV with the AI, starting from the Role CV. The AI keeps the Role CV's positioning and adapts it to the job description. It also picks projects for the job, like **Generate all** with projects.

After either action the job's fields behave exactly like hand edits: the PDF shows as out of date, and a ready job with a generated PDF gets its PDF regenerated automatically.

A job keeps a copy of the Role CV content. Editing or regenerating a Role CV later does **not** change jobs that already used it. Click **Apply as is** or **Refine for this job** again to pick up the changes.

Deleting a Role CV removes it from every job that used it. The jobs keep their tailored headline, summary, skills and projects.

### Auto-picking

JobOps compares the job title and description with each Role CV's name, headline and role description and picks the best fit, or none. It uses the AI model set for **project selection**. If that call fails, JobOps falls back to a simple keyword match. The AI receives the job title and description and, for each Role CV, its name, headline and role description (not its summary).

### Role CVs in the pipeline

**Settings → Display → Role CVs when auto-tailoring** controls how pipeline runs, **Move to Ready** and auto-tailored manual imports use Role CVs:

| Setting | What happens |
| --- | --- |
| **Refine for each job** (default) | JobOps picks a Role CV for the job and tailors from it. |
| **Use as is** | JobOps picks a Role CV and copies it into the job. No AI call for the CV text. |
| **Off** | Role CVs are ignored. |

Details:

- With no Role CVs, tailoring works exactly as before, whatever the setting.
- JobOps only picks a Role CV for a job that has never had one picked. Your manual choice, including **None**, is kept.
- If no Role CV fits, or the chosen one has no headline or summary yet, the job is tailored the usual way.
- Jobs that already have a tailored headline and summary keep them, as before.

### Tailoring prompt placeholder

The **Resume tailoring prompt** has a `{{roleCvBaseline}}` placeholder. When a job is refined from a Role CV, JobOps fills it with the Role CV's headline, summary and skills. Otherwise it is empty. If you customised the tailoring prompt before this placeholder existed, JobOps adds the Role CV content at the end of your prompt, so it is never dropped. Add `{{roleCvBaseline}}` to your template to choose where it goes.

### Out of date

JobOps records which version of your master resume a Role CV was generated from. When the master resume changes later, the Role CV shows **Outdated** and a notice. Click **Regenerate** to bring it up to date. Your hand edits are not changed until you regenerate.

The PDF has its own status:

- **Not made yet**: no PDF exists.
- **Up to date**: the PDF matches the current fields and PDF settings.
- **Out of date**: you edited the fields, changed PDF settings (renderer, theme, paper size, project settings), or changed the master resume since the PDF was made. Click **Update PDF**.

PDFs use the same renderer and settings as job PDFs. Only one PDF for the same Role CV can be made at a time; a second request while one is running is rejected.

### API

All routes return the standard `{ ok, data | error, meta.requestId }` envelope.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/role-cvs` | List Role CVs (`data.roleCvs`) |
| `POST` | `/api/role-cvs` | Create (`name`, `roleDescription`) |
| `GET` | `/api/role-cvs/:id` | Get one |
| `PATCH` | `/api/role-cvs/:id` | Update fields |
| `DELETE` | `/api/role-cvs/:id` | Delete it and its PDF |
| `POST` | `/api/role-cvs/:id/generate` | Generate content with the AI model |
| `POST` | `/api/role-cvs/:id/generate-pdf` | Render the PDF |
| `GET` | `/api/role-cvs/:id/pdf` | Download the PDF |
| `POST` | `/api/jobs/:id/role-cv/match` | Auto-pick a Role CV for the job |
| `PUT` | `/api/jobs/:id/role-cv` | Set the job's Role CV (`roleCvId`, or `null` for none) |
| `POST` | `/api/jobs/:id/role-cv/apply` | Copy the Role CV into the job (optional `roleCvId`) |
| `POST` | `/api/jobs/:id/role-cv/refine` | Tailor the job from the Role CV (optional `roleCvId`) |

The job routes return the updated job. Jobs carry `roleCvId` and `roleCvMatchSource` (`auto`, `manual` or `null` when never picked). Passing `roleCvId` to `apply` or `refine` also records it as a manual choice.

Field encodings match per-job tailoring: `tailoredSkills` is a JSON array string of `{ "name", "keywords" }` groups and `selectedProjectIds` is a comma-separated list of AI-selected project ids. Each Role CV also reports `isStale` (master resume changed since generation) and `pdfFreshness` (`missing`, `current`, `stale` or `regenerating`).

```bash
curl -X POST http://localhost:3001/api/role-cvs \
  -H "Content-Type: application/json" \
  -d '{"name":"Backend Engineer","roleDescription":"Go services, PostgreSQL, payments"}'

curl -X POST http://localhost:3001/api/jobs/<jobId>/role-cv/apply \
  -H "Content-Type: application/json" \
  -d '{"roleCvId":"<roleCvId>"}'
```

## Common problems

- **Generate says to set up your resume first**: import or create your resume in Resume Studio, or select a Reactive Resume base resume in Settings.
- **Generate is disabled**: add a role description.
- **Generation fails**: check the LLM provider and tailoring model in **Settings**. Role CVs use the same model configuration as resume tailoring.
- **"A Role CV named ... already exists"**: names are unique per workspace, ignoring case. Pick another name.
- **"This Role CV PDF is already being generated"**: wait for the running PDF to finish, then try again.
- **No Role CV box in the Tailoring tab**: create a Role CV first.
- **Apply as is and Refine are disabled**: choose a Role CV, and generate it (or fill in its headline and summary) on the Role CVs page.
- **A job ignored my new Role CV**: JobOps only auto-picks for jobs that were never matched. Click **Auto-pick** or choose it by hand.
- **Changes to a Role CV don't show on a job**: jobs keep a copy. Click **Apply as is** or **Refine for this job** again.
- **Outdated after a small resume edit**: any saved change to the master resume marks Role CVs generated before it as outdated. With a Reactive Resume base resume (no Resume Studio document), only switching to another base resume is detected.

## Related pages

- [Resume Studio](/docs/features/design-resume)
- [Orchestrator: tailoring and PDFs](/docs/features/orchestrator)
- [Settings](/docs/features/settings)
- [Reactive Resume](/docs/features/reactive-resume)
