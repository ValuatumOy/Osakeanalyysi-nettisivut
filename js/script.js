/* =====================================================
   VALUATUM AI EQUITY REPORTS — Main Script
===================================================== */

// ── Un-stick checkout buttons after a bfcache restore ──────────────────
// When a customer hits "back" from Stripe Checkout, browsers often restore
// this page from the back/forward cache instead of reloading it. That
// restores the DOM exactly as it was when they left — still showing
// "Redirecting to secure checkout..." with the button disabled — because no
// script re-runs on a bfcache restore. `pageshow` with `persisted: true`
// fires in that case (unlike a normal load), so use it to reset anything
// still marked as loading.
window.addEventListener('pageshow', function (event) {
  if (!event.persisted) return;
  document.querySelectorAll('[data-loading="1"]').forEach(function (el) {
    el.dataset.loading = '';
    el.style.pointerEvents = '';
    el.style.opacity = '';
    el.disabled = false;
    if (el.dataset.originalLabel) el.textContent = el.dataset.originalLabel;
  });
});

// ── Nav scroll ──────────────────────────────────────
(function initNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  if (!nav.classList.contains('nav--over-hero')) { nav.classList.add('scrolled'); return; }
  const sync = () => nav.classList.toggle('scrolled', window.scrollY > 24);
  sync();
  window.addEventListener('scroll', sync, { passive: true });
})();

// ── Nav sign-in link ────────────────────────────────
// A signed-in member was still being invited to sign in. The token is the
// only site-wide signal we have; the member area itself owns signing out.
(function initNavAccountLink() {
  if (!localStorage.memberToken) return;
  // Pages whose CTA is already the member area do not need a second link to it.
  const hasMemberCta = document.querySelector('[href="members.html"].nav-cta, [href="members.html"].nav-mobile-cta');
  document.querySelectorAll('.nav-signin, .nav-mobile-link:not(.nav-mobile-cta)[href="members.html"]')
    .forEach(link => {
      if (hasMemberCta) link.remove();
      else link.textContent = 'Member area';
    });
})();

// ── Button press ────────────────────────────────────
// A ripple from where the button was actually pressed. Delegated, so it covers
// every button on the page including the ones rendered later.
(function initButtonRipple() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary) return;
    const button = event.target.closest('.btn, .nav-cta, .search-btn');
    if (!button || button.disabled) return;
    const box = button.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    // Reach the farthest corner, so the ripple always fills the button.
    const size = Math.hypot(Math.max(x, box.width - x), Math.max(y, box.height - y)) * 2;
    const ripple = document.createElement('span');
    ripple.className = 'btn-ripple';
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (x - size / 2) + 'px';
    ripple.style.top = (y - size / 2) + 'px';
    ripple.addEventListener('animationend', () => ripple.remove());
    button.appendChild(ripple);
  });
})();

// ── Mobile menu ─────────────────────────────────────
(function initMobileMenu() {
  const btn = document.querySelector('.nav-hamburger');
  const menu = document.getElementById('mobileMenu');
  if (!btn || !menu) return;
  btn.addEventListener('click', () => {
    const open = menu.style.display === 'flex';
    menu.style.display = open ? 'none' : 'flex';
    btn.setAttribute('aria-expanded', !open);
  });
})();

// ── Reveal on scroll ────────────────────────────────
(function initReveal() {
  const io = new IntersectionObserver(
    (entries) => entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('is-visible'); io.unobserve(e.target); }
    }),
    { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
  );
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));
})();

// ── Hero loaded animation ────────────────────────────
(function initHeroLoaded() {
  const hero = document.querySelector('.hero');
  if (!hero) return;
  requestAnimationFrame(() => setTimeout(() => hero.classList.add('hero-loaded'), 100));
})();

// ── FAQ accordion ───────────────────────────────────
(function initFAQ() {
  document.querySelectorAll('.faq-question').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      const isOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item.open').forEach(i => i.classList.remove('open'));
      if (!isOpen) item.classList.add('open');
    });
  });
})();

