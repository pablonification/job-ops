import type { VariantProps } from "class-variance-authority";
import { ExternalLink } from "lucide-react";
import type React from "react";
import { Button, type buttonVariants } from "@/components/ui/button";
import { getHttpHref } from "@/lib/safe-href";
import { cn } from "@/lib/utils";
import { KbdHint } from "./KbdHint";

interface OpenJobListingButtonProps {
  href: string;
  className?: string;
  shortcut?: string;
  disabled?: boolean;
  size?: VariantProps<typeof buttonVariants>["size"];
  onClick?: () => void;
}

export const OpenJobListingButton: React.FC<OpenJobListingButtonProps> = ({
  href,
  className,
  shortcut,
  size = "sm",
  disabled = false,
  onClick,
}) => {
  const safeHref = getHttpHref(href);
  if (disabled || !safeHref) {
    return (
      <Button
        variant="outline"
        size={size}
        className={cn("gap-1", className)}
        disabled
      >
        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">Open Job Listing</span>
        {shortcut ? <KbdHint shortcut={shortcut} className="ml-auto" /> : null}
      </Button>
    );
  }

  return (
    <Button
      asChild
      variant="outline"
      size={size}
      className={cn("gap-1", className)}
    >
      <a
        href={safeHref}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onClick}
      >
        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">Open Job Listing</span>
        {shortcut ? <KbdHint shortcut={shortcut} className="ml-auto" /> : null}
      </a>
    </Button>
  );
};
