const DEFAULT_TIMEOUT_MS = 30_000;

export const FINANCIAL_VARIABLES = [
  'bv',
  'adj_share_price_a',
  'ns',
  'ebit',
  'net_earnings',
  'market_cap_ye',
];

export class WisdomClient {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (!baseUrl) throw new Error('WISDOM_API_BASE is required');
    if (!token) throw new Error('WISDOM_API_TOKEN is required');
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');

    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...options.headers,
        },
      });

      const body = await response.text();
      let data;
      try {
        data = body ? JSON.parse(body) : null;
      } catch {
        throw new Error(`Wisdom returned invalid JSON for ${path} (HTTP ${response.status})`);
      }

      if (!response.ok) {
        const detail = data?.error || response.statusText || 'Request failed';
        throw new Error(`Wisdom request ${path} failed (HTTP ${response.status}): ${detail}`);
      }

      return data;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`Wisdom request ${path} timed out after ${this.timeoutMs} ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async findCompanyByTicker(ticker) {
    const normalizedTicker = normalizeTicker(ticker);
    const companies = await this.request(`/company?ticker=${encodeURIComponent(normalizedTicker)}`);
    if (!Array.isArray(companies)) {
      throw new Error('Wisdom /company response was not an array');
    }

    const exactMatches = companies.filter(
      (company) => normalizeTicker(company?.ticker) === normalizedTicker,
    );

    if (exactMatches.length === 0) {
      throw new Error(`No exact Wisdom company match found for ticker ${normalizedTicker}`);
    }
    if (exactMatches.length > 1) {
      const ids = exactMatches.map((company) => company.companyId).join(', ');
      throw new Error(`Ticker ${normalizedTicker} matched multiple companies: ${ids}`);
    }

    const company = exactMatches[0];
    if (!Array.isArray(company.models) || company.models.length === 0) {
      throw new Error(`Company ${normalizedTicker} has no accessible models`);
    }
    return company;
  }

  async getLatestActualModels(company) {
    const fids = company.models
      .map((model) => Number(model.followedModelId))
      .filter(Number.isInteger);
    if (fids.length === 0) {
      throw new Error(`Company ${company.ticker} has no valid followed model IDs`);
    }

    const body = {
      fids,
      varPoses: FINANCIAL_VARIABLES.map((varName) => ({ varName, relPos: 'Y-1' })),
      includeHistoryData: true,
      includeEstimates: false,
    };

    const response = await this.request('/modeldata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new Error('Wisdom /modeldata response was not an object');
    }

    const models = Object.values(response).filter(
      (model) => Number(model?.companyId) === Number(company.companyId),
    );
    if (models.length === 0) {
      throw new Error(`Wisdom returned no model data for ${company.ticker}`);
    }
    return models;
  }
}

export function normalizeTicker(ticker) {
  return String(ticker || '').trim().toUpperCase();
}