// ── Search functionality ─────────────────────────────
(function exposeWisdomCompanySearch() {
  const endpoint = '/api/search-companies';
  window.searchWisdomCompanies = async function searchWisdomCompanies(rawQuery) {
    const query = String(rawQuery || '').trim();
    if (!query) return [];
    const response = await fetch(endpoint + '?q=' + encodeURIComponent(query));
    if (!response.ok) throw new Error('Company search returned ' + response.status);
    const data = await response.json();
    return Array.isArray(data.results) ? data.results : [];
  };
})();

(function initSearch() {
  const inputs = document.querySelectorAll('.search-input');
  inputs.forEach(input => {
    const wrap = input.closest('.search-field-wrap') || input.parentElement;
    const autocomplete = wrap?.parentElement?.querySelector('.search-autocomplete');
    let wisdomMatches = [];
    let debounceTimer = null;
    let requestSequence = 0;

    if (autocomplete) {
      input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        const sequence = ++requestSequence;
        wisdomMatches = [];
        if (q.length < 1) {
          autocomplete.innerHTML = '';
          autocomplete.classList.remove('open');
          return;
        }
        const localMatches = searchableCompanyPages().filter(c =>
          c.ticker.toLowerCase().includes(q) ||
          c.name.toLowerCase().includes(q)
        ).slice(0, 6);
        renderAutocomplete(autocomplete, localMatches, wisdomMatches);

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          try {
            const results = await window.searchWisdomCompanies(input.value);
            if (sequence !== requestSequence) return;
            wisdomMatches = results;
          } catch {
            if (sequence !== requestSequence) return;
            wisdomMatches = [];
          }
          const currentQuery = input.value.trim().toLowerCase();
          const currentLocalMatches = searchableCompanyPages().filter(c =>
            c.ticker.toLowerCase().includes(currentQuery) ||
            c.name.toLowerCase().includes(currentQuery)
          ).slice(0, 6);
          renderAutocomplete(autocomplete, currentLocalMatches, wisdomMatches);
        }, 250);
      });

      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          const q = input.value.trim();
          if (q) handleSearch(q);
        }
      });

      document.addEventListener('click', e => {
        if (!wrap?.contains(e.target) && !autocomplete.contains(e.target)) {
          autocomplete.classList.remove('open');
        }
      });

      autocomplete.addEventListener('pointerdown', e => {
        const item = e.target.closest('.autocomplete-item');
        if (!item) return;
        e.preventDefault();
        if (item.dataset.url) {
          openCompanyPage(item.dataset.url);
          return;
        }
        if (item.dataset.freshTicker) {
          openFreshReportCompany({
            companyName: item.dataset.freshName,
            ticker: item.dataset.freshTicker,
          });
        }
      });
    }
  });

  document.querySelectorAll('.search-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.closest('.search-field-wrap, .hero-search-wrap')
        ?.querySelector('.search-input');
      if (input) handleSearch(input.value.trim());
    });
  });
})();

function renderAutocomplete(container, companies, wisdomCompanies = []) {
  const localTickers = new Set(companies.map(c => String(c.ticker || '').toLowerCase()));
  const freshCompanies = wisdomCompanies
    .filter(c => !localTickers.has(String(c.ticker || '').toLowerCase()))
    .slice(0, Math.max(0, 6 - companies.length));
  const localHtml = companies.map(c => `
    <button class="autocomplete-item" type="button" data-url="${escapeAttr(c.url)}" role="option">
      <span class="autocomplete-ticker">${escapeHtml(c.ticker)}</span>
      <span class="autocomplete-name">${escapeHtml(c.name)}</span>
      <span class="autocomplete-exchange">Open company page</span>
    </button>
  `).join('');
  const freshHtml = freshCompanies.map(c => `
    <button class="autocomplete-item autocomplete-item-fresh" type="button" data-fresh-name="${escapeAttr(c.companyName)}" data-fresh-ticker="${escapeAttr(c.ticker)}" role="option">
      <span class="autocomplete-ticker">${escapeHtml(c.ticker)}</span>
      <span class="autocomplete-name">${escapeHtml(c.companyName)}</span>
      <span class="autocomplete-exchange">Generate fresh report</span>
    </button>
  `).join('');
  container.innerHTML = localHtml + freshHtml;
  container.classList.toggle('open', companies.length + freshCompanies.length > 0);
}

