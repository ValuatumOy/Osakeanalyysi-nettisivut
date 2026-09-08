// Drives /order/index.html. The Stripe checkout session id in the URL is the
// bearer token, same trust model as /api/report-download — see
// api/order-status.js / api/order-revision.js.
(function () {
  const POLL_MS = 8000;

  function show(id) { document.getElementById(id).style.display = ''; }
  function hide(id) { document.getElementById(id).style.display = 'none'; }
  function hideAll() {
    ['stateProgress', 'stateDelivered', 'stateError'].forEach(hide);
  }

  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session_id');

  // Two kinds of order land on this page. A paying buyer carries a Stripe
  // checkout session id, verified by the /api/* proxies. A member's own
  // generation has a plain UUID and no payment to verify — it is authenticated
  // by the member token the member area stored, against the members API. Same
  // payload either way, so everything below this point is unchanged.
  const MEMBER_GEN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const memberToken = () => window.localStorage.memberToken || '';
  const isMemberRun = () => MEMBER_GEN_ID.test(sessionId || '') && Boolean(memberToken());
  const MEMBERS_API = /^(www\.)?aiequityreports\.com$/.test(location.hostname)
    ? 'https://members.aiequityreports.com'
    : 'https://members-test.aiequityreports.com';

  // A third way in: the admin, from the catalog on /admin/, reading any
  // order's revision history — the forecast writeups and change memos that
  // are otherwise visible only to the customer who asked for them. The admin
  // page's password is in localStorage on this same origin; the API checks
  // it. Read-only: every control that would act as the customer stays hidden.
  const isAdminView = params.get('admin') === '1';
  const adminPassword = () => window.localStorage.aerAdminPassword || '';
  const ADMIN_API = window.localStorage.aerAdminApiBase
    || (location.hostname.startsWith('test.') || !/aiequityreports\.com$/.test(location.hostname)
      ? 'https://api-test.aiequityreports.com'
      : 'https://api.aiequityreports.com');

  function fetchOrderState() {
    if (isAdminView) {
      return fetch(ADMIN_API + '/api/admin/orders/' + encodeURIComponent(sessionId), {
        headers: { authorization: 'Bearer ' + adminPassword() },
      });
    }
    if (!isMemberRun()) {
      return fetch('/api/order-status?session_id=' + encodeURIComponent(sessionId));
    }
    return fetch(MEMBERS_API + '/generations/' + encodeURIComponent(sessionId) + '/order', {
      headers: { authorization: 'Bearer ' + memberToken() },
    });
  }

  // Buying more rounds, from whichever side of the wall this order lives on. A
  // one-off buyer had no way at all: the page told them they were out and
  // stopped there.
  function postBuyRounds(rounds) {
    if (!isMemberRun()) {
      return fetch('/api/order-revision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, buyRounds: true, rounds: rounds }),
      });
    }
    return fetch(MEMBERS_API + '/generations/' + encodeURIComponent(sessionId) + '/revisions-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + memberToken() },
      body: JSON.stringify({ rounds: rounds, returnTo: location.origin + location.pathname }),
    });
  }

  async function buyMoreRounds(button) {
    const answer = window.prompt('How many more revision rounds?', '2');
    if (answer === null) return;
    const rounds = Number(answer);
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) {
      window.alert('Give a whole number of rounds, 1 to 10.');
      return;
    }
    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Opening checkout…';
    try {
      const res = await postBuyRounds(rounds);
      const data = await res.json().catch(function () { return null; });
      if (res.ok && data && data.url) { location.href = data.url; return; }
      window.alert((data && data.error) || 'Could not start the checkout.');
    } catch (err) {
      window.alert('Could not start the checkout.');
    }
    button.disabled = false;
    button.textContent = label;
  }

  function postRevision(comments) {
    if (!isMemberRun()) {
      return fetch('/api/order-revision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, comments: comments }),
      });
    }
    return fetch(MEMBERS_API + '/generations/' + encodeURIComponent(sessionId) + '/revisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + memberToken() },
      body: JSON.stringify({ comments: comments }),
    });
  }

  // The target-price workbench's calculator: `{ overrides?, solve? }` through
  // whichever door this order lives behind. Read-only on every side.
  function postValuation(body) {
    if (!isMemberRun()) {
      return fetch('/api/order-revision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, valuation: body }),
      });
    }
    return fetch(MEMBERS_API + '/generations/' + encodeURIComponent(sessionId) + '/valuation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + memberToken() },
      body: JSON.stringify(body),
    });
  }

  // Back from the rounds checkout. The webhook is what credits them, so this
  // only has to say so and reload — silence read as a checkout that failed.
  (function reportRoundsPurchase() {
    const outcome = params.get('revisions');
    if (!outcome) return;
    window.setTimeout(function () {
      window.alert(outcome === 'added'
        ? 'Your extra revision rounds have been added. They appear on this page within a few seconds.'
        : 'The checkout was cancelled — no rounds were added and nothing was charged.');
    }, 300);
    history.replaceState(null, '', location.pathname + '?session_id=' + encodeURIComponent(sessionId || ''));
  })();

  if (!sessionId) {
    hideAll();
    document.getElementById('errorMsg').textContent =
      'No order reference found. If you completed a payment, contact contact26@valuatum.com.';
    show('stateError');
    return;
  }

  let pollTimer = null;
  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }
  function pollAgain(delayMs) {
    stopPolling();
    pollTimer = setTimeout(load, delayMs || POLL_MS);
  }

  // A 404 right after checkout does not mean the order is missing — it means
  // the Stripe webhook that creates it hasn't landed yet (it's async and can
  // trail the redirect by a few seconds). Give it a grace period of polls
  // before treating "not found" as final, so a customer who clicks through
  // immediately doesn't get stuck on a dead-end error.
  const NOT_FOUND_GRACE_POLLS = 12; // ~96s at POLL_MS
  let notFoundStreak = 0;

  // ── Revision history rendering ──────────────────────────────────────
  // Renders the engine's change memo (pdf-report-engine/docs/api.md, "The
  // change memo") for each delivered revision — ported from the equivalent
  // React view in ../ai-stock-analysis/frontend/src/components/RevisionDetails.tsx
  // to plain HTML strings, since this page has no framework.

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(value) {
    return String(value == null ? '' : value).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
  }

  function formatNumber(value) {
    return value == null ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function formatValue(value, currency) {
    return value == null ? '—' : (currency ? currency + ' ' : '') + value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function formatDate(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // Small, safe Markdown-lite renderer for memo prose: paragraphs, #/##/###
  // headings, -/*/1. bullets, and pipe tables, with inline bold/code/links.
  // Every raw text segment is escaped before any tag is added around it.
  function renderInline(text) {
    const token = /(\[[^\]]+\]\((https?:\/\/[^\s)]+)\)|\*\*[^*]+\*\*|`[^`]+`)/g;
    let html = '';
    let cursor = 0;
    let match;
    while ((match = token.exec(text))) {
      if (match.index > cursor) html += escapeHtml(text.slice(cursor, match.index));
      const value = match[0];
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(value);
      if (link) {
        html += '<a href="' + escapeAttr(link[2]) + '" target="_blank" rel="noreferrer">' + escapeHtml(link[1]) + '</a>';
      } else if (value.startsWith('**')) {
        html += '<strong>' + escapeHtml(value.slice(2, -2)) + '</strong>';
      } else {
        html += '<code>' + escapeHtml(value.slice(1, -1)) + '</code>';
      }
      cursor = match.index + value.length;
    }
    if (cursor < text.length) html += escapeHtml(text.slice(cursor));
    return html;
  }

  function splitTableRow(line) {
    const trimmed = line.trim();
    if (!trimmed.includes('|')) return null;
    const content = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
    const withoutTrailingPipe = content.endsWith('|') ? content.slice(0, -1) : content;
    const cells = withoutTrailingPipe.split('|');
    return cells.length > 1 ? cells : null;
  }

  function isTableSeparator(cell) {
    return /^:?-{3,}:?$/.test(cell.trim());
  }

  function renderMarkdown(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const html = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const nextLine = lines[index + 1];
      const headerCells = splitTableRow(line);
      const separatorCells = nextLine ? splitTableRow(nextLine) : null;

      if (headerCells && separatorCells && separatorCells.length === headerCells.length && separatorCells.every(isTableSeparator)) {
        const rows = [];
        let rowIndex = index + 2;
        while (rowIndex < lines.length) {
          const cells = splitTableRow(lines[rowIndex]);
          if (!cells || cells.length !== headerCells.length) break;
          rows.push(cells);
          rowIndex += 1;
        }
        html.push('<table><thead><tr>' + headerCells.map((cell) => '<th>' + renderInline(cell.trim()) + '</th>').join('')
          + '</tr></thead><tbody>' + rows.map((row) => '<tr>' + row.map((cell) => '<td>' + renderInline(cell.trim()) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
        index = rowIndex - 1;
        continue;
      }

      const trimmed = line.trim();
      if (!trimmed) continue;

      const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
      if (heading) {
        html.push('<h4>' + renderInline(heading[2]) + '</h4>');
        continue;
      }

      const bullet = /^(?:[-*]|\d+\.)\s+(.+)$/.exec(trimmed);
      if (bullet) {
        html.push('<ul><li><span aria-hidden="true">•</span><span>' + renderInline(bullet[1]) + '</span></li></ul>');
        continue;
      }

      html.push('<p>' + renderInline(line) + '</p>');
    }

    return '<div class="revision-md">' + html.join('') + '</div>';
  }

  function legacyForecastWriteup(revision) {
    return [
      revision.assumptions && '## Assumptions\n\n' + revision.assumptions,
      revision.derivation && '## Derivation\n\n' + revision.derivation,
      revision.unchanged && '## Deliberately unchanged\n\n' + revision.unchanged,
    ].filter(Boolean).join('\n\n');
  }

  // A cell's period. The engine writes a year and its quarters as distinct
  // cells, so `quarter` is the only thing separating `ns 2026` from `ns Q4/26`.
  function periodLabel(row) {
    return row.quarter == null ? String(row.year) : 'Q' + row.quarter + '/' + String(row.year).slice(-2);
  }

  // Ported from ForecastMovementCharts in RevisionDetails.tsx: one bar chart
  // per moved varname (net sales / EBIT) and periodicity, each bar showing the
  // new value with a dashed marker + label for the old one where they differ.
  // Annual and quarterly figures get separate charts because a quarter is
  // roughly a quarter of its year, and a shared y-scale would flatten the
  // quarterly bars into slivers.
  function renderForecastChart(wrote, derived) {
    const NAMES = { ns: 'Net sales', ebit: 'EBIT' };
    // A quarter-revised year has no written full-year cell — the engine cannot
    // send a year alongside its own quarters — so without these the annual
    // chart skips that year entirely. It is a full-year movement like any
    // other, and reads as one: how the figure reached the model is not
    // something the reader needs.
    const derivedRows = (derived || []).filter((row) => row.after != null);

    const series = [];
    ['ns', 'ebit'].forEach((varname) => {
      [false, true].forEach((quarterly) => {
        const written = wrote.filter((row) => row.varname === varname && (row.quarter != null) === quarterly);
        // Annual only: a written year wins over a derived one, though by
        // construction the two never cover the same year.
        const writtenYears = new Set(written.map((row) => row.year));
        const extra = quarterly
          ? []
          : derivedRows.filter((row) => row.varname === varname && !writtenYears.has(row.year));
        const points = written.concat(extra)
          .sort((a, b) => a.year - b.year || (a.quarter || 0) - (b.quarter || 0));
        if (!points.length) return;
        const label = NAMES[varname] || varname;
        series.push({ title: quarterly ? label + ', quarterly' : label, points });
      });
    });
    if (!series.length) return '';

    return series.map((entry) => renderForecastChartCard(entry.title, entry.points)).join('');
  }

  function renderForecastChartCard(title, points) {
    // Two quarters do not need the height eight years do.
    const width = 900, height = points.length <= 3 ? 170 : 260, left = 24, bottom = 34, top = 44;
    const slot = (width - left - 10) / points.length;
    const values = points.reduce((acc, p) => acc.concat([p.before == null ? 0 : p.before, p.after]), []);
    const min = Math.min(0, ...values);
    const max = Math.max(1, ...values);
    const range = max - min || 1;
    const y = (value) => top + ((max - value) / range) * (height - top - bottom);
    const zero = y(0);
    const barWidth = Math.min(64, slot * 0.46);
    const labelWidth = (text) => Math.max(20, text.length * 6.6 + 10);
    const NEW = '#2A7452', OLD = '#8A9590', INK = '#1A2420';

    const bars = points.map((point, index) => {
      const period = periodLabel(point);
      const x = left + slot * index + slot / 2;
      const oldY = y(point.before == null ? 0 : point.before);
      const newY = y(point.after);
      const changed = point.before != null && point.before !== point.after;
      const increased = point.before == null || point.after >= point.before;
      const oldLabel = formatNumber(point.before);
      const newLabel = formatNumber(point.after);
      // The new value sits on top of the bar; when the old value was higher its
      // dashed ghost outline stays, with its label above the ghost.
      // Labels never share a line: when the two tops are close, the old value
      // takes the line above and the new one sits just under it.
      const close = changed && Math.abs(oldY - newY) < 18;
      const oldLabelY = increased ? (close ? newY + 16 : oldY + 14) : oldY - 8;
      const newLabelY = !increased && close ? oldLabelY + 15 : newY - 8;
      const pill = (px, py, text, fill) => '<rect x="' + (px - labelWidth(text) / 2) + '" y="' + (py - 11) + '" width="' + labelWidth(text) + '" height="15" rx="7.5" fill="' + fill + '"/>';
      let g = '<g>';
      if (changed && !increased) {
        g += '<rect x="' + (x - barWidth / 2) + '" y="' + oldY + '" width="' + barWidth + '" height="' + Math.max(1, zero - oldY) + '" fill="none" stroke="' + OLD + '" stroke-width="1.25" stroke-dasharray="4 3"/>';
      }
      g += '<rect x="' + (x - barWidth / 2) + '" y="' + Math.min(newY, zero) + '" width="' + barWidth + '" height="' + Math.max(1, Math.abs(zero - newY)) + '" rx="2" fill="' + (changed ? NEW : '#C9DED3') + '"/>';
      if (changed && increased) {
        g += '<line x1="' + (x - barWidth / 2 - 4) + '" y1="' + oldY + '" x2="' + (x + barWidth / 2 + 4) + '" y2="' + oldY + '" stroke="' + OLD + '" stroke-width="1.25" stroke-dasharray="4 3"/>';
      }
      g += pill(x, newLabelY, newLabel, 'white') + '<text x="' + x + '" y="' + newLabelY + '" text-anchor="middle" fill="' + (changed ? NEW : INK) + '" font-size="11.5" font-weight="600">' + escapeHtml(newLabel) + '</text>';
      if (changed) {
        g += pill(x, oldLabelY, oldLabel, 'white') + '<text x="' + x + '" y="' + oldLabelY + '" text-anchor="middle" fill="' + OLD + '" font-size="11">' + escapeHtml(oldLabel) + '</text>';
      }
      g += '<text x="' + x + '" y="' + (height - 12) + '" text-anchor="middle" fill="' + (changed ? INK : OLD) + '" font-size="12" font-weight="' + (changed ? '600' : '400') + '">' + escapeHtml(period) + '</text>';
      g += '<title>' + escapeHtml(period) + ': ' + (changed ? 'was ' + escapeHtml(oldLabel) + ', now ' : '') + escapeHtml(newLabel) + '</title>';
      return g + '</g>';
    }).join('');

    return '<figure class="rv-chart">'
      + '<figcaption>' + escapeHtml(title) + '</figcaption>'
      + '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + escapeAttr(title) + ' forecast movement chart" style="width:100%;">'
      + '<line x1="' + left + '" y1="' + zero + '" x2="' + (width - 10) + '" y2="' + zero + '" stroke="#E2E9E5"/>'
      + bars
      + '</svg></figure>';
  }

  // The whole path the revision wrote, as a grid: one row per variable and
  // periodicity, one column per period, the new value with "was" beneath it
  // where it moved. The chart shows the shape; this shows the numbers.
  function renderForecastGrid(wrote, derived) {
    const NAMES = { ns: 'Net sales', ebit: 'EBIT' };
    const derivedRows = (derived || []).filter((row) => row.after != null);
    const rows = [];
    ['ns', 'ebit'].forEach((varname) => {
      [false, true].forEach((quarterly) => {
        const written = wrote.filter((row) => row.varname === varname && (row.quarter != null) === quarterly);
        const years = new Set(written.map((row) => row.year));
        const extra = quarterly ? [] : derivedRows.filter((row) => row.varname === varname && !years.has(row.year));
        const cells = written.concat(extra).sort((a, b) => a.year - b.year || (a.quarter || 0) - (b.quarter || 0));
        if (cells.length) rows.push({ label: (NAMES[varname] || varname) + (quarterly ? ', quarterly' : ''), cells });
      });
    });
    if (!rows.length) return '';
    return rows.map((row) => {
      let html = '<div class="rv-grid-wrap"><table class="rv-grid"><thead><tr><th scope="col">' + escapeHtml(row.label) + '</th>'
        + row.cells.map((c) => '<th scope="col">' + escapeHtml(periodLabel(c)) + '</th>').join('') + '</tr></thead><tbody><tr><th scope="row">' + (row.label.indexOf('quarterly') >= 0 ? 'Q' : 'Year') + '</th>';
      row.cells.forEach((c) => {
        const changed = c.before != null && c.before !== c.after;
        html += '<td class="' + (changed ? 'is-changed' : '') + '"><span class="rv-grid-new">' + escapeHtml(formatNumber(c.after)) + '</span>'
          + (changed ? '<span class="rv-grid-was">was ' + escapeHtml(formatNumber(c.before)) + '</span>' : '') + '</td>';
      });
      return html + '</tr></tbody></table></div>';
    }).join('');
  }

  // What the model recomputed from the written path (EBITDA, EPS, cash flow,
  // net debt...). Measured by the engine, so shown as numbers, not prose:
  // grouped by metric, one column per year, moved cells marked.
  function renderRecomputed(recomputed) {
    const rows = (recomputed || []).filter((r) => r && typeof r.metric === 'string');
    if (!rows.length) return '';
    const byMetric = new Map();
    rows.forEach((r) => {
      const m = /^(.*?)\s+((?:19|20)\d{2})$/.exec(r.metric.trim());
      const name = m ? m[1] : r.metric, year = m ? m[2] : '';
      if (!byMetric.has(name)) byMetric.set(name, []);
      byMetric.get(name).push({ year, before: r.before, after: r.after });
    });
    const years = [...new Set(rows.map((r) => (/((?:19|20)\d{2})$/.exec(r.metric.trim()) || [])[1]).filter(Boolean))].sort();
    const fmt = (name, v) => {
      if (v == null || !Number.isFinite(v)) return '—';
      if (/margin|%|yield|ratio/i.test(name) && Math.abs(v) < 5) return (v * 100).toFixed(1) + '%';
      return Math.abs(v) >= 100 ? formatNumber(Math.round(v)) : v.toFixed(2);
    };
    const moved = (a, b) => a != null && b != null && Math.abs(a - b) > Math.max(1e-9, Math.abs(a) * 0.0005);
    let html = '<details class="rv-recomputed"><summary>' + rows.length + ' figures the model recomputed from this path <span class="rv-muted">EBITDA, margins, EPS, cash flow, net debt…</span></summary>'
      + '<div class="rv-grid-wrap"><table class="rv-grid rv-grid--dense"><thead><tr><th scope="col">Metric</th>' + years.map((y) => '<th scope="col">' + y + '</th>').join('') + '</tr></thead><tbody>';
    byMetric.forEach((cells, name) => {
      html += '<tr><th scope="row">' + escapeHtml(name) + '</th>';
      years.forEach((y) => {
        const c = cells.find((x) => x.year === y);
        if (!c) { html += '<td class="rv-muted">—</td>'; return; }
        const changed = moved(c.before, c.after);
        html += '<td class="' + (changed ? 'is-changed' : '') + '"><span class="rv-grid-new">' + escapeHtml(fmt(name, c.after)) + '</span>'
          + (changed ? '<span class="rv-grid-was">was ' + escapeHtml(fmt(name, c.before)) + '</span>' : '') + '</td>';
      });
      html += '</tr>';
    });
    return html + '</tbody></table></div></details>';
  }

  // The engine sends this section whenever an estimates revision ran, even
  // when the model concluded the comment moves nothing: then `wrote` is
  // empty and `resultFid` is null, and the writeup explains the decision.
  // A revision can also write nothing because every value was dropped, in
  // which case the "Values not written" table below carries the reason.
  function renderForecastSection(revision) {
    const wrote = revision.wrote || [];
    const derived = (revision.derivedFullYear || []).filter((row) => row.after != null);
    const moved = wrote.length > 0 || derived.length > 0;
    const dropped = revision.dropped || [];
    const writeup = revision.writeup || legacyForecastWriteup(revision);
    const movedCells = wrote.filter((c) => c.before != null && c.before !== c.after).length
      + derived.filter((c) => c.before != null && c.before !== c.after).length;

    let html = '<section class="rv-block">';
    html += '<h3 class="rv-block-title">The forecast this version is built on</h3>';
    if (moved) {
      html += '<p class="rv-block-sub">' + (movedCells
        ? movedCells + ' figure' + (movedCells === 1 ? '' : 's') + ' moved in the model; the rest of the path is shown so you can see the whole shape, not only the patch.'
        : 'Every figure in the writable window is shown; none moved.') + '</p>';
      html += renderForecastChart(wrote, revision.derivedFullYear);
      html += renderForecastGrid(wrote, revision.derivedFullYear);
      html += renderRecomputed(revision.recomputed);
      html += '<h4 class="rv-sub-title">Why the forecast changed</h4>';
      html += renderMarkdown(writeup);
    } else {
      html += '<p class="rv-block-sub">'
        + (dropped.length
          ? 'No forecast values were written in this version. The values below were proposed but could not be applied.'
          : 'The model kept its forecasts unchanged in this version.')
        + '</p>';
      if (writeup) {
        html += '<h4 class="rv-sub-title">' + (dropped.length ? 'What the model proposed' : 'Why the forecast stayed unchanged') + '</h4>';
        html += renderMarkdown(writeup);
      }
    }

    if (dropped.length) {
      html += '<h4 class="rv-sub-title">Values not written</h4><div class="rv-grid-wrap"><table class="rv-grid rv-grid--list"><thead><tr><th scope="col">Variable</th><th scope="col">Period</th><th scope="col">Reason</th></tr></thead><tbody>'
        + dropped.map((row) => '<tr><td>' + escapeHtml(row.varname) + '</td><td>' + escapeHtml(periodLabel(row)) + '</td><td class="rv-reason">' + escapeHtml(row.reason) + '</td></tr>').join('')
        + '</tbody></table></div>';
    }
    if (revision.quarterlyReconciliation) {
      html += '<h4 class="rv-sub-title">How the full year was set</h4>';
      html += renderMarkdown(revision.quarterlyReconciliation);
    }
    if (revision.levelCaveat) {
      html += '<p class="rv-caveat">' + escapeHtml(revision.levelCaveat) + '</p>';
    }
    html += '</section>';
    return html;
  }

  function ratingChip(rating) {
    const r = String(rating || '').toUpperCase();
    if (!r) return '<span class="wb-rating wb-rating--none">—</span>';
    return '<span class="wb-rating wb-rating--' + r.toLowerCase() + '">' + escapeHtml(r) + '</span>';
  }

  // The measured headline of a revision — target before → after, rating
  // before → after — in the same voice as the target-price workbench.
  function renderHeadline(memo) {
    const h = memo && memo.headline;
    if (!h) return '';
    const tp = h.targetPrice || {};
    const ccy = tp.currency || '';
    const moved = tp.before != null && tp.after != null && Math.abs(tp.after - tp.before) > 0.04;
    const delta = moved ? ((tp.after - tp.before) / tp.before) * 100 : null;
    const ratingChanged = h.rating && h.rating.before && h.rating.after && h.rating.before !== h.rating.after;
    return '<div class="rv-headline">'
      + '<div><span class="wb-summary-label">Target price</span>'
      + '<span class="rv-target">' + (tp.after == null ? '—' : escapeHtml(tp.after.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }))) + '<span class="wb-target-ccy">' + escapeHtml(ccy) + '</span></span>'
      + (moved
        ? '<span class="rv-delta ' + (delta > 0 ? 'is-up' : 'is-down') + '">' + (delta > 0 ? '+' : '−') + Math.abs(delta).toFixed(1) + '% · was ' + escapeHtml(tp.before.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })) + '</span>'
        : '<span class="rv-delta">unchanged</span>')
      + '</div>'
      + '<div><span class="wb-summary-label">Rating</span>'
      + '<span class="rv-rating-row">' + ratingChip(h.rating && h.rating.after) + (ratingChanged ? '<span class="rv-delta">was ' + ratingChip(h.rating.before) + '</span>' : '<span class="rv-delta">unchanged</span>') + '</span>'
      + '</div>'
      + '</div>';
  }

  function renderChangeMemo(memo) {
    if (!memo) return '<p class="rv-muted">Change details are not available for this version.</p>';
    let html = renderHeadline(memo);
    const d = memo.differences || {};
    html += '<section class="rv-block"><h3 class="rv-block-title">What moved in the report</h3>';
    if (d.summary) html += '<div class="rv-summary">' + renderMarkdown(d.summary) + '</div>';
    if (d.items && d.items.length) {
      html += '<dl class="rv-items">' + d.items.map((item) => '<div class="rv-item"><dt>' + escapeHtml(item.area) + '</dt><dd>' + renderMarkdown(item.what) + '</dd></div>').join('') + '</dl>';
    }
    if (d.unchanged) html += '<div class="rv-item rv-item--unchanged"><dt>Unchanged</dt><dd>' + renderMarkdown(d.unchanged) + '</dd></div>';
    html += '</section>';
    if (memo.forecastRevision) html += renderForecastSection(memo.forecastRevision);
    return html;
  }

  // A one-line, measured account of a version for the closed row: the target
  // move and the rating, so the list reads without opening anything.
  function renderVersionPulse(entry) {
    const h = entry.changes && entry.changes.headline;
    if (!h || !h.targetPrice) return '';
    const tp = h.targetPrice;
    const moved = tp.before != null && tp.after != null && Math.abs(tp.after - tp.before) > 0.04;
    const f = (v) => v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    let html = '<span class="rv-pulse">';
    html += moved
      ? '<span class="rv-pulse-was">' + escapeHtml(f(tp.before)) + '</span><span class="rv-pulse-arrow" aria-hidden="true">→</span><span class="rv-pulse-now">' + escapeHtml(f(tp.after)) + ' ' + escapeHtml(tp.currency || '') + '</span>'
      : '<span class="rv-pulse-now">' + escapeHtml(f(tp.after)) + ' ' + escapeHtml(tp.currency || '') + '</span><span class="rv-pulse-was">unchanged</span>';
    if (h.rating && h.rating.after) html += ratingChip(h.rating.after);
    return html + '</span>';
  }

  function renderRevisionHistory(list) {
    if (!list || !list.length) return '';
    let html = '<section class="rv"><div class="rv-head"><h2 class="rv-title">Versions</h2>'
      + '<p class="rv-head-sub">Newest first. Every figure here is measured from the two reports by the engine; the prose is the engine\'s account of what differs, never of why.</p></div>';
    list.forEach((entry, index) => {
      const date = formatDate(entry.completedAt);
      html += '<details class="rv-entry' + (entry.original ? ' rv-entry--original' : '') + '"' + (index === 0 ? ' open' : '') + '>';
      html += '<summary class="rv-summary-row">'
        + '<span class="rv-vnum" aria-label="Version ' + escapeHtml(entry.version) + '">v' + escapeHtml(entry.version) + '</span>'
        + '<span class="rv-who"><span class="rv-who-label">' + versionLabel(entry) + '</span>'
        + (date ? '<span class="rv-date">' + escapeHtml(date) + '</span>' : '') + '</span>'
        + renderVersionPulse(entry)
        + (entry.pdfUrl ? '<a class="rv-download" href="' + escapeAttr(entry.pdfUrl) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">PDF</a>' : '')
        + '<span class="rv-chevron" aria-hidden="true"></span>'
        + '</summary>';
      html += '<div class="rv-body">';
      if (entry.original) {
        html += '<p class="rv-muted">The report as originally delivered, written by the AI, before any revisions or edits.</p>';
      } else if (entry.kind === 'edit') {
        html += renderEditDetails(entry);
      } else {
        if (entry.comments) html += '<div class="rv-request"><span class="wb-summary-label">Your request</span><p>' + escapeHtml(entry.comments) + '</p></div>';
        html += renderAnalystProse(entry.changes);
        html += renderChangeMemo(entry.changes);
        if (entry.reportQuality && entry.reportQuality.status === 'blocked') {
          html += '<p class="wb-quality">Delivered with ' + entry.reportQuality.blockers + ' unresolved valuation finding' + (entry.reportQuality.blockers === 1 ? '' : 's') + '. The figures are computed by the engine; the argument behind them is under review.</p>';
        }
        html += renderFit(entry.fit);
      }
      html += '</div></details>';
    });
    html += '</section>';
    return html;
  }

  // ── Who wrote a version ─────────────────────────────────────────────
  // Every version is either the AI's work (the original, or a revision from
  // the customer's instructions), the customer's own hand edit, or an AI
  // revision that kept hand-edited paragraphs from an earlier version.
  function versionLabel(entry) {
    if (entry.original) return 'Original report';
    if (entry.kind === 'edit') return entry.editedBy ? 'Edited by ' + escapeHtml(entry.editedBy) : 'Edited by hand';
    return entry.authorship === 'mixed' ? 'AI revision, keeps your edits' : 'AI revision';
  }

  function versionBadge(entry) {
    if (entry.kind === 'edit') {
      const who = entry.editedBy ? 'Written by ' + escapeHtml(entry.editedBy) : 'Written by you';
      const from = entry.editedFrom != null && entry.editedFrom !== entry.version - 1
        ? ' · from version ' + escapeHtml(entry.editedFrom) : '';
      return '<span class="version-badge version-badge--hand">' + who + from + '</span>';
    }
    if (entry.authorship === 'mixed') {
      return '<span class="version-badge version-badge--mixed">AI-written · keeps your hand edits</span>';
    }
    return '<span class="version-badge version-badge--ai">AI-written</span>';
  }

  // A pointer names a field in the report's data ("recommendation/prose/0",
  // "chrome:thesis_title/title"). Turn it into something a reader can place.
  const POINTER_SECTIONS = {
    recommendation: 'Recommendation', coreAnalysis: 'Core analysis', valuePools: 'Value pools',
    valuation: 'Valuation', risks: 'Risks', catalysts: 'Catalysts', thesisReasons: 'Investment thesis',
    company: 'Company', summary: 'Summary', financials: 'Financials', outlook: 'Outlook',
  };
  function pointerLabel(pointer) {
    const p = String(pointer || '');
    if (p.startsWith('chrome:')) return 'Heading';
    const parts = p.split('/');
    const head = POINTER_SECTIONS[parts[0]] || parts[0].replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
    const rest = parts.slice(1).filter((seg) => !/^(prose|paragraphs|body|text)$/.test(seg));
    // A trailing index is a paragraph ("…, paragraph 3"); an index in the
    // middle numbers the item before it ("Value pools 2, deep dive, …").
    let label = head;
    rest.forEach((seg, i) => {
      if (/^\d+$/.test(seg)) label += (i === rest.length - 1 ? ', paragraph ' : ' ') + (Number(seg) + 1);
      else label += ', ' + seg.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    });
    return label;
  }

  // Which parts of the analysis a set of edits touched, named the way the
  // report names them, so the summary reads as "rewrote the recommendation and
  // the valuation" rather than as a count of paragraphs.
  function editedSections(edits) {
    const seen = [];
    edits.forEach((edit) => {
      const p = String(edit.pointer || '');
      const head = p.split('/')[0];
      // "the company" would read as the business itself, not the section.
      const named = head === 'company' ? 'the company profile'
        : POINTER_SECTIONS[head] && 'the ' + POINTER_SECTIONS[head].toLowerCase();
      const name = p.startsWith('chrome:') ? 'the headings' : named;
      if (name && !seen.includes(name)) seen.push(name);
    });
    return seen;
  }

  function joinList(items) {
    if (items.length <= 1) return escapeHtml(items[0] || '');
    const rest = items.slice(0, -1).map(escapeHtml).join(', ');
    return rest + ' and ' + escapeHtml(items[items.length - 1]);
  }

  // Word-level before/after: a longest-common-subsequence over word tokens,
  // rendered with <del>/<ins>. Small texts only (one paragraph), so the
  // quadratic table is fine.
  function diffWords(before, after) {
    const a = String(before || '').split(/(\s+)/).filter((t) => t !== '');
    const b = String(after || '').split(/(\s+)/).filter((t) => t !== '');
    if (a.length * b.length > 250000) {
      return '<del>' + escapeHtml(before) + '</del> <ins>' + escapeHtml(after) + '</ins>';
    }
    const table = [];
    for (let i = a.length; i >= 0; i -= 1) {
      table[i] = [];
      for (let j = b.length; j >= 0; j -= 1) {
        if (i === a.length || j === b.length) table[i][j] = 0;
        else if (a[i] === b[j]) table[i][j] = table[i + 1][j + 1] + 1;
        else table[i][j] = Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let html = '';
    let i = 0, j = 0;
    let del = '', ins = '';
    const flush = () => {
      if (del) html += '<del>' + escapeHtml(del) + '</del>';
      if (ins) html += '<ins>' + escapeHtml(ins) + '</ins>';
      del = ''; ins = '';
    };
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { flush(); html += escapeHtml(a[i]); i += 1; j += 1; }
      else if (table[i + 1][j] >= table[i][j + 1]) { del += a[i]; i += 1; }
      else { ins += b[j]; j += 1; }
    }
    while (i < a.length) { del += a[i]; i += 1; }
    while (j < b.length) { ins += b[j]; j += 1; }
    flush();
    return html;
  }

  // The renderer's page-fit report on a delivered version. Only a page whose
  // tail is actually cut off is worth raising: printing a page slightly
  // smaller is the renderer doing its job, and saying so just adds noise.
  function renderFit(fit) {
    if (!fit) return '';
    const clipped = (fit && fit.clipped) || [];
    if (!clipped.length) return '';
    return '<p class="version-fit version-fit--clipped">Page' + (clipped.length > 1 ? 's ' : ' ')
      + clipped.map((p) => escapeHtml(p.page)).join(', ') + ' cut off in the PDF — the text no longer fits. Shorten it and save again.</p>';
  }

  // A hand-edited version: who changed what, side by side, plus what the
  // engine noticed about the edit (figures changed in prose, over-long text).
  function renderEditDetails(entry) {
    const edits = entry.edits || [];
    const warnings = entry.editWarnings || {};
    const who = entry.editedBy ? escapeHtml(entry.editedBy) : 'You';
    const from = entry.editedFrom != null ? entry.editedFrom : entry.version - 1;
    // What the edit did to the analysis: the engine's change memo says it in a
    // sentence, having seen both versions of the report. Without a memo, name
    // the parts that were rewritten — as much as this page can tell on its own.
    const memoSummary = entry.changes && entry.changes.differences && entry.changes.differences.summary;
    let html;
    if (memoSummary) {
      html = '<div class="revision-comment">' + renderMarkdown(memoSummary) + '</div>';
    } else {
      const sections = editedSections(edits);
      const what = sections.length ? 'rewrote ' + joinList(sections) : 'rewrote part of the text';
      html = '<p class="revision-comment">' + who + ' ' + what
        + '. The rest of the report — the figures, tables and charts included — is unchanged from version '
        + escapeHtml(from) + '.</p>';
    }

    if (!edits.length) {
      html += renderChangeMemo(entry.changes);
    } else {
      edits.forEach((edit) => {
        html += '<div class="edit-diff"><div class="edit-diff-label">' + escapeHtml(pointerLabel(edit.pointer)) + '</div>';
        if (edit.after === '') {
          html += '<p class="edit-removed">Paragraph removed.</p>'
            + (edit.before ? '<div class="edit-diff-text"><del>' + escapeHtml(edit.before) + '</del></div>' : '');
        } else if (edit.before == null) {
          html += '<div class="edit-diff-text">' + escapeHtml(edit.after) + '</div>';
        } else {
          html += '<div class="edit-diff-text">' + diffWords(edit.before, edit.after) + '</div>';
        }
        const numbers = warnings.changedNumbers && warnings.changedNumbers[edit.pointer];
        if (numbers) {
          const parts = [];
          if (numbers.retained === false) parts.push('a figure from the original text was changed or dropped');
          if (numbers.added && numbers.added.length) parts.push('figures introduced: ' + numbers.added.map(escapeHtml).join(', '));
          html += '<p class="edit-diff-note">Figures changed by hand — ' + parts.join('; ') + '. The tables were not updated and may now disagree with this text.</p>';
        }
        const over = warnings.overBudget && warnings.overBudget[edit.pointer];
        if (over) {
          html += '<p class="edit-diff-note">Longer than the space allows (' + escapeHtml(over.length) + ' characters, suggested at most ' + escapeHtml(over.budget) + ').</p>';
        }
        html += '</div>';
      });
      if (warnings.unknownPointers && warnings.unknownPointers.length) {
        html += '<p class="revision-caveat">' + warnings.unknownPointers.length + ' change' + (warnings.unknownPointers.length > 1 ? 's' : '')
          + ' could not be applied because the paragraph no longer exists in the report.</p>';
      }
    }
    html += renderFit(entry.fit);
    return html;
  }

  // An AI revision of a version that carried hand-edited paragraphs: what
  // happened to each of them.
  function renderAnalystProse(memo) {
    const prose = memo && memo.analystProse;
    if (!prose) return '';
    const restored = prose.restored || [];
    const rewritten = prose.rewritten || [];
    const dropped = prose.dropped || [];
    if (!restored.length && !rewritten.length && !dropped.length) return '';
    let html = '<div class="analyst-prose"><strong>Your hand edits in this version.</strong> ';
    if (restored.length) html += restored.length + ' hand-edited paragraph' + (restored.length > 1 ? 's were' : ' was') + ' kept word for word (' + restored.map((p) => escapeHtml(pointerLabel(p))).join('; ') + '). ';
    if (rewritten.length) html += rewritten.length + ' ' + (rewritten.length > 1 ? 'were' : 'was') + ' rewritten by the AI (' + rewritten.map((p) => escapeHtml(pointerLabel(p))).join('; ') + '). ';
    if (dropped.length) html += dropped.length + ' lost ' + (dropped.length > 1 ? 'their places' : 'its place') + ' because the revision rebuilt that section (' + dropped.map((p) => escapeHtml(pointerLabel(p))).join('; ') + ').';
    return html + '</div>';
  }

  // ── The text editor ─────────────────────────────────────────────────
  // The report is shown as the engine's own rendered HTML in a frame, so the
  // customer edits exactly what will print. Every editable paragraph in that
  // document carries a data-pointer (the field it maps to); a small script
  // appended to the document handles click-to-edit and reports edits and a
  // page-fit estimate back to this page through postMessage. The frame is
  // sandboxed to scripts only (no same-origin access), so this page never
  // touches the document's DOM and the document cannot touch this page.
  const PAGE_WIDTH = 794; // the width the engine renders at
  const FIT_FLOOR = 0.85;  // the engine's smallest print size before a page clips

  // Plain, old-style JavaScript: it runs inside the sandboxed frame.
  const AGENT = [
    '<style>',
    '  [data-pointer]:not([data-derived]) { cursor: text; transition: box-shadow .12s; border-radius: 2px; }',
    '  [data-pointer]:not([data-derived]):hover { box-shadow: 0 0 0 2px rgba(61,158,114,.5); }',
    '  [data-pointer][contenteditable] { box-shadow: 0 0 0 2px rgb(61,158,114); outline: none; background: rgba(61,158,114,.06); }',
    '  [data-pointer][data-edited="true"] { box-shadow: 0 0 0 2px rgba(217,119,6,.55); }',
    '  [data-derived] { cursor: not-allowed; }',
    '  a[href] { cursor: inherit; }',
    '</style>',
    '<script>',
    '(function () {',
    '  var FLOOR = ' + FIT_FLOOR + ';',
    // The frame is sandboxed without same-origin access, so following any link
    // in the report — the table of contents included — lands on an error page.
    // Swallow the click; the paragraph underneath still opens for editing.
    '  document.addEventListener("click", function (e) {',
    '    var el = e.target;',
    '    while (el && el !== document) {',
    '      if (el.tagName === "A" && el.hasAttribute("href")) { e.preventDefault(); return; }',
    '      el = el.parentNode;',
    '    }',
    '  }, true);',
    '  var originals = {};',
    '  var post = function (m) { window.parent.postMessage(m, "*"); };',
    '  var editable = Array.prototype.slice.call(document.querySelectorAll("[data-pointer]:not([data-derived])"));',
    '  editable.forEach(function (el) {',
    '    var pointer = el.getAttribute("data-pointer");',
    '    originals[pointer] = el.textContent;',
    '    el.addEventListener("click", function (e) {',
    '      if (el.getAttribute("contenteditable")) return;',
    '      e.preventDefault();',
    '      el.setAttribute("contenteditable", "plaintext-only");',
    '      if (el.getAttribute("contenteditable") !== "plaintext-only") el.setAttribute("contenteditable", "true");',
    '      el.focus();',
    '    });',
    '    el.addEventListener("input", function () {',
    '      var text = el.textContent;',
    '      el.setAttribute("data-edited", text !== originals[pointer] ? "true" : "false");',
    '      post({ type: "edit", pointer: pointer, text: text, original: originals[pointer] });',
    '      scheduleFit();',
    '    });',
    '    el.addEventListener("blur", function () { el.removeAttribute("contenteditable"); });',
    '    el.addEventListener("keydown", function (e) {',
    '      if (e.key === "Escape") { el.blur(); }',
    '      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); }', // one element is one paragraph
    '    });',
    '  });',
    '  window.addEventListener("message", function (e) {',
    '    var m = e.data || {};',
    '    if (m.type !== "restore") return;',
    '    editable.forEach(function (el) {',
    '      if (el.getAttribute("data-pointer") !== m.pointer) return;',
    '      el.textContent = originals[m.pointer];',
    '      el.setAttribute("data-edited", "false");',
    '    });',
    '    scheduleFit();',
    '  });',
    '  var fitTimer = null;',
    '  function scheduleFit() { clearTimeout(fitTimer); fitTimer = setTimeout(measureFit, 250); }',
    '  function measureFit() {',
    '    var bodies = Array.prototype.slice.call(document.querySelectorAll(".page-body"));',
    '    var pages = [];',
    '    bodies.forEach(function (el, i) {',
    '      el.style.zoom = "";',
    '      var zoom = 1;',
    '      for (var pass = 0; pass < 3 && el.scrollHeight - el.clientHeight > 2 && zoom > FLOOR; pass++) {',
    '        zoom = Math.max(FLOOR, zoom * Math.min(1, (el.clientHeight / el.scrollHeight) - 0.01));',
    '        el.style.zoom = String(zoom);',
    '      }',
    '      var over = Math.max(0, el.scrollHeight - el.clientHeight);',
    '      if (zoom < 1 || over > 2) pages.push({ page: i + 1, zoom: Math.round(zoom * 1000) / 1000, over: over });',
    '    });',
    '    post({ type: "fit", pages: pages });',
    '  }',
    '  function whenReady(fn) {',
    '    if (window.__CHARTS_READY__ === true) return fn();',
    '    var n = 0; var t = setInterval(function () { if (window.__CHARTS_READY__ === true || ++n > 200) { clearInterval(t); fn(); } }, 100);',
    '  }',
    '  whenReady(function () { post({ type: "ready", editable: editable.length }); measureFit(); });',
    '})();',
    '</script>',
  ].join('\n');

  // The suggested length per paragraph: +35% or +200 characters, the same hint
  // the engine reports. A warning, not a limit — the page fit below is the
  // real answer.
  function editBudget(originalLength) {
    return Math.round(Math.max(originalLength * 1.35, originalLength + 200));
  }

  const editor = {
    open: false,
    frame: null,
    edits: new Map(), // pointer -> { text, original, budget }
    fit: null,
    editableCount: null,
    nextVersion: 2,
    saving: false,
  };

  function fetchPreviewHtml() {
    if (!isMemberRun()) {
      return fetch('/api/order-status?session_id=' + encodeURIComponent(sessionId) + '&preview=1');
    }
    return fetch(MEMBERS_API + '/generations/' + encodeURIComponent(sessionId) + '/preview', {
      headers: { authorization: 'Bearer ' + memberToken() },
    });
  }

  function postEdits(payload) {
    if (!isMemberRun()) {
      return fetch('/api/order-revision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ session_id: sessionId }, payload)),
      });
    }
    return fetch(MEMBERS_API + '/generations/' + encodeURIComponent(sessionId) + '/edits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + memberToken() },
      body: JSON.stringify(payload),
    });
  }

  function shortText(text, n) {
    const s = String(text || '');
    return s.length > n ? s.slice(0, n).trimEnd() + '…' : s;
  }

  // What changed in a paragraph, word by word. The panel used to show the
  // first 140 characters of the new text, which for a long paragraph is all
  // untouched prose — the edit itself scrolled off. So diff the two versions
  // and show only the changed words plus a little context around them.
  const DIFF_CONTEXT = 8; // words kept either side of a change

  function lcsDiff(a, b) {
    if (!a.length && !b.length) return [];
    if (!a.length) return [{ op: 'ins', words: b }];
    if (!b.length) return [{ op: 'del', words: a }];
    // A rewrite this large is not worth aligning word by word.
    if (a.length * b.length > 250000) return [{ op: 'del', words: a }, { op: 'ins', words: b }];

    const n = a.length;
    const m = b.length;
    const width = m + 1;
    const dp = new Uint16Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * width + j] = a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
      }
    }

    const out = [];
    const push = (op, word) => {
      const last = out[out.length - 1];
      if (last && last.op === op) last.words.push(word);
      else out.push({ op, words: [word] });
    };
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
      else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { push('del', a[i]); i++; }
      else { push('ins', b[j]); j++; }
    }
    while (i < n) push('del', a[i++]);
    while (j < m) push('ins', b[j++]);
    return out;
  }

  // Trim the shared head and tail first, so the alignment above only ever runs
  // on the span that actually differs.
  function wordDiffParts(original, edited) {
    const a = String(original || '').split(/\s+/).filter(Boolean);
    const b = String(edited || '').split(/\s+/).filter(Boolean);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

    const parts = [];
    if (start) parts.push({ op: 'same', words: a.slice(0, start) });
    for (const part of lcsDiff(a.slice(start, endA), b.slice(start, endB))) parts.push(part);
    if (endA < a.length) parts.push({ op: 'same', words: a.slice(endA) });
    return parts;
  }

  function renderDiff(original, edited) {
    const parts = wordDiffParts(original, edited);
    if (!parts.some((p) => p.op !== 'same')) return escapeHtml(shortText(edited, 140));

    return parts.map((part, idx) => {
      if (part.op !== 'same') {
        return '<span class="diff-' + part.op + '">' + escapeHtml(part.words.join(' ')) + '</span>';
      }
      const words = part.words;
      if (words.length <= DIFF_CONTEXT * 2 + 1) return escapeHtml(words.join(' '));
      const head = escapeHtml(words.slice(0, DIFF_CONTEXT).join(' '));
      const tail = escapeHtml(words.slice(-DIFF_CONTEXT).join(' '));
      if (idx === 0) return '… ' + tail;
      if (idx === parts.length - 1) return head + ' …';
      return head + ' … ' + tail;
    }).join(' ');
  }

  function renderEditorPanel() {
    const changesEl = document.getElementById('editorChanges');
    const warningsEl = document.getElementById('editorWarnings');
    const saveBtn = document.getElementById('editSaveBtn');
    const changed = [...editor.edits.values()];

    if (!changed.length) {
      changesEl.innerHTML = '<p class="editor-empty">No changes yet' + (editor.editableCount != null ? ' — ' + editor.editableCount + ' paragraphs can be edited.' : '.') + '</p>';
    } else {
      changesEl.innerHTML = '<ol class="editor-changes">' + changed.map((e) => {
        const over = e.text.length > e.budget;
        return '<li class="editor-change" data-pointer="' + escapeAttr(e.pointer) + '">'
          + '<div class="editor-change-head"><span class="label" title="' + escapeAttr(e.pointer) + '">' + escapeHtml(pointerLabel(e.pointer)) + '</span>'
          + '<span class="count' + (over ? ' is-over' : '') + '">' + e.text.length + '/' + e.budget + '</span>'
          + '<button type="button" data-discard="' + escapeAttr(e.pointer) + '" title="Discard this change">✕</button></div>'
          + (e.text === '' ? '<p class="editor-change-text is-removed">Paragraph will be removed</p>'
            : '<p class="editor-change-text">' + renderDiff(e.original, e.text) + '</p>')
          + '</li>';
      }).join('') + '</ol>';
    }

    const overBudget = changed.filter((e) => e.text.length > e.budget);
    const clipped = (editor.fit && editor.fit.pages.filter((p) => p.over > 2)) || [];
    if (overBudget.length || clipped.length) {
      let html = '<div class="editor-warnings">';
      if (overBudget.length) html += '<p>' + (overBudget.length === 1 ? 'One paragraph is' : overBudget.length + ' paragraphs are') + ' longer than the space suggests. It will still be applied; check the page fit.</p>';
      if (clipped.length) html += '<p><strong>Page' + (clipped.length > 1 ? 's ' : ' ') + clipped.map((p) => p.page).join(', ') + ' would be cut off even at ' + Math.round(FIT_FLOOR * 100) + '%. Shorten the text.</strong></p>';
      html += '<p>An estimate while you type — the saved version reports the real page fit.</p></div>';
      warningsEl.innerHTML = html;
    } else {
      warningsEl.innerHTML = '';
    }

    saveBtn.disabled = editor.saving || !changed.length;
    saveBtn.textContent = editor.saving ? 'Saving…' : 'Save as version ' + editor.nextVersion;
  }

  function fitFrame() {
    const wrap = document.getElementById('editorFrameWrap');
    if (!editor.frame || !wrap) return;
    const scale = Math.min(1, (wrap.clientWidth - 32) / PAGE_WIDTH);
    editor.frame.style.width = PAGE_WIDTH + 'px';
    editor.frame.style.height = ((wrap.clientHeight - 32) / scale) + 'px';
    editor.frame.style.transform = 'scale(' + scale + ')';
    editor.frame.style.transformOrigin = 'top left';
  }

  function onFrameMessage(e) {
    if (!editor.frame || e.source !== editor.frame.contentWindow) return;
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'edit') {
      if (m.text === m.original) editor.edits.delete(m.pointer);
      else editor.edits.set(m.pointer, { pointer: m.pointer, text: m.text, original: m.original, budget: editBudget(m.original.length) });
      renderEditorPanel();
    } else if (m.type === 'fit') {
      editor.fit = { pages: m.pages || [] };
      renderEditorPanel();
    } else if (m.type === 'ready') {
      editor.editableCount = m.editable;
      document.getElementById('editorFrameNote').style.display = 'none';
      renderEditorPanel();
    }
  }
  window.addEventListener('message', onFrameMessage);
  window.addEventListener('resize', fitFrame);

  async function openEditor(order) {
    const box = document.getElementById('editorBox');
    const wrap = document.getElementById('editorFrameWrap');
    const note = document.getElementById('editorFrameNote');
    const status = document.getElementById('editorStatus');
    document.querySelector('.order-card').classList.add('order-card--editing');
    editor.open = true;
    editor.edits = new Map();
    editor.fit = null;
    editor.editableCount = null;
    editor.nextVersion = (order.currentVersion || 1) + 1;
    editor.saving = false;
    document.getElementById('editorNameRow').style.display = isMemberRun() ? 'none' : '';
    status.textContent = '';
    status.classList.remove('is-error');
    note.style.display = '';
    note.textContent = 'Loading the report…';
    if (editor.frame) { editor.frame.remove(); editor.frame = null; }
    box.style.display = '';
    renderEditorPanel();
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });

    try {
      const res = await fetchPreviewHtml();
      if (!res.ok) {
        const data = await res.json().catch(function () { return {}; });
        note.textContent = data.error || 'The report could not be loaded for editing.';
        return;
      }
      const html = await res.text();
      if (!editor.open) return;
      const frame = document.createElement('iframe');
      frame.title = 'Editable report';
      frame.setAttribute('sandbox', 'allow-scripts');
      // The editing script goes last, so every element it looks for exists.
      frame.srcdoc = html.replace(/<\/body>\s*<\/html>\s*$/i, '') + AGENT + '</body></html>';
      wrap.appendChild(frame);
      editor.frame = frame;
      fitFrame();
      note.textContent = 'Drawing the report…';
    } catch (err) {
      note.textContent = 'Network error while loading the report. Please try again.';
    }
  }

  function closeEditor() {
    editor.open = false;
    if (editor.frame) { editor.frame.remove(); editor.frame = null; }
    editor.edits = new Map();
    document.getElementById('editorBox').style.display = 'none';
    document.querySelector('.order-card').classList.remove('order-card--editing');
  }

  async function saveEdits() {
    const status = document.getElementById('editorStatus');
    const changed = [...editor.edits.values()];
    if (!changed.length || editor.saving) return;
    editor.saving = true;
    status.textContent = '';
    status.classList.remove('is-error');
    renderEditorPanel();

    const payload = {
      edits: Object.fromEntries(changed.map((e) => [e.pointer, e.text])),
      originals: Object.fromEntries(changed.map((e) => [e.pointer, e.original])),
    };
    const name = (document.getElementById('editorName').value || '').trim();
    if (name && !isMemberRun()) payload.editedBy = name;

    try {
      const res = await postEdits(payload);
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        status.textContent = data.error || 'Could not save your changes. Please try again.';
        status.classList.add('is-error');
        editor.saving = false;
        renderEditorPanel();
        return;
      }
      closeEditor();
      load(); // switches to the progress state and starts polling
    } catch (err) {
      status.textContent = 'Network error. Please try again.';
      status.classList.add('is-error');
      editor.saving = false;
      renderEditorPanel();
    }
  }

  // ---- The target-price workbench ------------------------------------------
  const workbench = { open: false, order: null, panel: null };

  async function openWorkbench(order) {
    const box = document.getElementById('valuationBox');
    const status = document.getElementById('valuationStatus');
    workbench.open = true;
    status.textContent = '';
    status.classList.remove('is-error');
    box.style.display = '';
    document.querySelector('.order-card').classList.add('order-card--editing');
    document.getElementById('valuationOpenBtn').textContent = 'Close the target-price view';
    const remaining = Math.max(0, (order.revisionsAllowed || 0) - (order.revisionsUsed || 0));
    workbench.panel = window.ValuationWorkbench.mount(document.getElementById('valuationPanel'), {
      preview: postValuation,
      remainingRounds: remaining,
      onLock: function (overrides, changes) {
        // Phase 3 wires this to a revision that carries the locked rows; until
        // then the page says so instead of pretending.
        status.textContent = 'Locking ' + changes.length + ' assumption' + (changes.length === 1 ? '' : 's')
          + ' into a new report is the next step of this feature and is not live yet. Your report is unchanged.';
      },
    });
    await workbench.panel.start();
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeWorkbench() {
    workbench.open = false;
    document.getElementById('valuationBox').style.display = 'none';
    document.getElementById('valuationPanel').innerHTML = '';
    if (!editor.open) document.querySelector('.order-card').classList.remove('order-card--editing');
    const button = document.getElementById('valuationOpenBtn');
    button.innerHTML = button.dataset.label;
  }

  (function () {
    const button = document.getElementById('valuationOpenBtn');
    button.dataset.label = button.innerHTML;
    button.addEventListener('click', function () {
      if (workbench.open) { closeWorkbench(); return; }
      openWorkbench(workbench.order || {});
    });
    document.getElementById('valuationCloseBtn').addEventListener('click', closeWorkbench);
  })();

  document.getElementById('editOpenBtn').addEventListener('click', function () {
    if (editor.open) { closeEditor(); return; }
    openEditor(editor.order || {});
  });
  document.getElementById('editCancelBtn').addEventListener('click', closeEditor);
  document.getElementById('editSaveBtn').addEventListener('click', saveEdits);
  document.getElementById('editorChanges').addEventListener('click', function (e) {
    const button = e.target.closest('button[data-discard]');
    if (!button) return;
    const pointer = button.getAttribute('data-discard');
    editor.edits.delete(pointer);
    if (editor.frame) editor.frame.contentWindow.postMessage({ type: 'restore', pointer: pointer }, '*');
    renderEditorPanel();
  });

  function renderProgress(order) {
    hideAll();
    const title = document.getElementById('progressTitle');
    const sub = document.getElementById('progressSub');
    const meta = document.getElementById('progressMeta');
    if (order.status === 'REVISING' && order.activity === 'editing') {
      title.textContent = 'Applying your edits…';
      // Rendering itself is seconds; the wait is the engine starting up when it
      // has been idle, which is not the customer's problem to understand.
      sub.textContent = 'The report is being re-rendered with your text, exactly as you wrote it. This usually takes a few minutes.';
    } else if (order.status === 'REVISING') {
      title.textContent = 'Updating your report…';
      sub.textContent = 'The report engine is interpreting your request and regenerating the report. This usually takes 20 to 40 minutes.';
    } else {
      title.textContent = 'Preparing your report…';
      sub.textContent = 'This can take a little while. This page updates on its own — no need to refresh.';
    }
    meta.textContent = [order.companyName, order.ticker].filter(Boolean).join(' · ') || '—';
    show('stateProgress');
    pollAgain(order.activity === 'editing' ? 3000 : POLL_MS);
  }

  // Shown while notFoundStreak is within its grace period: the order record
  // may just not have landed yet.
  function renderAwaitingOrder() {
    hideAll();
    document.getElementById('progressTitle').textContent = 'Confirming your order…';
    document.getElementById('progressSub').textContent =
      'Your payment is being confirmed. This usually only takes a few seconds.';
    document.getElementById('progressMeta').textContent = '—';
    show('stateProgress');
    pollAgain();
  }

  // The admin's read-only view: say whose order this is, and remove every
  // control that would submit a revision, an edit or a purchase in the
  // customer's name. The history below is what the admin came for.
  function renderAdminView(order) {
    document.getElementById('deliveredTitle').textContent = 'Admin view — read only';
    document.getElementById('deliveredSub').textContent =
      'Ordered by ' + (order.analystName || order.email || 'an unknown customer')
      + (order.forkedFrom ? ', forked from another analysis' : '')
      + '. Revisions used: ' + (order.revisionsUsed || 0) + ' of ' + (order.revisionsAllowed || 0) + '.';
    ['editOpenBtn', 'revisionBox', 'revisionExhausted', 'revisionBuy'].forEach(hide);
  }

  function renderDelivered(order) {
    hideAll();
    document.getElementById('deliveredMeta').textContent =
      [order.companyName, order.ticker].filter(Boolean).join(' · ') || '—';

    // A fresh "build on" order has no PDF of its own until its first revision
    // completes (see createForkOrder in server/lambda/members.js) — a "Download"
    // button pointing at '#' reads as broken, so it stays hidden until there is
    // something behind it. originalUrl (the analysis the buyer paid for, resolved
    // live from the parent order) fills that gap in the meantime.
    const downloadBtn = document.getElementById('downloadBtn');
    if (order.pdfUrl) {
      downloadBtn.href = order.pdfUrl;
      downloadBtn.style.display = '';
    } else {
      downloadBtn.style.display = 'none';
    }
    const originalBtn = document.getElementById('originalBtn');
    if (originalBtn) {
      if (order.originalUrl) {
        originalBtn.href = order.originalUrl;
        originalBtn.style.display = '';
      } else {
        originalBtn.style.display = 'none';
      }
    }

    // Editing the text by hand: free and unlimited, offered on any delivered
    // version the engine can show as an editable document (a published
    // analysis is frozen and gets no button). The editor closes on every
    // reload so a freshly delivered version starts from a clean slate.
    editor.order = order;
    if (editor.open) closeEditor();
    document.getElementById('editOpenBtn').style.display = order.editable ? '' : 'none';
    // The target-price workbench: free to explore on any delivered version;
    // locking the assumptions into a new report is a revision like any other.
    workbench.order = order;
    if (workbench.open) closeWorkbench();
    document.getElementById('valuationOpenBtn').style.display = order.pdfUrl ? '' : 'none';

    // A report the engine delivered with unresolved valuation findings: the
    // target is code-computed, the argument behind it is under review. Say so
    // where the download button is, not only inside the workbench.
    const quality = document.getElementById('qualityBanner');
    if (quality) {
      const q = order.reportQuality;
      if (q && q.status === 'blocked') {
        quality.textContent = 'This version was delivered with ' + q.blockers + ' unresolved valuation finding' + (q.blockers === 1 ? '' : 's')
          + '. The target price and every figure are computed by the engine; the report\'s argument for them did not pass every check and is under review.';
        quality.style.display = '';
      } else {
        quality.style.display = 'none';
      }
    }

    const remaining = Math.max(0, (order.revisionsAllowed || 0) - (order.revisionsUsed || 0));
    const errorBanner = document.getElementById('revisionErrorBanner');
    if (order.revisionError) {
      errorBanner.textContent = 'Your last request could not be completed: ' + order.revisionError
        + ' Your current report is unchanged; you can try again below.';
      errorBanner.style.display = '';
    } else {
      errorBanner.style.display = 'none';
    }

    if (remaining > 0) {
      document.getElementById('revisionCount').textContent =
        remaining + ' of ' + order.revisionsAllowed + ' report revisions remaining.';
      // Reset the button every time this box is (re)shown: after a
      // successful submit it stays disabled/"Submitting..." from the click
      // handler below, and if a revision then fails, the flow lands back
      // here with the button still stuck that way.
      const revisionButton = document.getElementById('revisionSubmit');
      revisionButton.disabled = false;
      revisionButton.textContent = 'Request revision';
      show('revisionBox');
      hide('revisionExhausted');
    } else if ((order.revisionsAllowed || 0) > 0) {
      document.getElementById('revisionExhaustedCount').textContent = order.revisionsAllowed;
      hide('revisionBox');
      show('revisionExhausted');
    } else {
      hide('revisionBox');
      hide('revisionExhausted');
    }

    // Offered on any delivered report, not only an exhausted one — a report with
    // no rounds at all (a bought analysis, a coverage update) is exactly the case
    // that had nowhere to go.
    const buyBox = document.getElementById('revisionBuy');
    if (buyBox) {
      buyBox.style.display = '';
      document.getElementById('revisionBuyHint').textContent = remaining > 0
        ? 'Need more than ' + remaining + '? Add rounds to this report.'
        : 'Add more rounds to this report and keep steering it.';
    }

    document.getElementById('revisionHistory').innerHTML = renderRevisionHistory(order.revisionHistory);

    if (isAdminView) renderAdminView(order);

    show('stateDelivered');
    stopPolling(); // nothing changes until the customer submits a revision
  }

  function renderError(message) {
    hideAll();
    document.getElementById('errorMsg').textContent = message;
    show('stateError');
    stopPolling();
  }

  async function load() {
    // The delivery email is the main way into this page, and it can be opened
    // in a browser the member has never signed in on. Without the token the
    // Stripe proxy would be asked to verify a UUID and answer 500, so say what
    // is actually missing.
    if (isAdminView && !adminPassword()) {
      return renderError('Sign in on the admin page first, then open this link again.');
    }
    if (!isAdminView && MEMBER_GEN_ID.test(sessionId || '') && !memberToken()) {
      return renderError('This is your own generation. Sign in to the member area first, then open this link again.');
    }
    try {
      const res = await fetchOrderState();
      const data = await res.json();

      if (!res.ok) {
        if (isAdminView && res.status === 401) {
          return renderError('The admin password was not accepted. Sign in on the admin page again, then reload.');
        }
        if (res.status === 401 || res.status === 403) {
          return renderError(MEMBER_GEN_ID.test(sessionId || '')
            ? 'Sign in to the member area first, then open this link again.'
            : 'This link is no longer valid.');
        }
        if (res.status === 402) return renderError('Payment has not completed yet. If you just paid, give it a moment and reload.');
        if (res.status === 404) {
          notFoundStreak += 1;
          if (notFoundStreak <= NOT_FOUND_GRACE_POLLS) return renderAwaitingOrder();
          return renderError('We could not find this order. If you completed a payment, contact contact26@valuatum.com.');
        }
        return renderError(data.error || 'We could not load your order.');
      }
      notFoundStreak = 0;

      if (data.status === 'FAILED') {
        return renderError(data.error || 'Report generation failed. Contact contact26@valuatum.com and we will sort it out.');
      }
      if (data.status === 'DELIVERED') {
        return renderDelivered(data);
      }
      return renderProgress(data); // NEW, IMPORTING, RENDERING, REVISING
    } catch (err) {
      renderError('Network error. If this persists, email contact26@valuatum.com.');
    }
  }

  document.getElementById('revisionBuyBtn').addEventListener('click', function () {
    buyMoreRounds(this);
  });

  document.getElementById('revisionSubmit').addEventListener('click', async function () {
    const textarea = document.getElementById('revisionText');
    const status = document.getElementById('revisionStatus');
    const button = document.getElementById('revisionSubmit');
    const comments = textarea.value.trim();

    status.textContent = '';
    status.classList.remove('is-error');

    if (!comments) {
      status.textContent = 'Describe the change you would like to see.';
      status.classList.add('is-error');
      textarea.focus();
      return;
    }

    button.disabled = true;
    button.textContent = 'Submitting…';
    try {
      const res = await postRevision(comments);
      const data = await res.json();
      if (!res.ok) {
        status.textContent = data.error || 'Could not submit your request. Please try again.';
        status.classList.add('is-error');
        button.disabled = false;
        button.textContent = 'Request revision';
        return;
      }
      textarea.value = '';
      load(); // switches to the REVISING progress state and starts polling
    } catch (err) {
      status.textContent = 'Network error. Please try again.';
      status.classList.add('is-error');
      button.disabled = false;
      button.textContent = 'Request revision';
    }
  });

  // If this tab is restored from the browser's back/forward cache (e.g. the
  // customer navigated away and back), polling timers can be paused for an
  // unpredictable amount of time. Refresh immediately rather than waiting
  // for the next scheduled poll, so the page never sits on stale status.
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) load();
  });

  load();
})();
