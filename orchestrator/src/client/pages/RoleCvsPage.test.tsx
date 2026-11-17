import { createAppSettings } from "@shared/testing/factories.js";
import type { RoleCv } from "@shared/types";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { renderWithQueryClient } from "../test/renderWithQueryClient";
import { RoleCvsPage } from "./RoleCvsPage";

vi.mock("../api", () => ({
  getRoleCvs: vi.fn(),
  getProfileProjects: vi.fn(),
  getSettings: vi.fn(),
  createRoleCv: vi.fn(),
  updateRoleCv: vi.fn(),
  deleteRoleCv: vi.fn(),
  generateRoleCv: vi.fn(),
  generateRoleCvPdf: vi.fn(),
  getRoleCvPdfBlob: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeRoleCv(overrides: Partial<RoleCv> = {}): RoleCv {
  return {
    id: "cv-1",
    name: "Backend Engineer",
    roleDescription: "Go and payments",
    tailoredHeadline: "Backend Engineer",
    tailoredSummary: "Builds payment APIs.",
    tailoredSkills: JSON.stringify([
      { name: "Backend", keywords: ["Go", "PostgreSQL"] },
    ]),
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

function renderPage() {
  return renderWithQueryClient(
    <MemoryRouter>
      <RoleCvsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getProfileProjects).mockResolvedValue([]);
  vi.mocked(api.getSettings).mockResolvedValue(createAppSettings());
});

describe("RoleCvsPage", () => {
  it("shows an empty state and creates a Role CV from the dialog", async () => {
    vi.mocked(api.getRoleCvs).mockResolvedValue([]);
    const created = makeRoleCv({
      id: "cv-new",
      name: "Data Analyst",
      roleDescription: "SQL and dashboards",
      tailoredHeadline: null,
      tailoredSummary: null,
      tailoredSkills: null,
      generatedAt: null,
      masterResumeRevision: null,
    });
    vi.mocked(api.createRoleCv).mockResolvedValue(created);

    renderPage();

    expect(await screen.findByText("No Role CVs yet")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /New Role CV/ })[0]);

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Data Analyst" },
    });
    fireEvent.change(within(dialog).getByLabelText("Role description"), {
      target: { value: "SQL and dashboards" },
    });
    vi.mocked(api.getRoleCvs).mockResolvedValue([created]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(api.createRoleCv).toHaveBeenCalledWith({
        name: "Data Analyst",
        roleDescription: "SQL and dashboards",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Data Analyst" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Not generated").length).toBeGreaterThan(0);
  });

  it("shows the stale warning and regenerates", async () => {
    const stale = makeRoleCv({ isStale: true });
    vi.mocked(api.getRoleCvs).mockResolvedValue([stale]);
    vi.mocked(api.generateRoleCv).mockResolvedValue(
      makeRoleCv({ updatedAt: "2026-11-02T00:00:00.000Z" }),
    );

    renderPage();

    expect(
      await screen.findByText(
        /Your resume changed since this CV was generated/,
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Outdated").length).toBeGreaterThan(0);

    vi.mocked(api.getRoleCvs).mockResolvedValue([
      makeRoleCv({ updatedAt: "2026-11-02T00:00:00.000Z" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));

    await waitFor(() =>
      expect(api.generateRoleCv).toHaveBeenCalledWith("cv-1"),
    );
    await waitFor(() =>
      expect(
        screen.queryByText(/Your resume changed since this CV was generated/),
      ).not.toBeInTheDocument(),
    );
  });

  it("saves edited fields with the job tailoring encodings", async () => {
    const roleCv = makeRoleCv();
    vi.mocked(api.getRoleCvs).mockResolvedValue([roleCv]);
    vi.mocked(api.updateRoleCv).mockImplementation(async (_id, input) =>
      makeRoleCv({ ...input, updatedAt: "2026-11-03T00:00:00.000Z" }),
    );

    renderPage();

    const summary = await screen.findByLabelText("Summary");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(summary, { target: { value: "Ships payment systems." } });
    fireEvent.change(screen.getByLabelText("Category"), {
      target: { value: "Languages" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.updateRoleCv).toHaveBeenCalledWith("cv-1", {
        tailoredSummary: "Ships payment systems.",
        tailoredSkills: JSON.stringify([
          { name: "Languages", keywords: ["Go", "PostgreSQL"] },
        ]),
      }),
    );
  });

  it("makes a PDF and deletes after confirmation", async () => {
    const roleCv = makeRoleCv();
    vi.mocked(api.getRoleCvs).mockResolvedValue([roleCv]);
    const withPdf = makeRoleCv({
      pdfFreshness: "current",
      pdfGeneratedAt: "2026-11-03T00:00:00.000Z",
      updatedAt: "2026-11-03T00:00:00.000Z",
    });
    vi.mocked(api.generateRoleCvPdf).mockResolvedValue(withPdf);
    vi.mocked(api.deleteRoleCv).mockResolvedValue(undefined);

    renderPage();

    expect(
      await screen.findByRole("button", { name: "Download" }),
    ).toBeDisabled();
    vi.mocked(api.getRoleCvs).mockResolvedValue([withPdf]);
    fireEvent.click(screen.getByRole("button", { name: "Make PDF" }));
    await waitFor(() =>
      expect(api.generateRoleCvPdf).toHaveBeenCalledWith("cv-1"),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Download" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(api.deleteRoleCv).not.toHaveBeenCalled();
    vi.mocked(api.getRoleCvs).mockResolvedValue([]);
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(api.deleteRoleCv).toHaveBeenCalledWith("cv-1"));
    expect(await screen.findByText("No Role CVs yet")).toBeInTheDocument();
  });
});
