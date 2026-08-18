import { Router } from 'express';
import { z } from 'zod';
import { loginMerchant, refreshMerchantSession, registerMerchant } from './auth.service.js';

const registerSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8),
  merchantName: z.string().min(2).max(150)
});

const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1)
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

export const authRouter = Router();

authRouter.post('/register', async (req, res, next) => {
  try {
    const input = registerSchema.parse(req.body);
    const result = await registerMerchant(input);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const result = await loginMerchant(input);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const input = refreshSchema.parse(req.body);
    const result = await refreshMerchantSession(input.refreshToken);
    res.json(result);
  } catch (error) {
    next(error);
  }
});
