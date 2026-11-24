import { PubSub } from 'graphql-subscriptions';
import { ShipmentSubscriptionResolver } from './shipment-subscription.resolver';
import { ShipmentEventsPublisher } from './shipment-events.publisher';

describe('GraphQL shipment subscriptions (#431)', () => {
  const shipment = {
    id: 's1', buyerAddress: 'GA', supplierAddress: 'GB', logisticsAddress: 'GC', arbiterAddress: 'GD',
    status: 'IN_TRANSIT', totalAmount: 100n, releasedAmount: 0n, createdAt: new Date(),
  };
  const prisma: any = {
    shipment: { findUnique: jest.fn().mockResolvedValue(shipment) },
    milestone: { findUnique: jest.fn().mockResolvedValue({ id: 'm0', shipmentId: 's1', milestoneIndex: 0, name: 'm', paymentPercent: 100, status: 'CONFIRMED' }) },
  };
  let pubSub: PubSub;
  let resolver: ShipmentSubscriptionResolver;

  beforeEach(() => {
    pubSub = new PubSub();
    resolver = new ShipmentSubscriptionResolver(pubSub, prisma);
  });

  it('refuses unauthenticated and non-participant subscribers', async () => {
    await expect(resolver.shipmentUpdated('s1', { user: undefined })).rejects.toThrow('Authentication required');
    await expect(resolver.shipmentUpdated('s1', { user: { stellarAddress: 'GX', role: 'BUYER' } })).rejects.toThrow('Not a participant');
    await expect(resolver.milestoneUpdated('s1', { user: { stellarAddress: 'GX', role: 'BUYER' } })).rejects.toThrow('Not a participant');
  });

  it('delivers published chain-event updates to participants', async () => {
    const shipmentIt = (await resolver.shipmentUpdated('s1', { user: { stellarAddress: 'GA' } })) as AsyncIterator<any>;
    const milestoneIt = (await resolver.milestoneUpdated('s1', { user: { stellarAddress: 'GB' } })) as AsyncIterator<any>;
    const nextShipment = shipmentIt.next();
    const nextMilestone = milestoneIt.next();

    await new ShipmentEventsPublisher(pubSub, prisma).publishShipment('s1', 0);

    await expect(nextShipment).resolves.toMatchObject({ value: { shipmentUpdated: { id: 's1', totalAmount: '100' } } });
    await expect(nextMilestone).resolves.toMatchObject({ value: { milestoneUpdated: { id: 'm0', shipmentId: 's1' } } });
  });
});
