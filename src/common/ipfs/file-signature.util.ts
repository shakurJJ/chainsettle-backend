/**
 * Content-based MIME detection for uploaded proof files.
 *
 * The client-supplied Content-Type is not trustworthy (an executable renamed
 * to invoice.pdf would pass a header check), so uploads are validated against
 * the file's leading "magic bytes" instead. Only formats we accept for proofs
 * are recognised — anything else sniffs as null and is rejected.
 */

const startsWith = (buf: Buffer, bytes: number[], offset = 0): boolean =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

const ascii = (buf: Buffer, start: number, end: number): string =>
  buf.length >= end ? buf.toString('latin1', start, end) : '';

/** ISO-BMFF `ftyp` major brands that identify HEIF/AVIF images rather than video. */
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
/** Atoms that may open a classic QuickTime file with no `ftyp` box. */
const QUICKTIME_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

/**
 * Returns the MIME type implied by the buffer's content, or null when the
 * format is not recognised.
 */
export function sniffMimeType(buf: Buffer): string | null {
  if (!buf || buf.length < 4) return null;

  // Header must be at offset 0: readers tolerate leading junk, but allowing it
  // would let an executable carrying a "%PDF-" string further in pass as a PDF.
  if (ascii(buf, 0, 5) === '%PDF-') return 'application/pdf';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return 'image/webp';

  const box = ascii(buf, 4, 8);
  if (box === 'ftyp') {
    const brand = ascii(buf, 8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (HEIC_BRANDS.has(brand)) return 'image/heic';
    if (AVIF_BRANDS.has(brand)) return 'image/avif';
    return 'video/mp4';
  }
  if (QUICKTIME_ATOMS.has(box)) return 'video/quicktime';

  return null;
}

/** Common non-canonical spellings clients send for the types above. */
const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'application/x-pdf': 'application/pdf',
  'video/x-quicktime': 'video/quicktime',
};

export function normalizeMimeType(mime: string): string {
  const base = (mime ?? '').split(';')[0].trim().toLowerCase();
  return MIME_ALIASES[base] ?? base;
}

/**
 * True when the declared type is consistent with the sniffed one. MP4 and
 * QuickTime share a container format and are often labelled interchangeably
 * by clients, so they are treated as compatible.
 */
export function mimeTypesMatch(declared: string, sniffed: string): boolean {
  const a = normalizeMimeType(declared);
  const b = normalizeMimeType(sniffed);
  if (a === b) return true;
  const isoVideo = new Set(['video/mp4', 'video/quicktime']);
  return isoVideo.has(a) && isoVideo.has(b);
}
