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
  function pollAgain() {
    stopPolling();
    pollTimer = setTimeout(load, POLL_MS);
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

  // Ported from ForecastMovementCharts in RevisionDetails.tsx: one bar chart
  // per moved varname (net sales / EBIT), each bar showing the new value with
  // a dashed marker + label for the old one where they differ.
  function renderForecastChart(wrote) {
    const NAMES = { ns: 'Net sales', ebit: 'EBIT' };
    const groups = ['ns', 'ebit'].filter((name) => wrote.some((row) => row.varname === name));
    if (!groups.length) return '';

    return groups.map((name) => {
      const points = wrote.filter((row) => row.varname === name).sort((a, b) => a.year - b.year);
      const width = 900, height = 300, left = 58, bottom = 40, top = 48;
      const slot = (width - left - 10) / points.length;
      const values = points.reduce((acc, p) => acc.concat([p.before == null ? 0 : p.before, p.after]), []);
      const min = Math.min(0, ...values);
      const max = Math.max(1, ...values);
      const range = max - min || 1;
      const y = (value) => top + ((max - value) / range) * (height - top - bottom);
      const zero = y(0);
      const barWidth = Math.min(72, slot * 0.42);
      const labelWidth = (text) => Math.max(20, text.length * 6.7 + 8);

      const bars = points.map((point, index) => {
        const x = left + slot * index + slot / 2;
        const oldY = y(point.before == null ? 0 : point.before);
        const newY = y(point.after);
        const increased = point.before == null || point.after >= point.before;
        const changed = point.before != null && point.before !== point.after;
        const topsAreClose = changed && Math.abs(oldY - newY) < 32;
        const decreaseGap = newY - oldY;
        const oldLabelY = topsAreClose ? (oldY < newY ? oldY - 11 : oldY + 17) : oldY - 11;
        const newLabelY = decreaseGap > 0 ? (decreaseGap >= 20 ? newY - 5 : newY + 17) : newY - 11;
        const arrowY = Math.max(23, Math.min(oldY, newY) - 3);
        const oldLabel = formatNumber(point.before);
        const newLabel = formatNumber(point.after);
        const oldLabelInsideShortBar = oldLabelY > oldY && Math.abs(zero - oldY) < 25;
        const newLabelInsideShortBar = newLabelY > newY && Math.abs(zero - newY) < 25;
        const oldLabelX = oldLabelInsideShortBar ? x - barWidth / 2 - labelWidth(oldLabel) / 2 - 6 : x;
        const newLabelX = newLabelInsideShortBar ? x - barWidth / 2 - labelWidth(newLabel) / 2 - 6 : x;
        const fittedOldLabelY = oldLabelInsideShortBar ? oldY + 4 : oldLabelY;
        const fittedNewLabelY = newLabelInsideShortBar ? newY + 4 : newLabelY;
        const labelPill = (labelX, labelY, text) => {
          const w = labelWidth(text);
          return '<rect x="' + (labelX - w / 2) + '" y="' + (labelY - 13) + '" width="' + w + '" height="16" rx="8" fill="white" fill-opacity="0.96"/>';
        };
        const oldMarkerPath = increased
          ? 'M ' + (x - barWidth / 2) + ' ' + oldY + ' H ' + (x + barWidth / 2)
          : 'M ' + (x - barWidth / 2) + ' ' + newY + ' V ' + oldY + ' H ' + (x + barWidth / 2) + ' V ' + newY;

        let g = '<g>';
        g += '<rect x="' + (x - barWidth / 2) + '" y="' + Math.min(newY, zero) + '" width="' + barWidth + '" height="' + Math.max(1, Math.abs(zero - newY)) + '" fill="#0d9488" stroke="#0a7a70"/>';
        if (point.before != null && changed) {
          g += '<path d="' + oldMarkerPath + '" fill="none" stroke="white" stroke-width="4"/>';
          g += '<path d="' + oldMarkerPath + '" fill="none" stroke="#57534e" stroke-width="1.5" stroke-dasharray="6 4"/>';
          g += labelPill(oldLabelX, fittedOldLabelY, oldLabel);
          g += '<text x="' + oldLabelX + '" y="' + fittedOldLabelY + '" text-anchor="middle" fill="#57534e" font-size="12">' + escapeHtml(oldLabel) + '</text>';
        }
        g += labelPill(newLabelX, fittedNewLabelY, newLabel);
        g += '<text x="' + newLabelX + '" y="' + fittedNewLabelY + '" text-anchor="middle" fill="#0f766e" font-size="12" font-weight="600">' + escapeHtml(newLabel) + '</text>';
        if (changed) g += '<text x="' + (x + barWidth / 2 + 10) + '" y="' + arrowY + '" fill="#0f766e" font-size="22" font-weight="600">' + (increased ? '↑' : '↓') + '</text>';
        g += '<text x="' + x + '" y="' + (height - 14) + '" text-anchor="middle" fill="#57534e" font-size="13" font-weight="600">' + point.year + '</text>';
        g += '<title>' + point.year + ': old ' + escapeHtml(oldLabel) + ', new ' + escapeHtml(newLabel) + '</title>';
        g += '</g>';
        return g;
      }).join('');

      return '<div class="revision-chart-card">'
        + '<div class="revision-chart-title">' + escapeHtml(NAMES[name] || name) + '</div>'
        + '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + escapeAttr(name) + ' forecast movement chart" style="width:100%;">'
        + '<line x1="' + left + '" y1="' + zero + '" x2="' + (width - 10) + '" y2="' + zero + '" stroke="#d6d3d1"/>'
        + bars
        + '</svg></div>';
    }).join('');
  }

  function renderForecastSection(revision) {
    let html = '<div class="revision-section revision-forecast">';
    html += '<div class="revision-section-title">Forecast movement</div>';
    if (revision.wrote && revision.wrote.length) html += renderForecastChart(revision.wrote);
    html += '<div class="revision-section-title" style="margin-top:.5rem;">Why the forecast changed</div>';
    html += renderMarkdown(revision.writeup || legacyForecastWriteup(revision));

    if (revision.dropped && revision.dropped.length) {
      html += '<table class="revision-table"><caption>Values not written</caption><thead><tr><th>Variable</th><th>Year</th><th>Reason</th></tr></thead><tbody>'
        + revision.dropped.map((row) => '<tr><td>' + escapeHtml(row.varname) + '</td><td>' + escapeHtml(row.year) + '</td><td>' + escapeHtml(row.reason) + '</td></tr>').join('')
        + '</tbody></table>';
    }
    if (revision.levelCaveat) {
      html += '<p class="revision-caveat">' + escapeHtml(revision.levelCaveat) + '</p>';
    }
    html += '</div>';
    return html;
  }

  function renderChangeMemo(memo) {
    if (!memo) return '<p class="revision-no-memo">Change details are not available for this revision.</p>';

    let html = '<div class="revision-metrics">';
    html += '<div class="revision-metric"><div class="revision-metric-label">Target price</div><div class="revision-metric-values">'
      + '<span class="revision-metric-before">' + escapeHtml(formatValue(memo.headline.targetPrice.before, memo.headline.targetPrice.currency)) + '</span>'
      + '<span class="revision-metric-after">' + escapeHtml(formatValue(memo.headline.targetPrice.after, memo.headline.targetPrice.currency)) + '</span>'
      + '</div></div>';
    html += '<div class="revision-metric"><div class="revision-metric-label">Rating</div><div class="revision-metric-values">'
      + '<span class="revision-metric-before">' + escapeHtml(memo.headline.rating.before || '—') + '</span>'
      + '<span class="revision-metric-after">' + escapeHtml(memo.headline.rating.after || '—') + '</span>'
      + '</div></div>';
    html += '</div>';

    html += '<div class="revision-section"><div class="revision-section-title">What moved in the report</div>';
    html += renderMarkdown(memo.differences.summary);
    (memo.differences.items || []).forEach((item) => {
      html += '<div class="revision-diff-item"><div class="revision-diff-area">' + escapeHtml(item.area) + '</div>' + renderMarkdown(item.what) + '</div>';
    });
    if (memo.differences.unchanged) {
      html += '<div class="revision-section-title" style="margin-top:1rem;">Unchanged</div>' + renderMarkdown(memo.differences.unchanged);
    }
    html += '</div>';

    if (memo.forecastRevision) html += renderForecastSection(memo.forecastRevision);

    return html;
  }

  function renderRevisionHistory(list) {
    if (!list || !list.length) return '';
    let html = '<div class="revision-history"><div class="revision-history-title">Revision history</div>';
    list.forEach((entry, index) => {
      const label = entry.original ? 'Original report' : 'Revision ' + escapeHtml(entry.version);
      const date = formatDate(entry.completedAt);
      html += '<details class="revision-entry"' + (index === 0 ? ' open' : '') + '>';
      html += '<summary class="revision-entry-summary">'
        + '<span><span class="revision-entry-label">' + label + '</span>'
        + (date ? ' <span class="revision-entry-date">' + escapeHtml(date) + '</span>' : '') + '</span>';
      if (entry.pdfUrl) {
        html += '<a class="revision-download" href="' + escapeAttr(entry.pdfUrl) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">Download this version</a>';
      }
      html += '</summary>';
      html += '<div class="revision-entry-body">';
      if (entry.original) {
        html += '<p class="revision-no-memo">The report as originally delivered, before any revisions.</p>';
      } else {
        if (entry.comments) html += '<p class="revision-comment">' + escapeHtml(entry.comments) + '</p>';
        html += renderChangeMemo(entry.changes);
      }
      html += '</div></details>';
    });
    html += '</div>';
    return html;
  }

  function renderProgress(order) {
    hideAll();
    const title = document.getElementById('progressTitle');
    const sub = document.getElementById('progressSub');
    const meta = document.getElementById('progressMeta');
    if (order.status === 'REVISING') {
      title.textContent = 'Updating your report…';
      sub.textContent = 'The report engine is interpreting your request and regenerating the report. This usually takes around 15 minutes.';
    } else {
      title.textContent = 'Preparing your report…';
      sub.textContent = 'This can take a little while. This page updates on its own — no need to refresh.';
    }
    meta.textContent = [order.companyName, order.ticker].filter(Boolean).join(' · ') || '—';
    show('stateProgress');
    pollAgain();
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

  function renderDelivered(order) {
    hideAll();
    document.getElementById('deliveredMeta').textContent =
      [order.companyName, order.ticker].filter(Boolean).join(' · ') || '—';
    document.getElementById('downloadBtn').href = order.pdfUrl || '#';

    const remaining = Math.max(0, (order.revisionsAllowed || 0) - (order.revisionsUsed || 0));
    const errorBanner = document.getElementById('revisionErrorBanner');
    if (order.revisionError) {
      errorBanner.textContent = 'Your last revision request could not be completed: ' + order.revisionError
        + ' You can try again below.';
      errorBanner.style.display = '';
    } else {
      errorBanner.style.display = 'none';
    }

    if (remaining > 0) {
      document.getElementById('revisionCount').textContent =
        remaining + ' of ' + order.revisionsAllowed + ' report revisions remaining.';
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

    document.getElementById('revisionHistory').innerHTML = renderRevisionHistory(order.revisionHistory);

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
    try {
      const res = await fetch('/api/order-status?session_id=' + encodeURIComponent(sessionId));
      const data = await res.json();

      if (!res.ok) {
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
      const res = await fetch('/api/order-revision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, comments: comments }),
      });
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

  load();
})();
