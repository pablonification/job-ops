/**
 * Express app factory (useful for tests).
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { forbidden, unauthorized } from "@infra/errors";
import {
  apiErrorHandler,
  fail,
  notFoundApiHandler,
  requestContextMiddleware,
} from "@infra/http";
import { logger } from "@infra/logger";
import {
  type RequestAuthMethod,
  runWithRequestContext,
} from "@infra/request-context";
import { sanitizeUnknown } from "@infra/sanitize";
import { verifyToken } from "@server/auth/jwt";
import { getJobOpsAppConfig } from "@server/config/app-mode";
import { isDemoMode } from "@server/config/demo";
import * as usersRepo from "@server/repositories/users";
import {
  authenticateAccessToken,
  isAccessTokenCandidate,
} from "@server/services/access-tokens";
import { proxyChallengeViewerRequest } from "@server/services/challenge-viewer";
import { DEFAULT_TENANT_ID } from "@server/tenancy/constants";
import type { AccessTokenScope } from "@shared/types";
import cors from "cors";
import express from "express";
import { apiRouter } from "./api/index";
import { isMcpRoute, MCP_PATH } from "./mcp/endpoint";
import { mcpHandler } from "./mcp/http";
import { ojcpManifestHandler, ojcpMcpHandler } from "./ojcp";
import { resolveTracerRedirect } from "./services/tracer-links";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UMAMI_UPSTREAM_ORIGIN = "https://umami.dakheera47.com";
const UMAMI_PROXY_TIMEOUT_MS = 5_000;
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const REQUEST_HEADERS_TO_SKIP = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "transfer-encoding",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-forwarded-server",
]);
const ALLOWED_UMAMI_PROXY_PATHS = new Set(["/script.js", "/api/send"]);
const ALLOWED_UMAMI_PROXY_METHODS = new Map<string, string[]>([
  ["/script.js", ["GET", "HEAD"]],
  ["/api/send", ["POST"]],
]);
const ANALYTICS_DISABLED_TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);
const UMAMI_SCRIPT_PATTERN =
  /\s*<script\b[^>]*\ssrc\s*=\s*["']https:\/\/umami\.dakheera47\.com\/script\.js["'][^>]*>\s*<\/script>/gi;
const OPENPANEL_SCRIPT_PATTERN =
  /\s*<script>\s*window\.op =[\s\S]*?window\.op\("init", \{[\s\S]*?\n\s*}\);\s*<\/script>\s*<script src="https:\/\/openpanel\.dev\/op1\.js" defer async><\/script>/;

function isStatsRoute(path: string): boolean {
  return path === "/stats" || path.startsWith("/stats/");
}

function isAnalyticsDisabled(): boolean {
  const normalized = process.env.JOBOPS_DISABLE_ANALYTICS?.trim().toLowerCase();
  return normalized ? ANALYTICS_DISABLED_TRUTHY_VALUES.has(normalized) : false;
}

function renderHtmlWithAnalyticsConfig(html: string): string {
  if (!isAnalyticsDisabled()) return html;
  const withoutAnalytics = html
    .replace(UMAMI_SCRIPT_PATTERN, "")
    .replace(OPENPANEL_SCRIPT_PATTERN, "");
  if (!withoutAnalytics.includes("</head>")) return withoutAnalytics;
  return withoutAnalytics.replace(
    "</head>",
    "    <script>window.__JOBOPS_ANALYTICS_DISABLED__=true;</script>\n  </head>",
  );
}

function getUmamiUpstreamUrl(originalUrl: string): URL {
  const incomingUrl = new URL(originalUrl, "http://localhost");
  const upstreamUrl = new URL(UMAMI_UPSTREAM_ORIGIN);
  upstreamUrl.pathname = incomingUrl.pathname.replace(/^\/stats/, "") || "/";
  upstreamUrl.search = incomingUrl.search;
  return upstreamUrl;
}

function isAllowedUmamiProxyPath(pathname: string): boolean {
  return ALLOWED_UMAMI_PROXY_PATHS.has(pathname);
}

function getAllowedUmamiMethods(pathname: string): string[] {
  return ALLOWED_UMAMI_PROXY_METHODS.get(pathname) ?? [];
}

function isAllowedUmamiMethod(method: string, pathname: string): boolean {
  return getAllowedUmamiMethods(pathname).includes(method.toUpperCase());
}

function isUmamiProxyTimeoutError(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return true;
  }
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function buildUmamiProxyBody(req: express.Request): BodyInit | undefined {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  if (Buffer.isBuffer(req.body)) return new Uint8Array(req.body);
  if (typeof req.body === "string") return req.body;
  if (req.body === undefined || req.body === null) return undefined;
  if (
    typeof req.body === "object" &&
    Object.keys(req.body as Record<string, unknown>).length === 0
  ) {
    return undefined;
  }
  return JSON.stringify(req.body);
}

function copyUmamiResponseHeaders(
  upstreamResponse: Response,
  res: express.Response,
): void {
  for (const [key, value] of upstreamResponse.headers.entries()) {
    if (HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    res.setHeader(key, value);
  }
}

function buildUmamiProxyHeaders(req: express.Request): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value || REQUEST_HEADERS_TO_SKIP.has(key.toLowerCase())) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

/** API areas no personal access token may reach, whatever its scope. */
const ACCESS_TOKEN_FORBIDDEN_API_AREAS = [
  "/api/workspaces",
  "/api/auth/sso",
  "/api/database",
  "/api/backups",
  "/api/billing",
  "/api/settings/codex-auth",
];

