import * as api from "@client/api";
import { renderWithQueryClient } from "@client/test/renderWithQueryClient";
import { createJob } from "@shared/testing/factories.js";
import type { Job, RoleCv } from "@shared/types";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoleCvPicker } from "./RoleCvPicker";

vi.mock("@client/api", () => ({
  getRoleCvs: vi.fn(),
  setJobRoleCv: vi.fn(),
  matchJobRoleCv: vi.fn(),
  applyJobRoleCv: vi.fn(),
  refineJobRoleCv: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/components/ui/select", () => {
  const SelectContext = React.createContext<{
    onValueChange?: (value: string) => void;
  } | null>(null);

  const Select = ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (value: string) => void;
  }) => (
    <SelectContext.Provider value={{ onValueChange }}>
      <div>
        <input readOnly value={value ?? ""} aria-label="select-value" />
        {children}
      </div>
    </SelectContext.Provider>
  );
  const SelectContent = ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  );
  const SelectItem = ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => {
    const context = React.useContext(SelectContext);
    return (
      <button type="button" onClick={() => context?.onValueChange?.(value)}>
        Option: {children}
      </button>
    );
  };
  const SelectTrigger = ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  );
  const SelectValue = () => null;
  return { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
});

function makeRoleCv(overrides: Partial<RoleCv> = {}): RoleCv {
  return {
    id: "cv-backend",
    name: "Backend Engineer",
    roleDescription: "Go and payments",
    tailoredHeadline: "Backend Engineer",
    tailoredSummary: "Builds payment APIs.",
    tailoredSkills: "[]",
    selectedProjectIds: "",
    masterResumeRevision: "design:1:1:x",
    generatedAt: "2026-11-01T00:00:00.000Z",
    isStale: false,
    pdfFreshness: "missing",
    pdfGeneratedAt: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

const backendCv = makeRoleCv();
const dataCv = makeRoleCv({
  id: "cv-data",
  name: "Data Analyst",
  tailoredHeadline: null,
  tailoredSummary: null,
});

function renderPicker(job: Job, props: { disabled?: boolean } = {}) {
  const onJobChange = vi.fn();
  const beforeTailoringChange = vi.fn(async () => {});
  const onBusyChange = vi.fn();
  const view = renderWithQueryClient(
    <RoleCvPicker
      job={job}
      disabled={props.disabled}
      onJobChange={onJobChange}
      beforeTailoringChange={beforeTailoringChange}
      onBusyChange={onBusyChange}
    />,
  );
  return { ...view, onJobChange, beforeTailoringChange, onBusyChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getRoleCvs).mockResolvedValue([backendCv, dataCv]);
});

describe("RoleCvPicker", () => {
  it("renders nothing when there are no Role CVs", async () => {
    vi.mocked(api.getRoleCvs).mockResolvedValue([]);
    const { container } = renderPicker(createJob({ id: "job-1" }));

    await waitFor(() => expect(api.getRoleCvs).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the current choice and whether it was auto or manual", async () => {
    const { rerender } = renderPicker(
      createJob({
        id: "job-1",
        roleCvId: "cv-backend",
        roleCvMatchSource: "auto",
      }),
    );

    expect(await screen.findByText("Auto")).toBeInTheDocument();
    expect(screen.getByLabelText("select-value")).toHaveValue("cv-backend");

    rerender(
      <RoleCvPicker
        job={createJob({
          id: "job-1",
          roleCvId: "cv-backend",
          roleCvMatchSource: "manual",
        })}
        onJobChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Manual")).toBeInTheDocument();
  });

  it("saves a manual choice when another Role CV is selected", async () => {
    const updated = createJob({
      id: "job-1",
      roleCvId: "cv-data",
      roleCvMatchSource: "manual",
    });
    vi.mocked(api.setJobRoleCv).mockResolvedValue(updated);
    const { onJobChange, beforeTailoringChange } = renderPicker(
      createJob({ id: "job-1", roleCvId: "cv-backend" }),
    );

    fireEvent.click(await screen.findByText("Option: Data Analyst"));

    await waitFor(() =>
      expect(api.setJobRoleCv).toHaveBeenCalledWith("job-1", "cv-data"),
    );
    await waitFor(() =>
      expect(onJobChange).toHaveBeenCalledWith(updated, {
        tailoringChanged: false,
      }),
    );
    expect(beforeTailoringChange).not.toHaveBeenCalled();
  });

  it("applies the Role CV as is after flushing pending edits", async () => {
    const updated = createJob({ id: "job-1", roleCvId: "cv-backend" });
    vi.mocked(api.applyJobRoleCv).mockResolvedValue(updated);
    const { onJobChange, beforeTailoringChange } = renderPicker(
      createJob({ id: "job-1", roleCvId: "cv-backend" }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Apply as is" }));

    await waitFor(() =>
      expect(onJobChange).toHaveBeenCalledWith(updated, {
        tailoringChanged: true,
      }),
    );
    expect(api.applyJobRoleCv).toHaveBeenCalledWith("job-1");
    expect(beforeTailoringChange).toHaveBeenCalledTimes(1);
  });

  it("refines for the job and auto-picks on request", async () => {
    const job = createJob({ id: "job-1", roleCvId: "cv-backend" });
    vi.mocked(api.refineJobRoleCv).mockResolvedValue(job);
    vi.mocked(api.matchJobRoleCv).mockResolvedValue(job);
    const { onJobChange } = renderPicker(job);

    fireEvent.click(
      await screen.findByRole("button", { name: "Refine for this job" }),
    );
    await waitFor(() =>
      expect(api.refineJobRoleCv).toHaveBeenCalledWith("job-1"),
    );
    await waitFor(() => expect(onJobChange).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Auto-pick" }));
    await waitFor(() =>
      expect(api.matchJobRoleCv).toHaveBeenCalledWith("job-1"),
    );
  });

  it("disables apply and refine until the job's Role CV has content", async () => {
    renderPicker(createJob({ id: "job-1", roleCvId: "cv-data" }));

    expect(
      await screen.findByRole("button", { name: "Apply as is" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Refine for this job" }),
    ).toBeDisabled();
    expect(screen.getByText(/This Role CV is empty/)).toBeInTheDocument();
  });

  it("disables apply and refine when no Role CV is chosen", async () => {
    renderPicker(createJob({ id: "job-1" }));

    expect(
      await screen.findByRole("button", { name: "Apply as is" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Auto-pick" })).toBeEnabled();
  });
});
