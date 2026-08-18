import crypto from 'node:crypto';
import { createWebhookEndpoint, getWebhookEndpoints, getWebhookDeliveries } from './webhook.repository.js';
import type { WebhookEndpoint, WebhookDelivery } from './webhook.types.js';

function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString('hex')}`;
}

export async function addWebhookEndpoint(merchantId: number, url: string): Promise<WebhookEndpoint> {
  const secret = generateWebhookSecret();
  const id = await createWebhookEndpoint(merchantId, url, secret);
  
  return {
    id,
    merchantId,
    url,
    secret,
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export async function listWebhookEndpoints(merchantId: number): Promise<WebhookEndpoint[]> {
  return getWebhookEndpoints(merchantId);
}

export async function listWebhookDeliveries(merchantId: number, limit?: number): Promise<WebhookDelivery[]> {
  return getWebhookDeliveries(merchantId, limit);
}
