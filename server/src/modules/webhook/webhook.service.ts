import crypto from 'node:crypto';
import {
  createWebhookEndpoint,
  getWebhookEndpoints,
  getWebhookDeliveries,
  getWebhookDeliveryById,
  logWebhookDelivery
} from './webhook.repository.js';
import type { WebhookEndpoint, WebhookDelivery } from './webhook.types.js';
import { validateWebhookDestination, type DnsLookupFunction } from '../../utils/ssrf.js';
import { env } from '../../config/env.js';

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

export interface RetryWebhookDeliveryResult {
  success: boolean;
  delivery: WebhookDelivery;
  error?: string;
}

export interface RetryWebhookDeliveryOptions {
  fetchFn?: typeof fetch;
  dnsLookupFn?: DnsLookupFunction;
  allowedInternalTargets?: string;
}

export async function retryWebhookDelivery(
  merchantId: number,
  deliveryId: number,
  options?: RetryWebhookDeliveryOptions
): Promise<RetryWebhookDeliveryResult> {
  const existing = await getWebhookDeliveryById(merchantId, deliveryId);
  if (!existing) {
    const error = new Error('Webhook delivery not found.');
    (error as any).statusCode = 404;
    (error as any).code = 'DELIVERY_NOT_FOUND';
    throw error;
  }

  if (!existing.endpointIsActive) {
    const error = new Error('Cannot retry delivery for an inactive webhook endpoint.');
    (error as any).statusCode = 400;
    (error as any).code = 'ENDPOINT_INACTIVE';
    throw error;
  }

  // Validate destination against SSRF restrictions
  const destinationValidation = await validateWebhookDestination(
    existing.endpointUrl,
    options?.allowedInternalTargets ?? env.WEBHOOK_ALLOWED_INTERNAL_TARGETS,
    options?.dnsLookupFn
  );

  if (destinationValidation.status === 'BLOCKED') {
    const newDeliveryId = await logWebhookDelivery(
      existing.endpointId,
      existing.eventType,
      existing.payload,
      'failed',
      null
    );

    const newDelivery: WebhookDelivery = {
      id: newDeliveryId,
      endpointId: existing.endpointId,
      eventType: existing.eventType,
      payload: existing.payload,
      status: 'failed',
      responseStatus: null,
      createdAt: new Date().toISOString()
    };

    return {
      success: false,
      delivery: newDelivery,
      error: `Delivery blocked by SSRF policy: ${destinationValidation.reason}`
    };
  }

  if (destinationValidation.status === 'DNS_ERROR') {
    const newDeliveryId = await logWebhookDelivery(
      existing.endpointId,
      existing.eventType,
      existing.payload,
      'failed',
      null
    );

    const newDelivery: WebhookDelivery = {
      id: newDeliveryId,
      endpointId: existing.endpointId,
      eventType: existing.eventType,
      payload: existing.payload,
      status: 'failed',
      responseStatus: null,
      createdAt: new Date().toISOString()
    };

    return {
      success: false,
      delivery: newDelivery,
      error: 'DNS resolution failed for webhook target.'
    };
  }

  const payloadString = JSON.stringify(existing.payload);
  const signature = crypto
    .createHmac('sha256', existing.endpointSecret)
    .update(payloadString)
    .digest('hex');

  const fetchImpl = options?.fetchFn ?? fetch;
  let responseStatus: number | null = null;
  let isSuccess = false;
  let errorMessage: string | undefined;

  try {
    const response = await fetchImpl(existing.endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paybridge-signature': signature,
        'User-Agent': 'PayBridge-Webhook/1.0'
      },
      body: payloadString,
      redirect: 'error',
      signal: AbortSignal.timeout(5000)
    });

    responseStatus = response.status;
    isSuccess = response.status >= 200 && response.status < 300;
    // Drain/cancel response stream so socket returns immediately to pool
    await response.body?.cancel().catch(() => {});
    if (!isSuccess) {
      errorMessage = `Destination responded with HTTP ${response.status}`;
    }
  } catch (err: any) {
    isSuccess = false;
    responseStatus = null;
    errorMessage = err.name === 'TimeoutError' ? 'Request timed out' : err.message || 'Delivery request failed';
  }

  const newDeliveryId = await logWebhookDelivery(
    existing.endpointId,
    existing.eventType,
    existing.payload,
    isSuccess ? 'success' : 'failed',
    responseStatus
  );

  const newDelivery: WebhookDelivery = {
    id: newDeliveryId,
    endpointId: existing.endpointId,
    eventType: existing.eventType,
    payload: existing.payload,
    status: isSuccess ? 'success' : 'failed',
    responseStatus,
    createdAt: new Date().toISOString()
  };

  return {
    success: isSuccess,
    delivery: newDelivery,
    error: errorMessage
  };
}
