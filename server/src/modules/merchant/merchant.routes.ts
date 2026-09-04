import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import {
  activatePolicy,
  createPolicy,
  deactivatePolicy,
  evaluateProposedAction,
  getActivePolicy,
  getPolicyById,
  listPolicies,
  updatePolicy
} from '../policy/policy.service.js';
import { getMerchantProfile } from './merchant.service.js';

const timeStringRegex = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;

const createPolicySchema = z.object({
  autonomyTier: z.enum(['T0', 'T1', 'T2', 'T3', 'T4']).default('T1'),
  maxRetries: z.number().int().min(0).max(10).default(3),
  maxContactsPerCustomerPerWeek: z.number().int().min(0).max(20).default(3),
  dailyBudgetMinorUnits: z.number().int().nonnegative().default(0),
  maxIncentivePercent: z.number().min(0).max(100).default(0.0),
  quietHoursStart: z.string().regex(timeStringRegex, 'Invalid time format (HH:MM or HH:MM:SS)').nullable().optional(),
  quietHoursEnd: z.string().regex(timeStringRegex, 'Invalid time format (HH:MM or HH:MM:SS)').nullable().optional(),
  timezone: z.string().min(1).max(50).default('UTC'),
  isActive: z.boolean().default(true)
});

const updatePolicySchema = z.object({
  autonomyTier: z.enum(['T0', 'T1', 'T2', 'T3', 'T4']).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  maxContactsPerCustomerPerWeek: z.number().int().min(0).max(20).optional(),
  dailyBudgetMinorUnits: z.number().int().nonnegative().optional(),
  maxIncentivePercent: z.number().min(0).max(100).optional(),
  quietHoursStart: z.string().regex(timeStringRegex, 'Invalid time format (HH:MM or HH:MM:SS)').nullable().optional(),
  quietHoursEnd: z.string().regex(timeStringRegex, 'Invalid time format (HH:MM or HH:MM:SS)').nullable().optional(),
  timezone: z.string().min(1).max(50).optional(),
  isActive: z.boolean().optional()
});

const evaluateActionSchema = z.object({
  action: z.object({
    actionType: z.enum([
      'RETRY_PAYMENT',
      'CUSTOMER_OUTREACH',
      'OFFER_INCENTIVE',
      'REQUEST_PAYMENT_METHOD',
      'ESCALATE_TO_SUPPORT',
      'CLOSE_CASE'
    ]),
    caseRef: z.string().optional(),
    orderRef: z.string().optional(),
    costMinorUnits: z.number().int().nonnegative().optional(),
    incentivePercent: z.number().min(0).max(100).optional(),
    scheduledAt: z.union([z.string(), z.date()]).optional(),
    metadata: z.record(z.unknown()).optional()
  }),
  context: z
    .object({
      evaluationTime: z.coerce.date().optional(),
      globalAutonomyTier: z.enum(['T0', 'T1', 'T2', 'T3', 'T4']).optional(),
      currentRetryCount: z.number().int().nonnegative().optional(),
      contactsThisWeek: z.number().int().nonnegative().optional(),
      dailySpentMinorUnits: z.number().int().nonnegative().optional(),
      isTerminalFailure: z.boolean().optional(),
      failureCategory: z.string().optional(),
      requiresHumanReview: z.boolean().optional()
    })
    .optional()
});

export const merchantRouter = Router();

merchantRouter.use(authenticate);

/* GET /api/merchants/me — merchant profile & summary */
merchantRouter.get('/me', async (req, res, next) => {
  try {
    const profile = await getMerchantProfile(req.user!);
    res.json(profile);
  } catch (error) {
    next(error);
  }
});

/* GET /api/merchants/policies/active (or /policy) — get active policy configuration */
merchantRouter.get('/policies/active', async (req, res, next) => {
  try {
    const policy = await getActivePolicy(req.user!.id);
    res.json(policy);
  } catch (error) {
    next(error);
  }
});

merchantRouter.get('/policy', async (req, res, next) => {
  try {
    const policy = await getActivePolicy(req.user!.id);
    res.json(policy);
  } catch (error) {
    next(error);
  }
});

/* GET /api/merchants/policies — list all policy versions for authenticated merchant */
merchantRouter.get('/policies', async (req, res, next) => {
  try {
    const policies = await listPolicies(req.user!.id);
    res.json(policies);
  } catch (error) {
    next(error);
  }
});

/* GET /api/merchants/policies/:id — get specific policy by ID */
merchantRouter.get('/policies/:id', async (req, res, next) => {
  try {
    const policyId = z.coerce.number().int().positive().parse(req.params.id);
    const policy = await getPolicyById(policyId, req.user!.id);
    res.json(policy);
  } catch (error) {
    next(error);
  }
});

/* POST /api/merchants/policies — create new policy version */
merchantRouter.post('/policies', async (req, res, next) => {
  try {
    const input = createPolicySchema.parse(req.body);
    const policy = await createPolicy(req.user!.id, input);
    res.status(201).json(policy);
  } catch (error) {
    next(error);
  }
});

