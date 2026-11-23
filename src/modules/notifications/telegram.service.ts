import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationType, Prisma } from '@prisma/client';
import axios, { AxiosError } from 'axios';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number; type: string };
  };
};

type TelegramResponse<T> = {
  ok: boolean;
  result: T;
  description?: string;
};

const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_POLLER_LOCK = 'telegram:updates:poller-lock';
const TELEGRAM_UPDATE_OFFSET = 'telegram:updates:offset';
const TELEGRAM_POLLER_LOCK_TTL_MS = 120_000;
const TELEGRAM_DEFAULT_TYPES = new Set<NotificationType>([
  NotificationType.DISPUTE_RAISED,
  NotificationType.DISPUTE_RESOLVED,
  NotificationType.PAYMENT_RELEASED,
  NotificationType.MILESTONE_OVERDUE,
  NotificationType.SYSTEM_ALERT,
]);

function defaultPreferences() {
  return Object.values(NotificationType).reduce(
    (result, type) => ({
      ...result,
      [type]: {
        inApp: true,
        email: true,
        slack: true,
        sms: false,
        discord: false,
        push: true,
        telegram: TELEGRAM_DEFAULT_TYPES.has(type),
      },
    }),
    {},
  );
}

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly enabled: boolean;
  private readonly botToken: string;
  private botUsername: string | null = null;
  private polling = false;
  private updateOffset = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.enabled = this.config.get<boolean>('TELEGRAM_ENABLED', false);
    this.botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN', '');
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;
    if (!this.botToken) {
      throw new Error(
        'TELEGRAM_BOT_TOKEN is required when TELEGRAM_ENABLED is true',
      );
    }

    try {
      const bot = await this.callApi<{ username: string }>('getMe');
      if (!bot.username)
        throw new Error(
          'Telegram getMe response did not include a bot username',
        );
      this.botUsername = bot.username;
    } catch (error) {
      throw new Error(
        `Telegram bot startup validation failed: ${(error as Error).message}`,
      );
    }

    this.polling = true;
    void this.pollUpdates();
    this.logger.log(
      `Telegram notification channel enabled for @${this.botUsername}`,
    );
  }

  onModuleDestroy(): void {
    this.polling = false;
  }

  async createLink(userId: string): Promise<{ link: string; expiresAt: Date }> {
    this.assertEnabled();
    if (!this.botUsername) {
      throw new ServiceUnavailableException('Telegram bot is not ready');
    }

    const code = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
    await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: {
        userId,
        preferences: defaultPreferences(),
        telegramLinkCodeHash: this.hashCode(code),
        telegramLinkExpiresAt: expiresAt,
      },
      update: {
        telegramLinkCodeHash: this.hashCode(code),
        telegramLinkExpiresAt: expiresAt,
      },
    });

    return {
      link: `https://t.me/${this.botUsername}?start=${code}`,
      expiresAt,
    };
  }

  async unlink(userId: string): Promise<{ unlinked: boolean }> {
    await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, preferences: {} },
      update: {
        telegramChatId: null,
        telegramLinkCodeHash: null,
        telegramLinkExpiresAt: null,
      },
    });
    return { unlinked: true };
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.callApi('sendMessage', {
        chat_id: chatId,
        text: text.slice(0, 4096),
        disable_web_page_preview: true,
      });
    } catch (error) {
      this.logger.error(
        `Telegram notification delivery failed: ${(error as Error).message}`,
      );
    }
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new ServiceUnavailableException(
        'Telegram notifications are not enabled',
      );
    }
  }

  private hashCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  private async pollUpdates(): Promise<void> {
    while (this.polling) {
      const lockToken = randomUUID();
      let lockAcquired = false;
      try {
        lockAcquired = await this.redis.acquireLock(
          TELEGRAM_POLLER_LOCK,
          lockToken,
          TELEGRAM_POLLER_LOCK_TTL_MS,
        );
        if (!lockAcquired) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          continue;
        }

        const storedOffset = await this.redis.get(TELEGRAM_UPDATE_OFFSET);
        this.updateOffset = storedOffset ? Number(storedOffset) : 0;
        const updates = await this.callApi<TelegramUpdate[]>(
          'getUpdates',
          {
            offset: this.updateOffset,
            timeout: 25,
            limit: 10,
            allowed_updates: ['message'],
          },
          35_000,
        );
        for (const update of updates) {
          await this.handleUpdate(update);
          this.updateOffset = update.update_id + 1;
          await this.redis.set(
            TELEGRAM_UPDATE_OFFSET,
            String(this.updateOffset),
          );
        }
      } catch (error) {
        if (this.polling) {
          this.logger.error(
            `Telegram update polling failed: ${(error as Error).message}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      } finally {
        if (lockAcquired) {
          try {
            await this.redis.releaseLock(TELEGRAM_POLLER_LOCK, lockToken);
          } catch (error) {
            this.logger.error(
              `Failed to release Telegram poller lock: ${(error as Error).message}`,
            );
          }
        }
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const text = message?.text?.trim();
    if (!message || !text?.startsWith('/start')) return;

    const [command, code, ...extra] = text.split(/\s+/);
    if (command !== '/start' && command !== '/start@' + this.botUsername)
      return;
    if (!code || extra.length || !/^[A-Za-z0-9_-]{32,64}$/.test(code)) {
      await this.sendMessage(
        String(message.chat.id),
        'To link your account, generate a fresh link from ChainSettle notifications settings and open it here.',
      );
      return;
    }

    if (message.chat.type !== 'private') {
      await this.sendMessage(
        String(message.chat.id),
        'Please link your account in a private chat with this bot.',
      );
      return;
    }

    try {
      const result = await this.prisma.notificationPreference.updateMany({
        where: {
          telegramLinkCodeHash: this.hashCode(code),
          telegramLinkExpiresAt: { gt: new Date() },
        },
        data: {
          telegramChatId: String(message.chat.id),
          telegramLinkCodeHash: null,
          telegramLinkExpiresAt: null,
        },
      });
      await this.sendMessage(
        String(message.chat.id),
        result.count
          ? 'Your ChainSettle account is now linked. You will receive critical notifications here.'
          : 'This linking code is invalid or expired. Generate a new link in ChainSettle.',
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        await this.sendMessage(
          String(message.chat.id),
          'This Telegram account is already linked to another ChainSettle account.',
        );
        return;
      }
      throw error;
    }
  }

  private async callApi<T = void>(
    method: string,
    params?: Record<string, unknown>,
    timeout = 10_000,
  ): Promise<T> {
    try {
      const response = await axios.post<TelegramResponse<T>>(
        `https://api.telegram.org/bot${this.botToken}/${method}`,
        params ?? {},
        { timeout },
      );
      if (!response.data.ok) {
        throw new Error(
          response.data.description ?? `Telegram ${method} request failed`,
        );
      }
      return response.data.result;
    } catch (error) {
      const axiosError = error as AxiosError<TelegramResponse<unknown>>;
      const description =
        axiosError.response?.data?.description ??
        axiosError.code ??
        `Telegram ${method} request failed`;
      throw new BadRequestException(description);
    }
  }
}
