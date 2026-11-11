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

test('Neola identifies the scope of its 2025 financial statements', async () => {
  const html = await read('reports/neola-medical-equity-report.html');
  for (const value of ['SEK 0.0m', 'SEK -11.09m', 'SEK -11.02m', 'SEK 75.8m', '1.06 SEK', 'SEK 82.6m']) assert.ok(html.includes(value));
  assert.match(html, /Swedish K3 financial statements; no consolidated statements were prepared for 2025/);
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
