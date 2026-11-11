#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIELDS = new Map([
  ['Revenue', 'revenue'],
  ['ProfitLossFromOperatingActivities', 'ebit'],
  ['ProfitLossAttributableToOwnersOfParent', 'netEarnings'],
  ['EquityAttributableToOwnersOfParent', 'bookValue'],
]);
const DAY = 86_400_000;

function qualified(value, namespaces) {
  const match = /^([^:]+):(.+)$/.exec(value || '');
  return match && namespaces[match[1]] ? { uri: namespaces[match[1]], local: match[2] } : null;
}

function dateAtMidnight(value) {
  if (!/^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:Z)?)?$/.test(value || '')) return null;
  const day = value.slice(0, 10);
  const timestamp = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === day ? timestamp : null;
}

// Compare decimal values exactly, including equivalent representations such as 1 and 1.0.
function decimalKey(value) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[Ee]([+-]?\d+))?$/.exec(String(value));
  if (!match || Math.abs(Number(match[4] || 0)) > 1000) throw new Error('Invalid numeric fact');
  let digits = `${match[2]}${match[3] || ''}`.replace(/^0+/, '');
  if (!digits) return '0';
  let exponent = Number(match[4] || 0) - (match[3] || '').length;
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); exponent++; }
  return `${match[1]}${digits}e${exponent}`;
}

/** Read source facts for manual review. This does not verify the filing or update a page. */
export function extractEsefCandidate(document, { lei, currency, periodStart, periodEnd }) {
  if (!/^[A-Z0-9]{20}$/.test(lei || '') || !/^[A-Z]{3}$/.test(currency || '') || !/^\d{4}-\d{2}-\d{2}$/.test(periodStart || '') || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd || '')) {
    throw new Error('An explicit LEI, currency, fiscal period start and end are required');
  }
  const end = dateAtMidnight(periodEnd);
  const start = dateAtMidnight(periodStart);
  if (end === null || start === null) throw new Error('Invalid fiscal period date');
  const instant = end + DAY;
  if ((instant - start) / DAY < 350 || (instant - start) / DAY > 380) throw new Error('Fiscal period must be an annual duration');
  const namespaces = document?.documentInfo?.namespaces;
  if (document?.documentInfo?.documentType !== 'https://xbrl.org/2021/xbrl-json' || !namespaces || !document?.facts || typeof document.facts !== 'object' || Array.isArray(document.facts)) {
    throw new Error('Invalid xBRL-JSON document');
  }
  const metrics = { revenue: null, ebit: null, netEarnings: null, bookValue: null };
  const chosen = new Map();
  for (const fact of Object.values(document.facts)) {
    const d = fact?.dimensions;
    if (!d || Object.keys(d).some((key) => !['concept', 'entity', 'period', 'unit'].includes(key))) continue;
    const concept = qualified(d.concept, namespaces);
    if (!concept || !/^https?:\/\/xbrl\.ifrs\.org\/taxonomy\/[^/]+\/ifrs-full$/.test(concept.uri)) continue;
    const field = FIELDS.get(concept.local);
    if (!field) continue;
    const parts = String(d.period || '').split('/');
    let selected = false;
    if (field === 'bookValue' && parts.length === 1) selected = dateAtMidnight(parts[0]) === instant;
    if (field !== 'bookValue' && parts.length === 2) {
      const factStart = dateAtMidnight(parts[0]);
      const finish = dateAtMidnight(parts[1]);
      const days = (finish - factStart) / DAY;
      if (factStart !== null && finish === instant && days >= 350 && days <= 380 && factStart !== start) {
        throw new Error(`${field}: conflicting annual period start`);
      }
      selected = factStart === start && finish === instant;
    }
    if (!selected) continue;
    const entity = qualified(d.entity, namespaces);
    const unit = qualified(d.unit, namespaces);
    if (!entity || !/^https?:\/\/standards\.iso\.org\/iso\/17442$/.test(entity.uri) || entity.local !== lei) {
      throw new Error(`${field}: unexpected filing entity`);
    }
    if (!unit || unit.uri !== 'http://www.xbrl.org/2003/iso4217' || unit.local !== currency) {
      throw new Error(`${field}: unexpected reporting currency`);
    }
    if (fact.value !== null && typeof fact.value !== 'string') throw new Error(`${field}: numeric facts must be strings`);
    const key = fact.value === null ? null : decimalKey(fact.value);
    if (chosen.has(field) && chosen.get(field) !== key) throw new Error(`${field}: conflicting facts`);
    chosen.set(field, key);
    metrics[field] = fact.value;
  }
  if (!chosen.size) throw new Error('No supported facts for the specified annual period');
  return {
    lei, currency, periodStart, periodEnd, valuesInCurrencyUnits: metrics,
    note: 'Unreviewed candidate: independently verify company identity, filing, period, accounting scope and values before publishing.',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 10 || new Set(args.filter((_, i) => i % 2 === 0)).size !== 5) throw new Error('Usage: node scripts/company-pages/esef-candidate.mjs --file <xbrl.json> --lei <LEI> --currency <ISO> --period-start <YYYY-MM-DD> --period-end <YYYY-MM-DD>');
    const options = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
    if (!['--file', '--lei', '--currency', '--period-start', '--period-end'].every((key) => options[key])) throw new Error('Missing or unrecognised argument');
    const document = JSON.parse(await fs.readFile(options['--file'], 'utf8'));
    console.log(JSON.stringify(extractEsefCandidate(document, { lei: options['--lei'], currency: options['--currency'], periodStart: options['--period-start'], periodEnd: options['--period-end'] }), null, 2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
