import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';

export const merchantRouter = Router();

merchantRouter.get('/me', authenticate, (req, res) => {
  res.json({
    user: req.user,
    summary: {
      totalTransactions: 0,
      successfulPayments: 0,
      failedPayments: 0,
      pendingPayments: 0
    }
  });
});
