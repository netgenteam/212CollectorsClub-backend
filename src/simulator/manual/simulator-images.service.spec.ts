import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SIMULATOR_IMAGES_DIR } from '../../admin-catalog/product-image-upload-paths.constants.js';
import { pngOf } from '../../../test/fixtures/simulator-images.js';
import { SimulatorImagesService } from './simulator-images.service.js';
import { isValidImageUrl } from './image-url.validator.js';

const service = new SimulatorImagesService();
const errOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { getResponse: () => { errorCode: string } }) => e.getResponse(),
  );

describe('SimulatorImagesService', () => {
  const made: string[] = [];
  afterAll(() =>
    Promise.all(
      made.map((u) =>
        rm(join(SIMULATOR_IMAGES_DIR, u.split('/').pop()!), { force: true }),
      ),
    ),
  );

  it('requires a file', async () => {
    expect(await errOf(service.upload(undefined))).toMatchObject({
      errorCode: 'SIMULATOR_IMAGE_REQUIRED',
    });
  });

  it('maps errors to SIMULATOR_IMAGE_* codes', async () => {
    expect(
      await errOf(service.upload({ buffer: Buffer.from('x.png') })),
    ).toMatchObject({ errorCode: 'UNSUPPORTED_FILE_TYPE' });
    expect(
      await errOf(service.upload({ buffer: pngOf(4097, 5) })),
    ).toMatchObject({ errorCode: 'SIMULATOR_IMAGE_DIMENSIONS' });
    expect(await errOf(service.upload({ buffer: pngOf(0, 0) }))).toMatchObject({
      errorCode: 'SIMULATOR_IMAGE_DIMENSIONS',
    });
    const big = Buffer.concat([pngOf(5, 5), Buffer.alloc(2 * 1024 * 1024)]);
    expect(await errOf(service.upload({ buffer: big }))).toMatchObject({
      errorCode: 'SIMULATOR_IMAGE_TOO_LARGE',
    });
  });

  it('accepts any proportion and returns a url that passes the imageUrl validator', async () => {
    for (const [w, h] of [
      [1000, 1000],
      [300, 900],
    ]) {
      const r = await service.upload({ buffer: pngOf(w, h) });
      made.push(r.url);
      expect(r).toMatchObject({ width: w, height: h });
      expect(r.url).toMatch(
        /^\/uploads\/public\/simulator\/[0-9a-f-]{36}\.png$/,
      );
      expect(isValidImageUrl(r.url)).toBe(true);
    }
  });
});
