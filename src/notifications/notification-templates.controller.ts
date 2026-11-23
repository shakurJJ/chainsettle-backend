import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Put,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as Handlebars from 'handlebars';
import { NotificationTemplateOverride } from './notification-template-override.entity';
import { NotificationTemplatesService } from './notification-templates.service';

interface UpdateTemplateDto {
  locale?: string;
  subject?: string;
  body?: string;
}

@Controller('admin/notification-templates')
export class NotificationTemplatesController {
  constructor(
    @InjectRepository(NotificationTemplateOverride)
    private readonly overrides: Repository<NotificationTemplateOverride>,
    private readonly templates: NotificationTemplatesService,
  ) {}

  @Get(':type')
  async get(@Param('type') type: string) {
    const fileTemplate = this.templates.getFileTemplate(type);
    if (!fileTemplate) {
      throw new NotFoundException(`Unknown notification type: ${type}`);
    }

    const overrides = await this.overrides.find({ where: { type } });
    const byLocale: Record<string, { subject: string; body: string }> = {};
    for (const override of overrides) {
      byLocale[override.locale] = {
        subject: override.subject,
        body: override.body,
      };
    }

    return {
      type,
      default: fileTemplate,
      overrides: byLocale,
    };
  }

  @Put(':type')
  async update(@Param('type') type: string, @Body() dto: UpdateTemplateDto) {
    if (!this.templates.getFileTemplate(type)) {
      throw new NotFoundException(`Unknown notification type: ${type}`);
    }

    const locale = dto.locale || 'en';
    const subject = dto.subject ?? '';
    const body = dto.body ?? '';

    this.validateTemplate(subject, 'subject');
    this.validateTemplate(body, 'body');

    let override = await this.overrides.findOne({ where: { type, locale } });
    if (!override) {
      override = this.overrides.create({ type, locale });
    }
    override.subject = subject;
    override.body = body;

    const saved = await this.overrides.save(override);

    return {
      type: saved.type,
      locale: saved.locale,
      subject: saved.subject,
      body: saved.body,
    };
  }

  private validateTemplate(source: string, field: string): void {
    try {
      Handlebars.precompile(source);
    } catch (error) {
      throw new BadRequestException(
        `Invalid Handlebars syntax in ${field}: ${(error as Error).message}`,
      );
    }
  }
}
