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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { RecurringSchedulesService } from './recurring-schedules.service';
import { CreateRecurringScheduleDto, UpdateRecurringScheduleDto } from './dto/recurring-schedule.dto';

@ApiTags('recurring-schedules')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('recurring-schedules')
export class RecurringSchedulesController {
  constructor(private readonly schedules: RecurringSchedulesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a recurring draft-shipment schedule from a template' })
  @ApiResponse({ status: 400, description: 'Invalid interval, amount, start time, or incomplete template' })
  create(@Body() dto: CreateRecurringScheduleDto, @CurrentUser() user: AuthenticatedUser) {
    return this.schedules.create(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: "List the caller's recurring schedules" })
  findMine(@CurrentUser() user: AuthenticatedUser) {
    return this.schedules.findMine(user.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update or pause (active=false) a recurring schedule' })
  update(@Param('id') id: string, @Body() dto: UpdateRecurringScheduleDto, @CurrentUser() user: AuthenticatedUser) {
    return this.schedules.update(id, user.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a recurring schedule' })
  async remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.schedules.remove(id, user.id);
  }
}
