import { forbidden } from "@infra/errors";
import type { AccessTokenScope } from "@shared/types";
import type { McpToolDefinition } from "./tool";

const SCOPE_RANK: Record<AccessTokenScope, number> = { read: 0, write: 1 };

export function hasScope(
  granted: AccessTokenScope,
  required: AccessTokenScope,
): boolean {
  return SCOPE_RANK[granted] >= SCOPE_RANK[required];
}

/** Throws a FORBIDDEN AppError when the caller's scope is too narrow. */
export function assertToolScope(
  tool: Pick<McpToolDefinition, "name" | "scope">,
  granted: AccessTokenScope,
): void {
  if (hasScope(granted, tool.scope)) return;
  throw forbidden(
    `The ${tool.name} tool needs a token with ${tool.scope} scope; this token has ${granted} scope. Create a read-write token in Settings > Agent access.`,
  );
}
