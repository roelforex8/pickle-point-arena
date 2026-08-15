export const maxReceiptBytes = 20 * 1024 * 1024;

export const receiptFileAccept = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.pdf';

export const receiptMimeByExtension = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
};

const allowedReceiptMimeTypes = new Set(Object.values(receiptMimeByExtension));

export function validateReceiptFile(file) {
  if (!file) throw new Error('Choose a receipt image or PDF first.');
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  const reportedMimeType = file.type?.toLowerCase() || '';
  const mimeType = allowedReceiptMimeTypes.has(reportedMimeType) ? reportedMimeType : (receiptMimeByExtension[extension] || reportedMimeType);
  if (!allowedReceiptMimeTypes.has(mimeType)) throw new Error('Choose a JPG, PNG, WebP, HEIC, HEIF, or PDF receipt.');
  if (!file.size || file.size > maxReceiptBytes) throw new Error('Choose a non-empty receipt file no larger than 20 MB.');
  return mimeType;
}

export function formatReceiptFileSize(bytes) {
  const size = Number(bytes || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function startsWith(bytes, signature) {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

export async function detectReceiptMimeType(file) {
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1'].includes(brand)) return 'image/heif';
  }
  throw new Error('The selected file does not appear to be a supported receipt image or PDF. Try a screenshot instead.');
}
