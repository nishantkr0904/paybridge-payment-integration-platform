import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { HttpError } from '../../utils/http-error.js';
import { logger } from '../../utils/logger.js';
import { exportCaseAuditTrail } from './audit.service.js';

export const auditRouter = Router();

// All audit export endpoints require authentication (tenant-scoped)
auditRouter.use(authenticate);

const ExportQuerySchema = z.object({
  format: z.enum(['csv', 'json']).default('csv'),
  includeTraces: z
    .enum(['true', 'false'])
    .optional()
    .transform((val) => val !== 'false')
});

/**
 * GET /api/audit/cases/:idOrRef/export
 * Exports certified audit trail artifact as CSV or JSON for compliance/dispute defense (AUD-006 / RDB-002).
 */
auditRouter.get('/cases/:idOrRef/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const merchantId = req.user!.id;
    const actorEmail = req.user!.email;
    const idOrRef = Array.isArray(req.params.idOrRef) ? req.params.idOrRef[0] : req.params.idOrRef;

    const parsedQuery = ExportQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        `Invalid export query parameters: ${parsedQuery.error.issues.map((i) => i.message).join(', ')}`
      );
    }

    const { format, includeTraces } = parsedQuery.data;

    logger.info(
      {
        merchantId,
        actorEmail,
        caseIdentifier: idOrRef,
        format,
        includeTraces,
        correlationId: req.headers['x-correlation-id']
      },
      `[AuditExport] Generating ${format.toUpperCase()} compliance audit export for case ${idOrRef}`
    );

    const result = await exportCaseAuditTrail(
      idOrRef,
      merchantId,
      actorEmail,
      format,
      includeTraces
    );

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('X-Audit-Signature', result.signature);
    res.setHeader('X-Export-Id', result.data.metadata.exportId);

    return res.status(200).send(result.content);
  } catch (err) {
    next(err);
  }
});
