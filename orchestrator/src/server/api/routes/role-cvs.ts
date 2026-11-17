import { toAppError } from "@infra/errors";
import { asyncRoute, fail, ok } from "@infra/http";
import { logger } from "@infra/logger";
import { resolveRequestOrigin } from "@infra/request-origin";
import {
  createRoleCv,
  deleteRoleCv,
  generateRoleCv,
  generateRoleCvPdf,
  getRoleCv,
  getRoleCvPdfFile,
  listRoleCvs,
  updateRoleCv,
} from "@server/services/role-cvs";
import { safePdfFileName } from "@shared/filename-sanitizer";
import type { RoleCvsListResponse } from "@shared/types";
import { type Request, type Response, Router } from "express";
import { z } from "zod";

export const roleCvsRouter = Router();

const nameSchema = z.string().trim().min(1).max(120);
const roleDescriptionSchema = z.string().trim().max(20000);

const createRoleCvSchema = z.object({
  name: nameSchema,
  roleDescription: roleDescriptionSchema.default(""),
});

const tailoredSkillsSchema = z
  .string()
  .max(50000)
  .nullable()
  .refine(
    (value) => {
      if (value === null || value.trim() === "") return true;
      try {
        return Array.isArray(JSON.parse(value));
      } catch {
        return false;
      }
    },
    { message: "tailoredSkills must be a JSON array" },
  );

const updateRoleCvSchema = z
  .object({
    name: nameSchema.optional(),
    roleDescription: roleDescriptionSchema.optional(),
    tailoredHeadline: z.string().max(500).nullable().optional(),
    tailoredSummary: z.string().max(10000).nullable().optional(),
    tailoredSkills: tailoredSkillsSchema.optional(),
    selectedProjectIds: z.string().max(5000).nullable().optional(),
  })
  .strict();

roleCvsRouter.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const payload: RoleCvsListResponse = { roleCvs: await listRoleCvs() };
    ok(res, payload);
  }),
);

roleCvsRouter.post(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    const input = createRoleCvSchema.parse(req.body ?? {});
    ok(res, await createRoleCv(input), 201);
  }),
);

roleCvsRouter.get(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    ok(res, await getRoleCv(req.params.id));
  }),
);

roleCvsRouter.patch(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const input = updateRoleCvSchema.parse(req.body ?? {});
    ok(res, await updateRoleCv(req.params.id, input));
  }),
);

roleCvsRouter.delete(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    await deleteRoleCv(req.params.id);
    ok(res, { id: req.params.id, deleted: true });
  }),
);

roleCvsRouter.post(
  "/:id/generate",
  asyncRoute(async (req: Request, res: Response) => {
    ok(res, await generateRoleCv(req.params.id));
  }),
);

roleCvsRouter.post(
  "/:id/generate-pdf",
  asyncRoute(async (req: Request, res: Response) => {
    ok(
      res,
      await generateRoleCvPdf(req.params.id, {
        requestOrigin: resolveRequestOrigin(req),
      }),
    );
  }),
);

roleCvsRouter.get(
  "/:id/pdf",
  asyncRoute(async (req: Request, res: Response) => {
    const file = await getRoleCvPdfFile(req.params.id);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${safePdfFileName(file.fileName, { fallbackBase: "Role_CV" })}"`,
    );
    res.sendFile(file.path, (error) => {
      if (error && !res.headersSent) {
        fail(res, toAppError(error));
      }
    });
  }),
);

roleCvsRouter.use(
  (error: unknown, req: Request, res: Response, _next: () => void) => {
    const err = toAppError(error);
    logger[err.status >= 500 ? "error" : "warn"]("Role CV request failed", {
      route: `${req.method} /api/role-cvs${req.path}`,
      status: err.status,
      code: err.code,
      details: err.details,
    });
    fail(res, err);
  },
);
