import { HttpError } from '../../utils/http-error.js';
import { generateUlid } from '../../utils/ulid.js';
import {
  createOrder,
  createTransaction,
  findOrderByRef,
  findOrdersByMerchantId,
  findTransactionsByOrderId,
  getOrderCountsByMerchant,
  updateOrderStatus,
  updateTransactionStatus
} from './payment.repository.js';
import type { CreateOrderInput, OrderFilters, ProcessPaymentInput } from './payment.types.js';

/* ------------------------------------------------------------------ */
/*  Create checkout order                                             */
/* ------------------------------------------------------------------ */

export async function createCheckoutOrder(merchantId: number, input: CreateOrderInput) {
  const orderRef = generateUlid();

  const order = await createOrder({
    merchantId,
    orderRef,
    amount: input.amount,
    currency: input.currency,
    description: input.description,
    customerEmail: input.customerEmail,
    metadata: input.metadata
  });

  return order;
}

/* ------------------------------------------------------------------ */
/*  Process payment                                                   */
/* ------------------------------------------------------------------ */

function simulateGateway(method: string): {
  success: boolean;
  gatewayResponse: Record<string, unknown>;
  failureReason?: string;
} {
  const isSuccess = Math.random() < 0.8;

  if (isSuccess) {
    return {
      success: true,
      gatewayResponse: {
        provider: 'paybridge-sim',
        method,
        authCode: generateUlid().slice(0, 12),
        processedAt: new Date().toISOString()
      }
    };
  }

  const reasons = [
    'Insufficient funds',
    'Card declined by issuer',
    'Transaction timeout',
    'Risk check failed'
  ];

  return {
    success: false,
    gatewayResponse: {
      provider: 'paybridge-sim',
      method,
      errorCode: 'GATEWAY_DECLINED',
      processedAt: new Date().toISOString()
    },
    failureReason: reasons[Math.floor(Math.random() * reasons.length)]
  };
}

export async function processPayment(orderRef: string, merchantId: number, input: ProcessPaymentInput) {
  const order = await findOrderByRef(orderRef);

  if (!order) {
    throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order does not exist.');
  }

  if (order.merchantId !== merchantId) {
    throw new HttpError(403, 'ORDER_FORBIDDEN', 'Order does not belong to this merchant.');
  }

  if (order.status === 'success') {
    throw new HttpError(409, 'ORDER_ALREADY_PAID', 'This order has already been paid.');
  }

  if (order.status === 'processing') {
    throw new HttpError(409, 'ORDER_PROCESSING', 'A payment is currently being processed for this order.');
  }

  const txnRef = generateUlid();

  const transaction = await createTransaction({
    orderId: order.id,
    txnRef,
    paymentMethod: input.paymentMethod,
    amount: order.amount
  });

  await updateTransactionStatus(transaction.id, 'processing');
  await updateOrderStatus(order.id, 'processing');

  const result = simulateGateway(input.paymentMethod);

  const finalTxnStatus = result.success ? 'success' as const : 'failed' as const;
  const finalOrderStatus = result.success ? 'success' as const : 'failed' as const;

  await updateTransactionStatus(
    transaction.id,
    finalTxnStatus,
    result.gatewayResponse,
    result.failureReason
  );

  await updateOrderStatus(order.id, finalOrderStatus);

  return {
    orderRef: order.orderRef,
    txnRef,
    status: finalOrderStatus,
    paymentMethod: input.paymentMethod,
    amount: order.amount,
    currency: order.currency,
    gatewayResponse: result.gatewayResponse,
    failureReason: result.failureReason ?? null
  };
}

/* ------------------------------------------------------------------ */
/*  Get order status                                                  */
/* ------------------------------------------------------------------ */

export async function getOrderStatus(orderRef: string, merchantId: number) {
  const order = await findOrderByRef(orderRef);

  if (!order) {
    throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order does not exist.');
  }

  if (order.merchantId !== merchantId) {
    throw new HttpError(403, 'ORDER_FORBIDDEN', 'Order does not belong to this merchant.');
  }

  const transactions = await findTransactionsByOrderId(order.id);

  return { order, transactions };
}

/* ------------------------------------------------------------------ */
/*  List merchant orders                                              */
/* ------------------------------------------------------------------ */

export async function listMerchantOrders(merchantId: number, filters: OrderFilters) {
  return findOrdersByMerchantId(merchantId, filters);
}

/* ------------------------------------------------------------------ */
/*  Merchant summary                                                  */
/* ------------------------------------------------------------------ */

export async function getMerchantOrderSummary(merchantId: number) {
  return getOrderCountsByMerchant(merchantId);
}
