import { HttpError } from '../../utils/http-error.js';
import {
  activatePolicy as repoActivatePolicy,
  createPolicy as repoCreatePolicy,
  deactivatePolicy as repoDeactivatePolicy,
  findActivePolicyByMerchantId,
  findPoliciesByMerchantId,
  findPolicyById
} from './policy.repository.js';
import type { CreatePolicyInput, Policy, UpdatePolicyInput } from './policy.types.js';

/* ------------------------------------------------------------------ */
/*  Policy Service Operations                                         */
/* ------------------------------------------------------------------ */

/**
 * Retrieves the currently active policy for a merchant.
 * If none exists, creates and returns a default policy for the merchant.
 */
export async function getActivePolicy(merchantId: number): Promise<Policy> {
  const activePolicy = await findActivePolicyByMerchantId(merchantId);

  if (activePolicy) {
    return activePolicy;
  }

  // Create default baseline policy for the new merchant
  return repoCreatePolicy(merchantId, {
    autonomyTier: 'T1',
    maxRetries: 3,
    maxContactsPerCustomerPerWeek: 3,
    dailyBudgetMinorUnits: 0,
    maxIncentivePercent: 0.0,
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: 'UTC',
    isActive: true
  });
}

/**
 * Retrieves a specific policy version by ID, scoped strictly to the authenticated merchant.
 */
export async function getPolicyById(id: number, merchantId: number): Promise<Policy> {
  const policy = await findPolicyById(id, merchantId);

  if (!policy) {
    throw new HttpError(404, 'POLICY_NOT_FOUND', 'Policy does not exist.');
  }

  return policy;
}

/**
 * Lists all policy versions for a merchant ordered newest to oldest.
 */
export async function listPolicies(merchantId: number): Promise<Policy[]> {
  return findPoliciesByMerchantId(merchantId);
}

/**
 * Creates a new policy version for a merchant.
 */
export async function createPolicy(merchantId: number, input: CreatePolicyInput): Promise<Policy> {
  return repoCreatePolicy(merchantId, input);
}

/**
 * Updates the merchant's active policy configuration by creating a new version.
 * Copies existing active settings as defaults if partial input is provided.
 */
export async function updatePolicy(merchantId: number, input: UpdatePolicyInput): Promise<Policy> {
  const currentActive = await findActivePolicyByMerchantId(merchantId);

  const mergedInput: CreatePolicyInput = {
    autonomyTier: input.autonomyTier ?? currentActive?.autonomyTier ?? 'T1',
    maxRetries: input.maxRetries ?? currentActive?.maxRetries ?? 3,
    maxContactsPerCustomerPerWeek:
      input.maxContactsPerCustomerPerWeek ?? currentActive?.maxContactsPerCustomerPerWeek ?? 3,
    dailyBudgetMinorUnits:
      input.dailyBudgetMinorUnits ?? currentActive?.dailyBudgetMinorUnits ?? 0,
    maxIncentivePercent:
      input.maxIncentivePercent ?? currentActive?.maxIncentivePercent ?? 0.0,
    quietHoursStart:
      input.quietHoursStart !== undefined ? input.quietHoursStart : (currentActive?.quietHoursStart ?? null),
    quietHoursEnd:
      input.quietHoursEnd !== undefined ? input.quietHoursEnd : (currentActive?.quietHoursEnd ?? null),
    timezone: input.timezone ?? currentActive?.timezone ?? 'UTC',
    isActive: input.isActive !== undefined ? input.isActive : true
  };

  return repoCreatePolicy(merchantId, mergedInput);
}

/**
 * Activates a specific policy version for a merchant.
 */
export async function activatePolicy(id: number, merchantId: number): Promise<Policy> {
  const activated = await repoActivatePolicy(id, merchantId);

  if (!activated) {
    throw new HttpError(404, 'POLICY_NOT_FOUND', 'Policy does not exist.');
  }

  return activated;
}

/**
 * Deactivates a specific policy version for a merchant.
 */
export async function deactivatePolicy(id: number, merchantId: number): Promise<{ success: boolean; message: string }> {
  const deactivated = await repoDeactivatePolicy(id, merchantId);

  if (!deactivated) {
    throw new HttpError(404, 'POLICY_NOT_FOUND', 'Policy does not exist.');
  }

  return { success: true, message: 'Policy successfully deactivated.' };
}
