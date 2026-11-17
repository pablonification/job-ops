import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { FormProvider, type UseFormReturn, useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { ScoringSettingsSection } from "./ScoringSettingsSection";

let form: UseFormReturn<UpdateSettingsInput> | null = null;

const ScoringHarness = ({
  defaults,
}: {
  defaults: Partial<UpdateSettingsInput>;
}) => {
  const methods = useForm<UpdateSettingsInput>({ defaultValues: defaults });
  form = methods;

  return (
    <FormProvider {...methods}>
      <ScoringSettingsSection
        layoutMode="panel"
        isLoading={false}
        isSaving={false}
        values={{
          penalizeMissingSalary: { effective: false, default: false },
          missingSalaryPenalty: { effective: 10, default: 10 },
          autoSkipScoreThreshold: { effective: null, default: null },
          blockedCompanyKeywords: { effective: [], default: [] },
          targetCompanies: { effective: ["Grab"], default: [] },
          dealbreakers: { effective: "", default: "" },
        }}
      />
    </FormProvider>
  );
};

describe("ScoringSettingsSection target companies and dealbreakers", () => {
  it("edits target companies one per line, keeping alias lines intact", () => {
    render(
      <ScoringHarness
        defaults={{ targetCompanies: ["Grab"], dealbreakers: "" }}
      />,
    );

    const targets = screen.getByLabelText("Target companies");
    expect(targets).toHaveValue("Grab");

    fireEvent.change(targets, {
      target: { value: "GoTo | Gojek | Tokopedia\nGrab\n" },
    });

    expect(form?.getValues("targetCompanies")).toEqual([
      "GoTo | Gojek | Tokopedia",
      "Grab",
      "",
    ]);
    expect(targets).toHaveValue("GoTo | Gojek | Tokopedia\nGrab\n");
    expect(screen.getByText(/separated by \|/)).toBeInTheDocument();
  });

  it("edits dealbreakers as free text", () => {
    render(
      <ScoringHarness defaults={{ targetCompanies: [], dealbreakers: "" }} />,
    );

    fireEvent.change(screen.getByLabelText("Dealbreakers"), {
      target: { value: "Unpaid roles\nOn-site outside Jakarta" },
    });

    expect(form?.getValues("dealbreakers")).toBe(
      "Unpaid roles\nOn-site outside Jakarta",
    );
  });
});
