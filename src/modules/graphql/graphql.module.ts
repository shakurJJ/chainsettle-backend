import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ShipmentResolver } from './shipment.resolver';
import { MilestoneResolver } from './milestone.resolver';
import { ShipmentSubscriptionResolver } from './shipment-subscription.resolver';
import { ShipmentsModule } from '../shipments/shipments.module';
import { MilestonesModule } from '../milestones/milestones.module';
import { EventsModule } from '../events/events.module';
import { GqlPubSubModule } from './gql-pubsub.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { createLoaders } from './graphql.loaders';
import { complexityLimitPlugin, depthLimitRule } from './graphql-limits';

const jwtModule = JwtModule.registerAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({ secret: config.get<string>('JWT_SECRET') }),
});

/**
 * Authenticates a graphql-ws connection from the JWT in `connectionParams`
 * (`{ authorization: 'Bearer <token>' }` or `{ token }`). Returns the user or
 * null — a null refuses the connection (#431).
 */
async function authenticateConnection(
  params: Record<string, any> | undefined,
  jwt: JwtService,
  prisma: PrismaService,
  secret: string | undefined,
) {
  const raw = params?.authorization ?? params?.Authorization ?? params?.token;
  if (typeof raw !== 'string' || !raw) return null;
  const token = raw.replace(/^Bearer\s+/i, '');
  try {
    const payload = jwt.verify<{ sub: string }>(token, { secret });
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, stellarAddress: true, role: true, deactivatedAt: true },
    });
    if (!user || user.deactivatedAt) return null;
    return user;
  } catch {
    return null;
  }
}

@Module({
  imports: [
    GqlPubSubModule,
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [ConfigModule, jwtModule],
      inject: [ConfigService, JwtService, PrismaService],
      useFactory: (config: ConfigService, jwt: JwtService, prisma: PrismaService) => {
        const isProd = process.env.NODE_ENV === 'production';
        const maxDepth = Number(config.get('GRAPHQL_MAX_DEPTH', 7));
        const maxComplexity = Number(config.get('GRAPHQL_MAX_COMPLEXITY', 1000));
        const secret = config.get<string>('JWT_SECRET');
        return {
          autoSchemaFile: true,
          path: '/graphql',
          playground: !isProd,
          introspection: !isProd,
          validationRules: [depthLimitRule(maxDepth)],
          plugins: [complexityLimitPlugin(maxComplexity)],
          subscriptions: {
            'graphql-ws': {
              path: '/graphql',
              onConnect: async (ctx: any) => {
                const user = await authenticateConnection(ctx.connectionParams, jwt, prisma, secret);
                if (!user) return false; // refuse unauthenticated sockets
                ctx.extra.user = user;
                return true;
              },
            },
          },
          context: ({ req, res, extra }: any) => ({
            // WebSocket connections carry the user authenticated in onConnect.
            req: req ?? { user: extra?.user, headers: {} },
            // Exposed so GqlThrottlerGuard can set X-RateLimit-* headers.
            res,
            loaders: createLoaders(prisma),
          }),
        };
      },
    }),
    ShipmentsModule,
    MilestonesModule,
    EventsModule,
  ],
  providers: [ShipmentResolver, MilestoneResolver, ShipmentSubscriptionResolver],
})
export class GraphqlModule {}
