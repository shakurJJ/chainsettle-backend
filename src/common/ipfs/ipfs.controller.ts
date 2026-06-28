import {
  Controller,
  Get,
  Param,
  UseGuards,
  BadRequestException,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IpfsService } from './ipfs.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';

const CID_REGEX = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

@ApiTags('ipfs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ipfs')
export class IpfsController {
  constructor(private readonly ipfs: IpfsService) {}

  @Get(':cid')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Proxy-fetch a file from IPFS by CID (JWT-guarded)' })
  @ApiResponse({ status: 200, description: 'File content with correct Content-Type' })
  @ApiResponse({ status: 400, description: 'Invalid CID format' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded (20 req/min per user)' })
  async getFile(@Param('cid') cid: string, @Res() res: Response) {
    if (!CID_REGEX.test(cid)) {
      throw new BadRequestException(`Invalid CID format: ${cid}`);
    }

    const { buffer, mimeType } = await this.ipfs.getFile(cid);
    res.setHeader('Content-Type', mimeType);
    res.end(buffer);
  }
}
