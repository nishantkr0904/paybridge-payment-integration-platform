import type { Server } from 'node:http';
import { logger } from './logger.js';
import { disconnectRabbitMQ } from '../infrastructure/rabbitmq.js';
import { disconnectRedis } from '../infrastructure/redis.js';
import { closePool } from '../config/database.js';

let globalShuttingDown = false;

export function isShuttingDown(): boolean {
  return globalShuttingDown;
}

export function setShuttingDown(value: boolean): void {
  globalShuttingDown = value;
}

export interface GracefulShutdownOptions {
  name?: string;
  graceTimeoutMs?: number;
  watchdogTimeoutMs?: number;
  logger?: typeof logger;
  stopTraffic?: () => Promise<void> | void;
  drainInFlight?: () => Promise<void> | void;
  closeResources?: () => Promise<void> | void;
  exitFn?: (code: number) => void;
}

export interface ShutdownHandler {
  shutdown(signal?: string): Promise<void>;
  isShuttingDown(): boolean;
  dispose(): void;
}

/**
 * Standard dependency teardown in required dependency order:
 * 1. RabbitMQ Channel & Connection (disconnectRabbitMQ)
 * 2. Redis Client (disconnectRedis)
 * 3. MySQL Connection Pool (closePool)
 *
 * Each step is executed resiliently: if one fails, subsequent steps still execute.
 */
export async function closeInfrastructureResources(
  loggerInstance: typeof logger = logger
): Promise<void> {
  // 1. RabbitMQ
  try {
    loggerInstance.info('[Shutdown] Closing RabbitMQ connection...');
    await disconnectRabbitMQ();
    loggerInstance.info('[Shutdown] RabbitMQ closed successfully');
  } catch (err) {
    loggerInstance.error({ err }, '[Shutdown] Error closing RabbitMQ connection');
  }

  // 2. Redis
  try {
    loggerInstance.info('[Shutdown] Closing Redis connection...');
    await disconnectRedis();
    loggerInstance.info('[Shutdown] Redis closed successfully');
  } catch (err) {
    loggerInstance.error({ err }, '[Shutdown] Error closing Redis connection');
  }

  // 3. MySQL Pool
  try {
    loggerInstance.info('[Shutdown] Closing MySQL connection pool...');
    await closePool();
    loggerInstance.info('[Shutdown] MySQL pool closed successfully');
  } catch (err) {
    loggerInstance.error({ err }, '[Shutdown] Error closing MySQL connection pool');
  }
}

/**
 * Create a coordinated graceful shutdown handler with phased draining,
 * dependency teardown, idempotency guards, and a hard watchdog timeout.
 */
