import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ShipmentReadAccessGuard } from './shipment-read-access.guard';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrganizationsService } from '../../organizations/organizations.service';

describe('ShipmentReadAccessGuard', () => {
  let guard: ShipmentReadAccessGuard;
  let prisma: { shipment: { findUnique: jest.Mock } };
  let organizationsService: { canReadShipment: jest.Mock };

  const shipmentId = 'shipment-123';

  const buildContext = (user: any, params: any = { id: shipmentId }): ExecutionContext => {
    const request: any = { user, params };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  };

  const getRequest = (context: ExecutionContext): any =>
    context.switchToHttp().getRequest();

  beforeEach(() => {
    prisma = {
      shipment: {
        findUnique: jest.fn(),
      },
    };
    organizationsService = {
      canReadShipment: jest.fn(),
    };
    guard = new ShipmentReadAccessGuard(
      prisma as unknown as PrismaService,
      organizationsService as unknown as OrganizationsService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('allow paths', () => {
    it('allows ADMIN role to bypass all checks', async () => {
      const context = buildContext({ role: 'ADMIN' });

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(prisma.shipment.findUnique).not.toHaveBeenCalled();
      expect(organizationsService.canReadShipment).not.toHaveBeenCalled();
    });

    it.each(['BUYER', 'SUPPLIER', 'LOGISTICS', 'ARBITER'])(
      'allows %s participant of the shipment',
      async (role) => {
        const context = buildContext({
          role,
          stellarAddress: 'GABC123',
        });
        prisma.shipment.findUnique.mockResolvedValue({
          id: shipmentId,
          buyerAddress: 'GABC123',
          supplierAddress: 'GSUP456',
          logisticsAddress: 'GLOG789',
          arbiterAddress: 'GARB000',
        });

        const result = await guard.canActivate(context);

        expect(result).toBe(true);
        expect(prisma.shipment.findUnique).toHaveBeenCalledWith({
          where: { id: shipmentId },
        });
      },
    );

    it('allows org API key via _apiKeyOrganizationId when org can read shipment', async () => {
      const context = buildContext({
        _apiKeyOrganizationId: 'org-1',
      });
      prisma.shipment.findUnique.mockResolvedValue({
        id: shipmentId,
        buyerAddress: 'GBUYER',
        supplierAddress: 'GSUPPLIER',
        logisticsAddress: 'GLOGISTICS',
        arbiterAddress: 'GARBITER',
      });
      organizationsService.canReadShipment.mockResolvedValue(true);

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(organizationsService.canReadShipment).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ id: shipmentId }),
      );
      expect(getRequest(context).shipmentAccess).toBe('organization');
    });

    it('allows org member via canReadShipment and sets shipmentAccess', async () => {
      const context = buildContext({
        stellarAddress: 'GMEMBER',
        organizationId: 'org-2',
      });
      prisma.shipment.findUnique.mockResolvedValue({
        id: shipmentId,
        buyerAddress: 'GBUYER',
        supplierAddress: 'GSUPPLIER',
        logisticsAddress: 'GLOGISTICS',
        arbiterAddress: 'GARBITER',
      });
      organizationsService.canReadShipment.mockResolvedValue(true);

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(organizationsService.canReadShipment).toHaveBeenCalledWith(
        'org-2',
        expect.objectContaining({ id: shipmentId }),
      );
      expect(getRequest(context).shipmentAccess).toBe('organization');
    });
  });

  describe('deny paths', () => {
    it('denies when user has no stellarAddress', async () => {
      const context = buildContext({ role: 'BUYER' });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.shipment.findUnique).not.toHaveBeenCalled();
    });

    it('denies when shipment id is missing', async () => {
      const context = buildContext({ stellarAddress: 'GABC123' }, {});

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.shipment.findUnique).not.toHaveBeenCalled();
    });

    it('denies when shipment is not found', async () => {
      const context = buildContext({ stellarAddress: 'GABC123' });
      prisma.shipment.findUnique.mockResolvedValue(null);

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('denies outsider with no org membership', async () => {
      const context = buildContext({
        stellarAddress: 'GOUTSIDER',
        organizationId: 'org-3',
      });
      prisma.shipment.findUnique.mockResolvedValue({
        id: shipmentId,
        buyerAddress: 'GBUYER',
        supplierAddress: 'GSUPPLIER',
        logisticsAddress: 'GLOGISTICS',
        arbiterAddress: 'GARBITER',
      });
      organizationsService.canReadShipment.mockResolvedValue(false);

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(getRequest(context).shipmentAccess).toBeUndefined();
    });
  });
});