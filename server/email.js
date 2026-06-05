const { Resend } = require('resend');

const FROM = process.env.FROM_EMAIL || 'reports@valuatum.com';
const ADMIN = process.env.ADMIN_EMAIL || 'contact26@valuatum.com';
const SITE = process.env.SITE_URL || 'https://valuatum.com';

function resend() {
  return new Resend(process.env.RESEND_API_KEY);
}

// ── Existing report: deliver PDF link ────────────────────────────────────────
async function sendReportEmail(toEmail, report) {
  await resend().emails.send({
    from: FROM,
    to: toEmail,
    subject: `Your Valuatum AI Equity Report — ${report.ticker}`,
    html: `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f7f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;">
        <tr><td style="background:#1B3028;border-radius:12px 12px 0 0;padding:24px 32px;">
          <p style="color:#6DBFA0;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;margin:0 0 4px;">Valuatum</p>
          <p style="color:rgba(255,255,255,.45);font-size:10px;letter-spacing:.08em;text-transform:uppercase;margin:0;">AI Equity Reports</p>
        </td></tr>
        <tr><td style="background:#fff;border:1px solid #E2E9E5;border-top:none;border-radius:0 0 12px 12px;padding:36px 32px;">
          <h1 style="font-size:22px;font-weight:300;color:#1A2420;margin:0 0 6px;letter-spacing:-.01em;">Your report is ready.</h1>
          <p style="color:#8A9590;margin:0 0 8px;font-size:14px;">${report.name} &middot; ${report.ticker}</p>
          <p style="color:#8A9590;margin:0 0 28px;font-size:13px;">Generated ${report.reportDate}</p>
          <a href="${report.pdfUrl}" style="display:inline-block;background:#3D9E72;color:#fff;padding:14px 28px;border-radius:100px;text-decoration:none;font-weight:600;font-size:15px;margin-bottom:28px;">
            Download PDF report &rarr;
          </a>
          <div style="border-top:1px solid #E2E9E5;padding-top:20px;">
            <p style="font-size:12px;color:#8A9590;line-height:1.65;margin:0 0 6px;">
              This report is licensed for your personal research and reference use.
            </p>
            <p style="font-size:11px;color:#8A9590;line-height:1.65;margin:0;">
              Questions? <a href="mailto:contact26@valuatum.com" style="color:#3D9E72;text-decoration:none;">contact26@valuatum.com</a>
              &nbsp;&middot;&nbsp; <em>AI-generated research. Not investment advice.</em>
            </p>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}

// ── Fresh report: confirm to customer ───────────────────────────────────────
async function sendFreshConfirmEmail(toEmail, meta) {
  const company = meta?.company || 'your company';
  const ticker = meta?.ticker ? ` (${meta.ticker})` : '';

  await resend().emails.send({
    from: FROM,
    to: toEmail,
    subject: `Fresh report order confirmed — ${company}`,
    html: `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f7f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;">
        <tr><td style="background:#1B3028;border-radius:12px 12px 0 0;padding:24px 32px;">
          <p style="color:#6DBFA0;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;margin:0 0 4px;">Valuatum</p>
          <p style="color:rgba(255,255,255,.45);font-size:10px;letter-spacing:.08em;text-transform:uppercase;margin:0;">AI Equity Reports</p>
        </td></tr>
        <tr><td style="background:#fff;border:1px solid #E2E9E5;border-top:none;border-radius:0 0 12px 12px;padding:36px 32px;">
          <h1 style="font-size:22px;font-weight:300;color:#1A2420;margin:0 0 6px;">Order confirmed.</h1>
          <p style="color:#8A9590;margin:0 0 20px;font-size:14px;">Fresh AI Equity Report for ${company}${ticker}</p>
          <p style="font-size:14px;color:#1A2420;line-height:1.7;margin:0 0 20px;">
            We've received your order and will generate a fresh report using the latest available financial data.
            Your PDF will arrive at this address within <strong>1 business day</strong>.
          </p>
          <div style="background:#f4f7f5;border-radius:8px;padding:14px 16px;margin-bottom:24px;">
            <p style="font-size:13px;color:#8A9590;margin:0;">
              While you wait, browse our
              <a href="${SITE}/reports.html" style="color:#3D9E72;text-decoration:none;">free sample reports</a>
              to see the format and quality of our analysis.
            </p>
          </div>
          <p style="font-size:11px;color:#8A9590;margin:0;">
            Questions? <a href="mailto:contact26@valuatum.com" style="color:#3D9E72;text-decoration:none;">contact26@valuatum.com</a>
            &nbsp;&middot;&nbsp; <em>AI-generated research. Not investment advice.</em>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}

// ── Fresh report: notify admin to generate ──────────────────────────────────
async function sendAdminNotification(meta, customerEmail) {
  await resend().emails.send({
    from: FROM,
    to: ADMIN,
    subject: `New fresh report order: ${meta?.company || 'unknown'}`,
    html: `
      <p><strong>New fresh report order — action required.</strong></p>
      <table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">
        <tr><td style="color:#666;">Company</td><td><strong>${meta?.company || '—'}</strong></td></tr>
        <tr><td style="color:#666;">Ticker</td><td>${meta?.ticker || '—'}</td></tr>
        <tr><td style="color:#666;">Exchange</td><td>${meta?.exchange || '—'}</td></tr>
        <tr><td style="color:#666;">Customer email</td><td><a href="mailto:${customerEmail}">${customerEmail || '—'}</a></td></tr>
        <tr><td style="color:#666;">Purpose</td><td>${meta?.purpose || '—'}</td></tr>
      </table>
      <p style="margin-top:16px;">Generate the report and send the PDF to the customer email above.</p>
    `,
  });
}

module.exports = { sendReportEmail, sendFreshConfirmEmail, sendAdminNotification };
