import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { TelegramService } from './telegram.service';

describe('TelegramService', () => {
  let prisma: {
    notificationPreference: {
      upsert: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let service: TelegramService;

  beforeEach(() => {
    prisma = {
      notificationPreference: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service = new TelegramService(
      prisma as unknown as PrismaService,
      {
        get: jest.fn((key: string, defaultValue?: unknown) =>
          key === 'TELEGRAM_ENABLED'
            ? true
            : key === 'TELEGRAM_BOT_TOKEN'
              ? '123:token'
              : defaultValue,
        ),
      } as unknown as ConfigService,
      {} as RedisService,
    );
    (service as any).botUsername = 'chainsettle_bot';
    jest.clearAllMocks();
  });

  afterEach(() => jest.restoreAllMocks());

  it('creates a short-lived deep link and stores only a hash of the code', async () => {
    const result = await service.createLink('user-1');
    const code = new URL(result.link).searchParams.get('start');
    const write = prisma.notificationPreference.upsert.mock.calls[0][0];

    expect(result.link).toMatch(/^https:\/\/t\.me\/chainsettle_bot\?start=/);
    expect(code).toBeTruthy();
    expect(write.create.telegramLinkCodeHash).not.toBe(code);
    expect(write.create.telegramLinkExpiresAt.getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(write.create.telegramLinkExpiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 10 * 60 * 1000,
    );
  });

  it('accepts a valid private /start code once and stores the Telegram chat id', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { ok: true, result: {} },
    } as never);

    await (service as any).handleUpdate({
      update_id: 7,
      message: {
        text: '/start ' + 'a'.repeat(43),
        chat: { id: 12345, type: 'private' },
      },
    });

    expect(prisma.notificationPreference.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          telegramLinkCodeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          telegramLinkExpiresAt: { gt: expect.any(Date) },
        }),
        data: expect.objectContaining({
          telegramChatId: '12345',
          telegramLinkCodeHash: null,
          telegramLinkExpiresAt: null,
        }),
      }),
    );
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining('/sendMessage'),
      expect.objectContaining({ chat_id: '12345' }),
      expect.any(Object),
    );
  });

  it('unlinks the Telegram chat and any pending link code', async () => {
    await service.unlink('user-1');

    expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      create: expect.objectContaining({ userId: 'user-1' }),
      update: {
        telegramChatId: null,
        telegramLinkCodeHash: null,
        telegramLinkExpiresAt: null,
      },
    });
  });

  it('fails startup when Telegram is enabled but the bot token is invalid', async () => {
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('Unauthorized'));

    await expect(service.onModuleInit()).rejects.toThrow(
      'Telegram bot startup validation failed',
    );
  });
});
