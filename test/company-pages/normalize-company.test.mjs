import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCompanyData, selectPrimaryModel } from '../../scripts/company-pages/normalize-company.mjs';

test('selectPrimaryModel uses orderNo and followed model ID as a tie-breaker', () => {
  const selected = selectPrimaryModel([
    { followedModelId: 300, orderNo: 2 },
    { followedModelId: 200, orderNo: 1 },
    { followedModelId: 100, orderNo: 1 },
  ]);

  assert.equal(selected.followedModelId, 100);
});

test('normalizeCompanyData reads the latest completed financial year', () => {
  const company = {
    companyId: 5,
    companyName: 'Example Oyj',
    companyCode: 'FI123',
    ticker: 'example',
    industry: 'Industrials',
  };
  const model = {
    followedModelId: 100,
    currentYear: 2026,
    currency: 'eur',
    dataMap: {
      2025: {
        bv: 400,
        adj_share_price_a: 12.34,
        ns: 1_200,
        ebit: 110,
        net_earnings: 80,
        market_cap_ye: 2_500,
      },
    },
    background: { description: 'Existing description', www: 'https://example.com' },
  };

  const result = normalizeCompanyData(company, model);

  assert.equal(result.financialYear, 2025);
  assert.equal(result.currency, 'EUR');
  assert.equal(result.marketCurrency, 'EUR');
  assert.equal(result.metrics.revenue, 1_200);
  assert.equal(result.metrics.sharePrice, 12.34);
  assert.equal(result.background.website, 'https://example.com');
});

test('normalizeCompanyData separates reporting and listing currencies', () => {
  const result = normalizeCompanyData(
    { companyId: 1, companyName: 'Evolution AB', ticker: 'EVO.ST', models: [] },
    {
      followedModelId: 2,
      currentYear: 2026,
      currency: 'EUR',
      dataMap: { 2025: { ns: 2_000, adj_share_price_a: 850, market_cap_ye: 175_000 } },
    },
  );

  assert.equal(result.currency, 'EUR');
  assert.equal(result.marketCurrency, 'SEK');
});

test('normalizeCompanyData corrects known Wisdom industry mismatches', () => {
  const result = normalizeCompanyData(
    { companyId: 1, companyName: 'Konecranes Plc', ticker: 'KCR.HE', industry: 'Agricultural - Machinery' },
    { followedModelId: 2, currentYear: 2026, currency: 'EUR', dataMap: { 2025: {} } },
  );

  assert.equal(result.industry, 'Industrial Machinery');
});

test('normalizeCompanyData preserves missing values as null', () => {
  const result = normalizeCompanyData(
    { companyId: 1, companyName: 'Example', ticker: 'EX', models: [] },
    { followedModelId: 2, currentYear: 2026, currency: 'EUR', dataMap: { 2025: { ns: 0 } } },
  );

  assert.equal(result.metrics.revenue, 0);
  assert.equal(result.metrics.ebit, null);
});
