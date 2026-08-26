/*
 * Analyst reports published on top of one company's engine report.
 *
 * This is the public, logged-out surface for the analyst layer. It used to be
 * report-store.html, a second catalogue in the nav that showed every company at once; the
 * page was retired because with no analyst published it duplicated reports.html and told
 * people to go there. What it also was, though, was the only caller of three members-API
 * endpoints that exist for readers with no account:
 *
 *   GET  /analyses/{genId}/free              an administrator's public free window
 *   POST /analyses/{genId}/buy-checkout      buying one without an account
 *   GET  /analyses/{genId}/purchased         collecting it after Stripe
 *
 * Those are the income side of the analyst programme, so they belong on the page for the
 * company the report is about rather than in a separate shop. Scoped to one company, this
 * needs no company filter, no analyst filter and no search: the page already is the filter.
 *
 * The section stays hidden until the API returns an analysis for this company, so a company
 * nobody has covered shows nothing at all, and the first published report lights it up with
 * no deploy.
 *
 * Mount:  <section data-analyst-reports data-ticker="NOKIA.HE" hidden>…</section>
 */
(function () {
  'use strict';

  var mount = document.querySelector('[data-analyst-reports]');
  if (!mount) return;

  var ticker = String(mount.getAttribute('data-ticker') || '').trim().toUpperCase();
  if (!ticker) return;
  var companyName = String(mount.getAttribute('data-company') || '').trim() || ticker;

  // Matched to the stage by hostname, so the test site never buys from, or pays into, the
  // live member system.
  var MEMBERS_API = /^(www\.)?aiequityreports\.com$/.test(location.hostname)
    ? 'https://members.aiequityreports.com'
    : 'https://members-test.aiequityreports.com';

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  var listEl = mount.querySelector('[data-analyst-list]');
  var bannerEl = mount.querySelector('[data-analyst-banner]');
  var countEl = mount.querySelector('[data-analyst-count]');

  function scoreCell(a) {
    return a.reviewCount
      ? '<span class="store-score">' + Number(a.peerScore).toFixed(1) + ' / 5</span>'
        + ' <span>from ' + a.reviewCount + ' review' + (a.reviewCount === 1 ? '' : 's') + '</span>'
      : '<span class="store-noscore">Not reviewed yet</span>';
  }

  // publicFree is the window an administrator opened by hand -- the only one a logged-out
  // visitor may open. `free` alone is the analyst's own decay, which spares a member a read
  // but does not open the document publicly.
  function priceCell(a) {
    if (a.publicFree) return '<span class="pill-free">Free to read</span>';
    if (a.free) return '<span class="pill-free">Free for members</span>';
    return a.priceEur > 0 ? '€' + a.priceEur : 'Costs one monthly read';
  }

  var RATING_CLASS = { BUY: 'rating-buy', HOLD: 'rating-hold', SELL: 'rating-sell' };

  // The analyst's own call, as the engine issued it for their job. Null on anything
  // published before GET /analyses carried it, so this renders nothing rather than guessing.
  function callCell(a) {
    if (!a.recommendation) return '';
    var cls = RATING_CLASS[a.recommendation] || '';
    return '<span class="analyst-call ' + cls + '">' + esc(a.recommendation) + '</span>'
      + (a.targetPrice ? '<span class="analyst-target">' + esc(a.targetPrice) + '</span>' : '')
      + '<span class="sep">·</span>';
  }

  function row(a, rank) {
    var published = new Date(a.publishedAt);
    var date = isNaN(published) ? '' : published.toISOString().slice(0, 10);
    var cta = a.publicFree
      ? '<button class="btn btn-primary btn-sm" data-free="' + esc(a.genId) + '">Read free</button>'
      : (a.priceEur > 0
          ? '<button class="btn btn-primary btn-sm" data-buy="' + esc(a.genId) + '">Buy for €' + a.priceEur + '</button>'
          : '')
        + '<a class="btn btn-outline-dark btn-sm" href="/members.html">Sign in to read</a>';
    cta += '<button class="btn btn-outline-dark btn-sm" data-fork="' + esc(a.genId) + '"'
      + ' title="Buy this analysis with revision rounds and steer it yourself">Build on this</button>';

  // The analyst's own profile link, when they have given one. A published call
  // with a name on it is more checkable if the name goes somewhere.
  function linkedinCell(a) {
    if (!a.analystLinkedin) return '';
    return ' <a class="analyst-linkedin" href="' + esc(a.analystLinkedin) + '"'
      + ' target="_blank" rel="noopener nofollow"'
      + ' aria-label="' + esc(a.analyst) + ' on LinkedIn" title="' + esc(a.analyst) + ' on LinkedIn">'
      + '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">'
      + '<path fill="currentColor" d="M4.98 3.5A2.5 2.5 0 1 1 0 3.5a2.5 2.5 0 0 1 4.98 0zM.5 8h4V24h-4V8zm7.5 0h3.8v2.2h.05c.53-1 1.83-2.2 3.77-2.2 4.03 0 4.78 2.65 4.78 6.1V24h-4v-7.1c0-1.7-.03-3.87-2.36-3.87-2.36 0-2.72 1.84-2.72 3.75V24H8V8z"/>'
      + '</svg></a>';
  }

    return '<div class="store-row">'
      + '<div class="store-row-main">'
        + '<div class="store-row-title"><span class="store-rank">' + rank + '</span>'
          + '<span class="store-kind store-kind--analyst">Analyst report</span>' + esc(a.analyst)
          + linkedinCell(a) + '</div>'
        + '<div class="store-row-meta">' + callCell(a) + scoreCell(a)
          + '<span class="sep">·</span>' + priceCell(a)
          + (date ? '<span class="sep">·</span>published ' + date : '') + '</div>'
      + '</div>'
      + '<div class="store-row-cta">' + cta + '</div>'
    + '</div>';
  }

  // No account needed: the API only answers for an analysis an administrator has put in a
  // free window, and hands back a short-lived signed URL.
  function openFree(genId, button) {
    var label = button.textContent;
    button.disabled = true;
    button.textContent = 'Opening…';
    fetch(MEMBERS_API + '/analyses/' + encodeURIComponent(genId) + '/free')
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (res.ok && data && data.url) {
            window.open(data.url, '_blank', 'noopener');
            button.textContent = label;
          } else {
            button.textContent = res.status === 403 ? 'No longer free' : 'Not available';
          }
        });
      })
      .catch(function () { button.textContent = 'Not available'; })
      .then(function () { button.disabled = false; });
  }

  // Buying needs no account: the analyst set the price, Stripe takes the payment, and the
  // checkout session id is the receipt that opens the PDF.
  // Same shape as buy(), against the fork checkout: what comes back is the
  // buyer's own report to revise rather than a copy of this one.
  function fork(genId, button) {
    button.disabled = true;
    button.textContent = 'Opening checkout…';
    fetch(MEMBERS_API + '/analyses/' + encodeURIComponent(genId) + '/fork-checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ returnTo: location.origin + location.pathname }),
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (res.ok && data && data.url) { location.href = data.url; return; }
          button.textContent = (data && data.error) || 'Not available';
          button.disabled = false;
        });
      })
      .catch(function () {
        button.textContent = 'Not available';
        button.disabled = false;
      });
  }

  function buy(genId, button) {
    button.disabled = true;
    button.textContent = 'Opening checkout…';
    fetch(MEMBERS_API + '/analyses/' + encodeURIComponent(genId) + '/buy-checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ returnTo: location.origin + location.pathname }),
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (res.ok && data && data.url) { location.href = data.url; return; }
          button.textContent = (data && data.error) || 'Not available';
          button.disabled = false;
        });
      })
      .catch(function () {
        button.textContent = 'Not available';
        button.disabled = false;
      });
  }

  // Coming back from Stripe: hand over what was paid for, once.
  function collectPurchase() {
    var params = new URLSearchParams(location.search);
    var genId = params.get('bought');
    var sessionId = params.get('session_id');
    if (!genId || genId === 'cancelled' || !sessionId || !bannerEl) return;

    mount.hidden = false;
    bannerEl.hidden = false;
    bannerEl.textContent = 'Confirming your purchase…';
    fetch(MEMBERS_API + '/analyses/' + encodeURIComponent(genId) + '/purchased?session_id=' + encodeURIComponent(sessionId))
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (res.ok && data && data.url) {
            bannerEl.innerHTML = 'Thank you. Your copy of <strong>' + esc(data.companyId)
              + '</strong> by ' + esc(data.analyst) + ' is ready. ';
            var link = document.createElement('a');
            link.href = data.url;
            link.target = '_blank';
            link.rel = 'noopener';
            link.className = 'btn btn-primary btn-sm';
            link.textContent = 'Download the PDF';
            bannerEl.appendChild(link);
            window.open(data.url, '_blank', 'noopener');
          } else {
            bannerEl.textContent = (data && data.error) || 'That purchase could not be confirmed.';
          }
        });
      })
      .catch(function () { bannerEl.textContent = 'That purchase could not be confirmed.'; });
  }

  var jump = document.querySelector('[data-analyst-jump]');

  // Nobody has covered this company yet. Saying so beats an absent section: it tells a
  // reader the layer exists and is empty here, rather than leaving them to wonder whether
  // the site has one at all.
  function emptyState() {
    return '<div class="store-empty">'
      + '<p><strong>No analyst has published a report on ' + esc(companyName) + ' yet.</strong></p>'
      + '<p>When one does it appears here: this company\'s Valuatum report re-run with that '
      + 'analyst\'s own assumptions and instructions, published under their name and dated. '
      + 'Reports are ordered by what other analysts said the work added over the engine\'s '
      + 'report, scored out of five by people who had to read it to say so.</p>'
      + '<p><a href="/analysts.html">How the analyst programme works</a></p>'
      + '</div>';
  }

  // A failed request is not the same statement as "nobody has published one", and on a site
  // that publishes ratings the difference is worth the extra branch.
  function errorState() {
    return '<div class="store-empty"><p>Analyst reports could not be loaded just now. '
      + 'Please try again shortly.</p></div>';
  }

  // The standing intro explains what an analyst report is; so does the empty state. Showing
  // both means reading the same explanation twice on a company nobody has covered.
  var noteEl = mount.querySelector('.store-note');
  function showNote(on) { if (noteEl) noteEl.hidden = !on; }

  function paint(list, failed) {
    if (failed) {
      listEl.innerHTML = errorState();
      showNote(true);
      if (countEl) countEl.textContent = '';
      if (jump) jump.textContent = 'Analyst reports';
      return;
    }
    if (!list.length) {
      listEl.innerHTML = emptyState();
      showNote(false);
      if (countEl) countEl.textContent = 'None yet';
      if (jump) jump.textContent = 'Analyst reports';
      return;
    }
    showNote(true);
    listEl.innerHTML = list.map(function (a, i) { return row(a, i + 1); }).join('');
    // "3 analyst reports" is a reason to click; "Analyst reports" is not.
    var label = list.length === 1 ? '1 analyst report' : list.length + ' analyst reports';
    if (countEl) countEl.textContent = label;
    if (jump) {
      jump.textContent = label;
      var free = list.filter(function (a) { return a.publicFree; }).length;
      if (free) jump.setAttribute('data-free-count', String(free));
    }
  }

  function load() {
    fetch(MEMBERS_API + '/analyses?companyId=' + encodeURIComponent(ticker))
      .then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (data) {
        // Already ranked by the API (server/members/ranking.js) -- never re-sort here.
        paint((data.analyses || []).filter(function (a) {
          return String(a.companyId || '').trim().toUpperCase() === ticker;
        }), false);
      })
      .catch(function () { paint([], true); });
  }

  listEl.addEventListener('click', function (ev) {
    var freeBtn = ev.target.closest('[data-free]');
    if (freeBtn) { openFree(freeBtn.getAttribute('data-free'), freeBtn); return; }
    var buyBtn = ev.target.closest('[data-buy]');
    if (buyBtn) { buy(buyBtn.getAttribute('data-buy'), buyBtn); return; }
    var forkBtn = ev.target.closest('[data-fork]');
    if (forkBtn) fork(forkBtn.getAttribute('data-fork'), forkBtn);
  });

  collectPurchase();
  load();
}());
