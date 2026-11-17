import { renderWithQueryClient } from "@client/test/renderWithQueryClient";
import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import type { PipelineScheduleStatus } from "@shared/types.js";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeLastScheduledRun,
  formatInTimeZone,
  ScheduleDigestSection,
} from "./ScheduleDigestSection";

vi.mock("@client/api", () => ({
  getScheduleStatus: vi.fn(),
  getPipelineSearchPresets: vi.fn(),
  sendTelegramTestMessage: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import * as api from "@client/api";
import { toast } from "sonner";

const ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

const values = {
  scheduleEnabled: { effective: true, default: false },
  scheduleTime: { effective: "08:00", default: "08:00" },
  scheduleTimeZone: { effective: "Asia/Jakarta", default: "UTC" },
  scheduleWeekdays: { effective: [...ALL_DAYS], default: [...ALL_DAYS] },
  scheduleCatchUpMinutes: { effective: 15, default: 15 },
  scheduleSearchPresetId: { effective: "", default: "" },
  digestMode: {
    effective: "scheduled" as const,
    default: "scheduled" as const,
  },
  digestMaxJobs: { effective: 5, default: 5 },
  telegramChatId: { effective: "42", default: "" },
};

function status(
  overrides: Partial<PipelineScheduleStatus> = {},
): PipelineScheduleStatus {
  return {
    available: true,
    unavailableReason: null,
    enabled: true,
    timeZone: "Asia/Jakarta",
    timeZoneValid: true,
    nextRunAt: "2026-11-18T01:00:00.000Z",
    runAsUsername: "owner",
    lastAttempt: null,
    lastScheduledRun: null,
    digest: {
      mode: "scheduled",
      telegramConfigured: true,
      linksAvailable: true,
      lastSentAt: null,
      lastStatus: null,
      lastDetail: null,
    },
    ...overrides,
  };
}

function Harness() {
  const methods = useForm<UpdateSettingsInput>({
    defaultValues: {
      scheduleEnabled: true,
      scheduleTime: "08:00",
      scheduleTimeZone: "Asia/Jakarta",
      scheduleWeekdays: [...ALL_DAYS],
      scheduleCatchUpMinutes: 15,
      scheduleSearchPresetId: "",
      digestMode: "scheduled",
      digestMaxJobs: 5,
      telegramChatId: "42",
      telegramBotToken: "",
    },
  });
  return (
    <FormProvider {...methods}>
      <ScheduleDigestSection
        values={values}
        telegramBotTokenHint="1234"
        isLoading={false}
        isSaving={false}
        layoutMode="panel"
      />
    </FormProvider>
  );
}

describe("ScheduleDigestSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getPipelineSearchPresets).mockResolvedValue({
      searches: [],
    });
  });

  it("shows the next run in the schedule's zone and why the last one was skipped", async () => {
    vi.mocked(api.getScheduleStatus).mockResolvedValue(
      status({
        lastAttempt: {
          occurrence: "2026-11-17T01:00:00.000Z",
          attemptedAt: "2026-11-17T01:00:02.000Z",
          outcome: "skipped_active",
          detail: "A run was already active.",
        },
        digest: {
          mode: "scheduled",
          telegramConfigured: true,
          linksAvailable: false,
          lastSentAt: "2026-11-16T01:12:00.000Z",
          lastStatus: "failed",
          lastDetail: "Telegram said: Forbidden: bot was blocked by the user",
        },
      }),
    );
    renderWithQueryClient(<Harness />);

    expect(
      await screen.findByText(
        `${formatInTimeZone("2026-11-17T01:00:00.000Z", "Asia/Jakarta")}: skipped, a run was already active`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        formatInTimeZone("2026-11-18T01:00:00.000Z", "Asia/Jakarta"),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/digest has no links/)).toBeInTheDocument();
    expect(screen.getByText(/bot was blocked by the user/)).toBeInTheDocument();
    expect(screen.getByText("1234********")).toBeInTheDocument();
    expect(screen.getByText(/no saved searches yet/i)).toBeInTheDocument();
  });

  it("sends a test message with the saved settings", async () => {
    vi.mocked(api.getScheduleStatus).mockResolvedValue(status());
    vi.mocked(api.sendTelegramTestMessage).mockResolvedValue({ sent: true });
    renderWithQueryClient(<Harness />);

    const button = await screen.findByRole("button", {
      name: /send test message/i,
    });
    fireEvent.click(button);
    await waitFor(() => {
      expect(api.sendTelegramTestMessage).toHaveBeenCalledTimes(1);
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Test message sent. Check Telegram.",
    );
  });

  it("asks to save before testing changed Telegram details", async () => {
    vi.mocked(api.getScheduleStatus).mockResolvedValue(status());
    renderWithQueryClient(<Harness />);

    fireEvent.change(await screen.findByLabelText("Chat id"), {
      target: { value: "-100999" },
    });
    expect(
      await screen.findByText(/Save first: the test uses the saved token/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /send test message/i }),
    ).toBeDisabled();
  });

  it("describes a finished or failed scheduled run", () => {
    const run = {
      id: "run-1",
      startedAt: "2026-11-17T01:00:05.000Z",
      completedAt: "2026-11-17T01:09:00.000Z",
      status: "completed" as const,
      jobsDiscovered: 40,
      jobsProcessed: 3,
      errorMessage: null,
      trigger: "schedule" as const,
    };
    const when = formatInTimeZone(run.startedAt, "Asia/Jakarta");
    expect(
      describeLastScheduledRun(
        status({
          lastScheduledRun: run,
          lastAttempt: {
            occurrence: "2026-11-17T01:00:00.000Z",
            attemptedAt: "2026-11-17T01:00:02.000Z",
            outcome: "started",
            detail: null,
          },
        }),
      ),
    ).toBe(`${when}: finished, 40 found, 3 tailored`);
    expect(
      describeLastScheduledRun(
        status({
          lastScheduledRun: {
            ...run,
            status: "failed",
            errorMessage: "usage limit reached",
          },
        }),
      ),
    ).toBe(`${when}: failed: usage limit reached`);
    expect(describeLastScheduledRun(status())).toBeNull();
  });
});
