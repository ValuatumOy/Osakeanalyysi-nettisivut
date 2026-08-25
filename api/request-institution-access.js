const { sendInstitutionRequest } = require('../server/email');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.website) return res.status(200).json({ ok: true });

  const organisation = clean(body.organisation, 160);
  const orgWebsite = clean(body.orgWebsite, 300);
  const contactName = clean(body.contactName, 160);
  const contactRole = clean(body.contactRole, 160);
  const email = clean(body.email, 254);
  const analysesPerYear = clean(body.analysesPerYear, 80);
  const analystCount = clean(body.analystCount, 80);
  const notes = clean(body.notes, 2000);
  const pageUrl = clean(body.pageUrl, 500);

  if (!organisation) return res.status(400).json({ error: 'Organisation is required' });
  if (!orgWebsite) return res.status(400).json({ error: 'Website is required' });
  if (!contactName) return res.status(400).json({ error: 'Your name is required' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid work email is required' });
  if (!analysesPerYear) return res.status(400).json({ error: 'Analyses per year is required' });
  if (!analystCount) return res.status(400).json({ error: 'Analyst headcount is required' });

  try {
    await sendInstitutionRequest({
      organisation, orgWebsite, contactName, contactRole, email,
      analysesPerYear, analystCount, notes, pageUrl,
    });
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('request-institution-access:', error.message);
    return res.status(500).json({ error: 'Request could not be sent' });
  }
};

function clean(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, maxLength);
}
