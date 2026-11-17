import type { AccessTokenSummary } from "@shared/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentAccessApi,
  AgentAccessSection,
  buildClaudeMcpAddCommand,
} from "./AgentAccessSection";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/client/lib/error-toast", () => ({
  showErrorToast: vi.fn(),
}));

import { toast } from "sonner";
import { showErrorToast } from "@/client/lib/error-toast";

const SECRET =
  "jo_pat_0123456789ab_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const MCP_URL = "https://jobs.example.com/mcp";

const activeToken: AccessTokenSummary = {
  id: "token-1",
  name: "Laptop agent",
  prefix: "jo_pat_0123456789ab",
  scope: "write",
  createdAt: "2026-11-01T00:00:00.000Z",
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
};

const revokedToken: AccessTokenSummary = {
  ...activeToken,
  id: "token-2",
  name: "Old agent",
  scope: "read",
  revokedAt: "2026-11-02T00:00:00.000Z",
};

function createApi(overrides: Partial<AgentAccessApi> = {}): AgentAccessApi {
  return {
    listAccessTokens: vi.fn(async () => ({
      tokens: [activeToken, revokedToken],
      mcpUrl: MCP_URL,
    })),
    createAccessToken: vi.fn(async (input) => ({
      token: {
        ...activeToken,
        id: "token-3",
        name: input.name,
        scope: input.scope,
      },
      secret: SECRET,
      mcpUrl: MCP_URL,
    })),
    revokeAccessToken: vi.fn(async () => ({
      ...activeToken,
      revokedAt: "2026-11-03T00:00:00.000Z",
    })),
    ...overrides,
  };
}

function renderSection(api: AgentAccessApi) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentAccessSection api={api} />
    </QueryClientProvider>,
  );
}

describe("AgentAccessSection", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lists tokens with scope and state", async () => {
    renderSection(createApi());

    expect(await screen.findByText("Laptop agent")).toBeInTheDocument();
    expect(screen.getByText("Old agent")).toBeInTheDocument();
    const activeRow = screen.getByTestId("access-token-token-1");
    const revokedRow = screen.getByTestId("access-token-token-2");
    expect(within(activeRow).getByText("Read and write")).toBeInTheDocument();
    expect(within(revokedRow).getByText("Read only")).toBeInTheDocument();
    expect(within(revokedRow).getByText("Revoked")).toBeInTheDocument();
    expect(screen.getByText(MCP_URL)).toBeInTheDocument();
    // Only the active token can be revoked.
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
  });

  it("creates a token and shows the secret and Claude Code command once", async () => {
    const api = createApi();
    renderSection(api);
    await screen.findByText("Laptop agent");

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "  Claude Code  " },
    });
    fireEvent.change(screen.getByLabelText("Access"), {
      target: { value: "write" },
    });
    fireEvent.change(screen.getByLabelText("Expires"), {
      target: { value: "never" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    await waitFor(() =>
      expect(api.createAccessToken).toHaveBeenCalledWith({
        name: "Claude Code",
        scope: "write",
        expiresInDays: null,
      }),
    );
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    const command = buildClaudeMcpAddCommand(MCP_URL, SECRET);
    expect(screen.getByText(command)).toBeInTheDocument();
    expect(command).toBe(
      `claude mcp add --transport http jobops '${MCP_URL}' --header 'Authorization: Bearer ${SECRET}'`,
    );

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it("asks for a name before creating", async () => {
    const api = createApi();
    renderSection(api);
    await screen.findByText("Laptop agent");

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    expect(
      await screen.findByText("Enter a name for the token."),
    ).toBeInTheDocument();
    expect(api.createAccessToken).not.toHaveBeenCalled();
  });

  it("revokes a token after confirmation", async () => {
    const api = createApi();
    renderSection(api);
    await screen.findByText("Laptop agent");

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Revoke token" }),
    );

    await waitFor(() =>
      expect(api.revokeAccessToken).toHaveBeenCalledWith("token-1"),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Token revoked"),
    );
  });

  it("reports creation errors", async () => {
    const api = createApi({
      createAccessToken: vi.fn(async () => {
        throw new Error("Agent access is disabled in the public demo.");
      }),
    });
    renderSection(api);
    await screen.findByText("Laptop agent");

    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith(
        expect.any(Error),
        "Could not create the token",
      ),
    );
  });
});