/* POST /api/merchants/policies/evaluate — evaluate proposed recovery action against active policy */
merchantRouter.post('/policies/evaluate', async (req, res, next) => {
  try {
    const { action, context } = evaluateActionSchema.parse(req.body);
    const evaluationContext = {
      ...context,
      correlationId: req.correlationId
    };
    const result = await evaluateProposedAction(req.user!.id, action, evaluationContext);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/* PUT /api/merchants/policies/active (or /policy or /policies) — update active policy */
merchantRouter.put('/policies/active', async (req, res, next) => {
  try {
    const input = updatePolicySchema.parse(req.body);
    const policy = await updatePolicy(req.user!.id, input);
    res.json(policy);
  } catch (error) {
    next(error);
  }
});

merchantRouter.put('/policy', async (req, res, next) => {
  try {
    const input = updatePolicySchema.parse(req.body);
    const policy = await updatePolicy(req.user!.id, input);
    res.json(policy);
  } catch (error) {
    next(error);
  }
});

merchantRouter.put('/policies', async (req, res, next) => {
  try {
    const input = updatePolicySchema.parse(req.body);
    const policy = await updatePolicy(req.user!.id, input);
    res.json(policy);
  } catch (error) {
    next(error);
  }
});

/* PATCH /api/merchants/policies/:id/activate — activate a specific policy version */
merchantRouter.patch('/policies/:id/activate', async (req, res, next) => {
  try {
    const policyId = z.coerce.number().int().positive().parse(req.params.id);
    const policy = await activatePolicy(policyId, req.user!.id);
    res.json(policy);
  } catch (error) {
    next(error);
  }
});

/* PATCH /api/merchants/policies/:id/deactivate — deactivate a specific policy version */
merchantRouter.patch('/policies/:id/deactivate', async (req, res, next) => {
  try {
    const policyId = z.coerce.number().int().positive().parse(req.params.id);
    const result = await deactivatePolicy(policyId, req.user!.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------ */
/*  Recovery Prioritisation & Revenue Ledger Routes (RCV-002)         */
/* ------------------------------------------------------------------ */

const ledgerQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  currency: z.string().length(3).optional()
});

const queueQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
  maxPerMerchant: z.coerce.number().int().positive().optional()
});

const loadShedSchema = z.object({
  capacityLimit: z.number().int().nonnegative().max(100000)
});

/* GET /api/merchants/recovery/ledger — get recoverable revenue & leakage ledger */
merchantRouter.get('/recovery/ledger', async (req, res, next) => {
  try {
    const query = ledgerQuerySchema.parse(req.query);
    const filters = {
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
      currency: query.currency
    };
    const ledger = await (await import('../recovery/case.service.js')).getRevenueLedger(
      req.user!.id,
      filters
    );
    res.json(ledger);
  } catch (error) {
    next(error);
  }
});

/* GET /api/merchants/recovery/analytics — get recovery analytics for authenticated merchant */
merchantRouter.get('/recovery/analytics', async (req, res, next) => {
  try {
    const { analyticsQuerySchema } = await import('../recovery/case.routes.js');
    const query = analyticsQuerySchema.parse(req.query);
    const filters = {
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
      currency: query.currency ? query.currency.toUpperCase() : undefined
    };
    const { getRecoveryAnalytics } = await import('../recovery/analytics.service.js');
    const analytics = await getRecoveryAnalytics(req.user!.id, filters);
    res.json(analytics);
  } catch (error) {
    next(error);
  }
});

/* GET /api/merchants/recovery/queue — get prioritized recovery cases */
merchantRouter.get('/recovery/queue', async (req, res, next) => {
  try {
    const query = queueQuerySchema.parse(req.query);
    const prioritizedQueue = await (
      await import('../recovery/case.service.js')
    ).getPrioritizedQueue(req.user!.id, {
      limit: query.limit,
      maxPerMerchant: query.maxPerMerchant
    });
    res.json(prioritizedQueue);
  } catch (error) {
    next(error);
  }
});

/* GET /api/merchants/recovery/metrics — get queue depth, oldest age, and shed volume */
merchantRouter.get('/recovery/metrics', async (req, res, next) => {
  try {
    const metrics = await (await import('../recovery/case.service.js')).getQueueMetrics(
      req.user!.id
    );
    res.json(metrics);
  } catch (error) {
    next(error);
  }
});

/* POST /api/merchants/recovery/shed — execute load shedding when backlog exceeds capacity */
merchantRouter.post('/recovery/shed', async (req, res, next) => {
  try {
    const input = loadShedSchema.parse(req.body);
    const result = await (await import('../recovery/case.service.js')).shedExcessBacklog(
      input.capacityLimit,
      req.id?.toString()
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/* GET /api/merchants/recovery/cases/:caseId/trace — get sanitized case trace summary (AI-007 / RDB-003) */
merchantRouter.get('/recovery/cases/:caseId/trace', async (req, res, next) => {
  try {
    const caseId = Number(req.params.caseId);
    const summary = await (await import('../ai/tracing/trace.service.js')).getMerchantTraceSummary(
      caseId,
      req.user!.id
    );
    if (!summary) {
      res.status(404).json({
        statusCode: 404,
        error: 'TRACE_NOT_FOUND',
        message: 'No reasoning trace found for this recovery case.'
      });
      return;
    }
    res.json(summary);
  } catch (error) {
    next(error);
  }
});
