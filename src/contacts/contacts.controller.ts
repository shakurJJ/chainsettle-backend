import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { parse } from 'csv-parse/sync';
import { ContactsService } from './contacts.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

const MAX_IMPORT_ROWS = 1000;
const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

interface ImportRowResult {
  row: number;
  status: 'imported' | 'skipped' | 'invalid';
  reason?: string;
  stellarAddress?: string;
}

@Controller('users/me/contacts')
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @Get()
  findAll(@CurrentUser() user: User) {
    return this.contactsService.findAllForUser(user.id);
  }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateContactDto) {
    return this.contactsService.create(user.id, dto);
  }

  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  async import(
    @CurrentUser() user: User,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Body('csv') csv: string | undefined,
  ) {
    const raw = file?.buffer?.toString('utf8') ?? csv;
    if (!raw || !raw.trim()) {
      throw new BadRequestException('CSV content is required');
    }

    let records: Record<string, string>[];
    try {
      records = parse(raw, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch (err) {
      throw new BadRequestException(
        `Invalid CSV: ${(err as Error).message}`,
      );
    }

    if (records.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException(
        `CSV exceeds maximum of ${MAX_IMPORT_ROWS} rows`,
      );
    }

    const existing = await this.contactsService.findAllForUser(user.id);
    const seen = new Set(
      existing.map((c) => c.stellarAddress?.toUpperCase()).filter(Boolean),
    );

    const results: ImportRowResult[] = [];
    let imported = 0;
    let skipped = 0;
    let invalid = 0;

    for (let i = 0; i < records.length; i++) {
      const rowNumber = i + 2; // account for header row
      const record = records[i];
      const name = (record.name ?? '').trim();
      const stellarAddress = (record.stellarAddress ?? '').trim();
      const email = (record.email ?? '').trim() || undefined;
      const notes = (record.notes ?? '').trim() || undefined;

      if (!name) {
        invalid++;
        results.push({ row: rowNumber, status: 'invalid', reason: 'Missing name' });
        continue;
      }

      if (!STELLAR_ADDRESS_REGEX.test(stellarAddress)) {
        invalid++;
        results.push({
          row: rowNumber,
          status: 'invalid',
          reason: 'Invalid Stellar address',
          stellarAddress,
        });
        continue;
      }

      const key = stellarAddress.toUpperCase();
      if (seen.has(key)) {
        skipped++;
        results.push({
          row: rowNumber,
          status: 'skipped',
          reason: 'Duplicate contact',
          stellarAddress,
        });
        continue;
      }

      try {
        await this.contactsService.create(user.id, {
          name,
          stellarAddress,
          email,
          notes,
        } as CreateContactDto);
        seen.add(key);
        imported++;
        results.push({ row: rowNumber, status: 'imported', stellarAddress });
      } catch (err) {
        invalid++;
        results.push({
          row: rowNumber,
          status: 'invalid',
          reason: (err as Error).message,
          stellarAddress,
        });
      }
    }

    return {
      total: records.length,
      imported,
      skipped,
      invalid,
      results,
    };
  }

  @Put(':id')
  update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateContactDto,
  ) {
    return this.contactsService.update(user.id, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: User, @Param('id') id: string) {
    return this.contactsService.remove(user.id, id);
  }
}
