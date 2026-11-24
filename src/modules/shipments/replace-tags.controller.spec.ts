import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Response } from 'express';
import { ShipmentsController } from './shipments.controller';
import { ShipmentsService } from './shipments.service';
import { ShipmentApprovalsService } from './shipment-approvals.service';
import { SavedFiltersService } from './saved-filters.service';
import { RedisService } from '../../common/redis/redis.service';
import { ShipmentRemindersService } from './shipment-reminders.service';
import { AuthService } from '../auth/auth.service';
import { ReplaceTagsDto } from './dto/tag.dto';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

describe('ShipmentsController — PUT /shipments/:id/tags', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const metadata: ArgumentMetadata = { type: 'body', metatype: ReplaceTagsDto, data: '' };
  const validate = (body: unknown) => pipe.transform(body, metadata);

  describe('ReplaceTagsDto validation', () => {
    it('accepts a valid tag list', async () => {
      const dto = await validate({ tags: ['urgent', 'fragile'] });
      expect(dto).toBeInstanceOf(ReplaceTagsDto);
      expect(dto.tags).toEqual(['urgent', 'fragile']);
    });

    it('accepts an empty tag list (clears tags)', async () => {
      await expect(validate({ tags: [] })).resolves.toEqual({ tags: [] });
    });

    it.each([
      ['missing tags', {}],
      ['a non-array string', { tags: 'x' }],
      ['non-string elements', { tags: [1, {}] }],
      ['an empty string tag', { tags: [''] }],
      ['a tag with spaces', { tags: ['two words'] }],
      ['a tag over 30 chars', { tags: ['a'.repeat(31)] }],
      ['more than 20 tags', { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }],
      ['10,000 tags', { tags: Array.from({ length: 10_000 }, (_, i) => `t${i}`) }],
    ])('rejects %s with 400', async (_label, body) => {
      await expect(validate(body)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('replaceTags handler', () => {
    it('passes the validated tags to the service and sets the ETag', async () => {
      const service = {
        replaceTags: jest.fn().mockResolvedValue({ id: 'ship-1', tags: ['urgent'] }),
        getEtag: jest.fn().mockResolvedValue('"etag-1"'),
      };
      const controller = new ShipmentsController(
        service as unknown as ShipmentsService,
        {} as ShipmentApprovalsService,
        {} as SavedFiltersService,
        {} as RedisService,
        {} as ShipmentRemindersService,
        {} as AuthService,
      );
      const res = { setHeader: jest.fn() } as unknown as Response;
      const user: AuthenticatedUser = { id: 'user-1', stellarAddress: 'GABC', role: UserRole.BUYER };

      const dto = await validate({ tags: ['urgent'] });
      const result = await controller.replaceTags('ship-1', dto, user, res, '"etag-0"');

      expect(service.replaceTags).toHaveBeenCalledWith('ship-1', ['urgent'], 'GABC', 'user-1', '"etag-0"');
      expect(res.setHeader).toHaveBeenCalledWith('ETag', '"etag-1"');
      expect(result).toEqual({ id: 'ship-1', tags: ['urgent'] });
    });
  });
});
