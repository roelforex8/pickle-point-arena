import assert from 'node:assert/strict';
import test from 'node:test';
import { detectReceiptMimeType, formatReceiptFileSize, maxReceiptBytes, receiptFileAccept, validateReceiptFile } from './receiptUpload.js';

function fakeFile(name, type, bytes, size = bytes.length) {
  const contents = new Uint8Array(Math.max(size, bytes.length));
  contents.set(bytes);
  return new File([contents], name, { type });
}

const signatures = {
  jpeg: [0xff, 0xd8, 0xff, 0xe0],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  webp: [...Buffer.from('RIFF0000WEBP')],
  heic: [...Buffer.from('\0\0\0\0ftypheic')],
  heif: [...Buffer.from('\0\0\0\0ftypmif1')],
  pdf: [...Buffer.from('%PDF-1.7')],
};

test('JPG/JPEG and PNG are accepted from their actual signatures', async () => {
  assert.equal(await detectReceiptMimeType(fakeFile('proof.JPG', '', signatures.jpeg)), 'image/jpeg');
  assert.equal(await detectReceiptMimeType(fakeFile('proof.jpeg', 'application/octet-stream', signatures.jpeg)), 'image/jpeg');
  assert.equal(await detectReceiptMimeType(fakeFile('proof.PNG', 'image/png', signatures.png)), 'image/png');
});

test('HEIC, HEIF, and WebP phone images are recognized for conversion', async () => {
  assert.equal(await detectReceiptMimeType(fakeFile('proof.HEIC', '', signatures.heic)), 'image/heic');
  assert.equal(await detectReceiptMimeType(fakeFile('proof.heif', 'application/octet-stream', signatures.heif)), 'image/heif');
  assert.equal(await detectReceiptMimeType(fakeFile('proof.WEBP', '', signatures.webp)), 'image/webp');
});

test('PDF is recognized from its signature with uppercase or generic metadata', async () => {
  assert.equal(validateReceiptFile(fakeFile('proof.PDF', 'application/octet-stream', signatures.pdf)), 'application/pdf');
  assert.equal(await detectReceiptMimeType(fakeFile('proof.PDF', '', signatures.pdf)), 'application/pdf');
});

test('uppercase extensions and missing or generic mobile MIME types pass picker validation', () => {
  assert.equal(validateReceiptFile(fakeFile('proof.JPEG', '', signatures.jpeg)), 'image/jpeg');
  assert.equal(validateReceiptFile(fakeFile('proof.HEIC', 'application/octet-stream', signatures.heic)), 'image/heic');
});

test('oversized files and misleading extensions are rejected clearly', async () => {
  assert.throws(() => validateReceiptFile(fakeFile('proof.jpg', 'image/jpeg', signatures.jpeg, maxReceiptBytes + 1)), /20 MB/);
  await assert.rejects(() => detectReceiptMimeType(fakeFile('proof.jpg', 'image/jpeg', [1, 2, 3, 4])), /does not appear/);
});

test('invalid extensions and extension/signature mismatches cannot bypass content inspection', async () => {
  assert.throws(() => validateReceiptFile(fakeFile('proof.exe', 'application/octet-stream', signatures.jpeg)), /JPG, PNG, WebP, HEIC, HEIF, or PDF/);
  await assert.rejects(() => detectReceiptMimeType(fakeFile('proof.png', 'image/png', signatures.jpeg.map(() => 1))), /does not appear/);
});

test('file picker accepts every supported receipt MIME type and extension', () => {
  for (const value of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf', '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.pdf']) {
    assert.ok(receiptFileAccept.split(',').includes(value), `missing ${value}`);
  }
});

test('selected receipt size is formatted for immediate display', () => {
  assert.equal(formatReceiptFileSize(512), '512 B');
  assert.equal(formatReceiptFileSize(1536), '1.5 KB');
  assert.equal(formatReceiptFileSize(2 * 1024 * 1024), '2.0 MB');
});
