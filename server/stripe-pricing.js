const CACHE_TTL_MS = 5 * 60 * 1000;

const PRICE_CONFIG = {
  ready: {
    productEnv: 'STRIPE_READY_REPORT_PRODUCT_ID',
    priceEnv: 'STRIPE_READY_REPORT_PRICE_ID',
    defaultProductId: 'prod_UtBtnbEY6jZjI0',
    defaultPriceId: 'price_1TtPVO2FVkKDgcuUAOQ8uvIa',
    fallbackUnitAmount: 2000,
    currency: 'eur',
  },
  fresh: {
    productEnv: 'STRIPE_FRESH_REPORT_PRODUCT_ID',
    priceEnv: 'STRIPE_FRESH_REPORT_PRICE_ID',
    defaultProductId: 'prod_UtBsf3RcUsub19',
    defaultPriceId: 'price_1TtPUr2FVkKDgcuUBSFqewde',
    fallbackUnitAmount: 5000,
    currency: 'eur',
  },
  // The "+ Revisions" tiers, deliberately with no fallback unit amount: a
  // misconfigured paid add-on should fail loudly rather than silently sell at
  // a guessed amount. No hardcoded default product id either (unlike ready/
  // fresh above) — instead the product is found by its `kind` metadata tag
  // (see scripts/stripe-setup-revisions-test.mjs, which sets it on create),
  // so nothing needs to be pasted into env vars once the product exists.
  // productEnv/priceEnv still work as an explicit override if ever needed.
  'ready-revisions': {
    productEnv: 'STRIPE_READY_REPORT_REVISIONS_PRODUCT_ID',
    priceEnv: 'STRIPE_READY_REPORT_REVISIONS_PRICE_ID',
    defaultProductId: '',
    defaultPriceId: '',
    lookupMetadataKind: 'ready-revisions',
    fallbackUnitAmount: null,
    currency: 'eur',
  },
  'fresh-revisions': {
    productEnv: 'STRIPE_FRESH_REPORT_REVISIONS_PRODUCT_ID',
    priceEnv: 'STRIPE_FRESH_REPORT_REVISIONS_PRICE_ID',
    defaultProductId: '',
    defaultPriceId: '',
    lookupMetadataKind: 'fresh-revisions',
    fallbackUnitAmount: null,
    currency: 'eur',
  },
};

const cache = new Map();

