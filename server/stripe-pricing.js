const CACHE_TTL_MS = 5 * 60 * 1000;

// How many forecast-revision requests a "+ Revisions" purchase includes when
// its Stripe product does not say (metadata.revisions, see
// includedRevisions below). Ready+ and fresh+ are a €5 add-on and include
// two; revisions on a free report are the whole €10 purchase and include
// three. Read here and nowhere else, so the checkout handlers, the public
// pricing payload and the members Lambda can never disagree on the number.
function revisionsIncluded(kind) {
  if (kind === 'free-revisions') {
    return Number.parseInt(process.env.FREE_REPORT_REVISIONS_INCLUDED || '', 10) || 3;
  }
  return Number.parseInt(process.env.REPORT_REVISIONS_INCLUDED || '', 10) || 2;
}

// The count a resolved price carries: the product's own metadata.revisions
// when set (scripts/stripe-setup-revisions.mjs writes it, and it can be
// changed in the Stripe dashboard next to the price), else the default above.
function includedRevisions(pricing) {
  return pricing.revisionsIncluded || revisionsIncluded(pricing.kind);
}

// What one extra revision round costs when no Stripe product for it exists
// yet. Kept as the fallback for the `extra-revision` kind below so a deploy
// without the product still sells rounds at the same price it always has.
function extraRevisionFallbackUnitAmount() {
  return Math.round((Number(process.env.EXTRA_REVISION_EUR || '') || 5) * 100);
}

const PRICE_CONFIG = {
  // The two base kinds keep their live product ids as defaults and a
  // hardcoded fallback amount, so the shop stays open when Stripe cannot be
  // reached. Under a test-mode key those live ids do not exist; the `kind`
  // metadata tag (scripts/stripe-setup-revisions.mjs sets it on the test
  // products, and adopts the live ones) is what finds the right product then.
  ready: {
    productEnv: 'STRIPE_READY_REPORT_PRODUCT_ID',
    priceEnv: 'STRIPE_READY_REPORT_PRICE_ID',
    defaultProductId: 'prod_UtBtnbEY6jZjI0',
    defaultPriceId: 'price_1TtPVO2FVkKDgcuUAOQ8uvIa',
    lookupMetadataKind: 'ready',
    fallbackUnitAmount: 2000,
    currency: 'eur',
  },
  fresh: {
    productEnv: 'STRIPE_FRESH_REPORT_PRODUCT_ID',
    priceEnv: 'STRIPE_FRESH_REPORT_PRICE_ID',
    defaultProductId: 'prod_UtBsf3RcUsub19',
    defaultPriceId: 'price_1TtPUr2FVkKDgcuUBSFqewde',
    lookupMetadataKind: 'fresh',
    fallbackUnitAmount: 5000,
    currency: 'eur',
  },
  // The "+ Revisions" tiers, deliberately with no fallback unit amount: a
  // misconfigured paid add-on should fail loudly rather than silently sell at
  // a guessed amount. No hardcoded default product id either (unlike ready/
  // fresh above) — instead the product is found by its `kind` metadata tag
  // (see scripts/stripe-setup-revisions.mjs, which sets it on create),
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
  // Revisions on a report that is itself free: the buyer pays only for the
  // included revision requests, the PDF they already have.
  'free-revisions': {
    productEnv: 'STRIPE_FREE_REPORT_REVISIONS_PRODUCT_ID',
    priceEnv: 'STRIPE_FREE_REPORT_REVISIONS_PRICE_ID',
    defaultProductId: '',
    defaultPriceId: '',
    lookupMetadataKind: 'free-revisions',
    fallbackUnitAmount: null,
    currency: 'eur',
  },
  // One more revision round on an order that has run out. Sold from both the
  // anonymous order page and the members area; resolving it here is what
  // keeps those two doors quoting one price.
  'extra-revision': {
    productEnv: 'STRIPE_EXTRA_REVISION_PRODUCT_ID',
    priceEnv: 'STRIPE_EXTRA_REVISION_PRICE_ID',
    defaultProductId: '',
    defaultPriceId: '',
    lookupMetadataKind: 'extra-revision',
    fallbackUnitAmount: extraRevisionFallbackUnitAmount,
    currency: 'eur',
  },
};

const cache = new Map();

