// Extracts report-content JSON for one live catalog report, gated so that a bad extraction is
// never published: the schema is enforced by structured outputs, the style checker must come
// back clean after one repair pass, and any failure throws instead of writing the file. The
// caller (sync.mjs) leaves the company's page untouched and fails the run loudly.
//
// Model and configuration are pinned to what docs/report-content-generation.md measured:
// pdftotext input, temperature 0, structured outputs, style-repair pass. Figures cannot be
// verified automatically — the returned headline block goes into the job summary for the
// retrospective five-second glance.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { chat, parseJsonResponse } from './openrouter.mjs';
import { pdfToText } from './pdf-text.mjs';
import { buildMessages } from './prompt.mjs';
import { REPORT_SCHEMA, toReportContent } from './schema.mjs';
import { checkStyle, scenarioRecitationDetail, styleViolations } from './style.mjs';
import { CONTENT_DIR } from './owners.mjs';

export const EXTRACTION_MODEL = 'openai/gpt-5.6-luna';
const RECOMMENDATIONS = new Set(['BUY', 'HOLD', 'SELL']);

// The catalog is the source of truth for these identity fields; the report text is for
// everything else. Do NOT take exchange, country or sector — the catalog abbreviates them
// where the report prints the fuller value the landing pages use.
const CATALOG_AUTHORITATIVE = ['ticker', 'reportDate'];

function applyCatalogFields(doc, entry) {
  for (const field of CATALOG_AUTHORITATIVE) {
    if (entry[field]) doc[field] = String(entry[field]).slice(0, field === 'reportDate' ? 10 : undefined);
  }
  return doc;
}

