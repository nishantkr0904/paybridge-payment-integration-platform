import amqp from 'amqplib';

const rabbitMqUrl = process.env.RABBITMQ_URL || 'amqp://localhost:5672';

let connection: amqp.ChannelModel | null = null;
let channel: amqp.Channel | null = null;

export const QUEUES = {
  PAYMENT_PROCESSING: 'payment_processing_queue',
  PAYMENT_DLQ: 'payment_dlq',
  WEBHOOK_DELIVERY: 'webhook_queue',
};

export const EXCHANGES = {
  PAYMENT: 'payment_exchange',
  DLX: 'dlx_exchange',
  WEBHOOK: 'webhook_exchange',
};

export async function connectRabbitMQ() {
  if (connection && channel) {
    return { connection, channel };
  }

  try {
    connection = await amqp.connect(rabbitMqUrl);
    channel = await connection.createChannel();

    // Setup Dead Letter Exchange
    await channel.assertExchange(EXCHANGES.DLX, 'direct', { durable: true });
    
    // Setup Payment Exchange
    await channel.assertExchange(EXCHANGES.PAYMENT, 'direct', { durable: true });

    // Setup DLQ
    await channel.assertQueue(QUEUES.PAYMENT_DLQ, { durable: true });
    await channel.bindQueue(QUEUES.PAYMENT_DLQ, EXCHANGES.DLX, 'payment.dlq');

    // Setup main processing queue with dead-lettering to DLX
    await channel.assertQueue(QUEUES.PAYMENT_PROCESSING, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': EXCHANGES.DLX,
        'x-dead-letter-routing-key': 'payment.dlq',
      },
    });
    
    await channel.bindQueue(QUEUES.PAYMENT_PROCESSING, EXCHANGES.PAYMENT, 'payment.process');

    // Setup Webhook Exchange and Queue
    await channel.assertExchange(EXCHANGES.WEBHOOK, 'direct', { durable: true });
    await channel.assertQueue(QUEUES.WEBHOOK_DELIVERY, { durable: true });
    await channel.bindQueue(QUEUES.WEBHOOK_DELIVERY, EXCHANGES.WEBHOOK, 'webhook.deliver');

    console.log('RabbitMQ Connected and Queues Assured');
    
    return { connection, channel };
  } catch (error) {
    console.error('RabbitMQ Connection Error:', error);
    throw error;
  }
}

export async function getRabbitMQChannel(): Promise<amqp.Channel> {
  if (!channel) {
    const conn = await connectRabbitMQ();
    return conn.channel;
  }
  return channel;
}

export async function disconnectRabbitMQ() {
  if (channel) {
    await channel.close();
    channel = null;
  }
  if (connection) {
    await connection.close();
    connection = null;
  }
}
