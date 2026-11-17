import {
  ID_BIG_TECH_COMPANY_IDS,
  type IdBigTechCompanyId,
} from "@shared/extractors/indonesia/big-tech.js";
import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { IdBigTechCompaniesField } from "./IdBigTechCompaniesField";

const Harness = ({ initial }: { initial: IdBigTechCompanyId[] }) => {
  const methods = useForm<UpdateSettingsInput>({
    defaultValues: { idbigtechCompanies: initial },
  });
  const value = methods.watch("idbigtechCompanies");
  return (
    <FormProvider {...methods}>
      <IdBigTechCompaniesField
        values={{
          effective: initial,
          default: [...ID_BIG_TECH_COMPANY_IDS],
        }}
        disabled={false}
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
      <output data-testid="dirty">{String(methods.formState.isDirty)}</output>
    </FormProvider>
  );
};

describe("IdBigTechCompaniesField", () => {
  it("lists every company, all on by default", () => {
    render(<Harness initial={[...ID_BIG_TECH_COMPANY_IDS]} />);

    for (const label of [
      "Grab",
      "GoTo",
      "TikTok & Tokopedia",
      "Shopee",
      "Traveloka",
      "tiket.com",
      "Blibli",
      "Xendit",
    ]) {
      expect(screen.getByLabelText(label)).toBeChecked();
    }
  });

  it("turns a company off and keeps the catalog order", () => {
    render(<Harness initial={[...ID_BIG_TECH_COMPANY_IDS]} />);

    fireEvent.click(screen.getByLabelText("Shopee"));

    expect(screen.getByLabelText("Shopee")).not.toBeChecked();
    expect(screen.getByTestId("value").textContent).toBe(
      JSON.stringify(ID_BIG_TECH_COMPANY_IDS.filter((id) => id !== "shopee")),
    );
    expect(screen.getByTestId("dirty").textContent).toBe("true");
  });

  it("keeps the last company on", () => {
    render(<Harness initial={["grab"]} />);

    expect(screen.getByLabelText("Grab")).toBeDisabled();
    expect(
      screen.getByText("At least one company has to stay on."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Xendit"));
    expect(screen.getByTestId("value").textContent).toBe(
      JSON.stringify(["grab", "xendit"]),
    );
    expect(screen.getByLabelText("Grab")).not.toBeDisabled();
  });
});
