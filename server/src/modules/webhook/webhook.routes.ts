import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { addWebhookEndpoint, listWebhookEndpoints, listWebhookDeliveries } from './webhook.service.js';

const addEndpointSchema = z.object({
  url: z.string().url()
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
// PROTECTED MERCHANT ROUTES
// ==========================================
webhookRouter.use(authenticate);

/* POST /api/webhooks/endpoints — Add a new webhook URL */
webhookRouter.post('/endpoints', async (req, res, next) => {
  try {
    const { url } = addEndpointSchema.parse(req.body);
    const endpoint = await addWebhookEndpoint(req.user!.id, url);
    res.status(201).json(endpoint);
  } catch (error) {
    next(error);
  }
});

/* GET /api/webhooks/endpoints — List configured webhooks */
webhookRouter.get('/endpoints', async (req, res, next) => {
  try {
    const endpoints = await listWebhookEndpoints(req.user!.id);
    res.json({ endpoints });
  } catch (error) {
    next(error);
  }
});

/* GET /api/webhooks/deliveries — View recent delivery attempts */
webhookRouter.get('/deliveries', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const deliveries = await listWebhookDeliveries(req.user!.id, limit);
    res.json({ deliveries });
  } catch (error) {
    next(error);
  }
});
