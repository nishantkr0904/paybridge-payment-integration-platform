import { api } from './client';

export type OrderStatus = 'pending' | 'processing' | 'success' | 'failed';

export type PaymentMethod = 'card' | 'upi' | 'netbanking' | 'wallet';

export type Order = {
  id: number;
  merchantId: number;
  orderRef: string;
  amount: number;
  currency: string;
  description: string | null;
  status: OrderStatus;
  customerEmail: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type Transaction = {
  id: number;
  orderId: number;
  txnRef: string;
  paymentMethod: PaymentMethod;
  status: string;
  gatewayResponse: Record<string, unknown> | null;
  failureReason: string | null;
  amount: number;
  createdAt: string;
  updatedAt: string;
};

export type PaymentResult = {
  orderRef: string;
  txnRef: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  amount: number;
  currency: string;
  gatewayResponse: Record<string, unknown> | null;
  failureReason: string | null;
};

export type OrderListResponse = {
  orders: Order[];
  total: number;
};

export type OrderDetailResponse = {
  order: Order;
  transactions: Transaction[];
};

export async function createOrder(input: {
  amount: number;
  currency?: string;
  description?: string;
  customerEmail?: string;
}): Promise<Order> {
  const response = await api.post<Order>('/payments/orders', input);
  return response.data;
}

export async function processPayment(
  orderRef: string,
  input: { paymentMethod: PaymentMethod }
): Promise<PaymentResult> {
  const response = await api.post<PaymentResult>(
    `/payments/orders/${orderRef}/pay`,
    input
  );
  return response.data;
}

export async function getOrder(orderRef: string): Promise<OrderDetailResponse> {
  const response = await api.get<OrderDetailResponse>(
    `/payments/orders/${orderRef}`
  );
  return response.data;
}

export async function listOrders(params?: {
  status?: OrderStatus;
  page?: number;
  limit?: number;
}): Promise<OrderListResponse> {
  const response = await api.get<OrderListResponse>('/payments/orders', {
    params
  });
  return response.data;
}