// options.products: an already-fetched active product list (with default
// prices expanded), so a caller resolving several metadata-tagged kinds at
// once lists the account's products one time instead of once per kind.
async function getStripePricing(stripe, kind, options = {}) {
  const config = PRICE_CONFIG[kind];
  if (!config) throw new Error(`Unknown Stripe price kind: ${kind}`);

  const cacheKey = `${kind}:${process.env[config.productEnv] || config.defaultProductId}:${process.env[config.priceEnv] || config.defaultPriceId}`;
  const cached = cache.get(cacheKey);
  if (!options.bypassCache && cached && cached.expiresAt > Date.now()) return cached.value;

  const value = await resolveStripePricing(stripe, kind, config, options.products);
  if (!options.bypassCache) {
    cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return value;
}

function revisionsEnabled() {
  return /^(1|true|yes|on)$/i.test(process.env.FORECAST_REVISIONS_ENABLED || '');
}

async function getPublicPricing(stripe, options = {}) {
  // One product listing serves every kind below.
  const products = await listActiveProducts(stripe).catch(() => []);
  const lookup = { ...options, products };
  const [ready, fresh] = await Promise.all([
    getStripePricing(stripe, 'ready', lookup),
    getStripePricing(stripe, 'fresh', lookup),
  ]);
  const pricing = { ready: publicPrice(ready), fresh: publicPrice(fresh), revisionsEnabled: revisionsEnabled() };
  if (!pricing.revisionsEnabled) return pricing;

  // The revisions kinds throw when unconfigured (see resolveStripePricing) —
  // catch per-kind so a half-set-up "ready" tier doesn't hide a working
  // "fresh" one, and vice versa.
  const [readyRevisions, freshRevisions, freeRevisions] = await Promise.all([
    getStripePricing(stripe, 'ready-revisions', lookup).catch(() => null),
    getStripePricing(stripe, 'fresh-revisions', lookup).catch(() => null),
    getStripePricing(stripe, 'free-revisions', lookup).catch(() => null),
  ]);
  pricing.readyRevisions = readyRevisions ? publicRevisionsPrice(readyRevisions) : null;
  pricing.freshRevisions = freshRevisions ? publicRevisionsPrice(freshRevisions) : null;
  pricing.freeRevisions = freeRevisions ? publicRevisionsPrice(freeRevisions) : null;
  // Kept for readers that predate per-tier counts; the ready+/fresh+ number.
  pricing.revisionsIncluded = revisionsIncluded('ready-revisions');
  return pricing;
}

// Resolution order: an explicit product id (env, then the live default), then
// the product tagged with the kind, then an explicit price id, then the
// fallback amount. An id from another Stripe mode is skipped quietly — the
// tag lookup is the expected path under a test key, not an error.
async function resolveStripePricing(stripe, kind, config, products) {
  const explicitProductId = stripeProductId(process.env[config.productEnv]);
  const productId = explicitProductId || stripeProductId(config.defaultProductId);
  if (productId) {
    try {
      const product = await stripe.products.retrieve(productId, { expand: ['default_price'] });
      const price = product.default_price;
      if (price && typeof price === 'object' && stripePriceId(price.id)) {
        return normalizePrice(kind, price, product);
      }
    } catch (err) {
      if (explicitProductId || !isOtherModeError(err)) {
        console.warn(`Stripe ${kind} product pricing lookup failed:`, err.message);
      }
    }
  }
  if (config.lookupMetadataKind) {
    try {
      const product = await findProductByMetadataKind(stripe, config.lookupMetadataKind, products);
      const price = product && product.default_price;
      if (price && typeof price === 'object' && stripePriceId(price.id)) {
        return normalizePrice(kind, price, product);
      }
    } catch (err) {
      console.warn(`Stripe ${kind} metadata product lookup failed:`, err.message);
    }
  }

  const explicitPriceId = stripePriceId(process.env[config.priceEnv]);
  const priceId = explicitPriceId || stripePriceId(config.defaultPriceId);
  if (priceId) {
    try {
      return normalizePrice(kind, await stripe.prices.retrieve(priceId));
    } catch (err) {
      if (explicitPriceId || !isOtherModeError(err)) {
        console.warn(`Stripe ${kind} price lookup failed:`, err.message);
      }
    }
  }

  const fallbackUnitAmount = typeof config.fallbackUnitAmount === 'function'
    ? config.fallbackUnitAmount()
    : config.fallbackUnitAmount;
  if (fallbackUnitAmount == null) {
    throw new Error(
      config.lookupMetadataKind
        ? `No Stripe price configured for "${kind}" — create the product with `
          + `metadata.kind="${config.lookupMetadataKind}" (see scripts/stripe-setup-revisions.mjs), `
          + `or set ${config.productEnv} / ${config.priceEnv} to override`
        : `No Stripe price configured for "${kind}" — set ${config.productEnv} or ${config.priceEnv}`,
    );
  }

  return {
    kind,
    priceId: null,
    unitAmount: fallbackUnitAmount,
    currency: config.currency,
  };
}

// Stripe's wording when a live id is looked up with a test key (or the other
// way round): "No such product: 'prod_…'; a similar object exists in live
// mode, but a test mode key was used to make this request."
function isOtherModeError(err) {
  return /similar object exists in (live|test) mode/i.test(String(err && err.message || ''));
}

async function listActiveProducts(stripe) {
  const products = await stripe.products.list({
    active: true,
    limit: 100,
    expand: ['data.default_price'],
  });
  return products.data;
}

// Finds the active product tagged with the given `kind` in its metadata
// (set by scripts/stripe-setup-revisions.mjs on create) so revisions
// pricing works without ever pasting a product/price id into env vars.
async function findProductByMetadataKind(stripe, metadataKind, products) {
  const list = Array.isArray(products) ? products : await listActiveProducts(stripe);
  return list.find(p => p.metadata && p.metadata.kind === metadataKind) || null;
}

function normalizePrice(kind, price, product) {
  const revisions = Number.parseInt(product?.metadata?.revisions || '', 10);
  return {
    kind,
    priceId: price.id,
    unitAmount: Number(price.unit_amount || 0),
    currency: String(price.currency || 'eur').toLowerCase(),
    revisionsIncluded: revisions > 0 ? revisions : null,
  };
}

function publicRevisionsPrice(price) {
  return { ...publicPrice(price), included: includedRevisions(price) };
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
  const symbol = String(currency).toLowerCase() === 'eur' ? '€' : `${String(currency).toUpperCase()} `;
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
  includedRevisions,
  revisionsEnabled,
  revisionsIncluded,
};
