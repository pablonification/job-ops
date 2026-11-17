import * as api from "@client/api";
import { SettingsInput } from "@client/pages/settings/components/SettingsInput";
import { SettingsSectionFrame } from "@client/pages/settings/components/SettingsSectionFrame";
import type { ScheduleValues } from "@client/pages/settings/types";
import { formatSecretHint } from "@client/pages/settings/utils";
import {
  DIGEST_MODE_VALUES,
  type DigestMode,
  MAX_DIGEST_MAX_JOBS,
  MAX_SCHEDULE_CATCH_UP_MINUTES,
  SCHEDULE_WEEKDAY_VALUES,
  type ScheduleWeekday,
} from "@shared/pipeline-schedule.js";
import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import type { PipelineRun, PipelineScheduleStatus } from "@shared/types.js";
import { useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { showErrorToast } from "@/client/lib/error-toast";
import { queryKeys } from "@/client/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

type ScheduleDigestSectionProps = {
  values: ScheduleValues;
  /** System admins only: status and the test message need it. */
  canManage: boolean;
  telegramBotTokenHint: string | null;
  isLoading: boolean;
  isSaving: boolean;
  layoutMode?: "accordion" | "panel";
};

const WEEKDAY_LABELS: Record<ScheduleWeekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

const DIGEST_MODE_LABELS: Record<DigestMode, string> = {
  scheduled: "After scheduled runs",
  all: "After every run",
  off: "Off",
};

const MOST_RECENT_SEARCH = "__most_recent__";

function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function knownTimeZones(): string[] {
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.("timeZone");
    return supported ?? [];
  } catch {
    return [];
  }
}

