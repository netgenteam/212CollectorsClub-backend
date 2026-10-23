import { readdir } from 'node:fs/promises';
import { LANDING_IMAGES_DIR } from '../admin-catalog/product-image-upload-paths.constants.js';
import { pngOf, webpOf } from '../../test/fixtures/landing-images.js';
import { LandingImagesService } from './landing-images.service.js';

const service = new LandingImagesService();
const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { getResponse: () => { errorCode: string; details?: unknown } }) =>
      e.getResponse(),
  );

describe('LandingImagesService', () => {
  it('requires a file', async () => {
    expect(await codeOf(service.upload(undefined, 'generic'))).toMatchObject({
      errorCode: 'LANDING_IMAGE_REQUIRED',
    });
  });

  it('rejects non-image bytes without touching the disk', async () => {
    const before = await readdir(LANDING_IMAGES_DIR).catch(() => []);
    expect(
      await codeOf(
        service.upload({ buffer: Buffer.from('plain text.png') }, 'generic'),
      ),
    ).toMatchObject({ errorCode: 'UNSUPPORTED_FILE_TYPE' });
    expect(await readdir(LANDING_IMAGES_DIR).catch(() => [])).toEqual(before);
  });

  it('enforces min width and max side (422 LANDING_IMAGE_DIMENSIONS)', async () => {
    for (const buf of [pngOf(199, 300), pngOf(5000, 300), pngOf(300, 4097)]) {
      expect(
        await codeOf(service.upload({ buffer: buf }, 'generic')),
      ).toMatchObject({ errorCode: 'LANDING_IMAGE_DIMENSIONS' });
    }
  });

  it('applies the 63:88 ratio only to kind=card', async () => {
    expect(
      await codeOf(service.upload({ buffer: pngOf(800, 800) }, 'card')),
    ).toMatchObject({
      errorCode: 'LANDING_IMAGE_BAD_RATIO',
      details: { width: 800, height: 800, expected: 0.7159, tolerance: 0.03 },
    });
    // 3 % boundary: 630x880 ok, 650x880 (+3.2 %) not.
    expect(
      await codeOf(service.upload({ buffer: webpOf(650, 880) }, 'card')),
    ).toMatchObject({ errorCode: 'LANDING_IMAGE_BAD_RATIO' });
  });
});
