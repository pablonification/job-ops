import * as api from "@client/api";
import { showErrorToast } from "@client/lib/error-toast";
import { queryKeys } from "@client/lib/queryKeys";
import type { Job, RoleCv } from "@shared/types.js";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NONE_VALUE = "__none__";

type RoleCvAction = "select" | "match" | "apply" | "refine";

export interface RoleCvPickerProps {
  job: Job;
  disabled?: boolean;
  /** Runs before an action that rewrites tailoring (e.g. flush autosave). */
  beforeTailoringChange?: () => Promise<void>;
  /** Receives the updated job after every action. */
  onJobChange: (
    job: Job,
    change: { tailoringChanged: boolean },
  ) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}

function hasContent(roleCv: RoleCv | undefined): boolean {
  return Boolean(
    roleCv?.tailoredHeadline?.trim() && roleCv?.tailoredSummary?.trim(),
  );
}

function matchLabel(job: Job): string | null {
  if (job.roleCvMatchSource === "manual") return "Manual";
  if (job.roleCvMatchSource === "auto") {
    return job.roleCvId ? "Auto" : "Auto: no match";
  }
  return null;
}

/**
 * Chooses the Role CV for a job and applies it as-is or refines it for the
 * job. Renders nothing until the user has at least one Role CV.
 */
export const RoleCvPicker: React.FC<RoleCvPickerProps> = ({
  job,
  disabled = false,
  beforeTailoringChange,
  onJobChange,
  onBusyChange,
}) => {
  const [busyAction, setBusyAction] = useState<RoleCvAction | null>(null);
  const roleCvsQuery = useQuery({
    queryKey: queryKeys.roleCvs.list(),
    queryFn: api.getRoleCvs,
  });
  const roleCvs = roleCvsQuery.data ?? [];
  if (roleCvs.length === 0) return null;

  const current = roleCvs.find((roleCv) => roleCv.id === job.roleCvId);
  const currentHasContent = hasContent(current);
  const label = matchLabel(job);
  const isBusy = busyAction !== null;
  const controlsDisabled = disabled || isBusy;

  const run = async (
    action: RoleCvAction,
    work: () => Promise<Job>,
    successMessage: (job: Job) => string,
  ) => {
    const tailoringChanged = action === "apply" || action === "refine";
    setBusyAction(action);
    onBusyChange?.(true);
    try {
      if (tailoringChanged) await beforeTailoringChange?.();
      const updated = await work();
      await onJobChange(updated, { tailoringChanged });
      toast.success(successMessage(updated));
    } catch (error) {
      showErrorToast(error, "Role CV action failed");
    } finally {
      setBusyAction(null);
      onBusyChange?.(false);
    }
  };

  const handleSelect = (value: string) => {
    const roleCvId = value === NONE_VALUE ? null : value;
    void run(
      "select",
      () => api.setJobRoleCv(job.id, roleCvId),
      () => (roleCvId ? "Role CV set" : "Role CV cleared"),
    );
  };

  const handleMatch = () =>
    void run(
      "match",
      () => api.matchJobRoleCv(job.id),
      (updated) =>
        updated.roleCvId ? "Role CV picked" : "No Role CV fits this job",
    );

  const handleApply = () =>
    void run(
      "apply",
      () => api.applyJobRoleCv(job.id),
      () => "Role CV applied",
    );

  const handleRefine = () =>
    void run(
      "refine",
      () => api.refineJobRoleCv(job.id),
      () => "CV refined for this job",
    );

  const spinner = (action: RoleCvAction) =>
    busyAction === action ? <Loader2 className="h-4 w-4 animate-spin" /> : null;

  return (
    <section
      aria-label="Role CV"
      className="space-y-3 rounded-md border px-3 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-foreground/90">
          Role CV
        </span>
        {label ? (
          <Badge variant="outline" className="text-[11px] font-medium">
            {label}
          </Badge>
        ) : null}
        {spinner("select")}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select
          value={job.roleCvId ?? NONE_VALUE}
          onValueChange={handleSelect}
          disabled={controlsDisabled}
        >
          <SelectTrigger
            aria-label="Role CV for this job"
            className="sm:max-w-xs"
          >
            <SelectValue placeholder="None" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>None</SelectItem>
            {roleCvs.map((roleCv) => (
              <SelectItem key={roleCv.id} value={roleCv.id}>
                {roleCv.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleMatch}
            disabled={controlsDisabled}
          >
            {spinner("match")}
            Auto-pick
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleApply}
            disabled={controlsDisabled || !currentHasContent}
          >
            {spinner("apply")}
            Apply as is
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefine}
            disabled={controlsDisabled || !currentHasContent}
          >
            {spinner("refine")}
            Refine for this job
          </Button>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground/75">
        {current && !currentHasContent
          ? "This Role CV is empty. Generate it on the Role CVs page first."
          : "Apply as is copies the Role CV without AI. Refine tailors it to this job."}
      </p>
    </section>
  );
};
