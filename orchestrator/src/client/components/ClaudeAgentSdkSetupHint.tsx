import { ExternalLink } from "lucide-react";
import type React from "react";

const AUTH_DOC = "https://code.claude.com/docs/en/authentication";

/**
 * Explains how to connect a Claude subscription for the `claude_agent_sdk`
 * provider. The Agent SDK ships with the JobOps image, so the only setup is
 * the long-lived OAuth token from `claude setup-token`.
 */
export const ClaudeAgentSdkSetupHint: React.FC = () => {
  return (
    <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">
        Claude subscription on this machine
      </p>
      <p className="mt-2">
        On any computer with Claude Code installed, run{" "}
        <code className="rounded bg-muted px-1 py-0.5">claude setup-token</code>{" "}
        (needs a Claude Pro, Max, Team, or Enterprise plan). Put the printed
        token in your <code className="rounded bg-muted px-1 py-0.5">.env</code>{" "}
        file as{" "}
        <code className="rounded bg-muted px-1 py-0.5">
          CLAUDE_CODE_OAUTH_TOKEN
        </code>{" "}
        and restart JobOps. There is no JobOps API key field.
      </p>
      <p className="mt-2">
        JobOps never passes{" "}
        <code className="rounded bg-muted px-1 py-0.5">ANTHROPIC_API_KEY</code>{" "}
        to this provider, so requests always use your subscription. Use model
        names such as{" "}
        <code className="rounded bg-muted px-1 py-0.5">sonnet</code>,{" "}
        <code className="rounded bg-muted px-1 py-0.5">opus</code>, or{" "}
        <code className="rounded bg-muted px-1 py-0.5">haiku</code>.
      </p>
      <p className="mt-2">
        <a
          className="inline-flex items-center gap-1 text-foreground underline decoration-border underline-offset-4"
          href={AUTH_DOC}
          target="_blank"
          rel="noopener noreferrer"
        >
          Claude authentication guide
          <ExternalLink className="size-3.5 shrink-0 opacity-70" aria-hidden />
        </a>
      </p>
    </div>
  );
};
