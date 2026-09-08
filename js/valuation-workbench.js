// The target-price workbench on the order page: the report's own valuation
// bridge with its inputs editable, the target recomputed by the engine on
// every change, a solver for "what would the current price require", and the
// report's sensitivity grid. Nothing here writes anything — locking the
// assumptions into a new report is a revision, wired by the order page.
//
//   ValuationWorkbench.mount(container, { preview, onLock, remainingRounds })
//     preview(body)  → Promise<Response> for { overrides?, solve? }
//     onLock(overrides, rows) → called with the customer's changes
(function () {
  'use strict';

  const LEVER_LABEL = {
    probabilityPct: 'probability',
    marketValue: 'market size',
    sharePct: 'market share',
    marginPct: 'margin',
    metricValue: 'profit forecast',
    selectedMultiple: 'multiple',
    weightPct: 'weight',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
  const fmt1 = (n) => (Math.round(n * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmtPct = (n) => (Math.round(n * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 });
  const fmtSigned = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmtPct(Math.abs(n)) + '%';
  const titleCase = (s) => String(s || '');
  const num = (v) => { const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };

  function mount(container, opts) {
    const state = { baseline: null, current: null, overrides: {}, timer: null, inflight: 0, solveRow: '' };
    const byKey = (rows) => { const m = {}; (rows || []).forEach((r) => { m[r.key] = r; }); return m; };

    // ---- rendering -------------------------------------------------------

    function fieldHtml(row, lever, value, extra) {
      const base = state.baseline && byKey(state.baseline.rows)[row.key];
      const baseValue = base ? valueOf(base, lever) : value;
      const changed = state.overrides[row.key] && state.overrides[row.key][lever] != null && Math.abs(baseValue - value) > 1e-9;
      const step = lever === 'metricValue' || lever === 'marketValue' ? 100 : lever === 'selectedMultiple' ? 0.5 : 1;
      const shown = lever === 'metricValue' || lever === 'marketValue' ? fmtInt(value) : lever === 'selectedMultiple' ? fmt1(value) : fmtPct(value);
      return '<span class="wb-field' + (changed ? ' is-changed' : '') + '">'
        + '<input type="text" inputmode="decimal" data-row="' + esc(row.key) + '" data-lever="' + lever + '" value="' + esc(shown) + '" step="' + step + '" aria-label="' + esc(titleCase(LEVER_LABEL[lever]) + ', ' + row.label) + '" size="' + Math.max(3, shown.length + 1) + '">'
        + (extra || '')
        + (changed ? '<span class="wb-was">was ' + esc(lever === 'metricValue' || lever === 'marketValue' ? fmtInt(baseValue) : lever === 'selectedMultiple' ? fmt1(baseValue) + 'x' : fmtPct(baseValue) + '%') + '</span>' : '')
        + '</span>';
    }

    function valueOf(row, lever) {
      if (lever === 'sharePct') return row.scale ? row.scale.sharePct : 0;
      if (lever === 'marketValue') return row.scale ? row.scale.marketValue : 0;
      if (lever === 'marginPct') return row.scale ? row.scale.marginPct : row.modelledMargin ? row.modelledMargin.impliedMarginPct : 0;
      return row[lever] || 0;
    }

    function metricCell(row, hinted) {
      const year = row.forecastYear ? row.forecastYear + 'E ' : '';
      const label = '<span class="wb-cell-label">' + esc(year + (row.metricUsed || '').replace(/^\d{4}E?\s*/i, '')) + '</span>';
      if (row.editable.indexOf('sharePct') >= 0 && row.scale) {
        return label
          + '<span class="wb-build">' + fieldHtml(row, 'sharePct', row.scale.sharePct, '<span class="wb-unit">%</span>')
          + '<span class="wb-op">of</span>' + (row.editable.indexOf('marketValue') >= 0
            ? fieldHtml(row, 'marketValue', row.scale.marketValue)
            : '<span class="wb-build-market" title="' + esc(row.scale.market) + '">' + fmtInt(row.scale.marketValue) + '</span>')
          + '<span class="wb-op">×</span>' + fieldHtml(row, 'marginPct', row.scale.marginPct, '<span class="wb-unit">%</span><span class="wb-unit-word" title="The report\'s own margin assumption for this scenario. The engine only checks that market × share × margin reproduces the profit figure; whether the margin is defensible is the analyst\'s call.">margin</span>') + '</span>'
          + '<span class="wb-derived">= ' + fmtInt(row.metricValue) + ' <span class="wb-market-name">' + esc(row.scale.sharePct >= 100 ? 'all of: ' : 'share of: ') + esc(row.scale.market) + (row.editable.indexOf('marketValue') >= 0 ? ' · the report\'s figure; change it if you read the market differently' : '') + '</span></span>'
          + (hinted ? '' : marginContextHint());
      }
      if (row.editable.indexOf('metricValue') >= 0) {
        const m = row.modelledMargin;
        if (m && row.editable.indexOf('marginPct') >= 0) {
          // Same shape as a scenario leg: the report's own revenue build for
          // this year, with the margin as the lever. Either field moves the metric.
          const differs = Math.abs(m.marginPct - m.impliedMarginPct) > 0.15;
          return label
            + '<span class="wb-build">' + fieldHtml(row, 'metricValue', row.metricValue)
            + '<span class="wb-op">=</span><span class="wb-build-market" title="' + esc('Revenue the report models for this business in ' + m.year) + '">' + fmtInt(m.revenue) + '</span>'
            + '<span class="wb-op">×</span>' + fieldHtml(row, 'marginPct', m.impliedMarginPct, '<span class="wb-unit">%</span><span class="wb-unit-word" title="' + esc('Margin on the report\'s own ' + m.year + ' revenue build. The report models ' + fmtPct(m.marginPct) + '% ' + m.metric + '; the bridge implies ' + fmtPct(m.impliedMarginPct) + '%.') + '">margin</span>') + '</span>'
            + (differs ? '<span class="wb-hint is-left">report models ' + fmtPct(m.marginPct) + '% ' + esc(m.metric) + ' margin; this bridge implies ' + fmtPct(m.impliedMarginPct) + '%</span>' : '');
        }
        return label + fieldHtml(row, 'metricValue', row.metricValue)
          + (m ? '<span class="wb-hint is-left" title="The margin this report models for the division, from its own revenue and cost build; a different year than the bridge values, so not a lever here.">modelled ' + esc(m.metric) + ' margin ' + esc(String(m.year)) + ': ' + fmtPct(m.marginPct) + '%</span>' : '');
      }
      if (row.kind === 'option-expectation' || row.kind === 'sotp-total') return '<span class="wb-cell-label">' + esc(row.metricUsed) + '</span>';
      return label + '<span class="wb-static">' + fmtInt(row.metricValue) + '</span>';
    }

    // A scenario leg's margin is asserted, not modelled: the only honest
    // context is what the report models elsewhere, shown as a list, never as
    // a number that could read as this division's own.
    function marginContextHint() {
      const list = (state.current && state.current.modelledMargins) || [];
      if (!list.length) return '';
      const values = list.map((m) => m.marginPct).sort((a, b) => a - b);
      const metric = list.every((m) => m.metric === list[0].metric) ? list[0].metric : 'profit';
      const detail = list.map((m) => m.division + ' ' + fmtPct(m.marginPct) + '% (' + m.metric + ' ' + m.year + ')').join(' · ');
      return '<span class="wb-hint is-left" title="' + esc(detail) + '">this scenario\'s margin is an assumption; the report models ' + fmtPct(values[0]) + '–' + fmtPct(values[values.length - 1]) + '% ' + esc(metric) + ' in its established businesses</span>';
    }

    function multipleCell(row) {
      if (!(row.selectedMultiple > 0)) return '<span class="wb-muted">—</span>';
      if (row.editable.indexOf('selectedMultiple') < 0) return '<span class="wb-static">' + fmt1(row.selectedMultiple) + 'x</span>';
      let hint = '';
      if (row.multipleOverridden) hint = '<span class="wb-hint is-warn">report basis no longer applies</span>';
      else if (row.multipleBasis) {
        const b = row.multipleBasis;
        hint = '<span class="wb-hint" title="' + esc(b.summary) + '">' + (b.kind === 'peers' ? 'peer median' : 'cash-flow basis') + (b.expectedMultiple ? ' ' + fmt1(b.expectedMultiple) + 'x' : '') + '</span>';
      }
      return fieldHtml(row, 'selectedMultiple', row.selectedMultiple, '<span class="wb-unit">x</span>') + hint;
    }

    function weightCell(row) {
      if (row.kind === 'option-leg') return fieldHtml(row, 'probabilityPct', row.probabilityPct, '<span class="wb-unit">%</span>');
      if (row.kind === 'method' && row.editable.indexOf('weightPct') >= 0) return fieldHtml(row, 'weightPct', row.weightPct, '<span class="wb-unit">%</span>');
      if (row.kind === 'method' || row.kind === 'sotp-total') return '<span class="wb-static">' + fmtPct(row.weightPct || 0) + '%</span>';
      return '<span class="wb-muted">—</span>';
    }

    function discountCell(row) {
      if (!(row.discountFactor > 1)) return '<span class="wb-muted">—</span>';
      return '<span class="wb-static">÷ ' + (Math.round(row.discountFactor * 100) / 100).toFixed(2) + '</span>';
    }

    function rowLabel(row) {
      if (row.kind === 'option-leg') return '<span class="wb-leg-label">' + esc(titleCase(row.scenario || row.label)) + '</span>';
      if (row.kind === 'option-expectation') {
        const residual = row.residualPct > 0.05
          ? '<span class="wb-division-note is-residual" title="The scenarios below do not cover every outcome; the rest is valued at zero.">' + fmtPct(row.residualPct) + '% of outcomes not covered by a scenario → valued at 0</span>'
          : '<span class="wb-division-note">scenarios cover 100% of outcomes</span>';
        return '<span class="wb-division">' + esc(titleCase(row.division)) + '</span><span class="wb-division-note">probability-weighted</span>' + residual;
      }
      if (row.kind === 'engine') return '<span class="wb-division">' + esc(titleCase(row.division || row.label)) + '</span>';
      if (row.kind === 'sotp-total') return '<span class="wb-division">Sum of the parts</span>';
      return '<span class="wb-division">' + esc(row.label) + '</span>';
    }

    function tableHtml(result) {
      const issuesByRow = {};
      (result.issues || []).forEach((i) => { (issuesByRow[i.row || ''] = issuesByRow[i.row || ''] || []).push(i); });
      let html = '<table class="wb-table"><thead><tr>'
        + '<th scope="col">Business · scenario</th><th scope="col">Forecast metric</th><th scope="col" class="num">× Multiple</th>'
        + '<th scope="col" class="num">÷ Discount</th><th scope="col" class="num">× Probability / weight</th><th scope="col" class="num">= ' + esc(result.currency) + ' / share</th>'
        + '</tr></thead><tbody>';
      let lastDivision = null;
      const hintedDivisions = {};
      result.rows.forEach((row) => {
        if (row.kind === 'anchor') return;
        const cls = ['wb-row', 'wb-row--' + row.kind];
        const division = row.division || null;
        if (row.kind === 'option-expectation' && lastDivision !== null) cls.push('wb-row--group-start');
        if (row.kind === 'engine' && lastDivision !== null && lastDivision !== division) cls.push('wb-row--group-start');
        lastDivision = division;
        const rowIssues = issuesByRow[row.key] || [];
        const contribution = Number.isFinite(row.contributionPerShare) ? fmt1(row.contributionPerShare) : '<span class="wb-muted">—</span>';
        if (row.kind === 'option-leg') hintedDivisions[row.division] = true;
        html += '<tr class="' + cls.join(' ') + (rowIssues.length ? ' has-issue' : '') + '" data-row="' + esc(row.key) + '">'
          + '<th scope="row">' + rowLabel(row) + '</th>'
          + '<td>' + metricCell(row, row.kind === 'option-leg' && hintedDivisions[row.division]) + '</td>'
          + '<td class="num">' + multipleCell(row) + '</td>'
          + '<td class="num">' + discountCell(row) + '</td>'
          + '<td class="num">' + weightCell(row) + '</td>'
          + '<td class="num wb-contrib"><span class="wb-static">' + contribution + '</span></td>'
          + '</tr>';
        rowIssues.forEach((i) => {
          html += '<tr class="wb-issue-row"><td colspan="6"><span class="wb-issue">' + esc(i.message) + '</span></td></tr>';
        });
      });
      (issuesByRow[''] || []).forEach((i) => {
        html += '<tr class="wb-issue-row"><td colspan="6"><span class="wb-issue">' + esc(i.message) + '</span></td></tr>';
      });
      html += '</tbody></table>';
      return html;
    }

    function bandHtml(result) {
      const up = result.upsidePct;
      const lo = result.bands.sellBelowPct, hi = result.bands.buyAbovePct;
      const span = 60; // −60 … +60 shown
      const pos = up == null ? null : Math.max(2, Math.min(98, ((up + span) / (2 * span)) * 100));
      const base = state.baseline && state.baseline.upsidePct;
      const basePos = base == null ? null : Math.max(2, Math.min(98, ((base + span) / (2 * span)) * 100));
      return '<div class="wb-band" aria-hidden="true">'
        + '<span class="wb-band-seg wb-band-seg--sell" style="width:' + (((lo + span) / (2 * span)) * 100) + '%">Sell</span>'
        + '<span class="wb-band-seg wb-band-seg--hold" style="width:' + (((hi - lo) / (2 * span)) * 100) + '%">Hold</span>'
        + '<span class="wb-band-seg wb-band-seg--buy" style="flex:1">Buy</span>'
        + (basePos != null && pos != null && Math.abs(basePos - pos) > 0.5 ? '<span class="wb-band-marker wb-band-marker--base" style="left:' + basePos + '%"></span>' : '')
        + (pos != null ? '<span class="wb-band-marker" style="left:' + pos + '%"></span>' : '')
        + '</div><div class="wb-band-scale"><span>−60%</span><span>' + lo + '%</span><span>+' + hi + '%</span><span>+60%</span></div>';
    }

    // The report's own QA verdict travels with the numbers. A blocked report is
    // delivered when its target is code-computed and only the argument behind
    // it failed a check; the numbers here are those numbers, so say so.
    function qualityHtml(result) {
      const q = result.reportQuality;
      if (!q || q.status !== 'blocked') return '';
      return '<p class="wb-quality">This report was delivered with ' + q.blockers + ' unresolved valuation finding' + (q.blockers === 1 ? '' : 's')
        + '. The target and every figure below are computed by the engine, but the report\'s argument for them did not pass every check and is under review.</p>';
    }

    function summaryHtml(result) {
      const base = state.baseline;
      const changed = base && result.targetPrice != null && Math.abs(result.targetPrice - base.targetPrice) > 0.04;
      const target = result.targetPrice == null ? '<span class="wb-target-value is-invalid">—</span>' : '<span class="wb-target-value">' + fmt1(result.targetPrice) + '</span>';
      const rating = result.rating ? '<span class="wb-rating wb-rating--' + result.rating.toLowerCase() + '">' + result.rating + '</span>' : '<span class="wb-rating wb-rating--none">not computable</span>';
      const ratingChanged = base && result.rating && base.rating !== result.rating;
      return '<div class="wb-summary">'
        + '<div class="wb-summary-target"><span class="wb-summary-label">12-month target price</span>'
        + '<span class="wb-target">' + target + '<span class="wb-target-ccy">' + esc(result.currency) + '</span></span>'
        + (result.targetPrice == null ? '<span class="wb-target-was is-invalid">fix the highlighted input to recompute</span>'
          : changed ? '<span class="wb-target-was">report: ' + fmt1(base.targetPrice) + ' ' + esc(result.currency) + '</span>' : '<span class="wb-target-was">as in the report</span>')
        + '</div>'
        + '<div class="wb-summary-band"><span class="wb-summary-label">Against the price the report was written at</span>'
        + '<span class="wb-upside">' + (result.upsidePct == null ? '—' : fmtSigned(result.upsidePct)) + ' ' + rating
        + (ratingChanged ? '<span class="wb-rating-was">was ' + esc(base.rating) + '</span>' : '') + '</span>'
        + bandHtml(result)
        + '</div>'
        + '<div class="wb-summary-price"><span class="wb-summary-label">Share price</span>'
        + '<span class="wb-price">' + fmt1(result.currentPrice) + ' <span class="wb-target-ccy">' + esc(result.currency) + '</span></span>'
        + '<span class="wb-target-was">priced ' + esc(result.pricedAsOf) + '</span></div>'
        + '</div>';
    }

    function solveOptions(result) {
      const options = [];
      result.rows.forEach((row) => {
        row.editable.forEach((lever) => {
          const name = row.kind === 'option-leg' ? titleCase(row.division) + ' — ' + titleCase(row.scenario) : titleCase(row.division || row.label);
          options.push({ value: row.key + '::' + lever, label: name + ' · ' + LEVER_LABEL[lever] });
        });
      });
      options.push({ value: '::allMetricsScale', label: 'Every profit forecast, scaled together' });
      return options;
    }

    function solveHtml(result) {
      const options = solveOptions(result).filter((o) => o.value !== '::allMetricsScale');
      if (!state.solveRow) state.solveRow = options[0] ? options[0].value : '';
      return '<div class="wb-solve">'
        + '<div class="wb-solve-label">What would the current price of ' + fmt1(result.currentPrice) + ' ' + esc(result.currency) + ' require?</div>'
        + '<div class="wb-solve-row">'
        + '<button type="button" class="btn btn-primary btn-sm" id="wbSolveAllBtn">Scale every forecast to the current price</button>'
        + '<span class="wb-solve-or">or move one input only:</span>'
        + '<select id="wbSolveLever" class="wb-select" aria-label="Input to solve for">' + options.map((o) => '<option value="' + esc(o.value) + '"' + (o.value === state.solveRow ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') + '</select>'
        + '<button type="button" class="btn btn-outline-dark btn-sm" id="wbSolveBtn">Solve</button>'
        + '</div><p class="wb-solve-result" id="wbSolveResult" aria-live="polite"></p></div>';
    }

    // Every profit forecast × k: the engine's own answer to "what does the
    // price require", applied as the same overrides a user could have typed
    // (the metric on an established business, the market on a scenario), so
    // the bridge below shows every "was".
    async function runSolveAll() {
      const out = container.querySelector('#wbSolveResult');
      out.innerHTML = '<span class="wb-muted">Solving…</span>';
      try {
        const data = await request({ overrides: state.overrides, solve: { for: 'allMetricsScale', targetPrice: state.current.currentPrice } });
        const s = data.solve;
        if (!s || !s.reached) {
          out.innerHTML = '<span class="wb-unreachable">Even scaling every forecast ' + (s ? (Math.round(s.upper * 10) / 10) + '×' : '') + ' does not reach the price.</span>';
          return;
        }
        const k = s.value;
        const rows = state.current.rows;
        rows.forEach((row) => {
          if (row.kind === 'engine' || row.kind === 'method') {
            if (row.editable.indexOf('metricValue') >= 0) (state.overrides[row.key] = state.overrides[row.key] || {}).metricValue = row.metricValue * k;
          } else if (row.kind === 'option-leg') {
            if (row.editable.indexOf('marketValue') >= 0) (state.overrides[row.key] = state.overrides[row.key] || {}).marketValue = row.scale.marketValue * k;
            else if (row.editable.indexOf('metricValue') >= 0) (state.overrides[row.key] = state.overrides[row.key] || {}).metricValue = row.metricValue * k;
          }
        });
        await refresh();
        const pct = (k - 1) * 100;
        container.querySelector('#wbSolveResult').innerHTML = 'Every profit forecast ' + (pct >= 0 ? 'raised' : 'lowered') + ' by <strong>' + fmtPct(Math.abs(pct)) + '%</strong> (×' + (Math.round(k * 100) / 100).toFixed(2) + ') puts the target at ' + fmt1(s.targetAtValue) + ' ' + esc(data.currency)
          + '. The bridge below now shows those figures, each with the report\'s own value beside it. <button type="button" class="wb-link" id="wbSolveUndo">Back to the report\'s figures</button>';
        const undo = container.querySelector('#wbSolveUndo');
        if (undo) undo.addEventListener('click', () => { state.overrides = {}; refresh(); });
      } catch (err) {
        out.innerHTML = '<span class="wb-issue">' + esc(err.message) + '</span>';
      }
    }

    function sensitivityHtml(result) {
      const s = result.sensitivity;
      if (!s || !s.rows.length) return '';
      const isProb = s.axis === 'probabilityPct';
      const price = result.currentPrice;
      const cellClass = (p) => { const up = ((p - price) / price) * 100; return up > result.bands.buyAbovePct ? 'is-buy' : up < result.bands.sellBelowPct ? 'is-sell' : 'is-hold'; };
      let html = '<div class="wb-sens"><div class="wb-section-title">Sensitivity</div>'
        + '<p class="wb-section-sub">' + (isProb ? 'Combined success probability of the largest option (rows) against its exit multiple (columns), with everything else as set above.' : 'The main profit forecast (rows) against its multiple (columns), with everything else as set above.') + ' Shaded by the rating each target would carry.</p>'
        + '<table class="wb-sens-table"><thead><tr><th scope="col">' + (isProb ? 'Probability' : 'Forecast') + '</th>' + s.columns.map((c) => '<th scope="col">' + fmt1(c) + 'x</th>').join('') + '</tr></thead><tbody>';
      s.rows.forEach((r) => {
        html += '<tr' + (r.label ? ' class="is-base"' : '') + '><th scope="row">' + (isProb ? fmtPct(r.value) + '%' : fmtInt(r.value)) + (r.label ? '<span class="wb-sens-note">now</span>' : '') + '</th>'
          + r.prices.map((p) => '<td class="' + cellClass(p) + '">' + fmt1(p) + '</td>').join('') + '</tr>';
      });
      return html + '</tbody></table></div>';
    }

    function footerHtml() {
      const changes = Object.keys(state.overrides).length;
      const rounds = opts.remainingRounds || 0;
      return '<div class="wb-footer">'
        + '<button type="button" class="btn btn-ghost" id="wbReset"' + (changes ? '' : ' disabled') + '>Back to the report\'s assumptions</button>'
        + '<div class="wb-footer-lock">'
        + '<button type="button" class="btn btn-primary btn-lg" id="wbLock"' + (changes && rounds > 0 && state.current && state.current.targetPrice != null ? '' : ' disabled') + '>Lock these assumptions &amp; generate the report</button>'
        + '<span class="wb-footer-hint">' + (rounds > 0
          ? 'Uses 1 of your ' + rounds + ' remaining revision' + (rounds === 1 ? '' : 's') + '. The report text is rewritten around the new numbers; nothing changes until you lock.'
          : 'Add a revision round to turn these assumptions into a new report.') + '</span>'
        + '</div></div>';
    }

    function render() {
      const result = state.current;
      container.innerHTML = qualityHtml(result) + summaryHtml(result)
        + '<div class="wb-section-title">The bridge</div>'
        + '<p class="wb-section-sub">Every figure the target is built from. Change any underlined value; the engine recomputes the whole bridge the same way it did for the report.</p>'
        + '<div class="wb-table-wrap">' + tableHtml(result) + '</div>'
        + '<div class="wb-lower">' + solveHtml(result) + sensitivityHtml(result) + '</div>'
        + footerHtml();
      wire();
    }

    // Patch what changed instead of re-rendering the table, so a field being
    // typed in keeps its caret.
    function update() {
      const result = state.current;
      const summary = container.querySelector('.wb-summary');
      if (summary) summary.outerHTML = summaryHtml(result);
      const wrap = container.querySelector('.wb-table-wrap');
      const active = document.activeElement;
      const activeKey = active && active.dataset && active.dataset.row ? active.dataset.row + '::' + active.dataset.lever : null;
      const selStart = active && active.selectionStart;
      if (wrap) wrap.innerHTML = tableHtml(result);
      if (activeKey) {
        const again = container.querySelector('input[data-row="' + CSS.escape(activeKey.split('::')[0]) + '"][data-lever="' + activeKey.split('::')[1] + '"]');
        if (again) { again.focus(); try { again.setSelectionRange(selStart, selStart); } catch (e) { /* not a text input */ } }
      }
      const sens = container.querySelector('.wb-sens');
      const sensHtml = sensitivityHtml(result);
      if (sens) { if (sensHtml) sens.outerHTML = sensHtml; else sens.remove(); }
      else if (sensHtml) container.querySelector('.wb-lower').insertAdjacentHTML('beforeend', sensHtml);
      const footer = container.querySelector('.wb-footer');
      if (footer) footer.outerHTML = footerHtml();
      const solve = container.querySelector('.wb-solve');
      if (solve) { const keep = container.querySelector('#wbSolveResult'); const kept = keep ? keep.innerHTML : ''; solve.outerHTML = solveHtml(result); container.querySelector('#wbSolveResult').innerHTML = kept; }
      wire();
    }

    // ---- interaction -----------------------------------------------------

    function wire() {
      container.querySelectorAll('input[data-lever]').forEach((input) => {
        input.addEventListener('input', () => schedule(input, 350));
        input.addEventListener('change', () => schedule(input, 0));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); schedule(input, 0); }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            const v = num(input.value); if (v == null) return;
            e.preventDefault();
            const step = Number(input.getAttribute('step')) * (e.shiftKey ? 10 : 1);
            input.value = String(Math.round((v + (e.key === 'ArrowUp' ? step : -step)) * 1000) / 1000);
            schedule(input, 150);
          }
        });
      });
      const reset = container.querySelector('#wbReset');
      if (reset) reset.addEventListener('click', () => { state.overrides = {}; state.solveRow = ''; refresh(); });
      const lock = container.querySelector('#wbLock');
      if (lock) lock.addEventListener('click', () => opts.onLock(state.overrides, changeList()));
      const solveBtn = container.querySelector('#wbSolveBtn');
      if (solveBtn) solveBtn.addEventListener('click', runSolve);
      const solveAllBtn = container.querySelector('#wbSolveAllBtn');
      if (solveAllBtn) solveAllBtn.addEventListener('click', runSolveAll);
      const sel = container.querySelector('#wbSolveLever');
      if (sel) sel.addEventListener('change', () => { state.solveRow = sel.value; container.querySelector('#wbSolveResult').innerHTML = ''; });
    }

    function schedule(input, delay) {
      let value = num(input.value);
      if (value == null) return;
      const key = input.dataset.row, lever = input.dataset.lever;
      // A scenario probability is stated in whole percents in the report and
      // its gates; a fractional one would come back as a finding when locked.
      if (lever === 'probabilityPct') { value = Math.round(value); input.value = String(value); }
      const base = byKey(state.baseline.rows)[key];
      const o = state.overrides[key] || (state.overrides[key] = {});
      if (base && Math.abs(valueOf(base, lever) - value) < 1e-9) { delete o[lever]; if (!Object.keys(o).length) delete state.overrides[key]; }
      else o[lever] = value;
      // A profit engine's metric and its margin describe the same number; the one just typed wins.
      if (base && base.kind === 'engine' && (lever === 'metricValue' || lever === 'marginPct')) {
        delete o[lever === 'metricValue' ? 'marginPct' : 'metricValue'];
        if (!Object.keys(o).length) delete state.overrides[key];
      }
      window.clearTimeout(state.timer);
      state.timer = window.setTimeout(refresh, delay);
    }

    async function request(body) {
      const res = await opts.preview(body);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
      return data;
    }

    async function refresh() {
      const ticket = ++state.inflight;
      container.classList.add('is-computing');
      try {
        const data = await request({ overrides: state.overrides });
        if (ticket !== state.inflight) return;
        state.current = data;
        update();
      } catch (err) {
        if (ticket !== state.inflight) return;
        showError(err.message);
      } finally {
        if (ticket === state.inflight) container.classList.remove('is-computing');
      }
    }

    async function runSolve() {
      const out = container.querySelector('#wbSolveResult');
      const [row, lever] = state.solveRow.split('::');
      out.innerHTML = '<span class="wb-muted">Solving…</span>';
      try {
        const data = await request({ overrides: state.overrides, solve: { for: lever, row: row || undefined, targetPrice: state.current.currentPrice } });
        const s = data.solve;
        const rowInfo = row ? byKey(state.current.rows)[row] : null;
        const name = rowInfo ? (rowInfo.kind === 'option-leg' ? titleCase(rowInfo.division) + ' — ' + titleCase(rowInfo.scenario) : titleCase(rowInfo.division || rowInfo.label)) : 'every profit forecast';
        const unit = lever === 'metricValue' || lever === 'marketValue' ? '' : lever === 'selectedMultiple' ? 'x' : lever === 'allMetricsScale' ? '×' : '%';
        const shown = (v) => (lever === 'metricValue' || lever === 'marketValue' ? fmtInt(v) : lever === 'allMetricsScale' ? (Math.round(v * 100) / 100).toFixed(2) : fmt1(v)) + unit;
        if (!s || !Number.isFinite(s.value) || s.targetAtValue == null) {
          out.innerHTML = '<span class="wb-issue">The calculator cannot vary this input on its own.</span>';
          return;
        }
        if (s.reached) {
          out.innerHTML = 'The ' + esc(LEVER_LABEL[lever] || 'forecasts') + ' for <strong>' + esc(name) + '</strong> would have to be <strong>' + esc(shown(s.value)) + '</strong>'
            + (rowInfo ? ' (the report has ' + esc(shown(valueOf(rowInfo, lever))) + ')' : '')
            + ' for the target to sit at ' + fmt1(s.targetAtValue) + ' ' + esc(data.currency) + '. '
            + (lever === 'allMetricsScale' ? '' : '<button type="button" class="wb-link" id="wbSolveApply">Set it and see the bridge</button>');
          const apply = out.querySelector('#wbSolveApply');
          if (apply) apply.addEventListener('click', () => {
            state.overrides[row] = Object.assign(state.overrides[row] || {}, {});
            // The solver's exact value, except a probability, which the report states in whole percents.
            state.overrides[row][lever] = lever === 'probabilityPct' ? Math.round(s.value) : s.value;
            refresh();
          });
        } else {
          out.innerHTML = '<span class="wb-unreachable">Not reachable with this input alone.</span> Even at <strong>' + esc(shown(s.value)) + '</strong>'
            + (lever === 'probabilityPct' ? ' (the other scenarios of this business take the rest)' : '')
            + ' the target would be ' + fmt1(s.targetAtValue) + ' ' + esc(data.currency) + '. Try another input, or use the button on the left to scale every forecast together.';
        }
      } catch (err) {
        out.innerHTML = '<span class="wb-issue">' + esc(err.message) + '</span>';
      }
    }

    function changeList() {
      const rows = byKey(state.current.rows), base = byKey(state.baseline.rows);
      const list = [];
      Object.keys(state.overrides).forEach((key) => {
        Object.keys(state.overrides[key]).forEach((lever) => {
          const row = rows[key] || base[key];
          list.push({ key, lever, label: row ? (row.kind === 'option-leg' ? titleCase(row.division) + ' — ' + titleCase(row.scenario) : titleCase(row.division || row.label)) : key,
            what: LEVER_LABEL[lever], before: valueOf(base[key], lever), after: state.overrides[key][lever] });
        });
      });
      return list;
    }

    function showError(message) {
      let el = container.querySelector('.wb-error');
      if (!el) { el = document.createElement('p'); el.className = 'wb-error'; container.prepend(el); }
      el.textContent = message;
    }

    async function start() {
      container.innerHTML = '<p class="wb-loading">Loading the valuation bridge…</p>';
      try {
        const data = await request({});
        state.baseline = data;
        state.current = data;
        render();
        return true;
      } catch (err) {
        container.innerHTML = '<p class="wb-unavailable">' + esc(err.message) + '</p>';
        return false;
      }
    }

    return { start, refresh, get overrides() { return state.overrides; } };
  }

  window.ValuationWorkbench = { mount };
})();
