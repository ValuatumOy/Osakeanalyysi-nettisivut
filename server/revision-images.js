// Images a customer sends with a revision request ("put this picture on the
// robotaxi page"). Every door that claims a revision (the order page through
// the Vercel function, a member's own run, the admin) checks them here and
// stores them in this stage's bucket; the order row keeps only their keys
// (a DynamoDB item holds 400 KB), and the reconciler sends them with the
// revision to the report engine, which places each on the page the comment
// names.

const crypto = require('crypto');

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
// As base64 three megabytes still fit Vercel's 4.5 MB request body.
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const MAGIC = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff] };

// This stage's own bucket: the members Lambda names it GENERATED_PDF_BUCKET
// (its REPORT_PDF_BUCKET is production's catalog); the API and worker
// Lambdas name it REPORT_PDF_BUCKET.
function bucket() {
  const name = process.env.GENERATED_PDF_BUCKET || process.env.REPORT_PDF_BUCKET;
  if (!name) throw new Error('GENERATED_PDF_BUCKET / REPORT_PDF_BUCKET is not set');
  return name;
}

// `[{ data: base64, mimeType }]` as checked images, or an Error saying why
// not. Nothing given is no images.
function parseImages(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) return new Error(`images must be a list of at most ${MAX_IMAGES}`);
  const images = [];
  for (const item of raw) {
    const magic = item && MAGIC[item.mimeType];
    if (!magic || typeof item.data !== 'string') return new Error('each image must be { data: base64, mimeType: "image/png" | "image/jpeg" }');
    const bytes = Buffer.from(item.data, 'base64');
    if (!magic.every((b, i) => bytes[i] === b)) return new Error('each image must be a PNG or JPEG file');
    if (bytes.length > MAX_IMAGE_BYTES) return new Error('each image must be 2 MB or smaller');
    images.push({ bytes, mimeType: item.mimeType });
  }
  if (images.reduce((sum, image) => sum + image.bytes.length, 0) > MAX_TOTAL_BYTES) return new Error('the images must be 3 MB or smaller together');
  return images;
}

// Store checked images under revision-images/<order>/; returns their keys.
// The AWS SDK is required on use, like server/aws/clients.js: the legacy
// Express server requires the reconciler without it installed.
async function storeImages(orderId, images) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const { s3 } = require('./aws/clients');
  const stored = [];
  for (const image of images) {
    const key = `revision-images/${encodeURIComponent(orderId)}/${crypto.randomUUID()}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`;
    await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: image.bytes, ContentType: image.mimeType }));
    stored.push({ key, mimeType: image.mimeType });
  }
  return stored;
}

// The stored images as the engine takes them: `[{ data: base64, mimeType }]`.
async function loadImages(stored) {
  if (!stored?.length) return [];
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { s3 } = require('./aws/clients');
  return Promise.all(stored.map(async ({ key, mimeType }) => {
    const res = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    return { data: Buffer.from(await res.Body.transformToByteArray()).toString('base64'), mimeType };
  }));
}

module.exports = { parseImages, storeImages, loadImages, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES };
