---
id: scheduled-runs
title: Scheduled Runs and Telegram Digest
description: Run a saved search every day at a set time and get the best new jobs on Telegram.
sidebar_position: 7
---

## What it is

Two settings in **Settings → Automation → Schedule & digest**:

- **Scheduled runs**: JobOps runs one of your saved searches by itself at a time of day, in your time zone, on the days you pick.
- **Telegram digest**: after a run, a Telegram bot sends you the run's counts and the best new jobs, each with its score, employer, a 🎯 mark for [target companies](/docs/next/features/target-companies) and a link to the job in JobOps.

Both are off until you turn them on. They are for self-hosted installs only: not available in hosted mode or in the public demo.

## Why it exists

Finding jobs should not depend on remembering to open the app. With a schedule, discovery and scoring happen every morning, and the digest tells you on your phone whether anything is worth a look.

## How to use it

### 1. Save a search

The schedule runs a saved search, not whatever is open in your browser.

1. Click **Find jobs** and set up the search as usual: search terms, sources, country and cities, how many jobs to tailor.
2. Click **Save as** and give it a name, for example `Big tech internships`.

### 2. Turn on the schedule

1. Open **Settings → Automation → Schedule & digest**.
2. Tick **Run the search on a schedule**.
3. Set **Time** (24-hour) and **Time zone** (an IANA name such as `Asia/Jakarta`). **Use this device's time zone** fills in your browser's zone.
4. Pick the **Days**.
5. In **Search to run**, pick a saved search, or keep **Most recently used saved search**.
6. Click **Save**.

The box under the fields shows the next run in your time zone and what happened at the last scheduled time.

Defaults and rules:

| Setting | Default | Notes |
| --- | --- | --- |
| Time | `08:00` | 24-hour, in the time zone below |
| Time zone | `UTC` | Must be a named zone; offsets like `+07:00` are not accepted, so daylight-saving changes are followed |
| Days | every day | At least one day |
| Catch-up window | 15 minutes | 1 to 720 |

