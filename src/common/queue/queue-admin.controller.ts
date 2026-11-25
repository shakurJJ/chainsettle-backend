import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { Roles } from '../decorators/roles.decorator';
import { isQueueName } from './queue.constants';
import { isQueueState, QUEUE_STATES, QueueService } from './queue.service';

/**
 * Admin view of the BullMQ background queues (#661): depth per state, the
 * effective concurrency/retry policy, and recent jobs (for example failed
 * ones, to see why and when the next retry happens).
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin/queues')
export class QueueAdminController {
  constructor(private readonly queues: QueueService) {}

  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: '[Admin] Queue depth and retry policy for every background queue',
    description:
      'Returns counts by state (waiting, active, delayed, failed, completed) plus the configured concurrency and retry policy.',
  })
  @ApiResponse({ status: 200, description: 'Queue depth and policies' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  async getQueues() {
    return {
      enabled: this.queues.isEnabled(),
      queues: await this.queues.getStats(),
    };
  }

  @Get(':name/jobs')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: '[Admin] Recent jobs in a background queue',
    description: `Queue: ${['webhooks', 'emails', 'exports'].join(', ')}. State: ${QUEUE_STATES.join(', ')}.`,
  })
  @ApiResponse({
    status: 200,
    description: 'Recent jobs in the requested state',
  })
  @ApiResponse({ status: 400, description: 'Unknown queue or state' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  async getJobs(
    @Param('name') name: string,
    @Query('state') state: string = 'failed',
    @Query('limit') limit: string = '20',
  ) {
    if (!isQueueName(name)) {
      throw new BadRequestException(`Unknown queue '${name}'`);
    }
    if (!isQueueState(state)) {
      throw new BadRequestException(
        `state must be one of: ${QUEUE_STATES.join(', ')}`,
      );
    }

    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    return {
      queue: name,
      state,
      jobs: await this.queues.listJobs(name, [state], parsedLimit),
    };
  }
}
