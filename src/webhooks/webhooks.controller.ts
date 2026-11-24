import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { WebhooksService } from './webhooks.service';
import { CreateWebhookDto } from './dto/create-webhook.dto';
import { UpdateWebhookDto } from './dto/update-webhook.dto';

@Controller('webhooks')
@UseGuards(JwtAuthGuard)
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.webhooksService.listForUser(userId);
  }

  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateWebhookDto) {
    return this.webhooksService.createForUser(userId, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateWebhookDto,
  ) {
    return this.webhooksService.updateForUser(userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.webhooksService.removeForUser(userId, id);
  }
}

@Controller('organizations/:organizationId/webhooks')
@UseGuards(JwtAuthGuard)
export class OrganizationWebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Get()
  list(
    @CurrentUser('id') userId: string,
    @Param('organizationId') organizationId: string,
  ) {
    return this.webhooksService.listForOrganization(userId, organizationId);
  }

  @Post()
  create(
    @CurrentUser('id') userId: string,
    @Param('organizationId') organizationId: string,
    @Body() dto: CreateWebhookDto,
  ) {
    return this.webhooksService.createForOrganization(
      userId,
      organizationId,
      dto,
    );
  }

  @Patch(':id')
  update(
    @CurrentUser('id') userId: string,
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @Body() dto: UpdateWebhookDto,
  ) {
    return this.webhooksService.updateForOrganization(
      userId,
      organizationId,
      id,
      dto,
    );
  }

  @Delete(':id')
  remove(
    @CurrentUser('id') userId: string,
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
  ) {
    return this.webhooksService.removeForOrganization(
      userId,
      organizationId,
      id,
    );
  }
}
