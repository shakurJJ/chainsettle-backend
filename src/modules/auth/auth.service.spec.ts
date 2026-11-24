import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Keypair } from '@stellar/stellar-sdk';
import { AuthService } from './auth.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { SessionService } from './session.service';

describe('AuthService', () => {
    let authService: AuthService;
    let mockRedis: jest.Mocked<RedisService>;
    let mockPrisma: Partial<PrismaService>;
    let mockJwt: jest.Mocked<JwtService>;
    let mockSessions: jest.Mocked<SessionService>;

    beforeEach(() => {
        mockRedis = {
            get: jest.fn(),
            set: jest.fn(),
            setPx: jest.fn(),
            del: jest.fn(),
        } as unknown as jest.Mocked<RedisService>;


        mockPrisma = {
            user: {
                upsert: jest.fn(),
            },
        } as unknown as Partial<PrismaService>;

        mockJwt = {
            sign: jest.fn().mockReturnValue('mock-access-token'),
        } as unknown as jest.Mocked<JwtService>;

        mockSessions = {
            createSession: jest.fn().mockResolvedValue('mock-session-id'),
        } as unknown as jest.Mocked<SessionService>;

        authService = new AuthService(
            mockPrisma as PrismaService,
            mockJwt as JwtService,
            mockRedis as RedisService,
            undefined as any,
            undefined as any,
            undefined as any,
            mockSessions,
        );
    });

    it('authenticates when the signature is valid', async () => {
        const keypair = Keypair.random();
        const stellarAddress = keypair.publicKey();
        const nonce = `chainsettle:${stellarAddress}:test`;
        const signature = keypair.sign(Buffer.from(nonce)).toString('base64');


        mockRedis.get.mockResolvedValue(nonce);
        mockRedis.del.mockResolvedValue(undefined);
        (mockPrisma.user.upsert as jest.Mock).mockResolvedValue({
            id: 1,
            stellarAddress,
            role: 'user',
        });

        const result = await authService.login({
            stellarAddress,
            signedNonce: nonce,
            signature,
        } as any);

        expect(result).toEqual({
            accessToken: 'mock-access-token',
            user: { id: 1, stellarAddress, role: 'user' },
        });
        expect(mockRedis.del).toHaveBeenCalledWith(`chainsettle:nonce:${stellarAddress}`);
        expect(mockSessions.createSession).toHaveBeenCalledWith(1, expect.any(String), expect.any(String));
    });

    it('rejects invalid signatures with 401', async () => {
        const keypair = Keypair.random();
        const stellarAddress = keypair.publicKey();
        const nonce = `chainsettle:${stellarAddress}:test`;
        const invalidSignature = Keypair.random()

            .sign(Buffer.from(nonce))
            .toString('base64');

        mockRedis.get.mockResolvedValue(nonce);

        const invalidCall = authService.login({
            stellarAddress,
            signedNonce: nonce,
            signature: invalidSignature,
        } as any);

        await expect(invalidCall).rejects.toThrow(UnauthorizedException);
        await expect(invalidCall).rejects.toThrow('Signature verification failed');
        expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('rejects expired or missing nonce before verification', async () => {
        const keypair = Keypair.random();
        const stellarAddress = keypair.publicKey();
        const nonce = `chainsettle:${stellarAddress}:test`;
        const signature = keypair.sign(Buffer.from(nonce)).toString('base64');


        mockRedis.get.mockResolvedValue(null);

        const expiredCall = authService.login({
            stellarAddress,
            signedNonce: nonce,
            signature,
        } as any);

        await expect(expiredCall).rejects.toThrow(UnauthorizedException);
        await expect(expiredCall).rejects.toThrow('Nonce expired or not found. Request a new one.');
        expect(mockRedis.del).not.toHaveBeenCalled();
    });
});
