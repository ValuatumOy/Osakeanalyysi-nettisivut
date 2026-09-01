#!/usr/bin/env node
// Renders the customer emails to HTML files so they can be screenshotted.
//
//   node render-emails.mjs <output dir>
//
// It loads server/email.js with the SES send call swapped for a capture, so the
// screenshots always show the real templates rather than a copy that can drift.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Module from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const out = process.argv[2] || here;

const emailPath = join(repo, 'server', 'email.js');
let src = readFileSync(emailPath, 'utf8');
// Replace the whole sendEmail function with one that just keeps the message.
src = src.replace(/async function sendEmail\([\s\S]*?\n}\n/, 'async function sendEmail(message){ global.__captured = message; }\n');

const require = createRequire(emailPath);
const mod = new Module(emailPath);
mod.filename = emailPath;
mod.paths = Module._nodeModulePaths(dirname(emailPath));
mod._compile(src, emailPath);
const email = mod.exports;

const PDF = 'https://files.aiequityreports.com/reports/pdfs/example.pdf';
const ORDER = 'https://www.aiequityreports.com/order/index.html?session_id=example';
const report = { name: 'Stora Enso Oyj', ticker: 'STERV', reportDate: '1 September 2026', pdfUrl: PDF, orderUrl: ORDER, version: 2 };

const jobs = [
  ['email-report',  () => email.sendReportEmail('buyer@example.com', report)],
  ['email-confirm', () => email.sendFreshConfirmEmail('buyer@example.com', { company: 'Stora Enso Oyj', ticker: 'STERV', orderUrl: ORDER })],
  ['email-revised', () => email.sendReportRevisedEmail('buyer@example.com', report)],
];

for (const [name, run] of jobs) {
  try {
    await run();
    writeFileSync(join(out, `${name}.html`), global.__captured.html);
    console.log(`  ${name} — ${global.__captured.subject}`);
  } catch (err) {
    console.log(`  ! ${name} failed: ${err.message}`);
  }
}
