import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import {
  createCheckoutOrder,
  getOrderStatus,
  listMerchantOrders,
  processPayment
} from './payment.service.js';

const createOrderSchema = z.object({
  amount: z.number().positive().multipleOf(0.01),
  currency: z.string().length(3).toUpperCase().default('INR'),
  description: z.string().max(255).optional(),
  customerEmail: z.string().email().optional(),
  metadata: z.record(z.unknown()).optional()
});

const processPaymentSchema = z.object({
  paymentMethod: z.enum(['card', 'upi', 'netbanking', 'wallet'])
});

const listOrdersSchema = z.object({
  status: z.enum(['pending', 'processing', 'success', 'failed']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20)
});

export const paymentRouter = Router();

paymentRouter.use(authenticate);

/* POST /api/payments/orders — create checkout order */
paymentRouter.post('/orders', async (req, res, next) => {
  try {
    const input = createOrderSchema.parse(req.body);
    const idempotencyKey =
      req.header('idempotency-key') || req.header('x-idempotency-key') || undefined;
    const order = await createCheckoutOrder(req.user!.id, input, idempotencyKey);
    res.status(201).json(order);
  } catch (error) {
    next(error);
  }
});

/* POST /api/payments/orders/:orderRef/pay — process payment */
paymentRouter.post('/orders/:orderRef/pay', async (req, res, next) => {
  try {
    const input = processPaymentSchema.parse(req.body);
    const idempotencyKey =
      req.header('idempotency-key') || req.header('x-idempotency-key') || undefined;
    const result = await processPayment(
      req.params.orderRef,
      req.user!.id,
      input,
      idempotencyKey,
      req.correlationId
    );
    res.status(202).json(result);
  } catch (error) {
    next(error);
  }
});

/* GET /api/payments/orders/:orderRef — get order status */
paymentRouter.get('/orders/:orderRef', async (req, res, next) => {
  try {
    const result = await getOrderStatus(req.params.orderRef, req.user!.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/* GET /api/payments/orders — list merchant orders */
paymentRouter.get('/orders', async (req, res, next) => {
  try {
    const filters = listOrdersSchema.parse(req.query);
    const result = await listMerchantOrders(req.user!.id, filters);
    res.json(result);
  } catch (error) {
    next(error);
  }
});
