const METRIC_VARIABLES = {
  bookValue: 'bv',
  sharePrice: 'adj_share_price_a',
  revenue: 'ns',
  ebit: 'ebit',
  netEarnings: 'net_earnings',
  marketCap: 'market_cap_ye',
};

export function selectPrimaryModel(models) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('Cannot select a primary model from an empty model list');
  }

  return [...models].sort((left, right) => {
    const leftOrder = Number.isFinite(Number(left.orderNo)) ? Number(left.orderNo) : Infinity;
    const rightOrder = Number.isFinite(Number(right.orderNo)) ? Number(right.orderNo) : Infinity;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return Number(left.followedModelId) - Number(right.followedModelId);
  })[0];
}

export function normalizeCompanyData(company, model) {
  const currentYear = Number(model.currentYear);
  if (!Number.isInteger(currentYear)) {
    throw new Error(`Model ${model.followedModelId} has an invalid currentYear`);
  }

  const financialYear = currentYear - 1;
  const yearData = model.dataMap?.[String(financialYear)] ?? model.dataMap?.[financialYear];
  if (!yearData || typeof yearData !== 'object') {
    throw new Error(
      `Model ${model.followedModelId} did not return Y-1 data for financial year ${financialYear}`,
    );
  }

  const metrics = Object.fromEntries(
    Object.entries(METRIC_VARIABLES).map(([key, variable]) => [key, finiteNumberOrNull(yearData[variable])]),
  );

  return {
    companyId: Number(company.companyId),
    followedModelId: Number(model.followedModelId),
    companyName: String(company.companyName || model.companyName || '').trim(),
    companyCode: String(company.companyCode || model.companyCode || '').trim(),
    ticker: String(company.ticker || '').trim().toUpperCase(),
    industry: String(company.industry || '').trim(),
    currency: String(model.currency || '').trim().toUpperCase(),
    financialYear,
    metrics,
    background: normalizeBackground(model.background),
  };
}

function normalizeBackground(background) {
  if (!background || typeof background !== 'object') return null;
  return {
    description: cleanOptionalText(background.description),
    companyText: cleanOptionalText(background.companyText),
    website: cleanOptionalText(background.www),
  };
}

function cleanOptionalText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
