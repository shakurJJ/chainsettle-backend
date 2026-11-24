import { readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException, UnsupportedMediaTypeException } from '@nestjs/common';
import axios from 'axios';
import { IpfsService } from './ipfs.service';
import { mimeTypesMatch, sniffMimeType } from './file-signature.util';

jest.mock('axios');
const mockedPost = axios.post as jest.Mock;

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name));

describe('sniffMimeType', () => {
  it('identifies the fixture files by content', () => {
    expect(sniffMimeType(fixture('invoice.pdf'))).toBe('application/pdf');
    expect(sniffMimeType(fixture('pixel.png'))).toBe('image/png');
    expect(sniffMimeType(fixture('pixel.jpg'))).toBe('image/jpeg');
  });

  it('does not recognise an executable regardless of its file name', () => {
    expect(sniffMimeType(fixture('disguised-executable.pdf'))).toBeNull();
  });

  it('identifies GIF, WebP, MP4 and QuickTime headers', () => {
    expect(sniffMimeType(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'))).toBe('image/gif');
    expect(sniffMimeType(Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1'))).toBe('image/webp');
    expect(sniffMimeType(Buffer.from('\x00\x00\x00\x18ftypisom\x00\x00\x02\x00', 'latin1'))).toBe('video/mp4');
    expect(sniffMimeType(Buffer.from('\x00\x00\x00\x14ftypqt  \x00\x00\x02\x00', 'latin1'))).toBe('video/quicktime');
  });

  it('requires the PDF header at the start of the file', () => {
    expect(sniffMimeType(Buffer.from('MZ\x90\x00junk%PDF-1.4', 'latin1'))).toBeNull();
  });

  it('returns null for tiny or empty buffers', () => {
    expect(sniffMimeType(Buffer.alloc(0))).toBeNull();
    expect(sniffMimeType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});

describe('mimeTypesMatch', () => {
  it('accepts common aliases and parameters', () => {
    expect(mimeTypesMatch('image/jpg', 'image/jpeg')).toBe(true);
    expect(mimeTypesMatch('application/pdf; charset=binary', 'application/pdf')).toBe(true);
    expect(mimeTypesMatch('video/quicktime', 'video/mp4')).toBe(true);
  });

  it('rejects differing types', () => {
    expect(mimeTypesMatch('application/pdf', 'image/png')).toBe(false);
  });
});

describe('IpfsService.uploadFile content validation', () => {
  let service: IpfsService;

  beforeEach(() => {
    mockedPost.mockReset();
    mockedPost.mockResolvedValue({ data: { IpfsHash: 'bafytestcid' } });

    const config = {
      get: jest.fn((key: string, def?: unknown) => (key === 'IPFS_API_KEY' ? 'test-key' : def)),
    };
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
    const prisma = { appConfig: { findUnique: jest.fn().mockResolvedValue(null) } };

    service = new IpfsService(config as any, redis as any, prisma as any);
    service.isHealthy = true;
  });

  it('rejects an executable renamed to invoice.pdf with 415 before pinning', async () => {
    await expect(
      service.uploadFile(fixture('disguised-executable.pdf'), 'invoice.pdf', 'application/pdf'),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('rejects content that does not match the declared type with 415', async () => {
    const err = await service
      .uploadFile(fixture('pixel.png'), 'invoice.pdf', 'application/pdf')
      .catch((e) => e);

    expect(err).toBeInstanceOf(UnsupportedMediaTypeException);
    expect(err.getStatus()).toBe(415);
    expect(err.message).toContain('does not match the declared type');
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('rejects sniffed types outside the allowed list', async () => {
    const heic = Buffer.from('\x00\x00\x00\x18ftypheic\x00\x00\x00\x00', 'latin1');

    await expect(service.uploadFile(heic, 'photo.jpg', 'image/jpeg')).rejects.toBeInstanceOf(
      UnsupportedMediaTypeException,
    );
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('keeps rejecting disallowed declared types with 400', async () => {
    await expect(
      service.uploadFile(fixture('invoice.pdf'), 'run.exe', 'application/x-msdownload'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['invoice.pdf', 'application/pdf'],
    ['pixel.png', 'image/png'],
    ['pixel.jpg', 'image/jpeg'],
  ])('uploads a valid %s', async (name, mime) => {
    await expect(service.uploadFile(fixture(name), name, mime)).resolves.toBe('bafytestcid');
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });
});
