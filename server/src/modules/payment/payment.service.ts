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

import { acquireLock, releaseLock } from '../../infrastructure/redis.js';
import { getRabbitMQChannel, EXCHANGES } from '../../infrastructure/rabbitmq.js';

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

  // Acquire a distributed lock to prevent double-processing
  // Uses orderRef as the lock key with a 10 second TTL
  const lockKey = `lock:order:${orderRef}`;
  const lockToken = await acquireLock(lockKey, 10);
  
  if (!lockToken) {
    throw new HttpError(429, 'ORDER_PROCESSING', 'A payment request is already in progress. Please try again.');
  }

  try {
    const txnRef = generateUlid();

    const transaction = await createTransaction({
      orderId: order.id,
      txnRef,
      paymentMethod: input.paymentMethod,
      amount: order.amount
    });

    await updateTransactionStatus(transaction.id, 'processing');
    await updateOrderStatus(order.id, 'processing');

    // Publish to RabbitMQ for asynchronous processing
    const channel = await getRabbitMQChannel();
    
    const payload = {
      transactionId: transaction.id,
      orderId: order.id,
      merchantId: order.merchantId,
      orderRef: order.orderRef,
      txnRef,
      paymentMethod: input.paymentMethod,
      amount: order.amount
    };

    channel.publish(
      EXCHANGES.PAYMENT,
      'payment.process',
      Buffer.from(JSON.stringify(payload)),
      { persistent: true }
    );

    return {
      orderRef: order.orderRef,
      txnRef,
      status: 'processing',
      paymentMethod: input.paymentMethod,
      amount: order.amount,
      currency: order.currency,
      message: 'Payment has been queued for processing.'
    };
  } finally {
    // We can release the lock since the DB state has been moved to 'processing'
    await releaseLock(lockKey, lockToken);
  }
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
