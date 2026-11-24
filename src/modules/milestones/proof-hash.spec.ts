import { createHash } from 'crypto';
import { MilestonesService, sha256Hex } from './milestones.service';

describe('Milestone proof SHA-256 (#394)', () => {
  const file = (content: string) =>
    ({
      buffer: Buffer.from(content),
      size: Buffer.byteLength(content),
      originalname: 'proof.pdf',
      mimetype: 'application/pdf',
    }) as Express.Multer.File;

  let prisma: any;
  let service: MilestonesService;

  beforeEach(() => {
    prisma = {
      shipment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 's1',
          status: 'ACTIVE',
          buyerAddress: 'GBUYER',
          supplierAddress: 'GSUPPLIER',
          logisticsAddress: 'GLOGISTICS',
        }),
      },
      milestone: {
        findUnique: jest.fn().mockResolvedValue({ id: 'm1', name: 'Pickup' }),
      },
      proofSubmission: {
        create: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
    };
    const ipfs = { uploadFile: jest.fn().mockResolvedValue('bafyCID'), getGatewayUrl: jest.fn() };
    const notifications = { notifyUser: jest.fn() };
    service = new MilestonesService(
      prisma,
      ipfs as any,
      notifications as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(service as any, 'markProofSubmitted').mockResolvedValue({});
  });

  it('computes a hex SHA-256', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      createHash('sha256').update('abc').digest('hex'),
    );
  });

  it('stores sha256 and fileSize on proof upload', async () => {
    await service.submitProof('s1', 0, 'GSUPPLIER', file('hello'));
    expect(prisma.proofSubmission.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ipfsCid: 'bafyCID',
        sha256: sha256Hex(Buffer.from('hello')),
        fileSize: 5,
      }),
    });
  });

  it('verify returns matches: true with the submission id for the same file', async () => {
    prisma.proofSubmission.findFirst.mockResolvedValue({ id: 'sub-1' });
    const result = await service.verifyProof('s1', 0, file('hello'));
    expect(prisma.proofSubmission.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { milestoneId: 'm1', sha256: sha256Hex(Buffer.from('hello')) },
      }),
    );
    expect(result).toEqual({ matches: true, submissionId: 'sub-1', sha256: sha256Hex(Buffer.from('hello')) });
  });

  it('verify returns matches: false for a different file', async () => {
    prisma.proofSubmission.findFirst.mockResolvedValue(null);
    const result = await service.verifyProof('s1', 0, file('tampered'));
    expect(result.matches).toBe(false);
    expect(result).not.toHaveProperty('submissionId');
  });

  it('proof history tolerates legacy rows without a hash', async () => {
    prisma.proofSubmission.findMany.mockResolvedValue([
      { id: 'old', ipfsCid: 'cid0', submittedBy: 'G', sha256: null, fileSize: null, createdAt: new Date(0) },
      { id: 'new', ipfsCid: 'cid1', submittedBy: 'G', sha256: 'abc', fileSize: 3, createdAt: new Date(1) },
    ]);
    const history = await service.getProofHistory('s1', 0);
    expect(history[0]).toMatchObject({ id: 'old', sha256: null, fileSize: null });
    expect(history[1]).toMatchObject({ id: 'new', sha256: 'abc', fileSize: 3 });
  });
});

describe('MilestonesService.getUpcomingForUser (#395)', () => {
  it('filters to the caller\'s ACTIVE shipments and flags role/overdue', async () => {
    const past = new Date(Date.now() - 86_400_000);
    const soon = new Date(Date.now() + 86_400_000);
    const prisma: any = {
      milestone: {
        findMany: jest.fn().mockResolvedValue([
          {
            milestoneIndex: 0, name: 'A', status: 'PENDING', dueAt: past,
            shipment: { id: 's1', referenceNumber: 'PO-1', buyerAddress: 'GME', supplierAddress: 'X', logisticsAddress: 'Y', arbiterAddress: 'Z' },
          },
          {
            milestoneIndex: 1, name: 'B', status: 'PROOF_SUBMITTED', dueAt: soon,
            shipment: { id: 's2', referenceNumber: null, buyerAddress: 'X', supplierAddress: 'GME', logisticsAddress: 'Y', arbiterAddress: 'Z' },
          },
        ]),
      },
    };
    const service = new MilestonesService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    const result = await service.getUpcomingForUser('GME', 14, true);

    const where = prisma.milestone.findMany.mock.calls[0][0].where;
    expect(where.shipment.status).toBe('ACTIVE');
    expect(where.shipment.OR).toContainEqual({ buyerAddress: 'GME' });
    expect(where.status).toEqual({ in: ['PENDING', 'PROOF_SUBMITTED'] });
    expect(result[0]).toMatchObject({ shipmentId: 's1', shipmentReference: 'PO-1', callerRole: 'BUYER', isOverdue: true });
    expect(result[1]).toMatchObject({ shipmentId: 's2', callerRole: 'SUPPLIER', isOverdue: false });
  });

  it('excludes past-due milestones unless includeOverdue is set', async () => {
    const prisma: any = { milestone: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new MilestonesService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await service.getUpcomingForUser('GME', 7, false);
    expect(prisma.milestone.findMany.mock.calls[0][0].where.dueAt.gte).toBeInstanceOf(Date);
  });
});