type AuthorizationContext = {
  userId: string;
  tenantId: string;
  username: string;
  isSystemAdmin: boolean;
  authMethod: RequestAuthMethod;
  accessTokenId?: string;
  accessTokenScope?: AccessTokenScope;
};

export function createAuthGuard() {
  const testAuthBypassEnabled =
    process.env.NODE_ENV === "test" &&
    process.env.JOBOPS_TEST_AUTH_BYPASS === "1";

  async function getAuthorizationContext(
    req: express.Request,
  ): Promise<AuthorizationContext | null> {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return null;
    const token = authHeader.slice("Bearer ".length).trim();
    try {
      // Personal access tokens resolve to the same context a session would,
      // through the same account checks below.
      const accessToken = isAccessTokenCandidate(token)
        ? await authenticateAccessToken(token)
        : null;
      if (isAccessTokenCandidate(token) && !accessToken) return null;
      const credential = accessToken
        ? { userId: accessToken.userId, tenantId: accessToken.tenantId }
        : await verifyToken(token);
      const user = await usersRepo.getUserById(credential.userId);
      const appConfig = getJobOpsAppConfig();
      if (
        !user ||
        user.isDisabled ||
        user.workspaceId !== credential.tenantId ||
        (appConfig.appMode === "hosted" &&
          user.workspaceId !== appConfig.hostedTenantId)
      ) {
        return null;
      }
      return {
        userId: user.id,
        tenantId: user.workspaceId,
        username: user.username,
        isSystemAdmin: user.isSystemAdmin,
        ...(accessToken
          ? {
              authMethod: "access_token" as const,
              accessTokenId: accessToken.tokenId,
              accessTokenScope: accessToken.scope,
            }
          : { authMethod: "session" as const }),
      };
    } catch {
      return null;
    }
  }

  /**
   * Limits on what a personal access token may do over the REST API. MCP
   * tools enforce scopes per tool instead.
   */
  function getAccessTokenRestriction(
    method: string,
    path: string,
    context: AuthorizationContext,
  ): string | null {
    if (context.authMethod !== "access_token") return null;
    // Express routing is case-insensitive, so compare lower-cased paths.
    const normalizedPath = (path.split("?")[0] || path).toLowerCase();
    if (
      normalizedPath === "/api/auth/tokens" ||
      normalizedPath.startsWith("/api/auth/tokens/")
    ) {
      return "Access tokens cannot manage access tokens. Sign in to the web app instead.";
    }
    // Account and instance administration stays with a signed-in person: a
    // token must not be able to set a password, link a sign-in identity,
    // manage users, wipe the database or touch backups and billing.
    if (
      ACCESS_TOKEN_FORBIDDEN_API_AREAS.some(
        (area) =>
          normalizedPath === area || normalizedPath.startsWith(`${area}/`),
      )
    ) {
      return "Access tokens cannot manage accounts, sign-in, backups, billing or the database. Sign in to the web app instead.";
    }
    if (
      context.accessTokenScope === "read" &&
      normalizedPath.startsWith("/api/") &&
      !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())
    ) {
      return "This access token is read-only.";
    }
    return null;
  }

  function isPublicReadOnlyRoute(method: string, path: string): boolean {
    const normalizedMethod = method.toUpperCase();
    const normalizedPath = path.split("?")[0] || path;

    // Explicitly allowed public API routes
    if (normalizedPath === "/api/demo/info") return true;
    if (normalizedPath === "/api/app/status") return true;
    if (normalizedPath === "/api/profile/status") return true;
    if (
      normalizedMethod === "POST" &&
      normalizedPath === "/api/billing/webhook" &&
      getJobOpsAppConfig().appMode === "hosted"
    )
      return true;
    if (normalizedMethod === "POST" && normalizedPath === "/ojcp/mcp")
      return true;
    if (
      normalizedMethod === "POST" &&
      normalizedPath === "/api/visa-sponsors/search"
    )
      return true;
    if (
      normalizedMethod === "POST" &&
      normalizedPath === "/api/webhook/trigger"
    )
      return Boolean(process.env.WEBHOOK_SECRET?.trim());

    // Auth endpoints must be accessible without existing auth.
    if (
      normalizedMethod === "POST" &&
      (normalizedPath === "/api/auth/login" ||
        normalizedPath === "/api/auth/logout" ||
        normalizedPath === "/api/auth/signup" ||
        normalizedPath === "/api/auth/setup")
    )
      return true;
    if (
      normalizedMethod === "GET" &&
      normalizedPath === "/api/auth/bootstrap-status"
    )
      return true;
    if (
      normalizedMethod === "GET" &&
      normalizedPath === "/api/auth/sso/providers"
    )
      return true;
    if (
      normalizedMethod === "POST" &&
      /^\/api\/auth\/sso\/(google|github|oidc)\/(start|callback)$/.test(
        normalizedPath,
      )
    )
      return true;
    if (
      ["GET", "HEAD"].includes(normalizedMethod) &&
      /^\/api\/design-resume\/assets\/[^/]+\/content$/.test(normalizedPath)
    )
      return getJobOpsAppConfig().appMode !== "hosted";
    if (
      ["GET", "HEAD"].includes(normalizedMethod) &&
      /^\/api\/[^/]+\/health$/.test(normalizedPath)
    )
      return true;

    return false;
  }

  function isProtectedDemoRoute(path: string): boolean {
    const normalizedPath = path.split("?")[0] || path;

    if (normalizedPath === "/api/auth/me") return true;
    // Linking and listing connected accounts act on a real user, so they stay
    // behind auth in demo mode. requiresAuth consults isPublicReadOnlyRoute
    // first, which keeps the sign-in routes reachable.
    if (normalizedPath.startsWith("/api/auth/sso/")) return true;
    if (normalizedPath.startsWith("/api/workspaces")) return true;
    if (normalizedPath === "/api/settings/codex-auth") return true;
    if (normalizedPath === "/api/settings/rx-resumes") return true;
    if (/^\/api\/settings\/rx-resumes\/[^/]+\/projects$/.test(normalizedPath)) {
      return true;
    }

    return false;
  }

  function isPublicDemoRoute(path: string): boolean {
    if (!isDemoMode()) return false;

    const normalizedPath = path.split("?")[0] || path;
    if (!normalizedPath.startsWith("/api/")) return false;

    return !isProtectedDemoRoute(normalizedPath);
  }

  function requiresAuth(method: string, path: string): boolean {
    // The agent endpoint is private for every method, including GET (the
    // generic rule below would leave non-API GETs public).
    if (isMcpRoute(path)) return method.toUpperCase() !== "OPTIONS";
    if (isPublicReadOnlyRoute(method, path)) return false;
    if (isPublicDemoRoute(path)) return false;
    // OPTIONS is always exempt for CORS preflight.
    if (method.toUpperCase() === "OPTIONS") return false;

    // Umami's public script posts browser beacons to /stats/api/send. The
    // proxy route still validates method/path before forwarding.
    if (isStatsRoute(path)) return false;

    // Analytics and per-job tracer details are workspace-private.
    if (path.startsWith("/api/tracer-links/analytics")) return true;
    if (path.startsWith("/api/tracer-links/jobs")) return true;

    // Allow public read access to other tracer link routes.
    if (path.startsWith("/api/tracer-links")) {
      return !["GET", "HEAD"].includes(method.toUpperCase());
    }

    // All other /api/* paths require auth regardless of HTTP method.
    if (path.startsWith("/api/")) return true;

    // Non-API routes (SPA, /health, static) remain publicly readable via GET/HEAD.
    return !["GET", "HEAD"].includes(method.toUpperCase());
  }

  const middleware = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    void (async () => {
      // Express matches routes case-insensitively, so every path rule in this
      // guard runs on the lower-cased path. Without this, "/API/jobs" would
      // reach the jobs route while being treated as a public non-API page.
      const guardPath = req.path.toLowerCase();
      if (!requiresAuth(req.method, guardPath)) {
        next();
        return;
      }

      if (testAuthBypassEnabled) {
        runWithRequestContext(
          {
            userId: "test-user",
            tenantId: DEFAULT_TENANT_ID,
            username: "test",
            isSystemAdmin: true,
            authMethod: "session",
          },
          () => next(),
        );
        return;
      }

      const userCount = await usersRepo.countUsers();
      if (userCount === 0) {
        fail(
          res,
          unauthorized(
            isDemoMode()
              ? "Authentication required"
              : "Initial setup is required",
          ),
        );
        return;
      }

      const authContext = await getAuthorizationContext(req);
      if (authContext) {
        const restriction = getAccessTokenRestriction(
          req.method,
          guardPath,
          authContext,
        );
        if (restriction) {
          fail(res, forbidden(restriction));
          return;
        }
        runWithRequestContext(authContext, () => next());
        return;
      }
      fail(res, unauthorized("Authentication required"));
    })().catch(next);
  };

  return {
    middleware,
    getAuthorizationContext,
  };
}

