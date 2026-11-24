import { createLoaders } from './graphql.loaders';
import { MilestoneResolver } from './milestone.resolver';
import { toMilestoneGql } from './milestone.mapper';

describe('GraphQL milestone loaders (#430)', () => {
  const prisma: any = {
    milestone: {
      findMany: jest.fn(async ({ where }) =>
        where.shipmentId.in.flatMap((sid: string) => [
          { id: `${sid}-m0`, shipmentId: sid, milestoneIndex: 0, name: 'm0', paymentPercent: 50, status: 'PENDING', paymentReleased: 10n },
          { id: `${sid}-m1`, shipmentId: sid, milestoneIndex: 1, name: 'm1', paymentPercent: 50, status: 'PENDING', paymentReleased: null },
        ]),
      ),
    },
    proofSubmission: {
      findMany: jest.fn(async ({ where }) =>
        where.milestoneId.in.map((mid: string) => ({ id: `p-${mid}`, milestoneId: mid, ipfsCid: 'Qm', submittedBy: 'G', createdAt: new Date() })),
      ),
    },
  };

  it('resolves shipment { milestones { proofSubmissions } } with one query per level', async () => {
    const loaders = createLoaders(prisma);
    const milestoneResolver = new MilestoneResolver(prisma);

    const shipments = ['s1', 's2', 's3'].map((id) => ({ id }) as any);
    const milestones = (await Promise.all(shipments.map(async (s) => (await loaders.milestonesByShipment.load(s.id)).map(toMilestoneGql)))).flat();
    const proofs = await Promise.all(milestones.map((m) => milestoneResolver.proofSubmissions(m, loaders)));

    expect(milestones).toHaveLength(6);
    expect(milestones[0].paymentReleased).toBe('10');
    expect(proofs.flat()).toHaveLength(6);
    expect(prisma.milestone.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.proofSubmission.findMany).toHaveBeenCalledTimes(1);
  });

  it('refuses milestone reads for non-participants', async () => {
    const resolver = new MilestoneResolver({
      ...prisma,
      milestone: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'm', shipment: { buyerAddress: 'GA', supplierAddress: 'GB', logisticsAddress: 'GC', arbiterAddress: 'GD' },
        }),
      },
    } as any);
    await expect(resolver.milestone('m', { stellarAddress: 'GX', role: 'BUYER' })).rejects.toThrow('Not a participant');
    await expect(resolver.milestone('m', { stellarAddress: 'GA', role: 'BUYER' })).resolves.toMatchObject({ id: 'm' });
  });
});
