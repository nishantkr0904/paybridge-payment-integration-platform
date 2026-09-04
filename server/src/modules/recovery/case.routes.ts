import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { HttpError } from '../../utils/http-error.js';
import { canTransition, InvalidCaseTransitionError } from './case.state-machine.js';
import {
  getCaseById,
  getCaseByRef,
  getCaseTimeline,
  getPrioritizedQueue,
  listCases,
  transitionCase
} from './case.service.js';
import { findTracesByCaseId } from '../ai/tracing/trace.service.js';
import type { CaseStatus } from './case.types.js';
import { getRecoveryAnalytics } from './analytics.service.js';
import type { RecoveryAnalyticsFilters } from './analytics.types.js';

const CASE_STATUSES = [
  'detected',
  'diagnosing',
  'scoring',
  'deciding',
  'awaiting_approval',
  'executing',
  'awaiting_outcome',
  'recovered',
  'unrecovered',
  'suppressed',
  'expired',
  'failed'
] as const;

const isoDatePattern = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export const analyticsQuerySchema = z
  .object({
    startDate: z
      .string()
      .refine(
        (val) => isoDatePattern.test(val) && !isNaN(Date.parse(val)),
        { message: 'startDate must be a valid ISO 8601 date or datetime string.' }
      )
      .optional(),
    endDate: z
      .string()
      .refine(
        (val) => isoDatePattern.test(val) && !isNaN(Date.parse(val)),
        { message: 'endDate must be a valid ISO 8601 date or datetime string.' }
      )
      .optional(),
    currency: z
      .string()
      .trim()
      .length(3, 'currency must be a 3-character ISO currency code.')
      .optional()
  })
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        return new Date(data.startDate).getTime() <= new Date(data.endDate).getTime();
      }
      return true;
    },
    {
      message: 'startDate must be less than or equal to endDate.',
      path: ['startDate']
    }
  );

const listCasesQuerySchema = z.object({
  status: z.enum(CASE_STATUSES).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0)
});

const queueQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
  maxPerMerchant: z.coerce.number().int().positive().optional()
});

const operatorActionSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT', 'CLOSE']),
  reason: z.string().trim().min(1, 'Reason is mandatory for operator action'),
  payload: z.record(z.unknown()).optional()
});

export const caseRouter = Router();

caseRouter.use(authenticate);

/* ------------------------------------------------------------------ */
/*  Recovery Analytics & Performance KPIs (ADB-001–004 / BT-C1 / BT-C2) */
/* ------------------------------------------------------------------ */

