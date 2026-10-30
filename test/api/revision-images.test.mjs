import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

// Images sent with a revision: checked the same at every door, stored by key,
// loaded back for the engine. S3 is faked through require.cache, as the other
// API tests fake their stores.
const require = createRequire(import.meta.url);
const IMAGES_ID = require.resolve('../../server/revision-images.js');
const CLIENTS_ID = require.resolve('../../server/aws/clients.js');

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const image = (bytes = png, mimeType = 'image/png') => ({ data: bytes.toString('base64'), mimeType });

function loadImages(t) {
  const objects = new Map();
  const s3 = { async send(command) {
    if (command.constructor.name === 'PutObjectCommand') { objects.set(command.input.Key, command.input); return {}; }
    const put = objects.get(command.input.Key);
    return { Body: { transformToByteArray: async () => new Uint8Array(put.Body) } };
  } };
  delete require.cache[IMAGES_ID];
  require.cache[CLIENTS_ID] = { id: CLIENTS_ID, filename: CLIENTS_ID, loaded: true, exports: { s3: () => s3 } };
  process.env.REPORT_PDF_BUCKET = 'stage-bucket';
  t.after(() => { delete require.cache[IMAGES_ID]; delete require.cache[CLIENTS_ID]; });
  return { images: require(IMAGES_ID), objects };
}

test('revision images: PNG or JPEG by their bytes, at most three, 2 MB each and 3 MB together', (t) => {
  const { images } = loadImages(t);
  assert.deepEqual(images.parseImages(undefined), []);
  assert.equal(images.parseImages([image()]).length, 1);
  assert.match(images.parseImages([image(), image(), image(), image()]).message, /at most 3/);
  assert.match(images.parseImages([image(png, 'image/gif')]).message, /image\/png/);
  assert.match(images.parseImages([image(Buffer.from('GIF89a'))]).message, /PNG or JPEG file/);
  const big = Buffer.concat([png, Buffer.alloc(1.6 * 1024 * 1024)]);
  assert.match(images.parseImages([image(Buffer.concat([png, Buffer.alloc(2.1 * 1024 * 1024)]))]).message, /2 MB/);
  assert.match(images.parseImages([image(big), image(big)]).message, /3 MB/);
});

test('revision images are stored under the order and come back as the engine takes them', async (t) => {
  const { images, objects } = loadImages(t);
  const stored = await images.storeImages('cs_123', images.parseImages([image()]));
  assert.equal(stored.length, 1);
  assert.match(stored[0].key, /^revision-images\/cs_123\/[0-9a-f-]+\.png$/);
  assert.equal(objects.get(stored[0].key).Bucket, 'stage-bucket');
  assert.deepEqual(await images.loadImages(stored), [image()]);
  assert.deepEqual(await images.loadImages(null), []);
});
