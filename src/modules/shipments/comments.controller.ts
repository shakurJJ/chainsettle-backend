import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { ShipmentParticipantGuard } from './guards/shipment-participant.guard';

@ApiTags('shipments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('shipments/:id/comments')
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Post a comment on a shipment (participants only)' })
  create(
    @Param('id') shipmentId: string,
    @Body() dto: CreateCommentDto,
    @CurrentUser() user: any,
  ) {
    return this.commentsService.create(shipmentId, user.sub, user.stellarAddress, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List comments on a shipment (visibility-filtered). Pinned comments sort first.' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAll(
    @Param('id') shipmentId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @CurrentUser() user: any = {},
  ) {
    return this.commentsService.findAll(shipmentId, user.stellarAddress, page, limit);
  }

  /**
   * PATCH /shipments/:id/comments/:commentId/pin
   * Pin a comment so it appears at the top of the thread.
   * Any participant can pin. Max 3 pinned comments per shipment.
   */
  @Patch(':commentId/pin')
  @UseGuards(ShipmentParticipantGuard)
  @ApiOperation({ summary: 'Pin a comment (participants only, max 3 per shipment)' })
  pin(
    @Param('id') shipmentId: string,
    @Param('commentId') commentId: string,
    @CurrentUser() user: any,
  ) {
    return this.commentsService.setPinned(shipmentId, commentId, true, user.sub, user.stellarAddress);
  }

  /**
   * PATCH /shipments/:id/comments/:commentId/unpin
   * Unpin a previously pinned comment.
   * Any participant can unpin.
   */
  @Patch(':commentId/unpin')
  @UseGuards(ShipmentParticipantGuard)
  @ApiOperation({ summary: 'Unpin a comment (participants only)' })
  unpin(
    @Param('id') shipmentId: string,
    @Param('commentId') commentId: string,
    @CurrentUser() user: any,
  ) {
    return this.commentsService.setPinned(shipmentId, commentId, false, user.sub, user.stellarAddress);
  }

  @Delete(':commentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a comment (author or admin)' })
  remove(
    @Param('id') shipmentId: string,
    @Param('commentId') commentId: string,
    @CurrentUser() user: any,
  ) {
    return this.commentsService.remove(shipmentId, commentId, user.sub, user.stellarAddress);
  }
}