function searchableCompanyPages() {
  if (Array.isArray(window.COMPANY_PAGE_CATALOG)) return window.COMPANY_PAGE_CATALOG;
  return [];
}

// ── Homepage company cards from catalog data ──────────────────────
(function initSampleCompanyCards() {
  const cards = document.querySelectorAll('[data-company-card]');
  if (!cards.length) return;

  const pages = searchableCompanyPages();
  cards.forEach(card => {
    const ticker = card.dataset.companyCard?.toLowerCase();
    if (!ticker) return;

    const company = pages.find(c => c.ticker.toLowerCase() === ticker);
    if (!company) return;

    const desc = card.querySelector('[data-company-description]');
    if (desc && company.description) desc.textContent = company.description;

    const image = card.querySelector('.sample-thumbnail-img');
    if (image && company.thumbnail) image.src = company.thumbnail;

    card.addEventListener('click', e => {
      if (e.target.closest('a, button')) return;
      openCompanyPage(company.url);
    });
    card.style.cursor = 'pointer';
  });
})();

function handleSearch(query) {
  if (!query) {
    window.location.href = 'reports.html';
    return;
  }
  const normalized = query.trim().toLowerCase();
  const pages = searchableCompanyPages();
  const exact = pages.find(c =>
    c.ticker.toLowerCase() === normalized ||
    c.name.toLowerCase() === normalized
  );
  const partial = exact || pages.find(c =>
    c.ticker.toLowerCase().includes(normalized) ||
    c.name.toLowerCase().includes(normalized)
  );
  if (partial) {
    openCompanyPage(partial.url);
    return;
  }
  window.location.href = `reports.html?search=${encodeURIComponent(query)}&source=homepage#order-fresh`;
}

function openCompanyPage(url) {
  if (!url) return;
  window.location.href = url;
}

function openFreshReportCompany(company) {
  const params = new URLSearchParams({
    search: company.companyName || company.ticker,
    freshTicker: company.ticker,
    source: 'homepage',
  });
  window.location.href = `reports.html?${params.toString()}#order-fresh`;
}

function escapeAttr(value) {
  return String(value || '').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Value driver bars animation ──────────────────────
(function initValuePools() {
  const bars = document.querySelectorAll('.pool-fill[data-pct]');
  if (!bars.length) return;
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        const pct = e.target.dataset.pct;
        e.target.style.width = pct + '%';
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.3 });
  bars.forEach(b => { b.style.width = '0%'; io.observe(b); });
})();

// ── Locked section click ─────────────────────────────
(function initLockedSections() {
  document.querySelectorAll('.locked-cta, .locked-section').forEach(el => {
    el.addEventListener('click', () => openEmailOrCheckout());
  });
  document.querySelectorAll('[data-unlock]').forEach(el => {
    el.addEventListener('click', () => openEmailOrCheckout());
  });
})();

