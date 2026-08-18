import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

import { connectRedis } from './infrastructure/redis.js';
import { connectRabbitMQ } from './infrastructure/rabbitmq.js';

async function bootstrap() {
  try {
    await connectRedis();
    logger.info('Redis connected on startup');
    
    await connectRabbitMQ();
    logger.info('RabbitMQ connected on startup');
    
    const app = createApp();

    app.listen(env.PORT, () => {
      logger.info(`PayBridge server listening on port ${env.PORT}`);
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}

bootstrap();
