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

  function renderProgress(order) {
    hideAll();
    const title = document.getElementById('progressTitle');
    const sub = document.getElementById('progressSub');
    const meta = document.getElementById('progressMeta');
    if (order.status === 'REVISING') {
      title.textContent = 'Updating your forecast…';
      sub.textContent = 'The report engine is interpreting your request, updating the forecast, and regenerating the report. This usually takes a few minutes.';
    } else {
      title.textContent = 'Preparing your report…';
      sub.textContent = 'This can take a little while. This page updates on its own — no need to refresh.';
    }
    meta.textContent = [order.companyName, order.ticker].filter(Boolean).join(' · ') || '—';
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
        remaining + ' of ' + order.revisionsAllowed + ' forecast revisions remaining.';
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
        if (res.status === 404) return renderError('We could not find this order. If you completed a payment, contact contact26@valuatum.com.');
        return renderError(data.error || 'We could not load your order.');
      }

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

  document.addEventListener('click', function (e) {
    const chip = e.target.closest('.revision-chip');
    if (chip) {
      document.getElementById('revisionText').value = chip.getAttribute('data-fill') || '';
      document.getElementById('revisionText').focus();
    }
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
