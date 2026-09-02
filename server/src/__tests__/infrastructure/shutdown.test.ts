import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type amqp from 'amqplib';
import {
  createGracefulShutdownHandler,
  createServerShutdownHandler,
  closeInfrastructureResources,
  isShuttingDown,
  setShuttingDown
} from '../../utils/shutdown.js';
import { createApp } from '../../app.js';
import * as rabbitmqInfra from '../../infrastructure/rabbitmq.js';
import * as redisInfra from '../../infrastructure/redis.js';
import * as databaseConfig from '../../config/database.js';
import {
  startPaymentWorker,
  stopPaymentWorker
} from '../../workers/payment.worker.js';

describe('Graceful Shutdown & Lifecycle Management (TASK-003)', () => {
  beforeEach(() => {
    setShuttingDown(false);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    setShuttingDown(false);
    vi.restoreAllMocks();
  });

  describe('Phased Shutdown Execution Order', () => {
    it('executes stopTraffic -> drainInFlight -> closeResources -> exit(0) in strict order', async () => {
      const callOrder: string[] = [];

      const mockStopTraffic = vi.fn(async () => {
        callOrder.push('stopTraffic');
      });

      const mockDrainInFlight = vi.fn(async () => {
        callOrder.push('drainInFlight');
      });

      const mockCloseResources = vi.fn(async () => {
        callOrder.push('closeResources');
      });

      const mockExitFn = vi.fn((code: number) => {
        callOrder.push(`exit:${code}`);
      });

      const handler = createGracefulShutdownHandler({
        name: 'test-service',
        graceTimeoutMs: 1000,
        watchdogTimeoutMs: 5000,
        stopTraffic: mockStopTraffic,
        drainInFlight: mockDrainInFlight,
        closeResources: mockCloseResources,
        exitFn: mockExitFn
      });

      await handler.shutdown('SIGTERM');

      expect(callOrder).toEqual([
        'stopTraffic',
        'drainInFlight',
        'closeResources',
        'exit:0'
      ]);
      expect(mockExitFn).toHaveBeenCalledWith(0);
      expect(isShuttingDown()).toBe(true);

      handler.dispose();
    });
  });

  describe('Readiness & Health Probe Behavior', () => {
    it('returns 200 OK when healthy and 503 when shutdown has started', async () => {
      const app = createApp();

      // Test healthy state
      const healthyReq = { url: '/api/health', method: 'GET' };
      const healthyRes = {
        statusCode: 200,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json: vi.fn()
      };

      // Query /api/health directly
      interface RouterLayer {
        route?: { path: string };
        handle_request: (req: unknown, res: unknown, next: () => void) => void;
      }
      const route = (app as unknown as { _router: { stack: RouterLayer[] } })._router.stack.find(
        (s) => s.route && s.route.path === '/api/health'
      );
      expect(route).toBeDefined();

      route?.handle_request(healthyReq, healthyRes, () => {});
      expect(healthyRes.json).toHaveBeenCalledWith({
        status: 'ok',
        service: 'paybridge-server'
      });

      // Now initiate shutdown
      setShuttingDown(true);

      const shutdownRes = {
        statusCode: 200,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json: vi.fn()
      };

      route?.handle_request(healthyReq, shutdownRes, () => {});
      expect(shutdownRes.statusCode).toBe(503);
      expect(shutdownRes.json).toHaveBeenCalledWith({
        status: 'shutting_down',
        service: 'paybridge-server'
      });
    });
  });

  describe('HTTP Server Draining', () => {
    it('closes the HTTP server handle and drains connections before exiting', async () => {
      const closeOrder: string[] = [];

      const mockServer = {
        close: vi.fn((cb?: (err?: Error) => void) => {
          closeOrder.push('server.close');
          if (cb) cb();
        }),
        on: vi.fn()
      } as unknown as Server;

      const mockCloseResources = vi.fn(async () => {
        closeOrder.push('closeResources');
      });

      const mockExitFn = vi.fn((code: number) => {
        closeOrder.push(`exit:${code}`);
      });

      const handler = createServerShutdownHandler({
        server: mockServer,
        onCloseResources: mockCloseResources,
        exitFn: mockExitFn
      });

      await handler.shutdown('SIGTERM');

      expect(mockServer.close).toHaveBeenCalled();
      expect(mockCloseResources).toHaveBeenCalled();
      expect(mockExitFn).toHaveBeenCalledWith(0);
      expect(closeOrder).toEqual(['server.close', 'closeResources', 'exit:0']);

      handler.dispose();
    });
  });

  describe('Worker Consumer Cancellation & In-Flight Draining', () => {
    it('cancels the RabbitMQ consumer tag and waits for in-flight jobs to settle', async () => {
      type MsgCallback = (msg: unknown) => void | Promise<void>;
      let messageHandler: MsgCallback | null = null;

      const mockChannel = {
        prefetch: vi.fn().mockResolvedValue(undefined),
        consume: vi.fn().mockImplementation((_queue: string, callback: MsgCallback) => {
          messageHandler = callback;
          return Promise.resolve({ consumerTag: 'amq.ctag-test123' });
        }),
        cancel: vi.fn().mockResolvedValue(undefined),
        ack: vi.fn(),
        nack: vi.fn(),
        publish: vi.fn().mockReturnValue(true)
      };

      vi.spyOn(rabbitmqInfra, 'getRabbitMQChannel').mockResolvedValue(
        mockChannel as unknown as amqp.Channel
      );

      // Start the payment worker
      const { consumerTag } = await startPaymentWorker();
      expect(consumerTag).toBe('amq.ctag-test123');
      expect(mockChannel.consume).toHaveBeenCalled();

      // Simulate an in-flight job triggered by a message
      let jobResolved = false;
      const fakeMsg = {
        content: Buffer.from(
          JSON.stringify({
            transactionId: 999,
            orderId: 100,
            merchantId: 1,
            orderRef: 'ord_test',
            paymentMethod: 'card'
          })
        )
      };

      // Mock repository and redis calls used inside handlePaymentMessage
      const paymentRepo = await import('../../modules/payment/payment.repository.js');
      vi.spyOn(paymentRepo, 'findTransactionById').mockResolvedValue({
        id: 999,
        orderId: 100,
        amount: 5000,
        status: 'processing',
        txnRef: 'txn_test',
        paymentMethod: 'card',
        gatewayResponse: null,
        failureReason: null,
        createdAt: new Date(),
        updatedAt: new Date()
      });
      vi.spyOn(paymentRepo, 'updateTransactionStatus').mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        jobResolved = true;
        return true;
      });
      vi.spyOn(paymentRepo, 'updateOrderStatus').mockResolvedValue(true);

      vi.spyOn(redisInfra, 'acquireLock').mockResolvedValue('lock-token');
      vi.spyOn(redisInfra, 'releaseLock').mockResolvedValue(true);

      // Trigger the consumer message
      if (messageHandler) {
        (messageHandler as MsgCallback)(fakeMsg);
      }

      // Concurrently initiate worker stop
      const stopPromise = stopPaymentWorker();

      // Verify that cancel was invoked immediately
      expect(mockChannel.cancel).toHaveBeenCalledWith('amq.ctag-test123');

      // Await worker stop
      await stopPromise;

      // In-flight job should be completely finished
      expect(jobResolved).toBe(true);
      expect(mockChannel.ack).toHaveBeenCalled();
    });
  });

  describe('Signal Idempotency & Duplicate Protection', () => {
    it('ignores second signal while shutdown is in progress and executes cleanup only once', async () => {
      const cleanups: string[] = [];

      const mockCloseResources = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        cleanups.push('cleanup');
      });

      const mockExitFn = vi.fn();

      const handler = createGracefulShutdownHandler({
        name: 'test-idempotent',
        closeResources: mockCloseResources,
        exitFn: mockExitFn
      });

      // Trigger multiple signals concurrently
      const promise1 = handler.shutdown('SIGTERM');
      const promise2 = handler.shutdown('SIGINT');
      const promise3 = handler.shutdown('SIGTERM');

      await Promise.all([promise1, promise2, promise3]);

      expect(cleanups.length).toBe(1);
      expect(mockCloseResources).toHaveBeenCalledTimes(1);
      expect(mockExitFn).toHaveBeenCalledTimes(1);
      expect(mockExitFn).toHaveBeenCalledWith(0);

      handler.dispose();
    });
  });

  describe('Hard Watchdog Timeout', () => {
    it('forces exit code 1 if shutdown operations exceed watchdogTimeoutMs', async () => {
      vi.useFakeTimers();

      const mockExitFn = vi.fn();

      // Resource close function that hangs indefinitely
      const hangingClose = vi.fn(async () => {
        await new Promise(() => {}); // never resolves
      });

      const handler = createGracefulShutdownHandler({
        name: 'test-watchdog',
        graceTimeoutMs: 100,
        watchdogTimeoutMs: 500,
        closeResources: hangingClose,
        exitFn: mockExitFn
      });

      handler.shutdown('SIGTERM');

      // Fast-forward past watchdog timeout
      vi.advanceTimersByTime(600);

      expect(mockExitFn).toHaveBeenCalledWith(1);

      handler.dispose();
      vi.useRealTimers();
    });
  });

  describe('Cleanup Failure Resilience', () => {
    it('continues executing remaining resource closures when one or more dependencies fail', async () => {
      vi.spyOn(rabbitmqInfra, 'disconnectRabbitMQ').mockRejectedValue(
        new Error('RabbitMQ connection reset during teardown')
      );
      vi.spyOn(redisInfra, 'disconnectRedis').mockRejectedValue(
        new Error('Redis client already disconnected')
      );
      const closePoolSpy = vi.spyOn(databaseConfig, 'closePool').mockResolvedValue(
        undefined
      );

      // Should not throw, and should attempt all three in order
      await expect(closeInfrastructureResources()).resolves.toBeUndefined();

      expect(rabbitmqInfra.disconnectRabbitMQ).toHaveBeenCalledTimes(1);
      expect(redisInfra.disconnectRedis).toHaveBeenCalledTimes(1);
      expect(closePoolSpy).toHaveBeenCalledTimes(1);
    });
  });
});
