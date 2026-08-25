const { sendCoverageRequest, sendInstitutionRequest } = require('../server/email');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Two forms, one function: the plan caps serverless functions and a second
// endpoint that only formats a different email is not worth one of them.
// `kind` picks the template; everything else (honeypot, cleaning, admin
// delivery) is shared.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.website) return res.status(200).json({ ok: true });

  const handler = body.kind === 'institution' ? institutionRequest : coverageRequest;

  try {
    const rejection = await handler(body);
    if (rejection) return res.status(400).json({ error: rejection });
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('request-coverage:', error.message);
    return res.status(500).json({ error: 'Request could not be sent' });
  }
};

async function coverageRequest(body) {
  const company = clean(body.company, 160);
  const email = clean(body.email, 254);
  if (!company) return 'Company name is required';
  if (!EMAIL_RE.test(email)) return 'A valid email is required';

  await sendCoverageRequest({
    company,
    email,
    ticker: clean(body.ticker, 80),
    notes: clean(body.notes, 2000),
    source: clean(body.source, 80) || 'reports',
    pageUrl: clean(body.pageUrl, 500),
  });
  return null;
}

async function institutionRequest(body) {
  const organisation = clean(body.organisation, 160);
  const orgWebsite = clean(body.orgWebsite, 300);
  const contactName = clean(body.contactName, 160);
  const email = clean(body.email, 254);
  const analysesPerYear = clean(body.analysesPerYear, 80);
  const analystCount = clean(body.analystCount, 80);

  if (!organisation) return 'Organisation is required';
  if (!orgWebsite) return 'Website is required';
  if (!contactName) return 'Your name is required';
  if (!EMAIL_RE.test(email)) return 'A valid work email is required';
  if (!analysesPerYear) return 'Analyses per year is required';
  if (!analystCount) return 'Analyst headcount is required';

  await sendInstitutionRequest({
    organisation, orgWebsite, contactName, email, analysesPerYear, analystCount,
    contactRole: clean(body.contactRole, 160),
    notes: clean(body.notes, 2000),
    pageUrl: clean(body.pageUrl, 500),
  });
  return null;
}

function clean(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, maxLength);
}
