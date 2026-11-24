import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as Handlebars from 'handlebars';
import * as fs from 'fs';
import * as path from 'path';
import { NotificationTemplateOverride } from './entities/notification-template-override.entity';

export interface NotificationTemplate {
  type: string;
  locale: string;
  subject: string;
  body: string;
  source: 'override' | 'file';
}

export interface SaveNotificationTemplateDto {
  locale?: string;
  subject: string;
  body: string;
}

const DEFAULT_LOCALE = 'en';
const TEMPLATES_DIR = path.join(__dirname, 'templates');

@Injectable()
  export class NotificationTemplatesService {
  private readonly logger = new Logger(NotificationTemplatesService.name);

  constructor(
    @InjectRepository(NotificationTemplateOverride)
    private readonly overrideRepository: Repository<NotificationTemplateOverride>,
  ) {}

  async getTemplate(type: string, locale: string = DEFAULT_LOCALE): Promise<NotificationTemplate> {
    const override = await this.overrideRepository.findOne({ where: { type, locale } });
    if (override) {
      return { type, locale, subject: override.subject, body: override.body, source: 'override' };
    }

    const fileTemplate = this.loadFileTemplate(type, locale);
    if (!fileTemplate) {
      throw new NotFoundException(`No notification template found for type "${type}" and locale "${locale}"`);
    }

    return { type, locale, subject: fileTemplate.subject, body: fileTemplate.body, source: 'file' };
  }

  async saveTemplate(
    type: string,
    dto: SaveNotificationTemplateDto,
    actorId?: string,
  ): Promise<NotificationTemplate> {
    const locale = dto.locale || DEFAULT_LOCALE;

    this.validateTemplate(dto.subject, 'subject');
    this.validateTemplate(dto.body, 'body');

    let override = await this.overrideRepository.findOne({ where: { type, locale } });
    if (!override) {
      override = this.overrideRepository.create({ type, locale });
    }

    override.subject = dto.subject;
    override.body = dto.body;
    override.updatedBy = actorId ?? null;

    const saved = await this.overrideRepository.save(override);

    this.logger.log(
      `Notification template override saved for type="${type}" locale="${locale}" by actor="${actorId ?? 'unknown'}"`,
    );

    return { type, locale, subject: saved.subject, body: saved.body, source: 'override' };
  }

  private validateTemplate(template: string, field: string): void {
    try {
      Handlebars.precompile(template);
    } catch (error) {
      throw new BadRequestException(
        `Invalid Handlebars syntax in ${field}: ${(error as Error).message}`,
      );
    }
  }

  private loadFileTemplate(
    type: string,
    locale: string,
  ): { subject: string; body: string } | null {
    const candidates = [
      path.join(TEMPLATES_DIR, locale, `${type}.hbs`),
      path.join(TEMPLATES_DIR, `${type}.${locale}.hbs`),
      path.join(TEMPLATES_DIR, `${type}.hbs`),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, 'utf8');
        return this.parseFileTemplate(raw);
      }
    }

    return null;
  }

  private parseFileTemplate(raw: string): { subject: string; body: string } {
    const subjectMatch = raw.match(/^\s*\{\{!--\s*subject:\s*([\s\S]*?)--\}\}/);
    if (subjectMatch) {
      return {
        subject: subjectMatch[1].trim(),
        body: raw.slice(subjectMatch[0].length).trim(),
      };
    }

    return { subject: '', body: raw.trim() };
  }
}
