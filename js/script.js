/* =====================================================
   VALUATUM AI EQUITY REPORTS — Main Script
===================================================== */

// ── Nav scroll ──────────────────────────────────────
(function initNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  const onScroll = () => {
    nav.classList.toggle('scrolled', window.scrollY > 40);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
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
(function initSearch() {
  const inputs = document.querySelectorAll('.search-input');
  inputs.forEach(input => {
    const wrap = input.closest('.search-field-wrap') || input.parentElement;
    const autocomplete = wrap?.parentElement?.querySelector('.search-autocomplete');

    if (autocomplete) {
      input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        if (q.length < 1) { autocomplete.classList.remove('open'); return; }
        const matches = searchableCompanyPages().filter(c =>
          c.ticker.toLowerCase().includes(q) ||
          c.name.toLowerCase().includes(q)
        ).slice(0, 6);
        renderAutocomplete(autocomplete, matches);
        autocomplete.classList.toggle('open', matches.length > 0);
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
        openCompanyPage(item.dataset.url);
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

function renderAutocomplete(container, companies) {
  container.innerHTML = companies.map(c => `
    <button class="autocomplete-item" type="button" data-url="${escapeAttr(c.url)}" role="option">
      <span class="autocomplete-ticker">${escapeHtml(c.ticker)}</span>
      <span class="autocomplete-name">${escapeHtml(c.name)}</span>
      <span class="autocomplete-exchange">${escapeHtml(c.exchange)}</span>
    </button>
  `).join('');
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
  window.location.href = `reports.html?search=${encodeURIComponent(query)}`;
}

function openCompanyPage(url) {
  if (!url) return;
  window.location.href = url;
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

// ── Value pool bars animation ──────────────────────
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

// ── "Generate this report" button (generated company/coverage pages) ─────────
// Entry point into the fresh-report pipeline. The button carries the covered
// company's real SYMBOL.EXCHANGE ticker; exchange/country are derived server-side
// from the ticker suffix, and Stripe Checkout collects the buyer email. The
// coverage price is set server-side (source: 'coverage'), never from the client.
(function initGenerateReportButton() {
  var buttons = document.querySelectorAll('[data-generate-report]');
  if (!buttons.length) return;

  buttons.forEach(function (btn) {
    btn.addEventListener('click', async function (e) {
      e.preventDefault();
      var company = btn.getAttribute('data-company') || '';
      var ticker = btn.getAttribute('data-ticker') || '';
      if (!company || !ticker) return;
      if (btn.dataset.loading === '1') return;

      var label = btn.textContent;
      btn.dataset.loading = '1';
      btn.style.pointerEvents = 'none';
      btn.style.opacity = '0.7';
      btn.textContent = 'Redirecting to secure checkout...';
      trackEvent('fresh_report_order_started', { company: company, ticker: ticker, source: 'coverage' });

      try {
        var res = await fetch('/api/create-fresh-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ company: company, ticker: ticker, source: 'coverage' }),
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
    });
  });
})();
