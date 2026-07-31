import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeCatalogReport } = require('../../server/catalog-client.js');

function withSiteUrl(siteUrl, run) {
  const previous = process.env.SITE_URL;
  process.env.SITE_URL = siteUrl;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = previous;
  }
}

test('relative pdfUrl becomes absolute against SITE_URL', () => {
  withSiteUrl('https://www.aiequityreports.com', () => {
    assert.equal(
      normalizeCatalogReport({ pdfUrl: 'reports/pdfs/Example_01062026.pdf' }).pdfUrl,
      'https://www.aiequityreports.com/reports/pdfs/Example_01062026.pdf',
    );
  });
});

test('a leading slash does not produce a double slash', () => {
  withSiteUrl('https://www.aiequityreports.com/', () => {
    assert.equal(
      normalizeCatalogReport({ pdfUrl: '/reports/pdfs/Example_01062026.pdf' }).pdfUrl,
      'https://www.aiequityreports.com/reports/pdfs/Example_01062026.pdf',
    );
  });
});

test('absolute pdfUrl is left untouched', () => {
  for (const pdfUrl of [
    'https://files.valuatum.com/reports/pdfs/AMD_05062026.pdf',
    'http://files.valuatum.com/reports/pdfs/AMD_05062026.pdf',
    '//files.valuatum.com/reports/pdfs/AMD_05062026.pdf',
  ]) {
    assert.equal(normalizeCatalogReport({ pdfUrl }).pdfUrl, pdfUrl);
  }
});

test('missing pdfUrl is preserved rather than stringified', () => {
  assert.equal(normalizeCatalogReport({}).pdfUrl, undefined);
  assert.equal(normalizeCatalogReport({ pdfUrl: null }).pdfUrl, null);
  assert.equal(normalizeCatalogReport({ pdfUrl: '' }).pdfUrl, '');
});

test('normalization does not disturb the pricing fields', () => {
  withSiteUrl('https://www.aiequityreports.com', () => {
    const free = normalizeCatalogReport({ pdfUrl: 'a.pdf', price: 0 });
    assert.equal(free.isFree, true);
    assert.equal(free.price, 0);

    const paid = normalizeCatalogReport({ pdfUrl: 'a.pdf', price: 4.99, reportType: 'existing' });
    assert.equal(paid.isFree, false);
    assert.equal(paid.price, 20);
  });
});