/* GET /api/recovery/analytics — get recovery performance KPIs, latency, and strategy performance */
caseRouter.get('/analytics', async (req, res, next) => {
  try {
    const query = analyticsQuerySchema.parse(req.query);
    const merchantId = req.user!.id;

    const filters: RecoveryAnalyticsFilters = {
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
      currency: query.currency ? query.currency.toUpperCase() : undefined
    };

    const analytics = await getRecoveryAnalytics(merchantId, filters);
    res.json(analytics);
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------ */
/*  Case Listing & Prioritised Triage Queue (RDB-001)                 */
/* ------------------------------------------------------------------ */

/* GET /api/recovery/cases — list recovery cases with status filtering and pagination */
caseRouter.get('/cases', async (req, res, next) => {
  try {
    const query = listCasesQuerySchema.parse(req.query);
    const merchantId = req.user!.id;

    let allCases = await listCases(merchantId);

    if (query.status) {
      allCases = allCases.filter((c) => c.status === query.status);
    }

    const total = allCases.length;
    const paginatedCases = allCases.slice(query.offset, query.offset + query.limit);

    res.json({
      cases: paginatedCases,
      total,
      limit: query.limit,
      offset: query.offset
    });
  } catch (error) {
    next(error);
  }
});

/* GET /api/recovery/queue — get prioritized triage queue */
caseRouter.get('/queue', async (req, res, next) => {
  try {
    const query = queueQuerySchema.parse(req.query);
    const merchantId = req.user!.id;

    const prioritizedQueue = await getPrioritizedQueue(merchantId, {
      limit: query.limit,
      maxPerMerchant: query.maxPerMerchant
    });

    res.json({
      queue: prioritizedQueue,
      total: prioritizedQueue.length
    });
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------ */
/*  Case Detail, Timeline & Reasoning Traces (RDB-002 / AI-007)       */
/* ------------------------------------------------------------------ */

/* GET /api/recovery/cases/:idOrRef — get single case by numeric ID or ULID reference */
caseRouter.get('/cases/:idOrRef', async (req, res, next) => {
  try {
    const { idOrRef } = req.params;
    const merchantId = req.user!.id;

    const numericId = Number(idOrRef);
    let recoveryCase;

    if (!isNaN(numericId) && numericId > 0 && String(numericId) === idOrRef) {
      recoveryCase = await getCaseById(numericId, merchantId);
    } else {
      recoveryCase = await getCaseByRef(idOrRef, merchantId);
    }

    res.json({ case: recoveryCase });
  } catch (error) {
    next(error);
  }
});

/* GET /api/recovery/cases/:caseId/timeline — get chronological case event history */
caseRouter.get('/cases/:caseId/timeline', async (req, res, next) => {
  try {
    const caseId = Number(req.params.caseId);
    if (isNaN(caseId) || caseId <= 0) {
      throw new HttpError(400, 'INVALID_CASE_ID', 'Case ID must be a positive integer.');
    }
    const merchantId = req.user!.id;

    const timeline = await getCaseTimeline(caseId, merchantId);
    res.json({ timeline });
  } catch (error) {
    next(error);
  }
});

/* GET /api/recovery/cases/:caseId/traces — get agent reasoning traces for case */
caseRouter.get('/cases/:caseId/traces', async (req, res, next) => {
  try {
    const caseId = Number(req.params.caseId);
    if (isNaN(caseId) || caseId <= 0) {
      throw new HttpError(400, 'INVALID_CASE_ID', 'Case ID must be a positive integer.');
    }
    const merchantId = req.user!.id;

    // Verify case belongs to authenticated merchant first
    await getCaseById(caseId, merchantId);

    const traces = await findTracesByCaseId(caseId, merchantId);
    res.json({ traces });
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------ */
/*  Operator Interventions & Human Actions (RCV-004 / RDB-004)        */
/* ------------------------------------------------------------------ */

/* POST /api/recovery/cases/:caseId/actions — execute operator action */
caseRouter.post('/cases/:caseId/actions', async (req, res, next) => {
  try {
    const caseId = Number(req.params.caseId);
    if (isNaN(caseId) || caseId <= 0) {
      throw new HttpError(400, 'INVALID_CASE_ID', 'Case ID must be a positive integer.');
    }
    const merchantId = req.user!.id;
    const body = operatorActionSchema.parse(req.body);

    const existingCase = await getCaseById(caseId, merchantId);

    let targetStatus: CaseStatus;
    if (body.action === 'APPROVE') {
      targetStatus = 'executing';
    } else if (body.action === 'REJECT') {
      targetStatus = 'suppressed';
    } else if (body.action === 'CLOSE') {
      targetStatus = 'suppressed';
    } else {
      throw new HttpError(400, 'INVALID_ACTION', `Unsupported operator action: ${body.action}`);
    }

    if (!canTransition(existingCase.status, targetStatus)) {
      throw new HttpError(
        400,
        'INVALID_CASE_TRANSITION',
        `Cannot perform action '${body.action}' on case in '${existingCase.status}' status.`
      );
    }

    const updatedCase = await transitionCase(
      caseId,
      merchantId,
      targetStatus,
      { type: 'operator', id: req.user!.email },
      body.reason,
      {
        operatorAction: body.action,
        operatorEmail: req.user!.email,
        ...body.payload
      },
      req.correlationId
    );

    res.json({ case: updatedCase });
  } catch (error) {
    if (error instanceof InvalidCaseTransitionError) {
      next(new HttpError(400, 'INVALID_CASE_TRANSITION', error.message));
      return;
    }
    next(error);
  }
});