- **One run per scheduled time.** The time is checked once a minute. A scheduled time never starts two runs, even if the server restarts in that minute.
- **Already running?** If a run is going at the scheduled time (one you started, or an agent's), the scheduled run is skipped, not queued. Settings shows `skipped, a run was already active`.
- **Server was off?** If JobOps comes back within the catch-up window after the scheduled time, it runs then. Later than that, it waits for the next scheduled day.
- **Daylight saving.** A time that does not exist on a day (clocks jump forward) runs once, just after the jump. A time that happens twice (clocks go back) runs once, the first time.
- **Who it runs as.** A scheduled run runs as the person who last saved the schedule, so their saved searches are used. If that account is disabled, it runs as the workspace's first active system admin. On a single-user install that is you.
- Scheduled runs show a **Scheduled** badge in the run history on the **Overview** page.
- Only system admins can change these settings.

### 3. Create a Telegram bot

1. In Telegram, open a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, then a display name (for example `My JobOps`), then a username that ends in `bot` (for example `my_jobops_bot`).
3. BotFather replies with a **token** that looks like `123456789:AAH...`. Keep it private: anyone with it can send messages as your bot.
4. Open a chat with your new bot and press **Start** (or send it any message). A bot cannot message you before you do this.

### 4. Find your chat id

The chat id says where the bot sends the digest. For a direct chat with the bot it is your own Telegram user id, a positive number.

1. After messaging your bot, open this address in your own browser, with your token in place of `<token>`:

   ```text
   https://api.telegram.org/bot<token>/getUpdates
   ```

2. In the reply, find `"chat":{"id":123456789,...}`. That number is the chat id.

For a group, add the bot to the group, send a message there and look again: group ids start with `-`. For a public channel, add the bot as an admin and use `@channelname`.

If `getUpdates` returns `"result":[]`, send the bot another message and reload.

### 5. Turn on the digest

1. Back in **Settings → Automation → Schedule & digest**, paste the **Bot token** and the **Chat id**.
2. Pick when to **Send a digest**:
   - **After scheduled runs** (default): only runs started by the schedule.
   - **After every run**: also runs you or an agent start.
   - **Off**.
3. Set **Jobs in the digest** (default 5, up to 20).
4. Click **Save**, then **Send test message**. You should get `JobOps test message...` in Telegram. If not, the error from Telegram is shown.

The token can also come from the `TELEGRAM_BOT_TOKEN` environment variable; a token saved in Settings takes priority. The token is never shown again after saving and never returned by the API, only its first characters.

### What the digest looks like

Plain text, short enough for a phone:

```text
JobOps: scheduled run finished
Found 48, 12 new. Scored 12, tailored 3.

Top new jobs:

1. Software Engineer Intern
Grab · score 92 · 🎯 target company
https://jobs.example.com/job/6f1c...

2. Backend Engineer Intern
Tokopedia · score 85 · 🎯 target company
https://jobs.example.com/job/a93e...

3. Mobile Engineer Intern
Acme · score 71
https://jobs.example.com/job/02bd...

+9 more new jobs in JobOps.
https://jobs.example.com/jobs/all
```

- **New** means found by this run for the first time. Jobs already in JobOps are counted in "Found" but not listed.
- No new jobs: nothing is sent.
- The run failed: a short notice with the reason is sent instead.
- The run is waiting for you, because a job site asked for a bot check or no AI model is set up: a short notice says what to do.
- Links use `JOBOPS_PUBLIC_BASE_URL`. Without it the digest has no links, and Settings says so.
- Telegram limits a message to 4096 characters. Long digests list fewer jobs; a job is never cut in half.

Sending the digest never fails or slows down a run. Problems are logged on the server and shown in Settings as **Last digest failed**.

What leaves your server: job titles, employers, scores and links, sent to Telegram (`api.telegram.org`) for the chat you set. Nothing else from your profile or resume.

## Common problems

### Next run says "none planned"

- The schedule is not ticked, or the settings were not saved.
- No day is selected.
- The time zone is not one the server knows. Settings then says so; pick the zone from the list.

### Last scheduled run says "did not start"

The reason is shown next to it. The common ones:

- `No job sources to search`: there is no saved search. Save one in the **Find jobs** dialog (step 1).
- `The saved search chosen for this run no longer exists`: pick another in **Search to run**.
- `Requested sources are not available at runtime`: a source in the saved search is not installed on this server. Edit the saved search.

If the digest is on, you also get this notice on Telegram.

### Last scheduled run says "skipped, a run was already active"

Another run was going at the scheduled time. Nothing is queued; the schedule runs again at the next scheduled time.

### The run did not start after a restart

Missed runs start only within the catch-up window. Raise **Catch-up window** if your server is often down at the scheduled time.

### Test message fails

- `Telegram said: Unauthorized`: the bot token is wrong or was revoked in BotFather. Paste the current one.
- `Telegram said: Bad Request: chat not found`: wrong chat id, or you have not pressed **Start** in the bot's chat yet.
- `Telegram said: Forbidden: bot was blocked by the user`: unblock the bot in Telegram.
- `Could not reach Telegram`: the server cannot reach `api.telegram.org`. Check its internet access and firewall.

### The digest has no links

Set `JOBOPS_PUBLIC_BASE_URL` to the address you open JobOps at, for example `https://jobs.example.com`, and restart.

### I got no digest after a run

- The run found no new jobs. This is expected.
- **Send a digest** is **After scheduled runs** and the run was started by hand.
- Settings shows **Last digest failed** with the reason.

## Related pages

- [Pipeline Run](/docs/next/features/pipeline-run)
- [Target Companies and Dealbreakers](/docs/next/features/target-companies)
- [Settings](/docs/next/features/settings)
- [Overview](/docs/next/features/overview)
- [Agent Access (MCP)](/docs/next/features/agent-access)
