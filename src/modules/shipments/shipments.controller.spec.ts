// NOTE: This repository's CI/test runner appears misconfigured in the current environment.
// Tests added for RBAC logic are primarily meant for Jest unit testing in a properly set up CI.

import { OrganizationsService } from '../organizations/organizations.service';
import { ForbiddenException } from '@nestjs/common';
import { ShipmentsController } from './shipments.controller';
import { ShipmentsService } from './shipments.service';
import { RedisService } from '../../common/redis/redis.service';
import { ShipmentApprovalsService } from './shipment-approvals.service';
import { SavedFiltersService } from './saved-filters.service';

const mockRedis: Partial<RedisService> = {
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn().mockResolvedValue(undefined),
};

const mockApprovals: Partial<ShipmentApprovalsService> = {
    approve: jest.fn(),
    getApprovalStatus: jest.fn(),
};

const mockSavedFilters: Partial<SavedFiltersService> = {
    applyTo: jest.fn(),
    findAll: jest.fn(),
};

describe('ShipmentsController (RBAC)', () => {
    it('rejects POST /shipments when buyerAddress does not match caller (non-admin)', async () => {
        const mockService: Partial<ShipmentsService> = {
            create: jest.fn().mockResolvedValue({}),
        };

        const controller = new ShipmentsController(
            mockService as ShipmentsService,
            mockApprovals as ShipmentApprovalsService,
            mockSavedFilters as SavedFiltersService,
            mockRedis as RedisService,
            {} as OrganizationsService,
        );

        const dto: any = {
            shipmentId: 'SHIP-1',
            buyerAddress: 'GBUY-OTHER',
            supplierAddress: 'GSUP',
            logisticsAddress: 'GLOG',
            arbiterAddress: 'GARB',
            tokenAddress: 'CNOP',
            totalAmount: '1000000000',
            milestones: [],
        };

        await expect(
            controller.create(dto, { stellarAddress: 'GBUY-ME', role: 'BUYER' }),
        ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows POST /shipments when buyerAddress matches caller (non-admin)', async () => {
        const mockService: Partial<ShipmentsService> = {
            create: jest.fn().mockResolvedValue({ id: 'SHIP-1' }),
        };

        const controller = new ShipmentsController(
            mockService as ShipmentsService,
            mockApprovals as ShipmentApprovalsService,
            mockSavedFilters as SavedFiltersService,
            mockRedis as RedisService,
            {} as OrganizationsService,
        );

        const dto: any = {
            shipmentId: 'SHIP-1',
            buyerAddress: 'GBUY-ME',
            supplierAddress: 'GSUP',
            logisticsAddress: 'GLOG',
            arbiterAddress: 'GARB',
            tokenAddress: 'CNOP',
            totalAmount: '1000000000',
            milestones: [],
        };

        await expect(
            controller.create(dto, { stellarAddress: 'GBUY-ME', role: 'BUYER' }),
        ).resolves.toEqual({ id: 'SHIP-1' });
    });

    it('returns cached response on duplicate request with Idempotency-Key', async () => {
        const cached = { id: 'SHIP-1' };
        const redisMock: Partial<RedisService> = {
            getJson: jest.fn().mockResolvedValue({ statusCode: 201, body: cached }),
            setJson: jest.fn().mockResolvedValue(undefined),
        };
        const mockService: Partial<ShipmentsService> = {
            create: jest.fn().mockResolvedValue({ id: 'SHIP-2' }),
        };

        const controller = new ShipmentsController(
            mockService as ShipmentsService,
            mockApprovals as ShipmentApprovalsService,
            mockSavedFilters as SavedFiltersService,
            redisMock as RedisService,
            {} as OrganizationsService,
        );

        const dto: any = {
            shipmentId: 'SHIP-1',
            buyerAddress: 'GBUY-ME',
            supplierAddress: 'GSUP',
            logisticsAddress: 'GLOG',
            arbiterAddress: 'GARB',
            tokenAddress: 'CNOP',
            totalAmount: '1000000000',
            milestones: [],
        };

        const result = await controller.create(dto, { sub: 'user-1', stellarAddress: 'GBUY-ME', role: 'BUYER' }, 'key-abc');
        expect(result).toEqual(cached);
        expect(mockService.create).not.toHaveBeenCalled();
    });

    it('delegates GET /shipments/:id/documents to shipmentsService.getDocuments', async () => {
        const mockDocuments = [{ source: 'PROOF', cid: 'Qm123', downloadUrl: '/api/v1/ipfs/Qm123' }];
        const mockService: Partial<ShipmentsService> = {
            getDocuments: jest.fn().mockResolvedValue(mockDocuments),
        };

        const controller = new ShipmentsController(
            mockService as ShipmentsService,
            mockApprovals as ShipmentApprovalsService,
            mockSavedFilters as SavedFiltersService,
            mockRedis as RedisService,
            {} as any,
            {} as any,
        );

        const result = await controller.getDocuments('SHIP-1', { source: 'PROOF' }, { stellarAddress: 'GBUY-ME', role: 'BUYER' });
        expect(result).toEqual(mockDocuments);
        expect(mockService.getDocuments).toHaveBeenCalledWith('SHIP-1', 'GBUY-ME', false, 'PROOF');
    });
});


