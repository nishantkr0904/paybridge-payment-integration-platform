export type WebhookEndpoint = {
  id: number;
  merchantId: number;
  url: string;
  secret: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WebhookDelivery = {
  id: number;
  endpointId: number;
  eventType: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'success' | 'failed';
  responseStatus: number | null;
  createdAt: string;
};
