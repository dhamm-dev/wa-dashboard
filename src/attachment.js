import { extname, basename } from 'node:path';

const starts = (bytes, hex) => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
const zip = bytes => starts(bytes, '504b0304') || starts(bytes, '504b0506');
const text = bytes => {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
  } catch { return false; }
};
const formats = {
  jpg: ['image/jpeg', b => starts(b, 'ffd8ff')], jpeg: ['image/jpeg', b => starts(b, 'ffd8ff')],
  png: ['image/png', b => starts(b, '89504e470d0a1a0a')],
  gif: ['image/gif', b => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString())],
  webp: ['image/webp', b => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP'],
  pdf: ['application/pdf', b => b.subarray(0, 5).toString() === '%PDF-'],
  txt: ['text/plain', text], csv: ['text/csv', text],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', zip],
  zip: ['application/zip', zip],
  mp3: ['audio/mpeg', b => b.subarray(0, 3).toString() === 'ID3' || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)],
  mp4: ['video/mp4', b => b.length >= 12 && b.subarray(4, 8).toString() === 'ftyp']
};

export function validateAttachment(file) {
  if (!file?.buffer?.length || typeof file.originalname !== 'string') throw new Error('Pilih lampiran yang tidak kosong');
  const original = basename(file.originalname.replaceAll('\\', '/'));
  const extension = extname(original).slice(1).toLowerCase();
  const format = formats[extension];
  if (!format || !format[1](file.buffer)) throw new Error('Jenis atau isi lampiran tidak didukung');
  const base = original.slice(0, -(extension.length + 1)).normalize('NFKC').replace(/[^a-zA-Z0-9 _-]/g, '_').trim().slice(0, 100) || 'lampiran';
  return { name: `${base}.${extension}`, mime: format[0] };
}