/** Landing-page slug: reuse the one an earlier report for this company already claimed. */
function resolveSlug(id, companyName, ticker) {
  const stem = id.replace(/-\d{8}(?:-\d+)?$/, '');
  for (const file of fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.json'))) {
    const doc = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, file), 'utf8'));
    const docStem = String(doc.id || '').replace(/-\d{8}(?:-\d+)?$/, '');
    const sameCompany = (ticker && doc.ticker === ticker) || (docStem && docStem === stem);
    if (sameCompany && doc.slug) return doc.slug;
  }
  const base = String(companyName)
    .replace(/,?\s+(Inc\.?|Oyj|Ltd\.?|plc|Corporation|Corp\.?|AB|ASA|A\/S|N\.V\.|S\.A\.|Group|Holdings?|Abp)\.?$/i, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${base}-equity-report`;
}

// Where the delivery pipeline serves report PDFs from (matches PDF_BASE_URL in
// server/reconciler.js). The catalog API only advertises pdfUrl for free reports, but every
// report's file is served unauthenticated under its fileName — the same URL the buyer email
// carries — so extraction derives it when the API withholds it.
const PDF_BASE_URL = 'https://files.aiequityreports.com/reports/pdfs';

async function downloadPdf(entry) {
  const url = entry.pdfUrl
    || (entry.fileName ? `${PDF_BASE_URL}/${encodeURIComponent(entry.fileName)}` : null);
  if (!url) throw new Error(`catalog entry ${entry.id} has neither pdfUrl nor fileName`);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'report-extract-'));
  const file = path.join(dir, entry.fileName || `${entry.id}.pdf`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`downloading ${url} failed (HTTP ${res.status})`);
  await fsp.writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/**
 * The prompt cannot fully suppress a handful of mechanical prose defects — a unitless figure, a
 * restated scenario cell — and which ones slip through varies by report. Detect them and hand
 * the model back its own offending sentences: one extra call, only when something is actually
 * wrong, and only accepted if it comes back cleaner.
 */
async function repairStyle(doc, messages, rawText) {
  let best = doc;
  let bestDraft = rawText;

  // Up to two rounds: most drafts come back clean after one, but a report can trip a
  // different rule while fixing the first. A round that does not improve things ends the
  // loop — the gate then decides whether what is left is publishable.
  for (let round = 0; round < 2; round++) {
    const violations = styleViolations(best);
    if (!violations.length) return best;

    const grouped = new Map();
    for (const v of violations) {
      if (!grouped.has(v.tic)) grouped.set(v.tic, []);
      grouped.get(v.tic).push(v.excerpt);
    }
    const complaint = [...grouped.entries()]
      .map(([tic, ex]) => `${tic}:\n${ex.map((e) => `  - "${e}"`).join('\n')}`)
      .join('\n\n');

    const result = await chat({
      model: EXTRACTION_MODEL,
      schema: REPORT_SCHEMA,
      schemaName: 'report_content',
      messages: [
        ...messages,
        { role: 'assistant', content: bestDraft },
        {
          role: 'user',
          content: [
            'Your draft breaks the house style in the places quoted below. Return the complete JSON again with these fixed and nothing else changed — same figures, same structure, same sections.',
            '',
            complaint,
            '',
            'unitless-figure: give the figure its currency and scale ("USD 250,000m"). Leave counts of physical things alone — units, vehicles, rides and miles are not money.',
            'scenario-recitation: the scenario table is already printed on the page. Delete the restated figure and use the space to say what that scenario requires to happen.',
            'meta-attribution: delete the reference to the document and assert the fact directly.',
            'overlong-unvalued-pool: cut it to 40-60 words.',
          ].join('\n'),
        },
      ],
    });

    const repaired = toReportContent(parseJsonResponse(result.text), { id: doc.id, slug: doc.slug });
    // Never accept a repair that made things worse; stop when a round stops helping.
    if (checkStyle(repaired).total >= checkStyle(best).total) break;
    best = repaired;
    bestDraft = result.text;
  }
  return best;
}

/** The strict gate. Throws with a reason when the extraction must not be published. */
function gate(doc) {
  const problems = [];
  if (!RECOMMENDATIONS.has(String(doc.headline?.recommendation || '').toUpperCase())) {
    problems.push(`headline.recommendation is "${doc.headline?.recommendation}", expected BUY/HOLD/SELL`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(doc.reportDate || ''))) {
    problems.push(`reportDate "${doc.reportDate}" is not ISO`);
  }
  // One echoed scenario figure is tolerated: the prompt requires the bridge section to state
  // the enterprise value its reverse test supports, and that figure can legitimately coincide
  // with a scenario cell. Two or more echoes is genuine table recitation.
  const style = styleViolations(doc).filter((v) => v.tic !== 'scenario-recitation');
  const recited = scenarioRecitationDetail(doc);
  if (recited.echoed.length > 1) {
    problems.push(`coreAnalysis restates ${recited.echoed.length} scenario-table figures: ${recited.echoed.join(', ')}`);
  }
  if (style.length) {
    const detail = style.map((v) => `${v.tic} («${v.excerpt.slice(0, 160)}»)`).join('; ');
    problems.push(`style violations remain after repair: ${detail}`);
  }
  if (problems.length) throw new Error(problems.join('; '));
}

/**
 * Extract one report and write report-content/<id>.json. Returns a summary for the job log.
 * Throws (writing nothing) when the gate fails.
 */
export async function extractReport(entry) {
  const pdfPath = await downloadPdf(entry);
  try {
    const reportText = await pdfToText(pdfPath);
    const messages = buildMessages({ reportText, pdfFilename: path.basename(pdfPath) });

    const result = await chat({
      model: EXTRACTION_MODEL,
      messages,
      schema: REPORT_SCHEMA,
      schemaName: 'report_content',
    });
    if (result.finishReason === 'length') {
      throw new Error('the model hit its output limit before finishing the JSON');
    }

    const raw = parseJsonResponse(result.text);
    let doc = applyCatalogFields(
      toReportContent(raw, { id: entry.id, slug: resolveSlug(entry.id, raw.companyName, raw.ticker) }),
      entry,
    );
    doc = applyCatalogFields(await repairStyle(doc, messages, result.text), entry);

    gate(doc);

    const outPath = path.join(CONTENT_DIR, `${entry.id}.json`);
    await fsp.writeFile(outPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

    return {
      id: entry.id,
      slug: doc.slug,
      companyName: doc.companyName,
      headline: doc.headline,
      usd: result.usage?.usd ?? null,
      outPath,
    };
  } finally {
    await fsp.rm(path.dirname(pdfPath), { recursive: true, force: true }).catch(() => {});
  }
}
