import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ShipmentResolver } from './shipment.resolver';
import { ShipmentsModule } from '../shipments/shipments.module';
import { MilestonesModule } from '../milestones/milestones.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      path: '/graphql',
      context: ({ req }) => ({ req }),
      playground: process.env.NODE_ENV !== 'production',
      introspection: process.env.NODE_ENV !== 'production',
    }),
    ShipmentsModule,
    MilestonesModule,
    EventsModule,
  ],
  providers: [ShipmentResolver],
})
export class GraphqlModule {}