function openEmailOrCheckout() {
  const modal = document.getElementById('emailModal');
  if (modal) {
    modal.classList.add('open');
    trackEvent('locked_section_clicked');
  } else {
    const pricingCard = document.querySelector('.sticky-cta-btn, .pricing-card-cta');
    if (pricingCard) pricingCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function getCurrentTicker() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('ticker');
  if (fromUrl) return fromUrl.toUpperCase();

  const fromPage = document.querySelector('[data-company-ticker]')?.textContent?.trim();
  return fromPage || 'TSLA';
}

function getCheckoutUrl(plan = 'single') {
  const pathPrefix = window.location.pathname.includes('/checkout/') ? '' : 'checkout/';
  const params = new URLSearchParams({
    plan,
    ticker: getCurrentTicker(),
  });
  return `${pathPrefix}success.html?${params.toString()}`;
}

function startCheckout(plan = 'single', props = {}) {
  const ticker = getCurrentTicker();
  trackEvent('checkout_started', { plan, ticker, ...props });
  showToast('Opening secure checkout...');
  window.setTimeout(() => {
    window.location.href = getCheckoutUrl(plan);
  }, 450);
}

// ── Email capture modal ─────────────────────────────
(function initEmailModal() {
  const modal = document.getElementById('emailModal');
  if (!modal) return;
  const form = modal.querySelector('.modal-form');
  const closeBtn = modal.querySelector('.modal-close');
  const skipBtn = modal.querySelector('.modal-skip button');

  const close = () => modal.classList.remove('open');

  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  closeBtn?.addEventListener('click', close);
  skipBtn?.addEventListener('click', () => {
    close();
    trackEvent('email_capture_skipped');
  });

  form?.addEventListener('submit', e => {
    e.preventDefault();
    const email = form.querySelector('input[type="email"]')?.value;
    if (email) {
      const purpose = modal.dataset.modalPurpose || 'save_report';
      trackEvent('email_submitted', { email, purpose });
      close();
      if (purpose === 'checkout') {
        startCheckout('single', { source: 'email_modal', email });
      } else {
        showToast('Report saved! We\'ll email you updates.');
      }
    }
  });

  document.querySelectorAll('[data-email-trigger]').forEach(el => {
    el.addEventListener('click', () => modal.classList.add('open'));
  });
})();

// ── Toast notification ───────────────────────────────
function showToast(message) {
  const existing = document.getElementById('toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.style.cssText = `
    position:fixed; bottom:2rem; left:50%; transform:translateX(-50%);
    background:var(--charcoal); color:white; padding:0.85rem 1.5rem;
    border-radius:var(--r-pill); font-size:0.875rem; z-index:500;
    box-shadow:0 8px 24px rgba(0,0,0,0.2); max-width:90vw; text-align:center;
    animation: toastIn 0.3s ease;
  `;
  const style = document.createElement('style');
  style.textContent = '@keyframes toastIn { from { opacity:0; transform:translateX(-50%) translateY(8px); } to { opacity:1; transform:translateX(-50%); } }';
  document.head.appendChild(style);
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ── Analytics stub ────────────────────────────────────
function trackEvent(event, props = {}) {
  console.log('[Analytics]', event, props);
  // TODO: replace with real analytics (GA4, Mixpanel, etc.)
  // gtag('event', event, props);
}

// ── Report nav active link ─────────────────────────
(function initReportNav() {
  const links = document.querySelectorAll('.sidebar-nav-link, .report-nav-link');
  if (!links.length) return;
  const sections = [];
  links.forEach(link => {
    const id = link.getAttribute('href')?.replace('#', '');
    if (id) {
      const el = document.getElementById(id);
      if (el) sections.push({ el, link });
    }
  });
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        links.forEach(l => l.classList.remove('active'));
        const found = sections.find(s => s.el === e.target);
        if (found) found.link.classList.add('active');
      }
    });
  }, { rootMargin: '-20% 0px -70% 0px' });
  sections.forEach(s => io.observe(s.el));
})();

// ── Mockup bar animation ──────────────────────────
(function initMockupBars() {
  document.querySelectorAll('.mockup-bar-fill[data-w]').forEach(bar => {
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          bar.style.width = bar.dataset.w;
          io.unobserve(bar);
        }
      });
    }, { threshold: 0.3 });
    bar.style.width = '0';
    io.observe(bar);
  });
})();

// ── Checkout button placeholder ───────────────────
// Pricing config hydration
(function initPricingFromConfig() {
  if (typeof PRICING_CONFIG === 'undefined') return;

  const formatPrice = (value) => {
    if (value === null || value === undefined) return 'Custom';
    const digits = Number.isInteger(value) ? 0 : 2;
    return PRICING_CONFIG.currencySymbol + Number(value).toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  };

  document.querySelectorAll('.pricing-card').forEach(card => {
    const nameEl = card.querySelector('.pricing-name');
    if (!nameEl) return;

    const tier = PRICING_CONFIG.tiers.find(t => t.name === nameEl.textContent.trim());
    if (!tier) return;

    const displayPrice = PRICING_CONFIG.launchMode && tier.launchPrice != null
      ? tier.launchPrice
      : tier.price;

    const priceEl = card.querySelector('.pricing-price-main');
    if (priceEl) priceEl.textContent = formatPrice(displayPrice);

    const launchEl = card.querySelector('.pricing-price-launch');
    if (launchEl && tier.launchPrice != null) launchEl.textContent = formatPrice(tier.price);

    const descEl = card.querySelector('.pricing-desc');
    if (descEl) descEl.textContent = tier.description;

    const featureList = card.querySelector('.pricing-features-list');
    if (featureList) {
      featureList.innerHTML = tier.features.map(feature => `<li>${feature}</li>`).join('');
    }

    const cta = card.querySelector('.pricing-card-cta');
    if (cta) {
      cta.textContent = tier.comingSoon ? 'Coming soon' : tier.cta;
      if (tier.comingSoon) {
        cta.setAttribute('disabled', '');
        cta.removeAttribute('data-checkout');
      } else if (tier.ctaHref === '#checkout') {
        cta.setAttribute('data-checkout', tier.id);
      } else if (cta.tagName === 'A') {
        cta.setAttribute('href', tier.ctaHref);
      }
    }
  });
})();

(function initCheckout() {
  document.querySelectorAll('[data-checkout]').forEach(btn => {
    btn.addEventListener('click', () => {
      const plan = btn.dataset.checkout;
      startCheckout(plan);
    });
  });
})();

// ── Report page: load company from URL ─────────────
(function initReportPage() {
  const isPreviewPage = document.getElementById('report-preview-page');
  if (!isPreviewPage || typeof TESLA_PREVIEW === 'undefined') return;

  const params = new URLSearchParams(window.location.search);
  const ticker = params.get('ticker') || 'TSLA';
  const company = COMPANIES.find(c => c.ticker.toLowerCase() === ticker.toLowerCase())
    || COMPANIES.find(c => c.id === 'tsla');

  if (!company) return;

  // Update company name/ticker displays
  document.querySelectorAll('[data-company-name]').forEach(el => el.textContent = company.name);
  document.querySelectorAll('[data-company-ticker]').forEach(el => el.textContent = company.ticker);
  document.querySelectorAll('[data-company-exchange]').forEach(el => el.textContent = company.exchange);
  document.querySelectorAll('[data-company-country]').forEach(el => el.textContent = company.country);
  document.querySelectorAll('[data-company-sector]').forEach(el => el.textContent = company.sector);
  document.querySelectorAll('[data-company-price]').forEach(el => el.textContent = `${company.currency === 'EUR' ? '€' : '$'}${company.sharePrice.toFixed(2)}`);

  // Update page title
  document.title = `${company.name} (${company.ticker}) AI Equity Report | Valuatum`;

  trackEvent('preview_viewed', { ticker: company.ticker, exchange: company.exchange });
})();

// ── Revisions choice modal (shared by every "buy report" entry point below) ──
// Lets a buyer pick standard vs. "+ Revisions" before checkout starts. Built
// lazily as a single reused overlay, since it needs to appear on 1000+
// generated pages with per-trigger pricing rather than being baked into
// every page's markup.
function formatEurAmount(cents) {
  var amount = cents / 100;
  return '€' + amount.toFixed(Number.isInteger(amount) ? 0 : 2);
}

function getRevisionsChoice(kind, revisable) {
  var pricing = window.SITE_PUBLIC_PRICING;
  var unavailable = { available: false };
  if (!pricing || !pricing.revisionsEnabled) return unavailable;
  if (kind === 'ready' && revisable === false) return unavailable;
  var base = kind === 'fresh' ? pricing.fresh : pricing.ready;
  var tier = kind === 'fresh' ? pricing.freshRevisions : pricing.readyRevisions;
  if (!base || !tier) return unavailable;
  return {
    available: true,
    basePrice: base.unitAmount,
    revisionsPrice: tier.unitAmount,
    revisionsCount: pricing.revisionsIncluded || 3,
  };
}

function closeRevisionsModal() {
  var modal = document.getElementById('revisionsModal');
  if (modal) modal.classList.remove('open');
}

function openRevisionsModal(choice, onChoose) {
  var modal = document.getElementById('revisionsModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'revisionsModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'revisionsModalTitle');
    modal.innerHTML =
      '<div class="modal">' +
        '<div class="modal-close" id="revisionsModalClose">&times;</div>' +
        '<div class="modal-title" id="revisionsModalTitle">Choose your report</div>' +
        '<div class="modal-body">Buy the standard report, or add report revisions now.</div>' +
        '<div class="modal-options">' +
          '<label class="modal-option"><input type="radio" name="revisionsChoice" value="0">' +
            '<span class="modal-option-text"><span class="modal-option-title"><span>Standard</span><span id="revisionsModalBasePrice"></span></span>' +
            '<span class="modal-option-desc">The complete AI equity report, delivered by email.</span></span></label>' +
          '<label class="modal-option"><input type="radio" name="revisionsChoice" value="1">' +
            '<span class="modal-option-text"><span class="modal-option-title"><span>+ Revisions</span><span id="revisionsModalRevisionsPrice"></span></span>' +
            '<span class="modal-option-desc" id="revisionsModalRevisionsDesc"></span></span></label>' +
        '</div>' +
        '<button type="button" class="btn btn-primary modal-submit" id="revisionsModalContinue">Continue to checkout</button>' +
      '</div>';
    document.body.appendChild(modal);

    modal.addEventListener('click', function (e) { if (e.target === modal) closeRevisionsModal(); });
    modal.querySelector('#revisionsModalClose').addEventListener('click', closeRevisionsModal);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal.classList.contains('open')) closeRevisionsModal();
    });
    modal.querySelectorAll('.modal-option').forEach(function (option) {
      option.addEventListener('click', function () {
        modal.querySelectorAll('.modal-option').forEach(function (o) { o.classList.remove('selected'); });
        option.classList.add('selected');
      });
    });
  }

  modal.querySelector('#revisionsModalBasePrice').textContent = formatEurAmount(choice.basePrice);
  modal.querySelector('#revisionsModalRevisionsPrice').textContent = formatEurAmount(choice.revisionsPrice);
  modal.querySelector('#revisionsModalRevisionsDesc').textContent =
    'Includes ' + choice.revisionsCount + ' report-revision requests after delivery. Describe a change in plain ' +
    'language and we\'ll update the forecast and regenerate the report.';

  modal.querySelectorAll('.modal-option').forEach(function (option, i) {
    option.classList.toggle('selected', i === 0);
    option.querySelector('input').checked = i === 0;
  });

  // Overwriting .onclick (rather than addEventListener) keeps this a single
  // handler even though the same modal element is reused across many opens.
  modal.querySelector('#revisionsModalContinue').onclick = function () {
    var checked = modal.querySelector('input[name="revisionsChoice"]:checked');
    closeRevisionsModal();
    onChoose(checked && checked.value === '1');
  };

  modal.classList.add('open');
}

// ── "Generate fresh report" button (generated company/coverage pages) ─────────
// Entry point into the fresh-report pipeline. The button carries the covered
// company's real SYMBOL.EXCHANGE ticker; exchange/country are derived server-side
// from the ticker suffix, and Stripe Checkout collects the buyer email. The
// coverage price is set server-side (source: 'coverage'), never from the client.
(function initGenerateReportButton() {
  var buttons = document.querySelectorAll('[data-generate-report]');
  if (!buttons.length) return;

  async function submitFreshReport(btn, company, ticker, withRevisions) {
    var label = btn.textContent;
    btn.dataset.loading = '1';
    btn.dataset.originalLabel = label;
    btn.style.pointerEvents = 'none';
    btn.style.opacity = '0.7';
    btn.textContent = 'Redirecting to secure checkout...';
    trackEvent('fresh_report_order_started', { company: company, ticker: ticker, source: 'coverage', withRevisions: withRevisions });

    try {
      var res = await fetch('/api/create-fresh-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company: company, ticker: ticker, source: 'coverage', withRevisions: withRevisions }),
      });
      var data = await res.json();
      if (data && data.url) {
        trackEvent('stripe_checkout_clicked', { type: 'fresh', company: company, source: 'coverage' });
        window.location.href = data.url;
        return;
      }
    } catch (err) { /* fall through to reset below */ }

    btn.dataset.loading = '';
    btn.style.pointerEvents = '';
    btn.style.opacity = '';
    btn.textContent = label;
    alert('Could not start checkout. Please try again or contact contact26@valuatum.com.');
  }

  buttons.forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      var company = btn.getAttribute('data-company') || '';
      var ticker = btn.getAttribute('data-ticker') || '';
      if (!company || !ticker) return;
      if (btn.dataset.loading === '1') return;

      var choice = getRevisionsChoice('fresh');
      if (choice.available) {
        openRevisionsModal(choice, function (withRevisions) { submitFreshReport(btn, company, ticker, withRevisions); });
      } else {
        submitFreshReport(btn, company, ticker, false);
      }
    });
  });
})();

// Direct Stripe checkout entry points on generated company pages.
async function submitReadyReportCheckout(link, reportId, withRevisions) {
  var label = link.textContent;
  link.dataset.loading = '1';
  link.dataset.originalLabel = label;
  link.style.pointerEvents = 'none';
  link.style.opacity = '0.7';
  link.textContent = 'Redirecting to secure checkout...';
  trackEvent('ready_report_checkout_started', { reportId: reportId, source: 'company_page', withRevisions: withRevisions });

  try {
    var res = await fetch('/api/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportId: reportId, withRevisions: withRevisions }),
    });
    var data = await res.json();
    if (data && data.url) {
      trackEvent('stripe_checkout_clicked', { type: 'ready', reportId: reportId, source: 'company_page' });
      window.location.href = data.url;
      return;
    }
  } catch (err) { /* fall through to reset below */ }

  link.dataset.loading = '';
  link.style.pointerEvents = '';
  link.style.opacity = '';
  link.textContent = label;
  alert('Could not start checkout. Please try again or contact contact26@valuatum.com.');
}

function bindReadyReportCheckoutLink(link) {
  var href = link.getAttribute('href') || '';
  var match = href.match(/#report-([^#?&]+)/);
  if (!match) return;
  var reportId = match[1];
  var revisable = link.getAttribute('data-revisable') === '1';

  link.addEventListener('click', function (e) {
    e.preventDefault();
    if (link.dataset.loading === '1') return;

    var choice = getRevisionsChoice('ready', revisable);
    if (choice.available) {
      openRevisionsModal(choice, function (withRevisions) { submitReadyReportCheckout(link, reportId, withRevisions); });
    } else {
      submitReadyReportCheckout(link, reportId, false);
    }
  });
}

(function initCompanyPageCheckoutLinks() {
  document.querySelectorAll('a[href*="/reports.html#report-"], a[href^="reports.html#report-"]')
    .forEach(bindReadyReportCheckoutLink);

  document.querySelectorAll('a[href="#generate"]').forEach(function (link) {
    if (!/generate/i.test(link.textContent || '')) return;
    link.addEventListener('click', function (e) {
      var checkoutButton = document.querySelector('[data-generate-report]');
      if (!checkoutButton) return;
      e.preventDefault();
      checkoutButton.click();
    });
  });
})();

// Keep visible sales-page prices in sync with Stripe product default prices.
(function initStripeBackedPublicPricing() {
  var fallbackPricing = {
    ready: { label: '\u20ac20.00', shortLabel: '\u20ac20' },
    fresh: { label: '\u20ac50.00', shortLabel: '\u20ac50' },
  };
  window.SITE_PUBLIC_PRICING = fallbackPricing;

  function replacePriceText(text, pricing) {
    return String(text || '')
      .replace(/\u20ac20\.00/g, pricing.ready.label)
      .replace(/\u20ac20(?![\d.])/g, pricing.ready.shortLabel)
      .replace(/\u20ac50\.00/g, pricing.fresh.label)
      .replace(/\u20ac50(?![\d.])/g, pricing.fresh.shortLabel);
  }

  function applyPricing(pricing) {
    if (!pricing || !pricing.ready || !pricing.fresh) return;
    window.SITE_PUBLIC_PRICING = pricing;

    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentElement;
        if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        return /(\u20ac20|\u20ac50)/.test(node.nodeValue)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });

    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (node) {
      node.nodeValue = replacePriceText(node.nodeValue, pricing);
    });

    window.dispatchEvent(new CustomEvent('site:pricing', { detail: pricing }));
  }

  window.applyStripeBackedPricing = applyPricing;
  window.SITE_PUBLIC_PRICING_PROMISE = fetch('/api/pricing')
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (pricing) {
      if (pricing) applyPricing(pricing);
      return pricing || fallbackPricing;
    })
    .catch(function () { return fallbackPricing; });
})();
