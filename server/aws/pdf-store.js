// S3 PDF catalog storage. Same flat layout as the legacy server's PDF dir:
// <prefix><Name>_<ddmmyyyy>.pdf plus a sidecar <Name>_<ddmmyyyy>.json.
// Serving happens through CloudFront (files.aiequityreports.com); this module
// is only the backend's read/write path plus the admin page's presigned PUT.

const {
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { s3 } = require('./clients');

const BUCKET = () => {
  const name = process.env.REPORT_PDF_BUCKET;
  if (!name) throw new Error('REPORT_PDF_BUCKET is not set');
  return name;
};

const PREFIX = () => {
  const prefix = process.env.REPORT_PDF_PREFIX || 'reports/pdfs/';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
};

function keyFor(fileName) {
  return `${PREFIX()}${fileName}`;
}

// List catalog PDFs in the same shape catalog.js's scanPdfDir produces.
// uploadedAt falls back to S3 LastModified, but real upload times live in the
// sidecars (stamped during migration) which win in the
// metadata merge.
async function listPdfs() {
  const files = [];
  let ContinuationToken;
  do {
    const page = await s3().send(new ListObjectsV2Command({
      Bucket: BUCKET(),
      Prefix: PREFIX(),
      ContinuationToken,
    }));
    for (const object of page.Contents || []) {
      const fileName = object.Key.slice(PREFIX().length);
      if (!/\.pdf$/i.test(fileName) || fileName.includes('/')) continue;
      files.push({
        fileName,
        uploadedAt: (object.LastModified || new Date()).toISOString(),
        size: object.Size ?? 0,
      });
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return files;
}

async function readSidecar(pdfFileName) {
  const sidecarKey = keyFor(pdfFileName.replace(/\.pdf$/i, '.json'));
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: BUCKET(), Key: sidecarKey }));
    const body = await res.Body.transformToString('utf8');
    const parsed = JSON.parse(body.replace(/^﻿/, ''));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return {};
    if (err instanceof SyntaxError) return {};
    throw err;
  }
}

// Fetch all sidecars for a file list (bounded parallelism) and return a Map
// fileName -> sidecar object, for injection into catalog.buildCatalog.
async function readSidecars(fileNames, concurrency = 25) {
  const byFileName = new Map();
  const queue = [...fileNames];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const fileName = queue.shift();
      byFileName.set(fileName, await readSidecar(fileName));
    }
  });
  await Promise.all(workers);
  return byFileName;
}

async function putPdf(fileName, buffer) {
  await s3().send(new PutObjectCommand({
    Bucket: BUCKET(),
    Key: keyFor(fileName),
    Body: buffer,
    ContentType: 'application/pdf',
  }));
}

// Atomic create: the write succeeds only if nothing exists at the key, so two concurrent
// deliveries for the same company on the same day can never overwrite each other — S3
// arbitrates, not a check-then-act probe. Returns false when the key is already taken.
// A 409 means another conditional write on the same key is in flight; treating it as taken
// costs at most a skipped suffix, never an overwrite.
async function putPdfIfAbsent(fileName, buffer) {
  try {
    await s3().send(new PutObjectCommand({
      Bucket: BUCKET(),
      Key: keyFor(fileName),
      Body: buffer,
      ContentType: 'application/pdf',
      IfNoneMatch: '*',
    }));
    return true;
  } catch (err) {
    const status = err.$metadata?.httpStatusCode;
    if (err.name === 'PreconditionFailed' || status === 412 || status === 409) return false;
    throw err;
  }
}

async function writeSidecar(pdfFileName, sidecar) {
  await s3().send(new PutObjectCommand({
    Bucket: BUCKET(),
    Key: keyFor(pdfFileName.replace(/\.pdf$/i, '.json')),
    Body: `${JSON.stringify(sidecar, null, 2)}\n`,
    ContentType: 'application/json',
  }));
}

async function pdfExists(fileName) {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: BUCKET(), Key: keyFor(fileName) }));
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

// The one deletion path in the system: explicit admin delete.
async function deleteReport(pdfFileName) {
  await s3().send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: keyFor(pdfFileName) }));
  await s3().send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: keyFor(pdfFileName.replace(/\.pdf$/i, '.json')) }));
}

// Presigned PUT for the admin upload flow: the browser uploads straight
// to S3; the URL is short-lived and pinned to one key + content type.
async function presignPdfUpload(fileName, expiresInSeconds = 300) {
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  return getSignedUrl(
    s3(),
    new PutObjectCommand({ Bucket: BUCKET(), Key: keyFor(fileName), ContentType: 'application/pdf' }),
    { expiresIn: expiresInSeconds },
  );
}

module.exports = {
  listPdfs,
  readSidecar,
  readSidecars,
  putPdf,
  putPdfIfAbsent,
  writeSidecar,
  pdfExists,
  deleteReport,
  presignPdfUpload,
};
