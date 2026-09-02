export type AutonomyTier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4';

export interface Policy {
  id: number;
  merchantId: number;
  autonomyTier: AutonomyTier;
  maxRetries: number;
  maxContactsPerCustomerPerWeek: number;
  dailyBudgetMinorUnits: number;
  maxIncentivePercent: number;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string;
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePolicyInput {
  autonomyTier?: AutonomyTier;
  maxRetries?: number;
  maxContactsPerCustomerPerWeek?: number;
  dailyBudgetMinorUnits?: number;
  maxIncentivePercent?: number;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  timezone?: string;
  isActive?: boolean;
}

export interface UpdatePolicyInput {
  autonomyTier?: AutonomyTier;
  maxRetries?: number;
  maxContactsPerCustomerPerWeek?: number;
  dailyBudgetMinorUnits?: number;
  maxIncentivePercent?: number;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  timezone?: string;
  isActive?: boolean;
}
