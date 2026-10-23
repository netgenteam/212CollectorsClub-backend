import { deflateSync } from 'node:zlib';

/** Minimal valid-header PNG of an exact size (IHDR + empty IDAT + IEND). */
export function pngOf(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([
      len,
      Buffer.from(type, 'ascii'),
      data,
      Buffer.alloc(4), // CRC not checked by image-size
    ]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(1))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Extended WebP (VP8X) header of an exact canvas size. */
export function webpOf(width: number, height: number): Buffer {
  const vp8x = Buffer.alloc(18);
  vp8x.write('VP8X', 0, 'ascii');
  vp8x.writeUInt32LE(10, 4);
  vp8x.writeUIntLE(width - 1, 12, 3);
  vp8x.writeUIntLE(height - 1, 15, 3);
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), vp8x]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