export function createGracefulShutdownHandler(
  options: GracefulShutdownOptions
): ShutdownHandler {
  const {
    name = 'service',
    graceTimeoutMs = 15000,
    watchdogTimeoutMs = 30000,
    logger: log = logger,
    stopTraffic,
    drainInFlight,
    closeResources = () => closeInfrastructureResources(log),
    exitFn = (code: number) => process.exit(code)
  } = options;

  let shutdownPromise: Promise<void> | null = null;
  let signalListenersAttached = false;

  const performShutdown = async (signal = 'SIGTERM'): Promise<void> => {
    // 1. Idempotency Guard: prevent concurrent / duplicate shutdowns
    if (shutdownPromise) {
      log.warn(
        { signal, service: name },
        `[Shutdown] Shutdown already in progress. Ignoring repeated signal.`
      );
      return shutdownPromise;
    }

    setShuttingDown(true);
    const startTime = Date.now();
    log.info(
      { signal, service: name, graceTimeoutMs, watchdogTimeoutMs },
      `[Shutdown] Received ${signal}. Starting graceful shutdown for ${name}...`
    );

    // 2. Hard Watchdog Timer
    const watchdogTimer = setTimeout(() => {
      const elapsedMs = Date.now() - startTime;
      log.fatal(
        { signal, service: name, elapsedMs, watchdogTimeoutMs },
        `[Shutdown] Hard watchdog timeout exceeded (${watchdogTimeoutMs}ms). Forcing exit code 1.`
      );
      exitFn(1);
    }, watchdogTimeoutMs);

    // Ensure timer doesn't prevent event loop exit if unreferenced in Node.js
    if (typeof watchdogTimer.unref === 'function') {
      watchdogTimer.unref();
    }

    shutdownPromise = (async () => {
      try {
        // Phase 1: Stop Traffic / Ingress
        if (stopTraffic) {
          log.info({ service: name }, `[Shutdown] Phase 1: Stopping traffic and new work intake...`);
          try {
            await stopTraffic();
            log.info({ service: name }, `[Shutdown] Phase 1: Traffic intake stopped.`);
          } catch (err) {
            log.error({ err, service: name }, `[Shutdown] Phase 1: Error while stopping traffic intake`);
          }
        }

        // Phase 2: Drain In-Flight Work
        if (drainInFlight) {
          log.info({ service: name }, `[Shutdown] Phase 2: Draining in-flight operations (grace limit: ${graceTimeoutMs}ms)...`);
          let drainTimedOut = false;

          let timeoutHandle: NodeJS.Timeout | null = null;
          const timeoutPromise = new Promise<void>((resolve) => {
            timeoutHandle = setTimeout(() => {
              drainTimedOut = true;
              log.warn(
                { service: name, graceTimeoutMs },
                `[Shutdown] Phase 2: Grace timeout (${graceTimeoutMs}ms) reached while draining in-flight work. Proceeding with resource closure.`
              );
              resolve();
            }, graceTimeoutMs);
          });

          const drainPromise = (async () => {
            try {
              await drainInFlight();
            } catch (err) {
              log.error({ err, service: name }, `[Shutdown] Phase 2: Error while draining in-flight work`);
            }
          })();

          await Promise.race([drainPromise, timeoutPromise]);
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }

          if (!drainTimedOut) {
            log.info({ service: name }, `[Shutdown] Phase 2: In-flight operations drained successfully.`);
          }
        }

        // Phase 3: Close Infrastructure Resources in Dependency Order
        if (closeResources) {
          log.info({ service: name }, `[Shutdown] Phase 3: Closing infrastructure dependencies in order...`);
          try {
            await closeResources();
            log.info({ service: name }, `[Shutdown] Phase 3: Infrastructure dependencies closed.`);
          } catch (err) {
            log.error({ err, service: name }, `[Shutdown] Phase 3: Error during resource closure`);
          }
        }

        clearTimeout(watchdogTimer);
        const elapsedMs = Date.now() - startTime;
        log.info(
          { service: name, elapsedMs },
          `[Shutdown] Graceful shutdown completed cleanly in ${elapsedMs}ms.`
        );

        exitFn(0);
      } catch (fatalErr) {
        clearTimeout(watchdogTimer);
        log.fatal({ err: fatalErr, service: name }, `[Shutdown] Fatal error during shutdown sequence.`);
        exitFn(1);
      }
    })();

    return shutdownPromise;
  };

  const sigtermHandler = () => void performShutdown('SIGTERM');
  const sigintHandler = () => void performShutdown('SIGINT');

  if (typeof process !== 'undefined' && process.on) {
    process.on('SIGTERM', sigtermHandler);
    process.on('SIGINT', sigintHandler);
    signalListenersAttached = true;
  }

  return {
    shutdown: performShutdown,
    isShuttingDown,
    dispose: () => {
      if (signalListenersAttached && typeof process !== 'undefined' && process.removeListener) {
        process.removeListener('SIGTERM', sigtermHandler);
        process.removeListener('SIGINT', sigintHandler);
        signalListenersAttached = false;
      }
      setShuttingDown(false);
    }
  };
}

/**
 * Convenience helper for the HTTP API Server.
 */
export function createServerShutdownHandler(options: {
  server: Server;
  graceTimeoutMs?: number;
  watchdogTimeoutMs?: number;
  onCloseResources?: () => Promise<void> | void;
  exitFn?: (code: number) => void;
}): ShutdownHandler {
  const { server, graceTimeoutMs, watchdogTimeoutMs, onCloseResources, exitFn } = options;

  const activeSockets = new Set<import('node:net').Socket>();

  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.on('close', () => {
      activeSockets.delete(socket);
    });
  });

  return createGracefulShutdownHandler({
    name: 'api-server',
    graceTimeoutMs,
    watchdogTimeoutMs,
    stopTraffic: async () => {
      // 1. Close the HTTP server to reject new incoming connections
      await new Promise<void>((resolve) => {
        server.close((err) => {
          if (err) {
            logger.warn({ err }, '[Shutdown] Server close completed with notice');
          }
          resolve();
        });
      });
    },
    drainInFlight: async () => {
      if (activeSockets.size > 0) {
        logger.info({ activeConnections: activeSockets.size }, '[Shutdown] Waiting for active connections to finish');
      }
    },
    closeResources: onCloseResources || (() => closeInfrastructureResources(logger)),
    exitFn
  });
}

/**
 * Convenience helper for worker processes.
 */
export function createWorkerShutdownHandler(options: {
  workerName: string;
  onStop: () => Promise<void> | void;
  graceTimeoutMs?: number;
  watchdogTimeoutMs?: number;
  onCloseResources?: () => Promise<void> | void;
  exitFn?: (code: number) => void;
}): ShutdownHandler {
  const {
    workerName,
    onStop,
    graceTimeoutMs,
    watchdogTimeoutMs,
    onCloseResources,
    exitFn
  } = options;

  return createGracefulShutdownHandler({
    name: workerName,
    graceTimeoutMs,
    watchdogTimeoutMs,
    stopTraffic: async () => {
      await onStop();
    },
    closeResources: onCloseResources || (() => closeInfrastructureResources(logger)),
    exitFn
  });
}
