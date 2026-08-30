import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { ShipmentTemplatesService } from './shipment-templates.service';
import {
  CreateShipmentTemplateDto,
  UpdateShipmentTemplateDto,
  UpdateTemplateVisibilityDto,
} from './dto/create-shipment-template.dto';
import { CreateTemplateFromShipmentDto } from './dto/create-template-from-shipment.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ShipmentParticipantGuard } from '../shipments/guards/shipment-participant.guard';

@ApiTags('shipment-templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('shipment-templates')
export class ShipmentTemplatesController {
  constructor(private readonly templatesService: ShipmentTemplatesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new shipment template' })
  @ApiResponse({ status: 201, description: 'Template created successfully' })
  create(
    @Body() dto: CreateShipmentTemplateDto,
    @CurrentUser() user: any,
  ) {
    return this.templatesService.create(dto, user.id);
  }

  @Post('from-shipment/:id')
  @UseGuards(ShipmentParticipantGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a shipment template from an existing shipment (buyer only)' })
  @ApiResponse({ status: 201, description: 'Template created from shipment' })
  @ApiResponse({ status: 403, description: 'Not a shipment participant, or not the buyer' })
  @ApiResponse({ status: 404, description: 'Shipment not found' })
  createFromShipment(
    @Param('id') shipmentId: string,
    @Body() dto: CreateTemplateFromShipmentDto,
    @CurrentUser() user: any,
  ) {
    return this.templatesService.createFromShipment(user.id, user.stellarAddress, shipmentId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List templates (own + public)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAll(
    @CurrentUser() user: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.templatesService.findAll(user.id, page, limit);
  }

  @Get('mine')
  @ApiOperation({ summary: "List the authenticated user's own templates (public + private)" })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findMine(
    @CurrentUser() user: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.templatesService.findMine(user.id, page, limit);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a template by ID' })
  @ApiResponse({ status: 200, description: 'Template found' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  findOne(@Param('id') id: string) {
    return this.templatesService.findOne(id);
  }

  @Get(':id/preview')
  @ApiOperation({ summary: 'Preview shipment creation from a template' })
  @ApiResponse({ status: 200, description: 'Resolved preview of the template' })
  @ApiResponse({ status: 403, description: 'Private template — owner only' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  preview(@Param('id') id: string, @CurrentUser() user: any) {
    return this.templatesService.preview(id, user.id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a template (owner only)' })
  @ApiResponse({ status: 200, description: 'Template updated successfully' })
  @ApiResponse({ status: 403, description: 'Only owner can update' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateShipmentTemplateDto,
    @CurrentUser() user: any,
  ) {
    return this.templatesService.update(id, user.id, dto);
  }

  @Patch(':id/visibility')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Toggle a template public/private (owner only)' })
  @ApiResponse({ status: 200, description: 'Visibility updated successfully' })
  @ApiResponse({ status: 403, description: 'Only owner can change visibility' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  updateVisibility(
    @Param('id') id: string,
    @Body() dto: UpdateTemplateVisibilityDto,
    @CurrentUser() user: any,
  ) {
    return this.templatesService.updateVisibility(id, user.id, user.stellarAddress, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a template (owner only)' })
  @ApiResponse({ status: 200, description: 'Template deleted successfully' })
  @ApiResponse({ status: 403, description: 'Only owner can delete' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  delete(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.templatesService.delete(id, user.id);
  }
}
