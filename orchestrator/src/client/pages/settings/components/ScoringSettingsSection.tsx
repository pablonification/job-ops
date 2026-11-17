import { TokenizedInput } from "@client/pages/orchestrator/TokenizedInput";
import { SettingsInput } from "@client/pages/settings/components/SettingsInput";
import { SettingsSectionFrame } from "@client/pages/settings/components/SettingsSectionFrame";
import type { ScoringValues } from "@client/pages/settings/types";
import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import type React from "react";
import { useState } from "react";
import { Controller, useFormContext } from "react-hook-form";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

type ScoringSettingsSectionProps = {
  values: ScoringValues;
  isLoading: boolean;
  isSaving: boolean;
  layoutMode?: "accordion" | "panel";
};

function parseTokenizedKeywordInput(input: string): string[] {
  return input
    .split(/[\n,]/g)
    .map((value) => value.trim())
    .filter(Boolean);
}

export const ScoringSettingsSection: React.FC<ScoringSettingsSectionProps> = ({
  values,
  isLoading,
  isSaving,
  layoutMode,
}) => {
  const {
    penalizeMissingSalary,
    missingSalaryPenalty,
    autoSkipScoreThreshold,
    blockedCompanyKeywords,
    targetCompanies,
    dealbreakers,
  } = values;
  const { control, watch, setValue } = useFormContext<UpdateSettingsInput>();
  const [blockedCompanyKeywordDraft, setBlockedCompanyKeywordDraft] =
    useState("");

  // Watch the current form value to conditionally show/hide penalty input
  const currentPenalizeEnabled =
    watch("penalizeMissingSalary") ?? penalizeMissingSalary.default;

  // Watch auto-skip threshold to show current value
  const currentAutoSkipThreshold = watch("autoSkipScoreThreshold");
  const blockedCompanyKeywordValues =
    watch("blockedCompanyKeywords") ?? blockedCompanyKeywords.default;
  const targetCompanyLines = watch("targetCompanies") ?? [];

  return (
    <SettingsSectionFrame
      mode={layoutMode}
      title="Scoring Settings"
      value="scoring"
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <label htmlFor="targetCompanies" className="text-sm font-medium">
            Target companies
          </label>
          <Textarea
            id="targetCompanies"
            rows={5}
            value={targetCompanyLines.join("\n")}
            onChange={(event) =>
              setValue("targetCompanies", event.target.value.split("\n"), {
                shouldDirty: true,
                shouldValidate: true,
              })
            }
            placeholder={"GoTo | Gojek | Tokopedia\nGrab\nShopee"}
            disabled={isLoading || isSaving}
          />
          <p className="text-xs text-muted-foreground">
            One company per line. Put other names for the same company on one
            line, separated by |. Jobs at these companies get a Target badge and
            a small lift in scoring when the fit is otherwise close.
          </p>
          <div className="break-words font-mono text-xs text-muted-foreground">
            Effective:{" "}
            {targetCompanies.effective.length > 0
              ? targetCompanies.effective.join(", ")
              : "None"}
          </div>
        </div>

        <div className="space-y-2">
          <label htmlFor="dealbreakers" className="text-sm font-medium">
            Dealbreakers
          </label>
          <Controller
            name="dealbreakers"
            control={control}
            render={({ field }) => (
              <Textarea
                id="dealbreakers"
                rows={4}
                value={field.value ?? ""}
                onChange={(event) => field.onChange(event.target.value)}
                onBlur={field.onBlur}
                placeholder={
                  "Unpaid roles\nOn-site outside Jakarta\nMore than 2 years of experience required"
                }
                disabled={isLoading || isSaving}
              />
            )}
          />
          <p className="text-xs text-muted-foreground">
            Things you will not accept, in plain words. Jobs that clearly break
            one get a low score, and the reason names it.
          </p>
          <div className="break-words font-mono text-xs text-muted-foreground">
            Effective: {dealbreakers.effective.trim() ? "Set" : "None"}
          </div>
        </div>

        <Separator />

        {/* Enable penalty toggle */}
        <div className="flex items-start space-x-3">
          <Controller
            name="penalizeMissingSalary"
            control={control}
            render={({ field }) => (
              <Checkbox
                id="penalizeMissingSalary"
                checked={field.value ?? penalizeMissingSalary.default}
                onCheckedChange={(checked) => {
                  field.onChange(
                    checked === "indeterminate" ? null : checked === true,
                  );
                }}
                disabled={isLoading || isSaving}
              />
            )}
          />
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="penalizeMissingSalary"
              className="text-sm font-medium leading-none cursor-pointer"
            >
              Penalize Missing Salary
            </label>
            <p className="text-xs text-muted-foreground">
              Reduce suitability scores for jobs that do not include salary
              information. Jobs with any salary text (including "Competitive")
              are not penalized.
            </p>
          </div>
        </div>

        {/* Penalty amount input - only shown when enabled */}
        {currentPenalizeEnabled && (
          <div className="pl-7">
            <Controller
              name="missingSalaryPenalty"
              control={control}
              render={({ field }) => (
                <SettingsInput
                  label="Penalty Amount"
                  type="number"
                  inputProps={{
                    ...field,
                    inputMode: "numeric",
                    min: 0,
                    max: 100,
                    step: 1,
                    value: field.value ?? missingSalaryPenalty.default,
                    onChange: (event) => {
                      const value = parseInt(event.target.value, 10);
                      if (Number.isNaN(value)) {
                        field.onChange(null);
                      } else {
                        field.onChange(Math.min(100, Math.max(0, value)));
                      }
                    },
                  }}
                  disabled={isLoading || isSaving}
                  helper={`Points to subtract from suitability score (0-100). Default: ${missingSalaryPenalty.default}.`}
                  current={`Effective: ${missingSalaryPenalty.effective} | Default: ${missingSalaryPenalty.default}`}
                />
              )}
            />
          </div>
        )}

        <Separator />

        {/* Auto-skip threshold input */}
        <div className="space-y-3">
          <Controller
            name="autoSkipScoreThreshold"
            control={control}
            render={({ field }) => (
              <SettingsInput
                label="Auto-skip Score Threshold"
                type="number"
                inputProps={{
                  ...field,
                  inputMode: "numeric",
                  min: 0,
                  max: 100,
                  step: 1,
                  value: field.value ?? "",
                  onChange: (event) => {
                    const value = event.target.value;
                    if (value === "" || value === null) {
                      field.onChange(null);
                    } else {
                      const parsed = parseInt(value, 10);
                      if (Number.isNaN(parsed)) {
                        field.onChange(null);
                      } else {
                        field.onChange(Math.min(100, Math.max(0, parsed)));
                      }
                    }
                  },
                  placeholder: "Disabled",
                }}
                disabled={isLoading || isSaving}
                helper="Jobs scoring below this threshold will be automatically skipped during scoring. Leave empty to disable auto-skip. (0-100)"
                current={`Effective: ${currentAutoSkipThreshold === null || currentAutoSkipThreshold === undefined ? "Disabled" : currentAutoSkipThreshold} | Default: ${autoSkipScoreThreshold.default ?? "Disabled"}`}
              />
            )}
          />
        </div>

        <div className="space-y-3">
          <label
            htmlFor="blocked-company-keywords"
            className="text-sm font-medium leading-none"
          >
            Blocked Company Keywords
          </label>
          <TokenizedInput
            id="blocked-company-keywords"
            values={blockedCompanyKeywordValues}
            draft={blockedCompanyKeywordDraft}
            parseInput={parseTokenizedKeywordInput}
            onDraftChange={setBlockedCompanyKeywordDraft}
            onValuesChange={(value) =>
              setValue("blockedCompanyKeywords", value, { shouldDirty: true })
            }
            placeholder='e.g. "recruitment", "staffing"'
            helperText="Jobs whose company name contains one of these keywords will be dropped during discovery."
            removeLabelPrefix="Remove blocked keyword"
            disabled={isLoading || isSaving}
          />
          <div className="break-words font-mono text-xs text-muted-foreground">
            Effective:{" "}
            {blockedCompanyKeywordValues.length > 0
              ? blockedCompanyKeywordValues.join(", ")
              : "None"}{" "}
            | Default:{" "}
            {blockedCompanyKeywords.default.length > 0
              ? blockedCompanyKeywords.default.join(", ")
              : "None"}
          </div>
        </div>

        <Separator />

        {/* Effective/Default values display */}
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <div className="text-xs text-muted-foreground">Penalty Enabled</div>
            <div className="break-words font-mono text-xs">
              Effective: {penalizeMissingSalary.effective ? "Yes" : "No"} |
              Default: {penalizeMissingSalary.default ? "Yes" : "No"}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Penalty Amount</div>
            <div className="break-words font-mono text-xs">
              Effective: {missingSalaryPenalty.effective} | Default:{" "}
              {missingSalaryPenalty.default}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">
              Auto-skip Threshold
            </div>
            <div className="break-words font-mono text-xs">
              Effective: {autoSkipScoreThreshold.effective ?? "Disabled"} |
              Default: {autoSkipScoreThreshold.default ?? "Disabled"}
            </div>
          </div>
        </div>
      </div>
    </SettingsSectionFrame>
  );
};
