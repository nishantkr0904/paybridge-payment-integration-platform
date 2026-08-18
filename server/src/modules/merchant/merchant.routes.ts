import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { getMerchantProfile } from './merchant.service.js';

export const merchantRouter = Router();

merchantRouter.get('/me', authenticate, async (req, res, next) => {
  try {
    const profile = await getMerchantProfile(req.user!);
    res.json(profile);
  } catch (error) {
    next(error);
  }
});

