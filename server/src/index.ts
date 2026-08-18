import { createApp } from './app.js';
import { env } from './config/env.js';

import { connectRedis } from './infrastructure/redis.js';
import { connectRabbitMQ } from './infrastructure/rabbitmq.js';

async function bootstrap() {
  try {
    await connectRedis();
    console.log('Redis connected on startup');
    
    await connectRabbitMQ();
    console.log('RabbitMQ connected on startup');
    
    const app = createApp();

    app.listen(env.PORT, () => {
      console.log(`PayBridge server listening on port ${env.PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

bootstrap();