/** "Tue 18 Nov, 08:00 WIB" in the schedule's zone. */
export function formatInTimeZone(iso: string, timeZone: string): string {
  const date = new Date(iso);
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function describeRun(run: PipelineRun): string {
  switch (run.status) {
    case "running":
      return "running now";
    case "completed":
      return `finished, ${run.jobsDiscovered} found, ${run.jobsProcessed} tailored`;
    case "cancelled":
      return "cancelled";
    case "failed":
      return run.errorMessage ? `failed: ${run.errorMessage}` : "failed";
  }
}

/** One line about the most recent scheduled time, for the status box. */
export function describeLastScheduledRun(
  status: PipelineScheduleStatus,
): string | null {
  const { lastAttempt, lastScheduledRun, timeZone } = status;
  if (!lastAttempt && !lastScheduledRun) return null;
  if (lastScheduledRun && (!lastAttempt || lastAttempt.outcome === "started")) {
    return `${formatInTimeZone(lastScheduledRun.startedAt, timeZone)}: ${describeRun(lastScheduledRun)}`;
  }
  if (!lastAttempt) return null;
  const when = formatInTimeZone(lastAttempt.occurrence, timeZone);
  switch (lastAttempt.outcome) {
    case "started":
      return `${when}: started`;
    case "skipped_active":
      return `${when}: skipped, a run was already active`;
    case "skipped_no_user":
      return `${when}: skipped, no active user to run as`;
    case "failed_to_start":
      return `${when}: did not start${lastAttempt.detail ? `: ${lastAttempt.detail}` : ""}`;
  }
}

function describeDigest(status: PipelineScheduleStatus): string | null {
  const { digest, timeZone } = status;
  if (!digest.lastStatus || !digest.lastSentAt) return null;
  const when = formatInTimeZone(digest.lastSentAt, timeZone);
  return digest.lastStatus === "sent"
    ? `Last digest sent ${when}.`
    : `Last digest failed ${when}: ${digest.lastDetail ?? "unknown error"}`;
}

export const ScheduleDigestSection: React.FC<ScheduleDigestSectionProps> = ({
  values,
  canManage,
  telegramBotTokenHint,
  isLoading,
  isSaving,
  layoutMode,
}) => {
  const {
    control,
    register,
    setValue,
    formState: { errors, dirtyFields },
  } = useFormContext<UpdateSettingsInput>();
  const [isSendingTest, setIsSendingTest] = useState(false);
  const disabled = isLoading || isSaving || !canManage;

  const statusQuery = useQuery({
    queryKey: queryKeys.settings.scheduleStatus(),
    queryFn: api.getScheduleStatus,
    refetchInterval: 60_000,
    enabled: canManage,
    retry: false,
  });
  const presetsQuery = useQuery({
    queryKey: queryKeys.pipeline.searchPresets(),
    queryFn: api.getPipelineSearchPresets,
  });
  const status = statusQuery.data ?? null;
  // Hosted mode and the demo answer the status request with the reason.
  const notice = !canManage
    ? "Only system admins can change the schedule and the digest."
    : statusQuery.error instanceof Error
      ? statusQuery.error.message
      : null;
  const presets = presetsQuery.data?.searches ?? [];

  const enabled =
    useWatch({ control, name: "scheduleEnabled" }) ??
    values.scheduleEnabled.effective;
  const timeZones = useMemo(knownTimeZones, []);
  const localZone = useMemo(browserTimeZone, []);
  const telegramDirty = Boolean(
    dirtyFields.telegramBotToken || dirtyFields.telegramChatId,
  );

  const handleSendTest = async () => {
    setIsSendingTest(true);
    try {
      await api.sendTelegramTestMessage();
      toast.success("Test message sent. Check Telegram.");
      void statusQuery.refetch();
    } catch (error) {
      showErrorToast(error, "Test message failed");
    } finally {
      setIsSendingTest(false);
    }
  };

  const lastRunLine = status ? describeLastScheduledRun(status) : null;
  const digestLine = status ? describeDigest(status) : null;

  return (
    <SettingsSectionFrame
      mode={layoutMode}
      title="Schedule & digest"
      value="schedule"
    >
      <div className="space-y-6">
        {notice ? (
          <p className="rounded-md border border-border/60 bg-muted/20 p-3 text-sm text-muted-foreground">
            {notice}
          </p>
        ) : null}

        <div className="flex items-start space-x-3">
          <Controller
            name="scheduleEnabled"
            control={control}
            render={({ field }) => (
              <Checkbox
                id="scheduleEnabled"
                checked={field.value ?? values.scheduleEnabled.effective}
                onCheckedChange={(checked) => field.onChange(checked === true)}
                disabled={disabled}
              />
            )}
          />
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="scheduleEnabled"
              className="cursor-pointer text-sm font-medium leading-none"
            >
              Run the search on a schedule
            </label>
            <p className="text-xs text-muted-foreground">
              JobOps runs one of your saved searches by itself. If a run is
              already going at that time, the scheduled run is skipped.
            </p>
          </div>
        </div>

        {enabled ? (
          <div className="space-y-5 pl-7">
            <div className="grid gap-5 md:grid-cols-2">
              <SettingsInput
                label="Time"
                type="time"
                inputProps={{ ...register("scheduleTime"), step: 60 }}
                disabled={disabled}
                error={errors.scheduleTime?.message as string | undefined}
                helper="24-hour time in the time zone below."
              />
              <div className="space-y-2">
                <SettingsInput
                  label="Time zone"
                  inputProps={{
                    ...register("scheduleTimeZone"),
                    list: "schedule-time-zones",
                    autoComplete: "off",
                    spellCheck: false,
                  }}
                  placeholder="Asia/Jakarta"
                  disabled={disabled}
                  error={errors.scheduleTimeZone?.message as string | undefined}
                />
                <datalist id="schedule-time-zones">
                  {timeZones.map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
                {localZone ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    disabled={disabled}
                    onClick={() =>
                      setValue("scheduleTimeZone", localZone, {
                        shouldDirty: true,
                        shouldValidate: true,
                      })
                    }
                  >
                    Use this device's time zone ({localZone})
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">Days</div>
              <Controller
                name="scheduleWeekdays"
                control={control}
                render={({ field }) => {
                  const selected = new Set(
                    field.value ?? values.scheduleWeekdays.effective,
                  );
                  return (
                    <div className="flex flex-wrap gap-3">
                      {SCHEDULE_WEEKDAY_VALUES.map((day) => (
                        <label
                          key={day}
                          htmlFor={`scheduleWeekday-${day}`}
                          className="flex cursor-pointer items-center gap-1.5 text-sm"
                        >
                          <Checkbox
                            id={`scheduleWeekday-${day}`}
                            checked={selected.has(day)}
                            disabled={disabled}
                            onCheckedChange={(checked) => {
                              const next = new Set(selected);
                              if (checked === true) next.add(day);
                              else next.delete(day);
                              field.onChange(
                                SCHEDULE_WEEKDAY_VALUES.filter((value) =>
                                  next.has(value),
                                ),
                              );
                            }}
                          />
                          {WEEKDAY_LABELS[day]}
                        </label>
                      ))}
                    </div>
                  );
                }}
              />
              {errors.scheduleWeekdays ? (
                <p className="text-xs text-destructive">
                  Pick at least one day.
                </p>
              ) : null}
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <div className="space-y-2">
                <label
                  htmlFor="scheduleSearchPresetId"
                  className="text-sm font-medium"
                >
                  Search to run
                </label>
                <Controller
                  name="scheduleSearchPresetId"
                  control={control}
                  render={({ field }) => (
                    <Select
                      value={field.value ? field.value : MOST_RECENT_SEARCH}
                      onValueChange={(value) =>
                        field.onChange(
                          value === MOST_RECENT_SEARCH ? "" : value,
                        )
                      }
                      disabled={disabled}
                    >
                      <SelectTrigger id="scheduleSearchPresetId">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={MOST_RECENT_SEARCH}>
                          Most recently used saved search
                        </SelectItem>
                        {presets.map((preset) => (
                          <SelectItem key={preset.id} value={preset.id}>
                            {preset.name}
                          </SelectItem>
                        ))}
                        {field.value &&
                        !presets.some((preset) => preset.id === field.value) ? (
                          <SelectItem value={field.value}>
                            Saved search not found
                          </SelectItem>
                        ) : null}
                      </SelectContent>
                    </Select>
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  {presets.length === 0
                    ? "You have no saved searches yet. Save one in the run dialog first."
                    : "Saved searches are made in the run dialog."}
                </p>
              </div>
              <Controller
                name="scheduleCatchUpMinutes"
                control={control}
                render={({ field }) => (
                  <SettingsInput
                    label="Catch-up window (minutes)"
                    type="number"
                    inputProps={{
                      ...field,
                      inputMode: "numeric",
                      min: 1,
                      max: MAX_SCHEDULE_CATCH_UP_MINUTES,
                      value:
                        field.value ?? values.scheduleCatchUpMinutes.effective,
                      onChange: (event) => {
                        const value = parseInt(event.target.value, 10);
                        field.onChange(Number.isNaN(value) ? null : value);
                      },
                    }}
                    disabled={disabled}
                    error={
                      errors.scheduleCatchUpMinutes?.message as
                        | string
                        | undefined
                    }
                    helper="If JobOps was off at the scheduled time, it still runs when it comes back within this many minutes. Later than that, it waits for the next day."
                  />
                )}
              />
            </div>
          </div>
        ) : null}

        <div className="space-y-1 rounded-md border border-border/60 bg-muted/20 p-3 text-sm">
          <div>
            <span className="text-muted-foreground">Next run: </span>
            {status?.nextRunAt
              ? formatInTimeZone(status.nextRunAt, status.timeZone)
              : status?.enabled && !status.timeZoneValid
                ? `none, "${status.timeZone}" is not a time zone this server knows`
                : "none planned"}
          </div>
          <div>
            <span className="text-muted-foreground">Last scheduled run: </span>
            {lastRunLine ?? "none yet"}
          </div>
          {status?.enabled && status.runAsUsername ? (
            <div className="text-xs text-muted-foreground">
              Runs as {status.runAsUsername}, the last person to save this
              schedule.
            </div>
          ) : null}
          <div className="text-xs text-muted-foreground">
            Save your changes to update this.
          </div>
        </div>

        <Separator />

        <div className="space-y-4">
          <div>
            <div className="text-sm font-medium">Telegram digest</div>
            <p className="text-xs text-muted-foreground">
              After a run, JobOps sends the best new jobs to Telegram. Nothing
              is sent when a run finds no new jobs. You also get a short note
              when a run fails or waits for you.
            </p>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="digestMode" className="text-sm font-medium">
                Send a digest
              </label>
              <Controller
                name="digestMode"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value ?? values.digestMode.effective}
                    onValueChange={(value) => field.onChange(value)}
                    disabled={disabled}
                  >
                    <SelectTrigger id="digestMode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DIGEST_MODE_VALUES.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {DIGEST_MODE_LABELS[mode]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <Controller
              name="digestMaxJobs"
              control={control}
              render={({ field }) => (
                <SettingsInput
                  label="Jobs in the digest"
                  type="number"
                  inputProps={{
                    ...field,
                    inputMode: "numeric",
                    min: 1,
                    max: MAX_DIGEST_MAX_JOBS,
                    value: field.value ?? values.digestMaxJobs.effective,
                    onChange: (event) => {
                      const value = parseInt(event.target.value, 10);
                      field.onChange(Number.isNaN(value) ? null : value);
                    },
                  }}
                  disabled={disabled}
                  error={errors.digestMaxJobs?.message as string | undefined}
                  helper={`The highest-scoring new jobs, up to ${MAX_DIGEST_MAX_JOBS}.`}
                />
              )}
            />
            <SettingsInput
              label="Bot token"
              type="password"
              inputProps={{
                ...register("telegramBotToken"),
                autoComplete: "off",
              }}
              placeholder="Enter a new token"
              disabled={disabled}
              error={errors.telegramBotToken?.message as string | undefined}
              helper="From @BotFather. Stored on the server and never shown again."
              current={formatSecretHint(telegramBotTokenHint)}
            />
            <SettingsInput
              label="Chat id"
              inputProps={{
                ...register("telegramChatId"),
                autoComplete: "off",
                inputMode: "text",
              }}
              placeholder="123456789"
              disabled={disabled}
              error={errors.telegramChatId?.message as string | undefined}
              helper="Your chat with the bot, a group (starts with -) or @channelname."
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleSendTest()}
              disabled={
                disabled || isSendingTest || telegramDirty || !status?.available
              }
            >
              <Send className="mr-2 h-4 w-4" />
              {isSendingTest ? "Sending…" : "Send test message"}
            </Button>
            <span className="text-xs text-muted-foreground">
              {telegramDirty
                ? "Save first: the test uses the saved token and chat id."
                : status && !status.digest.telegramConfigured
                  ? "Add a bot token and chat id to get digests."
                  : "Uses the saved token and chat id."}
            </span>
          </div>

          {status && !status.digest.linksAvailable ? (
            <p className="text-xs text-muted-foreground">
              JOBOPS_PUBLIC_BASE_URL is not set on the server, so the digest has
              no links to jobs.
            </p>
          ) : null}
          {digestLine ? (
            <p className="text-xs text-muted-foreground">{digestLine}</p>
          ) : null}
        </div>
      </div>
    </SettingsSectionFrame>
  );
};
