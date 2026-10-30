const { BatchGetCommand } = require('@aws-sdk/lib-dynamodb');
const { dynamo } = require('./clients');

async function getRevisionJobs(jobIds) {
  const table = process.env.PDF_ENGINE_JOBS_TABLE;
  const ids = [...new Set(jobIds.filter(Boolean))];
  const jobs = new Map();
  if (!table || !ids.length) return jobs;
  for (let i = 0; i < ids.length; i += 100) {
    let keys = ids.slice(i, i + 100).map(jobId => ({ jobId }));
    for (let attempt = 0; keys.length && attempt < 3; attempt += 1) {
      const result = await dynamo().send(new BatchGetCommand({ RequestItems: { [table]: {
        Keys: keys,
        ProjectionExpression: 'jobId, #status, username, snapshotKey, templateName, params.companyCode',
        ExpressionAttributeNames: { '#status': 'status' },
      } } }));
      for (const job of result.Responses?.[table] || []) jobs.set(job.jobId, job);
      keys = result.UnprocessedKeys?.[table]?.Keys || [];
    }
  }
  return jobs;
}

function canRevise(job, username = process.env.PDF_ENGINE_USERNAME || 'osakeanalyysi-site') {
  return Boolean(job && job.status === 'DONE' && job.username === username && job.snapshotKey
    && job.templateName === 'osakeanalyysi' && job.params && typeof job.params === 'object');
}

async function isOrderRevisable(order) {
  if (!order?.jobId || order.status !== 'DELIVERED') return false;
  try {
    const jobs = await getRevisionJobs([order.jobId]);
    return canRevise(jobs.get(order.jobId), order.engineUsername || undefined);
  } catch (err) {
    console.warn('Could not verify revision availability:', err.message);
    return false;
  }
}

module.exports = { getRevisionJobs, canRevise, isOrderRevisable };
