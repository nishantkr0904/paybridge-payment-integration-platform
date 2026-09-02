import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import {
  activatePolicy,
  createPolicy,
  deactivatePolicy,
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
