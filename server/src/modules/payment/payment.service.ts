import { acquireLock, releaseLock } from '../../infrastructure/redis.js';
import { getRabbitMQChannel, EXCHANGES } from '../../infrastructure/rabbitmq.js';
import { HttpError } from '../../utils/http-error.js';
import { generateUlid } from '../../utils/ulid.js';
import { executeWithIdempotency } from '../idempotency/idempotency.service.js';
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

const PAYMENT_LOCK_TTL_SECONDS = 10;

/* ------------------------------------------------------------------ */
/*  Create checkout order                                             */
/* ------------------------------------------------------------------ */

export async function createCheckoutOrder(
  merchantId: number,
  input: CreateOrderInput,
  idempotencyKey?: string
) {
  const result = await executeWithIdempotency({
    merchantId,
    idempotencyKey,
    requestPath: '/api/payments/orders',
    payload: input,
    action: async () => {
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

      return {
        statusCode: 201,
        data: order
      };
    }
  });

  return result.data;
}

/* ------------------------------------------------------------------ */
/*  Process payment                                                   */
/* ------------------------------------------------------------------ */

export async function processPayment(
  orderRef: string,
  merchantId: number,
  input: ProcessPaymentInput,
  idempotencyKey?: string
) {
  /**
   * Execution Ordering:
   * 1. Idempotency Acquisition (MySQL): Check if this logical request was already processed.
   *    If completed, replay cached 202 response without re-executing side effects.
   * 2. Order Concurrency Lock (Redis): Acquire ownership-safe distributed lock for the order.
   * 3. Database State Transition (MySQL): Validate order status, create transaction, update to 'processing'.
   * 4. Queue Dispatch (RabbitMQ): Publish message to payment worker exchange.
   * 5. Order Lock Release (Redis): Release ownership-safe lock in finally block via atomic Lua script.
   * 6. Idempotency Completion (MySQL): Mark idempotency record 'completed' with the response payload.
   */
  const result = await executeWithIdempotency({
    merchantId,
    idempotencyKey,
    requestPath: `/api/payments/orders/${orderRef}/pay`,
    payload: input,
    action: async () => {
      // Acquire a distributed lock to prevent double-processing.
      // Uses orderRef as the deterministic logical payment key with a bounded TTL.
      const lockKey = `lock:order:${orderRef}`;
      const lockToken = await acquireLock(lockKey, PAYMENT_LOCK_TTL_SECONDS);

      if (!lockToken) {
        throw new HttpError(429, 'ORDER_PROCESSING', 'A payment request is already in progress. Please try again.');
      }

      try {
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
          statusCode: 202,
          data: {
            orderRef: order.orderRef,
            txnRef,
            status: 'processing' as const,
            paymentMethod: input.paymentMethod,
            amount: order.amount,
            currency: order.currency,
            message: 'Payment has been queued for processing.'
          }
        };
      } finally {
        // Release the lock since the DB state has been moved to 'processing' or if an error occurred
        await releaseLock(lockKey, lockToken);
      }
    }
  });

  return result.data;
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