async function getStripePricing(stripe, kind, options = {}) {
  const config = PRICE_CONFIG[kind];
  if (!config) throw new Error(`Unknown Stripe price kind: ${kind}`);

  const cacheKey = `${kind}:${process.env[config.productEnv] || config.defaultProductId}:${process.env[config.priceEnv] || config.defaultPriceId}`;
  const cached = cache.get(cacheKey);
  if (!options.bypassCache && cached && cached.expiresAt > Date.now()) return cached.value;

  const value = await resolveStripePricing(stripe, kind, config);
  if (!options.bypassCache) {
    cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return value;
}

function revisionsEnabled() {
  return /^(1|true|yes|on)$/i.test(process.env.FORECAST_REVISIONS_ENABLED || '');
}

async function getPublicPricing(stripe, options = {}) {
  const [ready, fresh] = await Promise.all([
    getStripePricing(stripe, 'ready', options),
    getStripePricing(stripe, 'fresh', options),
  ]);
  const pricing = { ready: publicPrice(ready), fresh: publicPrice(fresh), revisionsEnabled: revisionsEnabled() };
  if (!pricing.revisionsEnabled) return pricing;

  // The revisions kinds throw when unconfigured (see resolveStripePricing) —
  // catch per-kind so a half-set-up "ready" tier doesn't hide a working
  // "fresh" one, and vice versa.
  const [readyRevisions, freshRevisions] = await Promise.all([
    getStripePricing(stripe, 'ready-revisions', options).catch(() => null),
    getStripePricing(stripe, 'fresh-revisions', options).catch(() => null),
  ]);
  pricing.readyRevisions = readyRevisions ? publicPrice(readyRevisions) : null;
  pricing.freshRevisions = freshRevisions ? publicPrice(freshRevisions) : null;
  pricing.revisionsIncluded = Number.parseInt(process.env.REPORT_REVISIONS_INCLUDED || '', 10) || 3;
  return pricing;
}

async function resolveStripePricing(stripe, kind, config) {
  const productId = stripeProductId(process.env[config.productEnv], config.defaultProductId);
  if (productId) {
    try {
      const product = await stripe.products.retrieve(productId, { expand: ['default_price'] });
      const price = product.default_price;
      if (price && typeof price === 'object' && stripePriceId(price.id)) {
        return normalizePrice(kind, price);
      }
    } catch (err) {
      console.warn(`Stripe ${kind} product pricing lookup failed:`, err.message);
    }
  } else if (config.lookupMetadataKind) {
    try {
      const product = await findProductByMetadataKind(stripe, config.lookupMetadataKind);
      const price = product && product.default_price;
      if (price && typeof price === 'object' && stripePriceId(price.id)) {
        return normalizePrice(kind, price);
      }
    } catch (err) {
      console.warn(`Stripe ${kind} metadata product lookup failed:`, err.message);
    }
  }

  const priceId = stripePriceId(process.env[config.priceEnv], config.defaultPriceId);
  if (priceId) {
    try {
      return normalizePrice(kind, await stripe.prices.retrieve(priceId));
    } catch (err) {
      console.warn(`Stripe ${kind} price lookup failed:`, err.message);
    }
  }

  if (config.fallbackUnitAmount == null) {
    throw new Error(
      config.lookupMetadataKind
        ? `No Stripe price configured for "${kind}" — create the product with `
          + `metadata.kind="${config.lookupMetadataKind}" (see scripts/stripe-setup-revisions-test.mjs), `
          + `or set ${config.productEnv} / ${config.priceEnv} to override`
        : `No Stripe price configured for "${kind}" — set ${config.productEnv} or ${config.priceEnv}`,
    );
  }

  return {
    kind,
    priceId: null,
    unitAmount: config.fallbackUnitAmount,
    currency: config.currency,
  };
}

// Finds the active product tagged with the given `kind` in its metadata
// (set by scripts/stripe-setup-revisions-test.mjs on create) so revisions
// pricing works without ever pasting a product/price id into env vars.
async function findProductByMetadataKind(stripe, metadataKind) {
  const products = await stripe.products.list({
    active: true,
    limit: 100,
    expand: ['data.default_price'],
  });
  return products.data.find(p => p.metadata && p.metadata.kind === metadataKind) || null;
}

function normalizePrice(kind, price) {
  return {
    kind,
    priceId: price.id,
    unitAmount: Number(price.unit_amount || 0),
    currency: String(price.currency || 'eur').toLowerCase(),
  };
}

function publicPrice(price) {
  return {
    unitAmount: price.unitAmount,
    currency: price.currency,
    label: formatPrice(price.unitAmount, price.currency, true),
    shortLabel: formatPrice(price.unitAmount, price.currency, false),
  };
}

function formatPrice(unitAmount, currency, forceDecimals) {
  const amount = Number(unitAmount || 0) / 100;
  const symbol = String(currency).toLowerCase() === 'eur' ? '\u20ac' : `${String(currency).toUpperCase()} `;
  const decimals = forceDecimals || !Number.isInteger(amount) ? 2 : 0;
  return `${symbol}${amount.toFixed(decimals)}`;
}

function stripePriceId(value, fallback = '') {
  const priceId = String(value || '').trim();
  if (/^price_[A-Za-z0-9]+$/.test(priceId)) return priceId;
  return fallback && /^price_[A-Za-z0-9]+$/.test(fallback) ? fallback : '';
}

function stripeProductId(value, fallback = '') {
  const productId = String(value || '').trim();
  if (/^prod_[A-Za-z0-9]+$/.test(productId)) return productId;
  return fallback && /^prod_[A-Za-z0-9]+$/.test(fallback) ? fallback : '';
}

module.exports = {
  getPublicPricing,
  getStripePricing,
};
