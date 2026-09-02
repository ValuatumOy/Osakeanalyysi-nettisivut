// AiEquityReportsWorker Lambda. One function, three triggers:
//
//   { action: 'tick' }  — async push from the API on a fresh order, and the
//                         EventBridge rate(5 minutes) backstop sweep. Runs the
//                         reconciler state machine and persists the weekly
//                         free selection (single writer).
//   { action: 'reap' }  — EventBridge daily rule. Ends expired resale windows
//                         by hiding sidecars (never deletes).
//
// Reserved concurrency 1 serializes invocations; a push that lands during a
// sweep is throttled into Lambda's async retry queue, which is intentional.

const { ensureSecrets } = require('../aws/secrets');

exports.handler = async (event) => {
  const action = event?.action || 'tick';
  try {
    return await run(action);
  } catch (err) {
    // Rethrown so the invocation still counts as a Lambda error (the
    // CloudWatch alarm watches that); the email is the part a person reads.
    console.error(`worker ${action} failed:`, err);
    await require('../email').reportError(`worker ${action}`, err);
    throw err;
  }
};

async function run(action) {
  await ensureSecrets();

  // Required late so env/secrets are in place before module-level config reads.
  const reconciler = require('../reconciler');
  const reaper = require('../reaper');
  const catalogAws = require('../aws/catalog-aws');

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
    await require('../email').reportError('worker: week-selection persistence', err);
  }

  return { ran };
}
