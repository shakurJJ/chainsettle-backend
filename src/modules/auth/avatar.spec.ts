import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { UsersController } from './users.controller';
import { SessionService } from './session.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { IpfsService } from '../../common/ipfs/ipfs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogService } from '../audit-logs/audit-log.service';

describe('User Avatar Management (IPFS Profile Picture)', () => {
  let authService: AuthService;
  let usersController: UsersController;
  let mockPrisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
  };
  let mockIpfs: {
    uploadFile: jest.Mock;
    getGatewayUrl: jest.Mock;
  };
  let mockSessions: {
    revokeAllSessions: jest.Mock;
    listSessions: jest.Mock;
    revokeSession: jest.Mock;
  };

  const userId = 'user-123';
  const stellarAddress = 'G' + 'A'.repeat(55);

  beforeEach(() => {
    mockPrisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    mockIpfs = {
      uploadFile: jest.fn(),
      getGatewayUrl: jest.fn(),
    };

    mockSessions = {
      revokeAllSessions: jest.fn(),
      listSessions: jest.fn(),
      revokeSession: jest.fn(),
    };

    authService = new AuthService(
      mockPrisma as unknown as PrismaService,
      {} as JwtService,
      {} as RedisService,
      {} as ConfigService,
      {} as NotificationsService,
      {} as AuditLogService,
      mockSessions as unknown as SessionService,
      mockIpfs as unknown as IpfsService,
    );

    usersController = new UsersController(
      authService,
      mockSessions as unknown as SessionService,
      {} as AuditLogService,
      {} as NotificationsService,
    );
  });

  describe('PUT /users/me/avatar — uploadAvatar', () => {
    it('successfully uploads valid PNG image and updates user avatarCid', async () => {
      const fileBuffer = Buffer.from('fake-png-content');
      const mockFile: Express.Multer.File = {
        fieldname: 'file',
        originalname: 'avatar.png',
        encoding: '7bit',
        mimetype: 'image/png',
        buffer: fileBuffer,
        size: fileBuffer.length,
      } as any;

      mockIpfs.uploadFile.mockResolvedValue('bafybeiavatarpngcid');
      mockPrisma.user.update.mockResolvedValue({
        id: userId,
        avatarCid: 'bafybeiavatarpngcid',
      });

      const result = await authService.uploadAvatar(userId, mockFile);

      expect(mockIpfs.uploadFile).toHaveBeenCalledWith(
        fileBuffer,
        'avatar.png',
        'image/png',
      );
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { avatarCid: 'bafybeiavatarpngcid' },
      });
      expect(result).toEqual({
        message: 'Avatar uploaded successfully',
        avatarCid: 'bafybeiavatarpngcid',
        avatarUrl: '/api/v1/ipfs/bafybeiavatarpngcid',
      });
    });

    it('successfully uploads JPEG and WebP images', async () => {
      for (const mime of ['image/jpeg', 'image/webp']) {
        const fileBuffer = Buffer.from('image-data');
        const mockFile: Express.Multer.File = {
          fieldname: 'file',
          originalname: `profile.${mime.split('/')[1]}`,
          encoding: '7bit',
          mimetype: mime,
          buffer: fileBuffer,
          size: fileBuffer.length,
        } as any;

        mockIpfs.uploadFile.mockResolvedValue('bafycid123');
        mockPrisma.user.update.mockResolvedValue({ id: userId, avatarCid: 'bafycid123' });

        const result = await authService.uploadAvatar(userId, mockFile);
        expect(result.avatarCid).toBe('bafycid123');
        expect(result.avatarUrl).toBe('/api/v1/ipfs/bafycid123');
      }
    });

    it('rejects upload when no file is provided with 400 BadRequestException', async () => {
      await expect(authService.uploadAvatar(userId, null as any)).rejects.toThrow(
        BadRequestException,
      );
      await expect(authService.uploadAvatar(userId, null as any)).rejects.toThrow(
        'Avatar image file is required',
      );
      expect(mockIpfs.uploadFile).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects unsupported MIME types (e.g. PDF, GIF, text) with 400 BadRequestException', async () => {
      const unsupportedMimes = ['application/pdf', 'image/gif', 'text/plain', 'video/mp4'];

      for (const mimetype of unsupportedMimes) {
        const mockFile: Express.Multer.File = {
          fieldname: 'file',
          originalname: 'file.ext',
          mimetype,
          buffer: Buffer.from('data'),
          size: 4,
        } as any;

        await expect(authService.uploadAvatar(userId, mockFile)).rejects.toThrow(
          BadRequestException,
        );
        await expect(authService.uploadAvatar(userId, mockFile)).rejects.toThrow(
          /Invalid file type/,
        );
      }

      expect(mockIpfs.uploadFile).not.toHaveBeenCalled();
    });

    it('rejects files larger than 2 MB with 413 PayloadTooLargeException', async () => {
      const oversizedSize = 2 * 1024 * 1024 + 1; // 2 MB + 1 byte
      const mockFile: Express.Multer.File = {
        fieldname: 'file',
        originalname: 'large.png',
        mimetype: 'image/png',
        buffer: Buffer.alloc(10), // small buffer stub but size metadata indicates oversized
        size: oversizedSize,
      } as any;

      await expect(authService.uploadAvatar(userId, mockFile)).rejects.toThrow(
        PayloadTooLargeException,
      );
      await expect(authService.uploadAvatar(userId, mockFile)).rejects.toThrow(
        'Avatar image must not exceed 2 MB',
      );

      // Also test oversized buffer length
      const oversizedBuffer = Buffer.alloc(2 * 1024 * 1024 + 10);
      const mockFileWithLargeBuffer: Express.Multer.File = {
        fieldname: 'file',
        originalname: 'large.png',
        mimetype: 'image/png',
        buffer: oversizedBuffer,
        size: oversizedBuffer.length,
      } as any;

      await expect(authService.uploadAvatar(userId, mockFileWithLargeBuffer)).rejects.toThrow(
        PayloadTooLargeException,
      );

      expect(mockIpfs.uploadFile).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /users/me/avatar — deleteAvatar', () => {
    it('clears avatarCid in database and returns success message', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: userId,
        avatarCid: 'existing-cid',
      });
      mockPrisma.user.update.mockResolvedValue({
        id: userId,
        avatarCid: null,
      });

      const result = await authService.deleteAvatar(userId);

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { avatarCid: null },
      });
      expect(result).toEqual({ message: 'Avatar deleted successfully' });
    });

    it('throws NotFoundException if user is not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(authService.deleteAvatar('non-existent')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('Profile and Public Profile Responses (avatarUrl)', () => {
    it('returns avatarUrl on GET /users/me when avatarCid is present', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: userId,
        stellarAddress,
        name: 'Alice',
        email: 'alice@example.com',
        role: UserRole.BUYER,
        displayCurrency: 'USD',
        avatarCid: 'bafybeialiceavatar',
        deactivatedAt: null,
        createdAt: new Date('2026-01-01'),
      });

      const profile = await authService.getProfile(userId);

      expect(profile.avatarCid).toBe('bafybeialiceavatar');
      expect(profile.avatarUrl).toBe('/api/v1/ipfs/bafybeialiceavatar');
    });

    it('returns avatarUrl: null on GET /users/me when avatarCid is not set', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: userId,
        stellarAddress,
        name: 'Bob',
        email: 'bob@example.com',
        role: UserRole.SUPPLIER,
        displayCurrency: 'USD',
        avatarCid: null,
        deactivatedAt: null,
        createdAt: new Date('2026-01-01'),
      });

      const profile = await authService.getProfile(userId);

      expect(profile.avatarCid).toBeNull();
      expect(profile.avatarUrl).toBeNull();
    });

    it('returns avatarUrl on GET /users/:stellarAddress (public profile)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        stellarAddress,
        name: 'Alice',
        role: UserRole.BUYER,
        avatarCid: 'bafybeialiceavatar',
        createdAt: new Date('2026-01-01'),
      });

      const publicProfile = await authService.getPublicProfile(stellarAddress);

      expect(publicProfile.avatarCid).toBe('bafybeialiceavatar');
      expect(publicProfile.avatarUrl).toBe('/api/v1/ipfs/bafybeialiceavatar');
    });
  });

  describe('UsersController integration', () => {
    it('controller delegates uploadAvatar and deleteAvatar to authService', async () => {
      const uploadSpy = jest
        .spyOn(authService, 'uploadAvatar')
        .mockResolvedValue({
          message: 'Avatar uploaded successfully',
          avatarCid: 'cid1',
          avatarUrl: '/api/v1/ipfs/cid1',
        });

      const deleteSpy = jest
        .spyOn(authService, 'deleteAvatar')
        .mockResolvedValue({ message: 'Avatar deleted successfully' });

      const fakeFile = { mimetype: 'image/png' } as any;

      const uploadRes = await usersController.uploadAvatar(userId, fakeFile);
      expect(uploadSpy).toHaveBeenCalledWith(userId, fakeFile);
      expect(uploadRes.avatarCid).toBe('cid1');

      const deleteRes = await usersController.deleteAvatar(userId);
      expect(deleteSpy).toHaveBeenCalledWith(userId);
      expect(deleteRes.message).toBe('Avatar deleted successfully');
    });
  });
});