export function createApp() {
  getJobOpsAppConfig();

  const app = express();
  const authGuard = createAuthGuard();
  const corsMiddleware = cors();

  const handleTracerRedirect = async (
    req: express.Request,
    res: express.Response,
    slug: string,
    route: string,
  ) => {
    try {
      const redirect = await resolveTracerRedirect({
        token: slug,
        requestId:
          (res.getHeader("x-request-id") as string | undefined) ?? null,
        ip: req.ip ?? null,
        userAgent: req.header("user-agent") ?? null,
        referrer: req.header("referer") ?? null,
      });

      if (!redirect) {
        logger.warn("Tracer link not found", {
          route,
          token: slug,
        });
        res.status(404).type("text/plain; charset=utf-8").send("Not found");
        return;
      }

      logger.info("Tracer link redirected", {
        route,
        token: slug,
        jobId: redirect.jobId,
      });
      res.set("Cache-Control", "no-store");
      res.set("Pragma", "no-cache");
      res.set("Expires", "0");
      res.redirect(302, redirect.destinationUrl);
    } catch (error) {
      logger.error("Tracer redirect failed", {
        route,
        token: slug,
        error,
      });
      res.status(500).type("text/plain; charset=utf-8").send("Internal error");
    }
  };

  app.use((req, res, next) => {
    if (isStatsRoute(req.path)) {
      next();
      return;
    }
    corsMiddleware(req, res, next);
  });
  app.use(requestContextMiddleware());
  if (getJobOpsAppConfig().appMode === "hosted") {
    app.use(
      "/api/billing/webhook",
      express.raw({ limit: "1mb", type: "application/json" }),
    );
  }
  app.use("/stats", express.raw({ limit: "1mb", type: "*/*" }));
  app.use(
    "/api/design-resume/assets",
    express.raw({
      limit: "10mb",
      type: [
        "image/png",
        "image/jpeg",
        "image/webp",
        "application/octet-stream",
      ],
    }),
  );
  // Resume file import sends base64 JSON payloads, which expand beyond the raw
  // file size. Scope the larger JSON limit to that endpoint only.
  app.use("/api/design-resume/import/file", express.json({ limit: "15mb" }));
  // Ghostwriter chat can include up to three base64 screenshot attachments, so
  // keep a larger JSON limit scoped to this endpoint to allow the maximum
  // validated payload through to route-level validation.
  app.use("/api/jobs/:id/chat", express.json({ limit: "12mb" }));
  app.use(express.json());

  // Logging middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      logger.info("HTTP request completed", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: duration,
      });
    });
    next();
  });

  // Optional authentication for protected routes
  app.use(authGuard.middleware);

  app.get("/.well-known/ojcp.json", ojcpManifestHandler);
  app.all("/ojcp/mcp", ojcpMcpHandler);
  app.all(MCP_PATH, mcpHandler);

  // API routes
  app.use("/api", apiRouter);
  app.use(notFoundApiHandler());

  app.get("/challenge-viewer/solved", (_req, res) => {
    res
      .status(200)
      .type("html")
      .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Challenge solved · Job Ops</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#4ade80;font-family:system-ui,sans-serif;text-align:center}h1{font-size:2rem;font-weight:600;margin-bottom:.5rem}p{color:#a1a1aa;font-size:1.1rem}</style></head>
<body><main><h1>Challenge solved</h1><p>This tab will close shortly. You can return to Job Ops.</p></main></body></html>`);
  });

  app.use("/challenge-viewer/session", (req, res) => {
    void proxyChallengeViewerRequest(req, res);
  });

  app.get("/cv/:slug", async (req, res) => {
    const slug = req.params.slug?.trim();
    if (!slug) {
      res.status(404).type("text/plain; charset=utf-8").send("Not found");
      return;
    }
    await handleTracerRedirect(req, res, slug, "GET /cv/:slug");
  });

  app.all(/^\/stats(?:\/.*)?$/, async (req, res) => {
    if (isAnalyticsDisabled()) {
      res.status(404).type("text/plain; charset=utf-8").send("Not found");
      return;
    }

    const upstreamUrl = getUmamiUpstreamUrl(req.originalUrl);
    if (!isAllowedUmamiProxyPath(upstreamUrl.pathname)) {
      res.status(404).type("text/plain; charset=utf-8").send("Not found");
      return;
    }
    if (!isAllowedUmamiMethod(req.method, upstreamUrl.pathname)) {
      res
        .setHeader(
          "Allow",
          getAllowedUmamiMethods(upstreamUrl.pathname).join(", "),
        )
        .status(405)
        .type("text/plain; charset=utf-8")
        .send("Method not allowed");
      return;
    }

    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        method: req.method,
        headers: buildUmamiProxyHeaders(req),
        body: buildUmamiProxyBody(req),
        redirect: "manual",
        signal: AbortSignal.timeout(UMAMI_PROXY_TIMEOUT_MS),
      });

      res.status(upstreamResponse.status);
      copyUmamiResponseHeaders(upstreamResponse, res);

      if (req.method === "HEAD") {
        res.end();
        return;
      }
      if (!upstreamResponse.body) {
        res.end();
        return;
      }

      await pipeline(
        Readable.fromWeb(upstreamResponse.body as NodeReadableStream),
        res,
      );
    } catch (error) {
      if (isUmamiProxyTimeoutError(error)) {
        logger.warn("Umami proxy timed out", {
          route: req.path,
          method: req.method,
          upstreamUrl: upstreamUrl.toString(),
          requestId:
            (res.getHeader("x-request-id") as string | undefined) ?? undefined,
        });
        res
          .status(504)
          .type("text/plain; charset=utf-8")
          .send("Upstream timeout");
        return;
      }

      logger.error("Umami proxy failed", {
        route: req.path,
        method: req.method,
        upstreamUrl: upstreamUrl.toString(),
        requestId:
          (res.getHeader("x-request-id") as string | undefined) ?? undefined,
        error: sanitizeUnknown(error),
      });
      res.status(502).type("text/plain; charset=utf-8").send("Upstream error");
    }
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Serve client app in production
  if (process.env.NODE_ENV === "production") {
    const packagedDocsDir = join(__dirname, "../../dist/docs");
    const workspaceDocsDir = join(__dirname, "../../../docs-site/build");
    const docsDir = existsSync(packagedDocsDir)
      ? packagedDocsDir
      : workspaceDocsDir;
    const docsIndexPath = join(docsDir, "index.html");
    let cachedDocsIndexHtml: string | null = null;

    if (existsSync(docsIndexPath)) {
      app.use("/docs", express.static(docsDir));
      app.get("/docs/*", async (req, res, next) => {
        if (!req.accepts("html")) {
          next();
          return;
        }
        if (extname(req.path)) {
          next();
          return;
        }
        if (!cachedDocsIndexHtml) {
          cachedDocsIndexHtml = await readFile(docsIndexPath, "utf-8");
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(renderHtmlWithAnalyticsConfig(cachedDocsIndexHtml));
      });
    }

    const clientDir = join(__dirname, "../../dist/client");
    const indexPath = join(clientDir, "index.html");
    let cachedIndexHtml: string | null = null;
    const serveClientHtml = async (
      req: express.Request,
      res: express.Response,
    ) => {
      if (!req.accepts("html")) {
        res.status(404).end();
        return;
      }
      if (!cachedIndexHtml) {
        cachedIndexHtml = await readFile(indexPath, "utf-8");
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderHtmlWithAnalyticsConfig(cachedIndexHtml));
    };

    // Entry HTML must be rewritten before static middleware can serve it.
    app.get(["/", "/index.html"], serveClientHtml);
    app.use(express.static(clientDir, { index: false }));
    app.get("*", serveClientHtml);
  }

  app.use(apiErrorHandler);

  return app;
}
