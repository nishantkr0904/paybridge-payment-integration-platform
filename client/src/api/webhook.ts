import { api } from './client';

export interface WebhookEndpoint {
  id: number;
  merchantId: number;
  url: string;
  secret: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: number;
  endpointId: number;
  eventType: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'success' | 'failed';
  responseStatus: number | null;
  createdAt: string;
}

export async function addWebhookEndpoint(url: string): Promise<WebhookEndpoint> {
  const { data } = await api.post<WebhookEndpoint>('/webhooks/endpoints', { url });
  return data;
}

export async function getWebhookEndpoints(): Promise<{ endpoints: WebhookEndpoint[] }> {
  const { data } = await api.get<{ endpoints: WebhookEndpoint[] }>('/webhooks/endpoints');
  return data;
}

export async function getWebhookDeliveries(): Promise<{ deliveries: WebhookDelivery[] }> {
  const { data } = await api.get<{ deliveries: WebhookDelivery[] }>('/webhooks/deliveries');
  return data;
}
