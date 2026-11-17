import * as clientApi from "@client/api";
import type {
  AccessTokenScope,
  AccessTokenSummary,
  CreateAccessTokenInput,
  CreateAccessTokenResponse,
} from "@shared/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { toast } from "sonner";
import { showErrorToast } from "@/client/lib/error-toast";
import { queryKeys } from "@/client/lib/queryKeys";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type AgentAccessApi = {
  listAccessTokens: typeof clientApi.listAccessTokens;
  createAccessToken: typeof clientApi.createAccessToken;
  revokeAccessToken: typeof clientApi.revokeAccessToken;
};

// Resolved at call time so modules that mock `@client/api` without these
// functions can still import the settings page.
const defaultAgentAccessApi: AgentAccessApi = {
  listAccessTokens: () => clientApi.listAccessTokens(),
  createAccessToken: (input) => clientApi.createAccessToken(input),
  revokeAccessToken: (id) => clientApi.revokeAccessToken(id),
};

const EXPIRY_OPTIONS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never" },
] as const;

const SELECT_CLASS_NAME =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const COPY_FEEDBACK_MS = 2_000;

function formatDate(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function getTokenState(
  token: AccessTokenSummary,
): "active" | "revoked" | "expired" {
  if (token.revokedAt) return "revoked";
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) {
    return "expired";
  }
  return "active";
}

/** Shell-safe single quoting for the copy-paste command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildClaudeMcpAddCommand(mcpUrl: string, secret: string) {
  return `claude mcp add --transport http jobops ${shellQuote(mcpUrl)} --header ${shellQuote(`Authorization: Bearer ${secret}`)}`;
}

function resolveMcpUrl(serverUrl: string | null | undefined): string {
  if (serverUrl) return serverUrl;
  if (typeof window !== "undefined") return `${window.location.origin}/mcp`;
  return "/mcp";
}

const CopyableBlock: React.FC<{ label: string; value: string }> = ({
  label,
  value,
}) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Copy is not available in this browser.");
      }
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch (error) {
      showErrorToast(error, "Could not copy. Select the text and copy it.");
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
          {value}
        </code>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void copy()}
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          {copied ? (
            <Check className="h-4 w-4" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
};

type AgentAccessSectionProps = {
  api?: AgentAccessApi;
};

export const AgentAccessSection: React.FC<AgentAccessSectionProps> = ({
  api = defaultAgentAccessApi,
}) => {
  const queryClient = useQueryClient();
  const [name, setName] = useState("Claude Code");
  const [scope, setScope] = useState<AccessTokenScope>("read");
  const [expiry, setExpiry] =
    useState<(typeof EXPIRY_OPTIONS)[number]["value"]>("90");
  const [nameError, setNameError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateAccessTokenResponse | null>(
    null,
  );

  const tokensQuery = useQuery({
    queryKey: queryKeys.auth.accessTokens(),
    queryFn: () => api.listAccessTokens(),
    retry: false,
  });

  const invalidateTokens = () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.auth.accessTokens(),
    });

  const createMutation = useMutation({
    mutationFn: (input: CreateAccessTokenInput) => api.createAccessToken(input),
    onSuccess: async (response) => {
      setCreated(response);
      await invalidateTokens();
    },
    onError: (error) => {
      showErrorToast(error, "Could not create the token");
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (token: AccessTokenSummary) => api.revokeAccessToken(token.id),
    onSuccess: async () => {
      await invalidateTokens();
      toast.success("Token revoked");
    },
    onError: (error) => {
      showErrorToast(error, "Could not revoke the token");
    },
  });

  const handleCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Enter a name for the token.");
      return;
    }
    setNameError(null);
    createMutation.mutate({
      name: trimmed,
      scope,
      expiresInDays: expiry === "never" ? null : Number(expiry),
    });
  };

  const tokens = tokensQuery.data?.tokens ?? [];
  const mcpUrl = resolveMcpUrl(created?.mcpUrl ?? tokensQuery.data?.mcpUrl);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          Connect an AI agent such as Claude Code to JobOps over MCP. A token
          acts as you: it sees your jobs and, with read and write access, can
          change them.
        </p>
        <p className="text-xs text-muted-foreground">
          MCP endpoint: <code className="font-mono">{mcpUrl}</code>
        </p>
      </div>

      {created ? (
        <section
          className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-4"
          aria-labelledby="agent-token-created-title"
          aria-live="polite"
        >
          <div className="space-y-1">
            <h3
              className="text-sm font-semibold"
              id="agent-token-created-title"
            >
              Copy your token now
            </h3>
            <p className="text-sm text-muted-foreground">
              This is the only time JobOps shows it. Store it somewhere safe.
            </p>
          </div>
          <CopyableBlock label="Token" value={created.secret} />
          <CopyableBlock
            label="Claude Code command"
            value={buildClaudeMcpAddCommand(mcpUrl, created.secret)}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setCreated(null)}
          >
            Done
          </Button>
        </section>
      ) : null}

      <div className="space-y-3">
        <div className="text-sm font-semibold">Create a token</div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="agent-token-name">
              Name
            </label>
            <Input
              id="agent-token-name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="agent-token-scope">
              Access
            </label>
            <select
              id="agent-token-scope"
              className={SELECT_CLASS_NAME}
              value={scope}
              onChange={(event) =>
                setScope(event.currentTarget.value as AccessTokenScope)
              }
            >
              <option value="read">Read only</option>
              <option value="write">Read and write</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="agent-token-expiry">
              Expires
            </label>
            <select
              id="agent-token-expiry"
              className={SELECT_CLASS_NAME}
              value={expiry}
              onChange={(event) =>
                setExpiry(
                  event.currentTarget
                    .value as (typeof EXPIRY_OPTIONS)[number]["value"],
                )
              }
            >
              {EXPIRY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {nameError ? (
          <p className="text-sm text-destructive" role="alert">
            {nameError}
          </p>
        ) : null}
        <Button
          type="button"
          onClick={handleCreate}
          disabled={createMutation.isPending}
        >
          Create token
        </Button>
      </div>

      <div className="space-y-3">
        <div className="text-sm font-semibold">Your tokens</div>
        {tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {tokensQuery.isLoading ? "Loading tokens…" : "No tokens yet."}
          </p>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {tokens.map((token) => {
              const state = getTokenState(token);
              return (
                <div
                  className="flex flex-wrap items-center justify-between gap-3 p-3"
                  key={token.id}
                  data-testid={`access-token-${token.id}`}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {token.name}
                      </span>
                      <Badge variant="outline">
                        {token.scope === "write"
                          ? "Read and write"
                          : "Read only"}
                      </Badge>
                      {state === "active" ? null : (
                        <Badge variant="secondary">
                          {state === "revoked" ? "Revoked" : "Expired"}
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <code className="font-mono">{token.prefix}…</code> ·
                      created {formatDate(token.createdAt)} · last used{" "}
                      {formatDate(token.lastUsedAt)} ·{" "}
                      {token.expiresAt
                        ? `expires ${formatDate(token.expiresAt)}`
                        : "no expiry"}
                    </div>
                  </div>
                  {state === "revoked" ? null : (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={revokeMutation.isPending}
                        >
                          Revoke
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Revoke {token.name}?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            Agents using this token lose access right away. This
                            can't be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => revokeMutation.mutate(token)}
                          >
                            Revoke token
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
