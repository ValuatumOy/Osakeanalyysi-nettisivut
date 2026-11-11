import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = file => fs.readFile(path.join(root, file), 'utf8');

test('Eagle Filters retains its identity and explains its year-end market capitalisation', async () => {
  const html = await read('reports/loudspring-equity-report.html');
  for (const value of ['EUR 3.1m', 'EUR -3.94m', 'EUR -4.76m', 'EUR -0.34m', '0.079 EUR', 'EUR 18.59m']) assert.ok(html.includes(value));
  assert.match(html, /Previously known as Loudspring/);
  assert.match(html, /issued shares that had not yet been registered/);
  assert.match(html, /data-ticker="EAGLE\.HE"/);
});

test('ININ does not present disputed owner equity as an audited figure', async () => {
  const html = await read('reports/elop-as-equity-report.html');
  for (const value of ['NOK 942.58m', 'NOK -10.95m', 'NOK -88.68m']) assert.ok(html.includes(value));
  assert.match(html, /Book value<\/span><span class="cp-v">N\/A/);
  assert.match(html, /conflicting owner-equity figures/);
  assert.match(html, /Previously known as Elop AS/);
  assert.match(html, /data-ticker="ININ\.OL"/);
});

test('bankrupt companies do not describe their old legal entities as active', async () => {
  for (const file of ['reports/dof-equity-report.html', 'reports/coala-life-group-equity-report.html']) {
    const html = await read(file);
    assert.match(html, /was declared bankrupt/);
    assert.doesNotMatch(html, /DOF ASA is an offshore|Coala-Life Group AB is a medical technology/);
  }
});

test('Saga Pure does not present investment income as revenue', async () => {
  const html = await read('reports/saga-pure-equity-report.html');
  assert.match(html, /Revenue<\/span><span class="cp-v">N\/A<\/span>/);
  assert.match(html, /NOK 6\.76m/);
  assert.match(html, /NOK 6\.48m/);
  assert.match(html, /fair-value changes and other items/);
  assert.doesNotMatch(html, /revenue of NOK -19\.4m|revenue of NOK 28\.16m/);
});

test('NYAB uses the current listing and distinguishes market capitalisation from share price', async () => {
  const html = await read('reports/skartanyab-equity-report.html');
  for (const value of ['EUR 547.00m', 'EUR 30.65m', 'EUR 21.32m', 'EUR 209.53m', 'SEK 4,292m']) assert.ok(html.includes(value));
  assert.match(html, /"identifier": "SE0022242434"/);
  assert.match(html, /Share price<\/span><span class="cp-v">N\/A<\/span>/);
  assert.match(html, /previously named SkartaNYAB/);
  assert.doesNotMatch(html, /financial overview for 2025:[^"\r\n]*year-end share price/);
  assert.doesNotMatch(html, /data-generate-report|5\.87 SEK/);
});

test('Formpipe separates continuing operations from the result of the sold business', async () => {
  const html = await read('reports/formpipe-software-equity-report.html');
  for (const value of ['SEK 242.4m', 'SEK -48.67m', 'SEK 495.07m', 'SEK 870.12m']) assert.ok(html.includes(value));
  assert.match(html, /net earnings include discontinued operations/);
  assert.match(html, /last trading day on Nasdaq Stockholm on 24 August 2026/);
  assert.doesNotMatch(html, /data-generate-report|SEK 243\.30m/);
});

test('Omda uses the audited sales revenue and its current listing identity', async () => {
  const html = await read('reports/csam-health-group-as-equity-report.html');
  for (const value of ['NOK 494.19m', 'NOK 50.18m', 'NOK 6.61m', 'NOK 16.67m']) assert.ok(html.includes(value));
  assert.match(html, /"identifier": "NO0010894512"/);
  assert.match(html, /Previously known as CSAM Health Group/);
  assert.match(html, /consolidated Norwegian GAAP/);
  assert.match(html, /Share price<\/span><span class="cp-v">N\/A<\/span>/);
  assert.doesNotMatch(html, /revenue of NOK 495\.69m|36\.93 NOK/);
});

// Active pages show Wisdom's figures (scripts/sync-company-pages.mjs); only the status note is pinned.
test('Summa Defence discloses restructuring', async () => {
  const html = await read('reports/summa-defence-equity-report.html');
  assert.match(html, /corporate restructuring proceedings for Summa Defence Plc and Summa Holding Oy/);
});

test('Interoil separates continuing operations from the total loss', async () => {
  const html = await read('reports/interoil-exploration-and-production-equity-report.html');
  for (const value of ['USD 8.68m', 'USD -5.5m', 'USD -29.89m', 'USD -62.12m']) assert.ok(html.includes(value));
  assert.match(html, /Revenue and operating profit relate to continuing operations; net earnings include discontinued operations/);
  assert.match(html, /material uncertainty related to going concern/);
});

test('historical split-adjusted shares do not show unverified market values', async () => {
  for (const file of ['reports/carbiotix-equity-report.html', 'reports/chordate-medical-holding-equity-report.html']) {
    const html = await read(file);
    assert.match(html, /Share price<\/span><span class="cp-v">N\/A/);
    assert.match(html, /Market capitalisation<\/span><span class="cp-v">N\/A/);
    assert.match(html, /share identifier changed during 2024/);
  }
});

test('Olav Thon keeps NOK financials without an unverified London currency', async () => {
  const html = await read('reports/olav-thon-eiendomsselskap-equity-report.html');
  for (const value of ['NOK 3,741.0m', 'NOK 1,881.0m', 'NOK 32,851.0m']) assert.ok(html.includes(value));
  assert.match(html, /Share price<\/span><span class="cp-v">N\/A/);
  assert.doesNotMatch(html, /company-meta-chip">GBP|227\.00 GBP|data-generate-report/);
});

test('Fagerhult uses its current name in the page, directory and search data', async () => {
  const html = await read('reports/ab-fagerhult-publ-equity-report.html');
  assert.match(html, /<h1 class="company-name">Fagerhult Group AB \(FAG\.ST\)/);
  assert.match(html, /Previously known as AB Fagerhult \(publ\.\)/);
  assert.match(await read('companies/f.html'), /Fagerhult Group AB \(FAG\.ST\)/);
  assert.match(await read('js/companyPagesData.js'), /"name": "Fagerhult Group AB"/);
});

test('AFRY uses the correct company name in the page and search index', async () => {
  const html = await read('reports/afry-equity-report.html');
  assert.match(html, /<h1 class="company-name">AFRY \(AFRY\.ST\)/);
  assert.match(html, /data-company="AFRY AB" data-ticker="AFRY\.ST"/);
  assert.match(await read('js/companyPagesData.js'), /"name": "AFRY"/);
});

test('Alfa Laval identifies the listed parent rather than its subsidiary', async () => {
  const html = await read('reports/alfa-laval-corporate-equity-report.html');
  assert.match(html, /<h1 class="company-name">Alfa Laval \(ALFA\.ST\)/);
  assert.match(html, /data-company="Alfa Laval AB" data-ticker="ALFA\.ST"/);
  assert.match(await read('companies/a.html'), /Alfa Laval \(ALFA\.ST\)/);
  assert.doesNotMatch(html, /Alfa Laval Corporate/);
});
