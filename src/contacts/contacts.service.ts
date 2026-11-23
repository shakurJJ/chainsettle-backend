import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { parse } from 'csv-parse/sync';
import { Contact } from './entities/contact.entity';
import { CreateContactDto } from './dto/create-contact.dto';
import { isValidStellarAddress } from '../common/utils/stellar.util';

export interface ContactImportRowResult {
  row: number;
  status: 'imported' | 'skipped' | 'invalid';
  reason?: string;
  contact?: Contact;
}

export interface ContactImportReport {
  total: number;
  imported: number;
  skipped: number;
  invalid: number;
  results: ContactImportRowResult[];
}

const MAX_IMPORT_ROWS = 1000;

@Injectable()
export class ContactsService {
  constructor(
    @InjectRepository(Contact)
    private readonly contactsRepository: Repository<Contact>,
  ) {}

  async findAllForUser(userId: string): Promise<Contact[]> {
    return this.contactsRepository.find({ where: { userId } });
  }

  async create(userId: string, dto: CreateContactDto): Promise<Contact> {
    const contact = this.contactsRepository.create({ ...dto, userId });
    return this.contactsRepository.save(contact);
  }

  async importFromCsv(userId: string, csv: string): Promise<ContactImportReport> {
    let records: Record<string, string>[];
    try {
      records = parse(csv, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch (err) {
      throw new BadRequestException('Invalid CSV format');
    }

    if (records.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException(
        `CSV import is limited to ${MAX_IMPORT_ROWS} rows`,
      );
    }

    const existing = await this.contactsRepository.find({ where: { userId } });
    const seenAddresses = new Set(
      existing.map((c) => c.stellarAddress).filter(Boolean),
    );

    const results: ContactImportRowResult[] = [];
    let imported = 0;
    let skipped = 0;
    let invalid = 0;

    for (let i = 0; i < records.length; i++) {
      const rowNumber = i + 1;
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

      if (!stellarAddress || !isValidStellarAddress(stellarAddress)) {
        invalid++;
        results.push({
          row: rowNumber,
          status: 'invalid',
          reason: 'Invalid Stellar address',
        });
        continue;
      }

      if (seenAddresses.has(stellarAddress)) {
        skipped++;
        results.push({
          row: rowNumber,
          status: 'skipped',
          reason: 'Duplicate stellarAddress',
        });
        continue;
      }

      const contact = this.contactsRepository.create({
        userId,
        name,
        stellarAddress,
        email,
        notes,
      });
      const saved = await this.contactsRepository.save(contact);
      seenAddresses.add(stellarAddress);
      imported++;
      results.push({ row: rowNumber, status: 'imported', contact: saved });
    }

    return {
      total: records.length,
      imported,
      skipped,
      invalid,
      results,
    };
  }
}
