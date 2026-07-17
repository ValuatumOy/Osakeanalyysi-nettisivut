const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');

function envValue(name, fallback) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

const FROM = envValue('FROM_EMAIL', 'reports@valuatum.com');
const ADMIN = envValue('ADMIN_EMAIL', 'contact26@valuatum.com');
const SITE = envValue('SITE_URL', 'https://valuatum.com');
const AWS_REGION = envValue('AWS_REGION', 'eu-west-1');

let sesClient;
function ses() {
  // The SDK's default credential chain resolves AWS_ACCESS_KEY_ID /
  // AWS_SECRET_ACCESS_KEY or an EC2/Lambda instance role automatically.
  if (!sesClient) {
    sesClient = new SESv2Client({ region: AWS_REGION });
  }
  return sesClient;
}

function describeSesError(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;

  const fields = [
    error.name,
    error.Code || error.code,
    error.$metadata?.httpStatusCode,
    error.message,
  ].filter(Boolean);

  if (fields.length) return fields.join(' ');

  try {
    return JSON.stringify(error);
  } catch (_) {
    return String(error);
  }
}

async function sendEmail(message, label) {
  const toAddresses = Array.isArray(message.to) ? message.to : [message.to];

  let response;
  try {
    response = await ses().send(new SendEmailCommand({
      FromEmailAddress: message.from,
      Destination: { ToAddresses: toAddresses },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: { Html: { Data: message.html, Charset: 'UTF-8' } },
        },
      },
    }));
  } catch (error) {
    throw new Error(`SES ${label} failed: ${describeSesError(error)}`);
  }

  console.log(`SES ${label} queued`, {
    id: response?.MessageId || null,
    from: message.from,
    to: toAddresses,
  });

  return response;
}

// ── Existing report: deliver PDF link ────────────────────────────────────────
async function sendReportEmail(toEmail, report) {
  await sendEmail({
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
  }, 'report email');
}

// ── Fresh report: confirm to customer ───────────────────────────────────────
async function sendFreshConfirmEmail(toEmail, meta) {
  const company = meta?.company || 'your company';
  const ticker = meta?.ticker ? ` (${meta.ticker})` : '';

  await sendEmail({
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
            We've received your order and are generating a fresh report using the latest available financial data.
            Your PDF will arrive at this address within <strong>about 30 minutes</strong>.
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
  }, 'fresh confirmation email');
}

// ── Fresh report: FAILURE fallback — ask admin to generate manually ─────────
// Called by the reconciler when an order lands in FAILED. This is the old
// manual path, now reserved for failures only.
async function sendAdminNotification(meta, customerEmail) {
  await sendEmail({
    from: FROM,
    to: ADMIN,
    subject: `Fresh report failed — manual generation needed: ${meta?.company || 'unknown'}`,
    html: `
      <p><strong>Automated generation failed — please generate this report manually and send it to the customer.</strong></p>
      <table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">
        <tr><td style="color:#666;">Company</td><td><strong>${meta?.company || '—'}</strong></td></tr>
        <tr><td style="color:#666;">Ticker</td><td>${meta?.ticker || '—'}</td></tr>
        <tr><td style="color:#666;">Exchange</td><td>${meta?.exchange || '—'}</td></tr>
        <tr><td style="color:#666;">Customer email</td><td><a href="mailto:${customerEmail}">${customerEmail || '—'}</a></td></tr>
        ${meta?.error ? `<tr><td style="color:#666;">Error</td><td>${meta.error}</td></tr>` : ''}
        ${meta?.purpose ? `<tr><td style="color:#666;">Purpose</td><td>${meta.purpose}</td></tr>` : ''}
      </table>
    `,
  }, 'admin failure notification');
}

// ── Fresh report: SUCCESS FYI — report generated & delivered (dev/testing) ──
// Called by the reconciler on DELIVERED when ADMIN_NOTIFY_ON_SUCCESS is set.
async function sendAdminDeliveryNotice(meta) {
  await sendEmail({
    from: FROM,
    to: ADMIN,
    subject: `Fresh report delivered: ${meta?.company || meta?.ticker || 'unknown'}`,
    html: `
      <p><strong>Fresh report generated and emailed to the customer.</strong> No action needed.</p>
      <table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">
        <tr><td style="color:#666;">Company</td><td><strong>${meta?.company || '—'}</strong></td></tr>
        <tr><td style="color:#666;">Ticker</td><td>${meta?.ticker || '—'}</td></tr>
        <tr><td style="color:#666;">Exchange</td><td>${meta?.exchange || '—'}</td></tr>
        <tr><td style="color:#666;">Customer</td><td><a href="mailto:${meta?.customerEmail || ''}">${meta?.customerEmail || '—'}</a></td></tr>
        <tr><td style="color:#666;">PDF</td><td><a href="${meta?.pdfUrl || '#'}">${meta?.pdfUrl || '—'}</a></td></tr>
      </table>
    `,
  }, 'admin delivery notice');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendCoverageRequest(meta) {
  const company = escapeHtml(meta?.company);
  const ticker = escapeHtml(meta?.ticker || '—');
  const requester = escapeHtml(meta?.email);
  const notes = escapeHtml(meta?.notes || '—').replace(/\r?\n/g, '<br>');
  const source = escapeHtml(meta?.source || 'reports');
  const pageUrl = escapeHtml(meta?.pageUrl || '—');

  return sendEmail({
    from: FROM,
    to: ADMIN,
    subject: `Coverage request: ${String(meta?.company || 'unknown').slice(0, 120)}`,
    html: `
      <p><strong>A new company coverage request was submitted on AI Equity Reports.</strong></p>
      <table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">
        <tr><td style="color:#666;">Company</td><td><strong>${company}</strong></td></tr>
        <tr><td style="color:#666;">Ticker / exchange</td><td>${ticker}</td></tr>
        <tr><td style="color:#666;">Requester</td><td><a href="mailto:${requester}">${requester}</a></td></tr>
        <tr><td style="color:#666;">Notes</td><td>${notes}</td></tr>
        <tr><td style="color:#666;">Source</td><td>${source}</td></tr>
        <tr><td style="color:#666;">Page</td><td>${pageUrl}</td></tr>
      </table>
    `,
  }, 'coverage request');
}

module.exports = {
  sendReportEmail,
  sendFreshConfirmEmail,
  sendAdminNotification,
  sendAdminDeliveryNotice,
  sendCoverageRequest,
};
