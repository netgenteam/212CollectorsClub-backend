export { pngOf, webpOf } from './landing-images.js';

const box = (type: string, payload: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, payload]);
};

/** Minimal JPEG: SOI + SOF0 with the size + EOI (image-size reads the SOF). */
export function jpegOf(width: number, height: number): Buffer {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  // JFIF APP0 first: image-size's JPEG parser walks segments from the first marker.
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** Minimal AVIF: ftyp(avif) + meta > iprp > ipco > ispe. */
export function avifOf(width: number, height: number): Buffer {
  const ispe = Buffer.alloc(12);
  ispe.writeUInt32BE(width, 4);
  ispe.writeUInt32BE(height, 8);
  const ftyp = box(
    'ftyp',
    Buffer.concat([
      Buffer.from('avif', 'ascii'),
      Buffer.alloc(4),
      Buffer.from('avif', 'ascii'),
    ]),
  );
  const meta = box(
    'meta',
    Buffer.concat([
      Buffer.alloc(4),
      box('iprp', box('ipco', box('ispe', ispe))),
    ]),
  );
  return Buffer.concat([ftyp, meta]);
}
