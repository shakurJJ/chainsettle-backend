import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { KycService } from './kyc.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  KycProvider,
  KycSession,
  KycWebhookPayload,
  KycWebhookResult,
} from './kyc-provider.interface';
import { KYC_PROVIDER } from './kyc.constants';

class FakeKycProvider implements KycProvider {
  public createSessionCalls: Array<{ userId: string; email?: string }> = [];
  public parseWebhookCalls: Array<{ payload: KycWebhookPayload; headers: Record<string, string> }> = [];
  public verifySignatureCalls: Array<{ payload: KycWebhookPayload; headers: Record<string, string> }> = [];

  public fixedReference = 'fake-ref-123';
  public verifySignatureResult = true;
  public parseWebhookResult: KycWebhookResult = {
    reference: 'fake-ref-123',
    status: 'VERIFIED',
  };

  async createSession(params: { userId: string; email?: string }): Promise<KycSession> {
    this.createSessionCalls.push(params);
    return {
      reference: this.fixedReference,
      url: `https://fake-kyc.example.com/session/${this.fixedReference}`,
    };
  }

  async parseWebhook(
    payload: KycWebhookPayload,
    headers: Record<string, string>,
  ): Promise<KycWebhookResult> {
    this.parseWebhookCalls.push({ payload, headers });
    return this.parseWebhookResult;
  }

  verifySignature(payload: KycWebhookPayload, headers: Record<string, string>): boolean {
    this.verifySignatureCalls.push({ payload, headers });
    return this.verifySignatureResult;
  }
}

describe('KycService', () => {
  let service: KycService;
  let fakeProvider: FakeKycProvider;

  const prismaMock = {
    kycVerification: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    user: {
      update: jest.fn(),
      findUnique: jest.fn(),
    },
  };

  const configMock = {
    get: jest.fn().mockReturnValue('fake'),
  };

  const auditLogMock = {
    log: jest.fn(),
    record: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    fakeProvider = new FakeKycProvider();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KycService,
        { provide: KYC_PROVIDER, useValue: fakeProvider },
        { provide: PrismaService, useValue: prismaMock },
        { provide: ConfigService, useValue: configMock },
        { provide: AuditLogService, useValue: auditLogMock },
      ],
    }).compile();

    service = module.get<KycService>(KycService);
  });

  describe('initiateVerification', () => {
    it('uses the provider reference returned by createSession', async () => {
      prismaMock.kycVerification.create.mockResolvedValue({
        id: 'verification-1',
        reference: fakeProvider.fixedReference,
        userId: 'user-1',
        status: 'PENDING',
      });

      const result = await service.initiateVerification({
        userId: 'user-1',
        email: 'user@example.com',
      });

      expect(fakeProvider.createSessionCalls).toHaveLength(1);
      expect(fakeProvider.createSessionCalls[0]).toEqual({
        userId: 'user-1',
        email: 'user@example.com',
      });
      expect(prismaMock.kycVerification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reference: fakeProvider.fixedReference,
            userId: 'user-1',
          }),
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          reference: fakeProvider.fixedReference,
        }),
      );
    });
  });

  describe('handleWebhook', () => {
    const payload: KycWebhookPayload = {
      reference: 'fake-ref-123',
      status: 'VERIFIED',
    };
    const headers: Record<string, string> = { 'x-signature': 'sig' };

    it('rejects invalid signatures without parsing the webhook', async () => {
      fakeProvider.verifySignatureResult = false;

      await expect(service.handleWebhook(payload, headers)).rejects.toThrow();

      expect(fakeProvider.verifySignatureCalls).toHaveLength(1);
      expect(fakeProvider.parseWebhookCalls).toHaveLength(0);
      expect(prismaMock.kycVerification.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.kycVerification.update).not.toHaveBeenCalled();
    });

    it('applies a VERIFIED result from the provider', async () => {
      fakeProvider.verifySignatureResult = true;
      fakeProvider.parseWebhookResult = {
        reference: 'fake-ref-123',
        status: 'VERIFIED',
      };
      prismaMock.kycVerification.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.user.update.mockResolvedValue({ id: 'user-1' });

      await service.handleWebhook(payload, headers);

      expect(fakeProvider.verifySignatureCalls).toHaveLength(1);
      expect(fakeProvider.parseWebhookCalls).toHaveLength(1);
      expect(prismaMock.kycVerification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ reference: 'fake-ref-123' }),
          data: expect.objectContaining({ status: 'VERIFIED' }),
        }),
      );
    });

    it('applies a REJECTED result from the provider', async () => {
      fakeProvider.verifySignatureResult = true;
      fakeProvider.parseWebhookResult = {
        reference: 'fake-ref-123',
        status: 'REJECTED',
      };
      prismaMock.kycVerification.updateMany.mockResolvedValue({ count: 1 });

      await service.handleWebhook(payload, headers);

      expect(fakeProvider.parseWebhookCalls).toHaveLength(1);
      expect(prismaMock.kycVerification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ reference: 'fake-ref-123' }),
          data: expect.objectContaining({ status: 'REJECTED' }),
        }),
      );
    });
  });

  describe('provider swapping', () => {
    it('works with a different provider implementation without changing KycService', async () => {
      const alternateProvider: KycProvider = {
        createSession: jest.fn().mockResolvedValue({
          reference: 'alt-ref-999',
          url: 'https://alt.example.com/session/alt-ref-999',
        }),
        parseWebhook: jest.fn().mockResolvedValue({
          reference: 'alt-ref-999',
          status: 'VERIFIED',
        }),
        verifySignature: jest.fn().mockReturnValue(true),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          KycService,
          { provide: KYC_PROVIDER, useValue: alternateProvider },
          { provide: PrismaService, useValue: prismaMock },
          { provide: ConfigService, useValue: configMock },
          { provide: AuditLogService, useValue: auditLogMock },
        ],
      }).compile();

      const altService = module.get<KycService>(KycService);

      prismaMock.kycVerification.create.mockResolvedValue({
        id: 'verification-2',
        reference: 'alt-ref-999',
        userId: 'user-2',
        status: 'PENDING',
      });

      const result = await altService.initiateVerification({
        userId: 'user-2',
        email: 'user2@example.com',
      });

      expect(alternateProvider.createSession).toHaveBeenCalledWith({
        userId: 'user-2',
        email: 'user2@example.com',
      });
      expect(result).toEqual(
        expect.objectContaining({ reference: 'alt-ref-999' }),
      );
    });
  });
});