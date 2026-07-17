const { sendCoverageRequest } = require('../server/email');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.website) return res.status(200).json({ ok: true });

  const company = clean(body.company, 160);
  const ticker = clean(body.ticker, 80);
  const email = clean(body.email, 254);
  const notes = clean(body.notes, 2000);
  const source = clean(body.source, 80) || 'reports';
  const pageUrl = clean(body.pageUrl, 500);

  if (!company) return res.status(400).json({ error: 'Company name is required' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required' });

  try {
    await sendCoverageRequest({ company, ticker, email, notes, source, pageUrl });
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('request-coverage:', error.message);
    return res.status(500).json({ error: 'Coverage request could not be sent' });
  }
};

function clean(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, maxLength);
}
