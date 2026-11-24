import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PubSub, PubSubEngine } from 'graphql-subscriptions';
import { RedisPubSub } from 'graphql-redis-subscriptions';
import Redis from 'ioredis';
import { ShipmentEventsPublisher } from './shipment-events.publisher';

export const GQL_PUBSUB = 'GQL_PUBSUB';

/**
 * PubSub backing GraphQL subscriptions (#431). Redis-backed so an event
 * processed on one instance reaches subscribers connected to any instance;
 * set GRAPHQL_PUBSUB=memory for single-process tests.
 */
@Global()
@Module({
  providers: [
    {
      provide: GQL_PUBSUB,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PubSubEngine => {
        if (process.env.GRAPHQL_PUBSUB === 'memory' || process.env.SDK_GENERATE === '1') {
          return new PubSub();
        }
        const url = config.get<string>('REDIS_URL', 'redis://localhost:6379');
        const logger = new Logger('GqlPubSub');
        const options = { maxRetriesPerRequest: 3, retryStrategy: (times: number) => Math.min(times * 50, 2000) };
        const publisher = new Redis(url, options);
        const subscriber = new Redis(url, options);
        for (const client of [publisher, subscriber]) {
          client.on('error', (err) => logger.error(`Redis error: ${err.message}`));
        }
        return new RedisPubSub({ publisher, subscriber });
      },
    },
    ShipmentEventsPublisher,
  ],
  exports: [GQL_PUBSUB, ShipmentEventsPublisher],
})
export class GqlPubSubModule {}
