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

Tailoring every application from scratch is slow, and it can drift between applications to similar roles. A Role CV gives you one reviewed version per target role that you can download and send for quick applications outside JobOps.

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

Field encodings match per-job tailoring: `tailoredSkills` is a JSON array string of `{ "name", "keywords" }` groups and `selectedProjectIds` is a comma-separated list of AI-selected project ids. Each Role CV also reports `isStale` (master resume changed since generation) and `pdfFreshness` (`missing`, `current`, `stale` or `regenerating`).

```bash
curl -X POST http://localhost:3001/api/role-cvs \
  -H "Content-Type: application/json" \
  -d '{"name":"Backend Engineer","roleDescription":"Go services, PostgreSQL, payments"}'
```

## Common problems

- **Generate says to set up your resume first**: import or create your resume in Resume Studio, or select a Reactive Resume base resume in Settings.
- **Generate is disabled**: add a role description.
- **Generation fails**: check the LLM provider and tailoring model in **Settings**. Role CVs use the same model configuration as resume tailoring.
- **"A Role CV named ... already exists"**: names are unique per workspace, ignoring case. Pick another name.
- **"This Role CV PDF is already being generated"**: wait for the running PDF to finish, then try again.
- **Outdated after a small resume edit**: any saved change to the master resume marks Role CVs generated before it as outdated. With a Reactive Resume base resume (no Resume Studio document), only switching to another base resume is detected.

## Related pages

- [Resume Studio](/docs/features/design-resume)
- [Settings](/docs/features/settings)
- [Reactive Resume](/docs/features/reactive-resume)
