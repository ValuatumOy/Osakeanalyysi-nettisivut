// The page-owner rule, shared by sync.mjs (which builds pages from it) and check.mjs (which
// verifies the built pages against it), so there is exactly one implementation.
//
// A company can have several reports live in the catalog at once, but has one landing page,
// because every report for a company resolves to the same slug. The rule that picks which
// report the page belongs to:
//
//   A company's page belongs to its free ready report if it has one; otherwise to its newest
//   ready report. A company with no live report keeps its page as a coverage page.
//
// See docs/report-page-automation.md for why the free clause exists.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CONTENT_DIR = path.join(ROOT, 'report-content');
export const PAGES_DIR = path.join(ROOT, 'reports');

// Reports whose PDF content does not match their catalog identity — never published and never
// re-extracted. Kept in sync with the same constant in scripts/report-index.mjs.
export const EXCLUDE = new Set(['nuholdings-02062026']);

/** Every committed report-content document, keyed by id. Throws on invalid JSON. */
export function loadContentDocs() {
  const byId = new Map();
  for (const file of fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, file), 'utf8'));
    } catch (e) {
      throw new Error(`report-content/${file} is not valid JSON: ${e.message}`);
    }
    const id = doc.id || file.replace(/\.json$/, '');
    if (!doc.slug) throw new Error(`report-content/${file} has no slug.`);
    byId.set(id, { ...doc, id });
  }
  return byId;
}

/** Live ready catalog entries keyed by id, dropping anything not publicly available. */
export function catalogById(catalog) {
  const byId = new Map();
  for (const entry of catalog) {
    if (!entry?.id) continue;
    if (entry.availability && entry.availability !== 'available') continue;
    if (entry.publicationStatus && entry.publicationStatus !== 'ready') continue;
    byId.set(entry.id, entry);
  }
  return byId;
}

// The free clause first, then newest; id as the deterministic tie-break for two reports with
// the same date and freeness (the higher collision suffix sorts later, hence wins).
function ownerOrder(a, b) {
  if (Boolean(a.cat.isFree) !== Boolean(b.cat.isFree)) return a.cat.isFree ? -1 : 1;
  const dateA = String(a.cat.reportDateIso || a.cat.reportDate || a.doc.reportDate || '');
  const dateB = String(b.cat.reportDateIso || b.cat.reportDate || b.doc.reportDate || '');
  if (dateA !== dateB) return dateB.localeCompare(dateA);
  return b.doc.id.localeCompare(a.doc.id);
}

const byDocDateDesc = (a, b) =>
  String(b.reportDate || '').localeCompare(String(a.reportDate || '')) || b.id.localeCompare(a.id);

/**
 * Resolve the whole site state: one entry per company slug, each with the report that owns the
 * page (or null → coverage page), plus the catalog entries that still need content extracted.
 *
 * @param {Array} catalog  entries from fetchLiveCatalog()
 * @param {Map} docs       from loadContentDocs()
 * @returns {{ companies: Map<slug, company>, toExtract: Array<catalogEntry> }}
 *   company = { slug, docs, owner: {doc, cat}|null, mode: 'free'|'paid'|'coverage', newestDoc }
 */
export function resolveState(catalog, docs) {
  const live = catalogById(catalog);

  // An EXCLUDEd document neither owns a page nor supplies coverage identity — its content does
  // not match its catalog identity, so nothing built from it can be trusted.
  const bySlug = new Map();
  for (const doc of docs.values()) {
    if (EXCLUDE.has(doc.id)) continue;
    if (!bySlug.has(doc.slug)) bySlug.set(doc.slug, []);
    bySlug.get(doc.slug).push(doc);
  }

  const companies = new Map();
  for (const [slug, group] of bySlug) {
    group.sort(byDocDateDesc);
    const candidates = group
      .filter((doc) => live.has(doc.id))
      .map((doc) => ({ doc, cat: live.get(doc.id) }))
      .sort(ownerOrder);
    const owner = candidates[0] || null;
    companies.set(slug, {
      slug,
      docs: group,
      newestDoc: group[0],
      owner,
      mode: owner ? (owner.cat.isFree ? 'free' : 'paid') : 'coverage',
    });
  }

  // Live reports with no content file yet: these need extraction before a page can exist.
  const known = new Set(docs.keys());
  const toExtract = [...live.values()].filter((entry) => !known.has(entry.id) && !EXCLUDE.has(entry.id));

  return { companies, toExtract };
}
