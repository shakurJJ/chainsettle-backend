import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InvitationsService } from './invitations.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';

describe('InvitationsService', () => {
  let service: InvitationsService;
  let prisma: {
    invitation: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    user: {
      findUnique: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let emailService: { sendInvitationEmail: jest.Mock };

  const baseInvitation = {
    id: 'inv-1',
    email: 'invitee@example.com',
    token: 'valid-token',
    status: 'PENDING',
    invitedById: 'user-1',
    organizationId: 'org-1',
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    prisma = {
      invitation: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    emailService = {
      sendInvitationEmail: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: emailService },
      ],
    }).compile();

    service = module.get<InvitationsService>(InvitationsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('creates an invitation and sends an email', async () => {
      prisma.invitation.findFirst.mockResolvedValue(null);
      prisma.invitation.create.mockResolvedValue(baseInvitation);

      const result = await service.create({
        email: 'invitee@example.com',
        organizationId: 'org-1',
        invitedById: 'user-1',
      } as any);

      expect(prisma.invitation.findFirst).toHaveBeenCalled();
      expect(prisma.invitation.create).toHaveBeenCalled();
      expect(emailService.sendInvitationEmail).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'invitee@example.com' }),
      );
      expect(result).toEqual(baseInvitation);
    });

    it('rejects a duplicate pending invitation', async () => {
      prisma.invitation.findFirst.mockResolvedValue(baseInvitation);

      await expect(
        service.create({
          email: 'invitee@example.com',
          organizationId: 'org-1',
          invitedById: 'user-1',
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.invitation.create).not.toHaveBeenCalled();
      expect(emailService.sendInvitationEmail).not.toHaveBeenCalled();
    });
  });

  describe('accept', () => {
    it('accepts an invitation with a valid token', async () => {
      prisma.invitation.findUnique.mockResolvedValue(baseInvitation);
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-2',
        email: 'invitee@example.com',
      });
      prisma.invitation.update.mockResolvedValue({
        ...baseInvitation,
        status: 'ACCEPTED',
      });

      const result = await service.accept('valid-token', 'user-2');

      expect(prisma.invitation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: baseInvitation.id },
          data: expect.objectContaining({ status: 'ACCEPTED' }),
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({ status: 'ACCEPTED' }),
      );
    });

    it('rejects an invalid token', async () => {
      prisma.invitation.findUnique.mockResolvedValue(null);

      await expect(service.accept('invalid-token', 'user-2')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(prisma.invitation.update).not.toHaveBeenCalled();
    });

    it('rejects an expired invitation', async () => {
      prisma.invitation.findUnique.mockResolvedValue({
        ...baseInvitation,
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(service.accept('valid-token', 'user-2')).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(prisma.invitation.update).not.toHaveBeenCalled();
    });

    it('rejects acceptance by the wrong user', async () => {
      prisma.invitation.findUnique.mockResolvedValue(baseInvitation);
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-3',
        email: 'someone-else@example.com',
      });

      await expect(service.accept('valid-token', 'user-3')).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      expect(prisma.invitation.update).not.toHaveBeenCalled();
    });
  });
});
