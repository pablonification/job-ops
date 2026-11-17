import {
  badRequest,
  forbidden,
  serviceUnavailable,
  unauthorized,
} from "@infra/errors";
import { asyncRoute, fail, ok } from "@infra/http";
import { logger } from "@infra/logger";
import { getRequestContext } from "@infra/request-context";
import { isDemoMode } from "@server/config/demo";
import { resolveMcpEndpointUrl } from "@server/mcp/endpoint";
import {
  createAccessToken,
  listAccessTokens,
  revokeAccessToken,
} from "@server/services/access-tokens";
import {
  ACCESS_TOKEN_MAX_EXPIRY_DAYS,
  ACCESS_TOKEN_SCOPES,
  type AccessTokenListResponse,
  type CreateAccessTokenResponse,
} from "@shared/types";
import { type Request, type Response, Router } from "express";
import { z } from "zod";

const createAccessTokenSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scope: z.enum(ACCESS_TOKEN_SCOPES),
  expiresInDays: z
    .number()
    .int()
    .min(1)
    .max(ACCESS_TOKEN_MAX_EXPIRY_DAYS)
    .nullable()
    .optional(),
});

export const accessTokensRouter = Router();

/**
 * Tokens are managed only from a signed-in session: an access token can never
 * mint, list or revoke tokens (the auth guard also blocks this).
 */
function requireSessionUser(
  res: Response,
): { userId: string; tenantId: string } | null {
  if (isDemoMode()) {
    fail(
      res,
      serviceUnavailable("Agent access is disabled in the public demo."),
    );
    return null;
  }
  const context = getRequestContext();
  if (!context?.userId || !context.tenantId) {
    fail(res, unauthorized("Authentication required"));
    return null;
  }
  if (context.authMethod === "access_token") {
    fail(res, forbidden("Access tokens cannot manage access tokens."));
    return null;
  }
  return { userId: context.userId, tenantId: context.tenantId };
}

accessTokensRouter.get(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    const user = requireSessionUser(res);
    if (!user) return;
    const data: AccessTokenListResponse = {
      tokens: await listAccessTokens(user),
      mcpUrl: resolveMcpEndpointUrl(req),
    };
    ok(res, data);
  }),
);

accessTokensRouter.post(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    const user = requireSessionUser(res);
    if (!user) return;
    const parsed = createAccessTokenSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      fail(
        res,
        badRequest(
          issue
            ? `${issue.path.join(".") || "body"}: ${issue.message}`
            : "Invalid request body",
          parsed.error.flatten(),
        ),
      );
      return;
    }
    const created = await createAccessToken({ ...user, ...parsed.data });
    logger.info("Access token created", {
      route: "POST /api/auth/tokens",
      tokenId: created.token.id,
      scope: created.token.scope,
      expiresAt: created.token.expiresAt,
    });
    const data: CreateAccessTokenResponse = {
      ...created,
      mcpUrl: resolveMcpEndpointUrl(req),
    };
    ok(res, data, 201);
  }),
);

accessTokensRouter.delete(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const user = requireSessionUser(res);
    if (!user) return;
    const token = await revokeAccessToken({ ...user, id: req.params.id ?? "" });
    logger.info("Access token revoked", {
      route: "DELETE /api/auth/tokens/:id",
      tokenId: token.id,
    });
    ok(res, token);
  }),
);
