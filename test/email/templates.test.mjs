import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

// server/email.js builds the message and hands it to SESv2. The SDK module is
// replaced in require.cache with a recorder (or a thrower), so every template
// can be rendered and inspected without credentials.
const require = createRequire(import.meta.url);
const EMAIL_ID = require.resolve('../../server/email.js');
const SES_ID = require.resolve('@aws-sdk/client-sesv2');

function loadEmail({ sendImpl } = {}) {
  const sent = [];
  class SESv2Client {
    async send(command) {
      if (sendImpl) return sendImpl(command.input);
      sent.push(command.input);
      return { MessageId: `msg-${sent.length}` };
    }
  }
  class SendEmailCommand { constructor(input) { this.input = input; } }
  delete require.cache[EMAIL_ID];
  require.cache[SES_ID] = { id: SES_ID, filename: SES_ID, loaded: true, exports: { SESv2Client, SendEmailCommand } };
  const mod = require(EMAIL_ID);
  return { email: mod, sent };
}

function cleanup(t) {
  const saved = { ADMIN_EMAIL: process.env.ADMIN_EMAIL, STAGE: process.env.STAGE };
  process.env.ADMIN_EMAIL = 'ops@example.test';
  process.env.STAGE = 'unit';
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    delete require.cache[EMAIL_ID];
    delete require.cache[SES_ID];
  });
}

const htmlOf = (msg) => msg.Content.Simple.Body.Html.Data;
const subjectOf = (msg) => msg.Content.Simple.Subject.Data;

test('the analysis purchase receipt uses the branded layout and plain wording', async (t) => {
  cleanup(t);
  const { email, sent } = loadEmail();
  await email.sendAnalysisPurchaseEmail('buyer@example.com', {
    company: 'TSLA', analystName: 'Jane Doe', link: 'https://www.example.test/members.html?bought=g1&session_id=cs_1',
  });
  assert.equal(sent.length, 1);
  const html = htmlOf(sent[0]);
  assert.equal(sent[0].Destination.ToAddresses[0], 'buyer@example.com');
  assert.equal(subjectOf(sent[0]), 'Your analyst report on TSLA');
  assert.match(html, /background:#1B3028/, 'dark Valuatum header');
  assert.match(html, /Your report is ready\./);
  assert.match(html, /Analyst report by Jane Doe/);
  assert.match(html, /href="https:\/\/www\.example\.test\/members\.html\?bought=g1&session_id=cs_1"/);
  assert.doesNotMatch(html, /analyst analysis/i);
  assert.doesNotMatch(html, /stays valid/i);
});

test('a forked purchase says the copy is being prepared rather than that the PDF is ready', async (t) => {
  cleanup(t);
  const { email, sent } = loadEmail();
  await email.sendAnalysisPurchaseEmail('buyer@example.com', { company: 'NOKIA.HE', link: 'https://x.test/?forked=g1', fork: true });
  assert.match(htmlOf(sent[0]), /Your purchase is complete\./);
  assert.match(htmlOf(sent[0]), /being prepared for revision/);
  assert.match(subjectOf(sent[0]), /ready to build on/);
});

test('the generation-failed email tells the customer what happens next and escapes the company name', async (t) => {
  cleanup(t);
  const { email, sent } = loadEmail();
  await email.sendGenerationFailedEmail('buyer@example.com', {
    company: 'A&B <Corp>', ticker: 'AB', orderUrl: 'https://x.test/order/index.html?session_id=cs_1',
  });
  const html = htmlOf(sent[0]);
  assert.match(subjectOf(sent[0]), /couldn't finish your report — AB/);
  assert.match(html, /A&amp;B &lt;Corp&gt;/);
  assert.match(html, /Our team has been notified/);
  assert.match(html, /refund/);
  assert.match(html, /View your order/);
  assert.match(html, /background:#1B3028/);
});

test('the revision-failed email says the report is unchanged and the allowance untouched', async (t) => {
  cleanup(t);
  const { email, sent } = loadEmail();
  await email.sendRevisionFailedEmail('buyer@example.com', { company: 'Tesla', ticker: 'TSLA', orderUrl: 'https://x.test/order' });
  const html = htmlOf(sent[0]);
  assert.match(html, /current report is unchanged/);
  assert.match(html, /not been counted against/);
  assert.match(html, /Open your order/);
});

test('the existing delivery emails still carry the licence line and the same layout', async (t) => {
  cleanup(t);
  const { email, sent } = loadEmail();
  await email.sendReportEmail('b@example.com', { name: 'Tesla', ticker: 'TSLA', reportDate: '2026-09-01', pdfUrl: 'https://x/p.pdf', orderUrl: 'https://x/o' });
  await email.sendReportRevisedEmail('b@example.com', { name: 'Tesla', ticker: 'TSLA', reportDate: '2026-09-02', pdfUrl: 'https://x/p2.pdf', orderUrl: 'https://x/o' });
  await email.sendFreshConfirmEmail('b@example.com', { company: 'Tesla', ticker: 'TSLA', orderUrl: 'https://x/o' });
  assert.equal(sent.length, 3);
  for (const msg of sent) assert.match(htmlOf(msg), /AI-generated research\. Not investment advice\./);
  assert.match(htmlOf(sent[0]), /licensed for your personal research/);
  assert.match(htmlOf(sent[0]), /Download PDF report/);
  assert.match(htmlOf(sent[0]), /Request revision/);
  assert.match(htmlOf(sent[1]), /Download the updated PDF/);
  assert.doesNotMatch(htmlOf(sent[2]), /licensed for your personal research/);
  assert.match(htmlOf(sent[2]), /Track your order/);
});

test('reportError emails the admin with the place, message, details, stage and stack', async (t) => {
  cleanup(t);
  const { email, sent } = loadEmail();
  const err = new Error('DynamoDB timed out');
  const ok = await email.reportError('api GET /api/orders/{id}', err, { orderId: 'cs_1', empty: '', skipped: undefined, n: 3 });
  assert.equal(ok, true);
  assert.equal(sent[0].Destination.ToAddresses[0], 'ops@example.test');
  assert.equal(subjectOf(sent[0]), '[AiEquityReports unit] api GET /api/orders/{id}: DynamoDB timed out');
  const html = htmlOf(sent[0]);
  assert.match(html, /Where: api GET \/api\/orders\/\{id\}/);
  assert.match(html, /Error: DynamoDB timed out/);
  assert.match(html, /orderId: cs_1/);
  assert.match(html, /n: 3/);
  assert.doesNotMatch(html, /empty:|skipped:/);
  assert.match(html, /Stack:/);
});

test('reportError never throws, even when SES itself is down', async (t) => {
  cleanup(t);
  const { email } = loadEmail({ sendImpl: async () => { throw new Error('MessageRejected'); } });
  const ok = await email.reportError('worker tick', new Error('boom'));
  assert.equal(ok, false);
});
