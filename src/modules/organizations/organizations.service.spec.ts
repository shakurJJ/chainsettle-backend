import { ForbiddenException } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { ShipmentReadAccessGuard } from '../shipments/guards/shipment-read-access.guard';

type Member = { id: string; orgId: string; userId: string; role: any; address: string };

/** Tiny in-memory Prisma fake — enough for the access rules. */
function makePrisma(members: Member[]) {
  const orgsOf = (address: string) => members.filter((m) => m.address === address).map((m) => m.orgId);
  return {
    organization: { findUnique: jest.fn(({ where }) => Promise.resolve(members.some((m) => m.orgId === where.id) ? { id: where.id } : null)) },
    organizationMember: {
      findUnique: jest.fn(({ where: { orgId_userId: k } }) =>
        Promise.resolve(members.find((m) => m.orgId === k.orgId && m.userId === k.userId) ?? null),
      ),
      findMany: jest.fn(({ where }) => {
        if (where.orgId) {
          return Promise.resolve(
            members.filter((m) => m.orgId === where.orgId).map((m) => ({ user: { stellarAddress: m.address } })),
          );
        }
        const addresses: string[] = where.organization.members.some.user.stellarAddress.in;
        const orgIds = new Set(addresses.flatMap(orgsOf));
        return Promise.resolve(members.filter((m) => m.userId === where.userId && orgIds.has(m.orgId)));
      }),
      delete: jest.fn(({ where }) => {
        members.splice(members.findIndex((m) => m.id === where.id), 1);
        return Promise.resolve();
      }),
      count: jest.fn(({ where }) =>
        Promise.resolve(members.filter((m) => m.orgId === where.orgId && m.role === where.role).length),
      ),
    },
    shipment: {
      findUnique: jest.fn().mockResolvedValue({
        buyerAddress: 'GBUYER',
        supplierAddress: 'GSUP',
        logisticsAddress: 'GLOG',
        arbiterAddress: 'GARB',
      }),
    },
  } as any;
}

const shipment = { buyerAddress: 'GBUYER', supplierAddress: 'GSUP', logisticsAddress: 'GLOG', arbiterAddress: 'GARB' };

function ctx(user: any, id = 'S1') {
  const req: any = { user, params: { id } };
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}

describe('Organizations access rules (#435)', () => {
  let members: Member[];
  let service: OrganizationsService;
  let prisma: any;

  beforeEach(() => {
    members = [
      { id: 'm1', orgId: 'org1', userId: 'buyer', role: 'OWNER', address: 'GBUYER' },
      { id: 'm2', orgId: 'org1', userId: 'colleague', role: 'MEMBER', address: 'GCOLL' },
      { id: 'm3', orgId: 'org1', userId: 'auditor', role: 'VIEWER', address: 'GAUD' },
      { id: 'm4', orgId: 'org2', userId: 'stranger', role: 'OWNER', address: 'GSTRANGER' },
    ];
    prisma = makePrisma(members);
    service = new OrganizationsService(prisma);
  });

  it('members can read org shipments; outsiders cannot', async () => {
    expect(await service.canReadShipment('colleague', shipment)).toBe(true);
    expect(await service.canReadShipment('auditor', shipment)).toBe(true);
    expect(await service.canReadShipment('stranger', shipment)).toBe(false);
  });

  it('VIEWERs cannot comment, MEMBERs can', async () => {
    expect(await service.canCommentOnShipment('auditor', shipment)).toBe(false);
    expect(await service.canCommentOnShipment('colleague', shipment)).toBe(true);
  });

  it('removing a member revokes access immediately', async () => {
    expect(await service.canReadShipment('colleague', shipment)).toBe(true);
    await service.removeMember('org1', 'buyer', 'colleague');
    expect(await service.canReadShipment('colleague', shipment)).toBe(false);
    await expect(service.getMemberAddresses('org1', 'colleague')).rejects.toThrow(ForbiddenException);
  });

  it('only members can list org shipment addresses', async () => {
    await expect(service.getMemberAddresses('org1', 'auditor')).resolves.toEqual(['GBUYER', 'GCOLL', 'GAUD']);
    await expect(service.getMemberAddresses('org1', 'stranger')).rejects.toThrow(ForbiddenException);
  });

  it('non-admins cannot remove members; the last OWNER cannot leave', async () => {
    await expect(service.removeMember('org1', 'colleague', 'auditor')).rejects.toThrow(ForbiddenException);
    await expect(service.removeMember('org1', 'buyer', 'buyer')).rejects.toThrow('at least one OWNER');
  });

  it('read guard lets org members view but grants no participant identity', async () => {
    const guard = new ShipmentReadAccessGuard(prisma, service);
    await expect(guard.canActivate(ctx({ id: 'auditor', stellarAddress: 'GAUD' }))).resolves.toBe(true);
    await expect(guard.canActivate(ctx({ id: 'stranger', stellarAddress: 'GSTRANGER' }))).rejects.toThrow(
      ForbiddenException,
    );
  });
});
