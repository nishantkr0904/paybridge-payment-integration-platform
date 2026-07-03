import { api } from './client';
import type { AuthUser } from './auth';

export type MerchantSummary = {
  totalTransactions: number;
  successfulPayments: number;
  failedPayments: number;
  pendingPayments: number;
};

export type MerchantProfile = {
  user: AuthUser;
  summary: MerchantSummary;
};

export async function getMerchantProfile(): Promise<MerchantProfile> {
  const response = await api.get<MerchantProfile>('/merchants/me');
  return response.data;
}
