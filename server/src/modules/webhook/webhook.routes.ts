import net from 'node:net';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission, hasPermission } from '../../middleware/authorize.js';
import { env } from '../../config/env.js';
import {
  isAllowedInternalTarget,
  isPrivateOrReservedIp,
  normalizeHostname
} from '../../utils/ssrf.js';
import { addWebhookEndpoint, listWebhookEndpoints, listWebhookDeliveries } from './webhook.service.js';

export const addEndpointSchema = z.object({
  url: z
    .string()
    .url()
    .superRefine((val, ctx) => {
      try {
        const parsed = new URL(val);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unsupported protocol '${parsed.protocol}'. Webhook URL must use HTTP or HTTPS.`
          });
          return;
        }

        const isInternalAllowed = isAllowedInternalTarget(
          parsed,
          env.WEBHOOK_ALLOWED_INTERNAL_TARGETS
        );

        if (isInternalAllowed) {
          return;
        }

        if (parsed.protocol === 'http:') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Webhook URL must use HTTPS for public endpoints.'
          });
          return;
        }

        const rawHostname = parsed.hostname.toLowerCase();
        const hostname = normalizeHostname(rawHostname);

        if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Webhook destination hostname cannot be localhost.'
          });
          return;
        }

        if (net.isIP(hostname) && isPrivateOrReservedIp(hostname)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Webhook URL cannot point to a private or reserved IP address.'
          });
          return;
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Invalid URL structure.'
        });
      }
    })
});

export const webhookRouter = Router();

// ==========================================
// DUMMY TEST LISTENER (No authentication)
// ==========================================
webhookRouter.post('/test-listener', (req, res) => {
  console.log('\n--- 🔔 TEST WEBHOOK LISTENER RECEIVED EVENT ---');
  console.log('Headers:', req.headers);
  console.log('Body:', JSON.stringify(req.body, null, 2));
  
  // In a real merchant implementation, you would verify the signature like this:
  // const signature = req.headers['x-paybridge-signature'];
  // const expectedSignature = crypto.createHmac('sha256', 'your_webhook_secret').update(JSON.stringify(req.body)).digest('hex');
  // if (signature !== expectedSignature) return res.status(401).send('Invalid signature');

  console.log('----------------------------------------------\n');
  res.status(200).json({ received: true });
});

// ==========================================
// PROTECTED MERCHANT ROUTES (Auth & RBAC)
// ==========================================
webhookRouter.use(authenticate);

/* POST /api/webhooks/endpoints — Add a new webhook URL (requires webhook:manage) */
webhookRouter.post('/endpoints', requirePermission('webhook:manage'), async (req, res, next) => {
  try {
    const { url } = addEndpointSchema.parse(req.body);
    const endpoint = await addWebhookEndpoint(req.user!.id, url);
    const canReadSecret = hasPermission(req.user!.roles, 'webhook:secret:read');
    const sanitizedEndpoint = canReadSecret
      ? endpoint
      : { ...endpoint, secret: 'whsec_••••••••••••••••••••••••' };
    res.status(201).json(sanitizedEndpoint);
  } catch (error) {
    next(error);
  }
});

/* GET /api/webhooks/endpoints — List configured webhooks (requires webhook:read) */
webhookRouter.get('/endpoints', requirePermission('webhook:read'), async (req, res, next) => {
  try {
    const endpoints = await listWebhookEndpoints(req.user!.id);
    const canReadSecret = hasPermission(req.user!.roles, 'webhook:secret:read');
    const sanitizedEndpoints = canReadSecret
      ? endpoints
      : endpoints.map((ep) => ({
          ...ep,
          secret: 'whsec_••••••••••••••••••••••••'
        }));
    res.json({ endpoints: sanitizedEndpoints });
  } catch (error) {
    next(error);
  }
});

/* GET /api/webhooks/deliveries — View recent delivery attempts (requires webhook:read) */
webhookRouter.get('/deliveries', requirePermission('webhook:read'), async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const deliveries = await listWebhookDeliveries(req.user!.id, limit);
    res.json({ deliveries });
  } catch (error) {
    next(error);
  }
});