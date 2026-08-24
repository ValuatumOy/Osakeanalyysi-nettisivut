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

  function row(a, rank) {
    var published = new Date(a.publishedAt);
    var date = isNaN(published) ? '' : published.toISOString().slice(0, 10);
    var cta = a.publicFree
      ? '<button class="btn btn-primary btn-sm" data-free="' + esc(a.genId) + '">Read free</button>'
      : (a.priceEur > 0
          ? '<button class="btn btn-primary btn-sm" data-buy="' + esc(a.genId) + '">Buy for €' + a.priceEur + '</button>'
          : '')
        + '<a class="btn btn-outline-dark btn-sm" href="/members.html">Sign in to read</a>';

    return '<div class="store-row">'
      + '<div class="store-row-main">'
        + '<div class="store-row-title"><span class="store-rank">' + rank + '</span>'
          + '<span class="store-kind store-kind--analyst">Analyst report</span>' + esc(a.analyst) + '</div>'
        + '<div class="store-row-meta">' + scoreCell(a)
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

  function load() {
    fetch(MEMBERS_API + '/analyses?companyId=' + encodeURIComponent(ticker))
      .then(function (r) { return r.ok ? r.json() : { analyses: [] }; })
      .catch(function () { return { analyses: [] }; })
      .then(function (data) {
        // Already ranked by the API (server/members/ranking.js) -- never re-sort here.
        var list = (data.analyses || []).filter(function (a) {
          return String(a.companyId || '').trim().toUpperCase() === ticker;
        });
        if (!list.length) return; // nobody has covered this company; section stays hidden
        listEl.innerHTML = list.map(function (a, i) { return row(a, i + 1); }).join('');
        var label = list.length === 1 ? '1 analyst report' : list.length + ' analyst reports';
        if (countEl) countEl.textContent = label;
        mount.hidden = false;

        // The section sits below the report body, so without this the marketplace is only
        // findable by scrolling past the whole thing. The button carries the count because
        // "3 analyst reports" is a reason to click and "Analyst reports" is not.
        var jump = document.querySelector('[data-analyst-jump]');
        if (jump) {
          jump.textContent = label;
          var free = list.filter(function (a) { return a.publicFree; }).length;
          if (free) jump.setAttribute('data-free-count', String(free));
          jump.hidden = false;
        }
      });
  }

  listEl.addEventListener('click', function (ev) {
    var freeBtn = ev.target.closest('[data-free]');
    if (freeBtn) { openFree(freeBtn.getAttribute('data-free'), freeBtn); return; }
    var buyBtn = ev.target.closest('[data-buy]');
    if (buyBtn) buy(buyBtn.getAttribute('data-buy'), buyBtn);
  });

  collectPurchase();
  load();
}());
