// AiEquityReportsWorker Lambda (plan §2). One function, three triggers:
//
//   { action: 'tick' }  — async push from the API on a fresh order, and the
//                         EventBridge rate(5 minutes) backstop sweep. Runs the
//                         reconciler state machine and persists the weekly
//                         free selection (single writer, plan §2.2 item 1).
//   { action: 'reap' }  — EventBridge daily rule. Ends expired resale windows
//                         by hiding sidecars (never deletes — plan §3).
//
// Reserved concurrency 1 serializes invocations; a push that lands during a
// sweep is throttled into Lambda's async retry queue, which is intentional.

const { ensureSecrets } = require('../aws/secrets');

exports.handler = async (event) => {
  await ensureSecrets();

  // Required late so env/secrets are in place before module-level config reads.
  const reconciler = require('../reconciler');
  const reaper = require('../reaper');
  const catalogAws = require('../aws/catalog-aws');

  const action = event?.action || 'tick';

  if (action === 'reap') {
    const summary = await reaper.sweep();
    console.log('worker: reap done', summary);
    return summary;
  }

  const ran = await reconciler.tick();

  // Record this week's free selection so the repeat-cooldown history
  // accumulates (reads are persistence-free; the worker is the one writer).
  try {
    const { catalog, state } = await catalogAws.buildCatalogAws();
    await catalogAws.persistWeekSelection(catalog, state);
  } catch (err) {
    console.warn('worker: week-selection persistence failed:', err.message);
  }

  return { ran };
};
