import { getOrderCountsByMerchant } from '../payment/payment.repository.js';
import type { AuthUser } from '../../types/auth.js';

export async function getMerchantProfile(user: AuthUser) {
  const counts = await getOrderCountsByMerchant(user.id);

  return {
    user,
    summary: {
      totalTransactions: counts.total,
      successfulPayments: counts.success,
      failedPayments: counts.failed,
      pendingPayments: counts.pending
    }
  };
}
