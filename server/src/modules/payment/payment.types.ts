export type OrderStatus = 'pending' | 'processing' | 'success' | 'failed';

export type TransactionStatus = 'initiated' | 'processing' | 'success' | 'failed';

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
  createdAt: Date;
  updatedAt: Date;
};

export type Transaction = {
  id: number;
  orderId: number;
  txnRef: string;
  paymentMethod: PaymentMethod;
  status: TransactionStatus;
  gatewayResponse: Record<string, unknown> | null;
  failureReason: string | null;
  amount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateOrderInput = {
  amount: number;
  currency: string;
  description?: string;
  customerEmail?: string;
  metadata?: Record<string, unknown>;
};

export type ProcessPaymentInput = {
  paymentMethod: PaymentMethod;
};

export type OrderFilters = {
  status?: OrderStatus;
  page: number;
  limit: number;
};
