import { Star } from "lucide-react";
import type React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TargetCompanyFilterPillProps } from "./types";

/** On/off filter: only jobs at the companies in Settings > Scoring. */
export const TargetCompanyFilterPill: React.FC<
  TargetCompanyFilterPillProps
> = ({ targetCompaniesOnly, onTargetCompaniesOnlyChange }) => (
  <Button
    type="button"
    variant="outline"
    size="sm"
    aria-pressed={targetCompaniesOnly}
    title="Only show jobs at your target companies (Settings > Scoring)"
    onClick={() => onTargetCompaniesOnlyChange(!targetCompaniesOnly)}
    className={cn(
      "h-9 gap-1.5 rounded-full border-solid text-xs font-medium text-muted-foreground",
      targetCompaniesOnly && "border-primary/50 bg-primary/5 text-foreground",
    )}
  >
    <span className="[&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:opacity-70">
      <Star />
    </span>
    <span>Target companies</span>
  </Button>
);
