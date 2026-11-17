import type { SourceSettingsValues } from "@client/pages/settings/types";
import {
  ID_BIG_TECH_COMPANIES,
  type IdBigTechCompanyId,
} from "@shared/extractors/indonesia/big-tech.js";
import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import type React from "react";
import { useFormContext } from "react-hook-form";
import { Checkbox } from "@/components/ui/checkbox";

type IdBigTechCompaniesFieldProps = {
  values: SourceSettingsValues["idbigtechCompanies"];
  disabled: boolean;
};

/** Which career sites the "Indonesia Big Tech" source scans. */
export const IdBigTechCompaniesField: React.FC<
  IdBigTechCompaniesFieldProps
> = ({ values, disabled }) => {
  const { watch, setValue } = useFormContext<UpdateSettingsInput>();
  const selected = new Set<IdBigTechCompanyId>(
    watch("idbigtechCompanies") ?? values.default,
  );

  const toggle = (id: IdBigTechCompanyId, checked: boolean) => {
    const next = ID_BIG_TECH_COMPANIES.map((company) => company.id).filter(
      (companyId) => (companyId === id ? checked : selected.has(companyId)),
    );
    setValue("idbigtechCompanies", next, { shouldDirty: true });
  };

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold">Indonesia Big Tech</legend>
      <p className="text-xs text-muted-foreground">
        Career sites this source checks. Turn off the ones you don't want.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {ID_BIG_TECH_COMPANIES.map((company) => {
          const checked = selected.has(company.id);
          const isLastChecked = checked && selected.size === 1;
          const inputId = `idbigtech-company-${company.id}`;
          return (
            <div key={company.id} className="flex items-center gap-2">
              <Checkbox
                id={inputId}
                checked={checked}
                // At least one company must stay on.
                disabled={disabled || isLastChecked}
                onCheckedChange={(value) => toggle(company.id, value === true)}
              />
              <label
                htmlFor={inputId}
                className="cursor-pointer text-sm leading-none"
              >
                {company.label}
              </label>
            </div>
          );
        })}
      </div>
      {selected.size === 1 ? (
        <p className="text-xs text-muted-foreground">
          At least one company has to stay on.
        </p>
      ) : null}
    </fieldset>
  );
};
