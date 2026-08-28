import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_LOCALE = 'en';
export const SUPPORTED_LOCALES = ['en', 'es'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

type LocaleTree = Record<string, unknown>;

@Injectable()
export class I18nService {
  private readonly logger = new Logger(I18nService.name);
  private readonly catalogs = new Map<string, LocaleTree>();

  constructor() {
    this.loadLocales();
  }

  /**
   * Resolve a BCP-47 Accept-Language value to a supported locale.
   * Falls back to English when missing or unsupported.
   */
  resolveLocale(acceptLanguage?: string | null): SupportedLocale {
    if (!acceptLanguage) return DEFAULT_LOCALE;

    const candidates = acceptLanguage
      .split(',')
      .map((part) => {
        const [tag, ...params] = part.trim().split(';');
        const qParam = params.find((p) => p.trim().startsWith('q='));
        const q = qParam ? parseFloat(qParam.split('=')[1]) : 1;
        return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 1 };
      })
      .sort((a, b) => b.q - a.q);

    for (const { tag } of candidates) {
      const primary = tag.split('-')[0] as SupportedLocale;
      if (SUPPORTED_LOCALES.includes(primary)) {
        return primary;
      }
    }

    return DEFAULT_LOCALE;
  }

  /**
   * Translate a dotted key (e.g. `errors.ONLY_BUYER_MAY_CONFIRM`).
   * Falls back to English, then to the key itself.
   */
  t(
    key: string,
    locale: string = DEFAULT_LOCALE,
    args: Record<string, string | number> = {},
  ): string {
    const raw =
      this.lookup(locale, key) ??
      this.lookup(DEFAULT_LOCALE, key) ??
      key;

    if (typeof raw !== 'string') {
      return key;
    }

    return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
      args[name] !== undefined ? String(args[name]) : `{${name}}`,
    );
  }

  /**
   * Translate a known English error string (or i18n key payload) for the response.
   * Supports:
   * - Plain English strings that match an `errors.*` English value
   * - Objects shaped like `{ i18nKey: 'errors.FOO', args?: {...} }`
   */
  translateErrorMessage(message: unknown, locale: string): unknown {
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      const payload = message as { i18nKey?: string; args?: Record<string, string | number>; message?: unknown };
      if (payload.i18nKey) {
        return this.t(payload.i18nKey, locale, payload.args ?? {});
      }
      if (Array.isArray(payload.message)) {
        return payload.message.map((m) => this.translateErrorMessage(m, locale));
      }
      if (typeof payload.message === 'string') {
        return this.translateErrorMessage(payload.message, locale);
      }
      return message;
    }

    if (Array.isArray(message)) {
      return message.map((m) => this.translateErrorMessage(m, locale));
    }

    if (typeof message !== 'string') {
      return message;
    }

    // Direct key usage: "errors.ONLY_BUYER_MAY_CONFIRM"
    if (message.startsWith('errors.') || message.startsWith('email.')) {
      return this.t(message, locale);
    }

    const key = this.findErrorKeyByEnglish(message);
    if (key) {
      const args = this.extractArgsFromEnglish(message, key);
      return this.t(`errors.${key}`, locale, args);
    }

    return message;
  }

  getEmailCopy(type: string, locale: string): Record<string, string> | null {
    const value = this.lookup(locale, `email.${type}`) ?? this.lookup(DEFAULT_LOCALE, `email.${type}`);
    if (!value || typeof value !== 'object') return null;
    return value as Record<string, string>;
  }

  private loadLocales() {
    const localesRoot = path.join(__dirname, 'locales');
    for (const locale of SUPPORTED_LOCALES) {
      const filePath = path.join(localesRoot, locale, 'common.json');
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        this.catalogs.set(locale, JSON.parse(raw) as LocaleTree);
      } catch (error) {
        this.logger.error(`Failed to load locale ${locale} from ${filePath}`, (error as Error).message);
      }
    }
  }

  private lookup(locale: string, key: string): unknown {
    const catalog = this.catalogs.get(locale) ?? this.catalogs.get(DEFAULT_LOCALE);
    if (!catalog) return undefined;

    return key.split('.').reduce<unknown>((node, part) => {
      if (node && typeof node === 'object' && part in (node as LocaleTree)) {
        return (node as LocaleTree)[part];
      }
      return undefined;
    }, catalog);
  }

  private findErrorKeyByEnglish(englishMessage: string): string | null {
    const enErrors = this.lookup(DEFAULT_LOCALE, 'errors');
    if (!enErrors || typeof enErrors !== 'object') return null;

    for (const [key, template] of Object.entries(enErrors as Record<string, string>)) {
      if (typeof template !== 'string') continue;
      if (template === englishMessage) return key;

      const pattern = template.replace(/\{(\w+)\}/g, '(.+)');
      const regex = new RegExp(`^${pattern}$`);
      if (regex.test(englishMessage)) return key;
    }

    return null;
  }

  private extractArgsFromEnglish(
    englishMessage: string,
    key: string,
  ): Record<string, string> {
    const template = this.lookup(DEFAULT_LOCALE, `errors.${key}`);
    if (typeof template !== 'string') return {};

    const names = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    if (names.length === 0) return {};

    const pattern = template.replace(/\{(\w+)\}/g, '(.+)');
    const match = englishMessage.match(new RegExp(`^${pattern}$`));
    if (!match) return {};

    const args: Record<string, string> = {};
    names.forEach((name, i) => {
      args[name] = match[i + 1];
    });
    return args;
  }
}
