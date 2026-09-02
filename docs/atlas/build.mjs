#!/usr/bin/env node
// Builds the Journey Atlas into admin/atlas.html.
//
//   node docs/atlas/build.mjs
//
// Inputs:  data.json (the journeys), app.js, template.html, shots/*.jpg
// Output:  admin/atlas.html — one self-contained file, screenshots inlined,
//          because the site deploys static files with no build step.
//
// The build also checks the journeys: every combination of the dropdowns must
// end at a step marked terminal, every step must be reachable, and every arrow
// must be taken by at least one combination. Problems are printed and the build
// exits non-zero.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const out = join(repo, 'admin', 'atlas.html');

const data = JSON.parse(readFileSync(join(here, 'data.json'), 'utf8'));
const app = readFileSync(join(here, 'app.js'), 'utf8');
const template = readFileSync(join(here, 'template.html'), 'utf8');

/* ---- screenshots ---- */
const shotDir = join(here, 'shots');
const onDisk = new Set(readdirSync(shotDir).filter(f => f.endsWith('.jpg')).map(f => f.slice(0, -4)));
const wanted = new Set();
for (const j of data.journeys) {
  for (const n of j.nodes) {
    for (const k of [n.img, ...(n.imgs || []), ...Object.values(n.imgBy || {})]) if (k) wanted.add(k);
  }
}
const missing = [...wanted].filter(k => !onDisk.has(k));
if (missing.length) {
  console.log(`Screenshots referenced but not in shots/: ${missing.join(', ')}`);
  console.log('Those steps will render as plain boxes. Run capture/capture.sh to make them.');
}
// Drop references we cannot satisfy so the page never shows a broken image.
for (const j of data.journeys) {
  for (const n of j.nodes) {
    if (n.img && !onDisk.has(n.img)) delete n.img;
    if (n.imgs) n.imgs = n.imgs.filter(k => onDisk.has(k));
    if (n.imgBy) for (const k of Object.keys(n.imgBy)) if (!onDisk.has(n.imgBy[k])) delete n.imgBy[k];
  }
}
const images = {};
for (const k of wanted) {
  if (!onDisk.has(k)) continue;
  images[k] = 'data:image/jpeg;base64,' + readFileSync(join(shotDir, `${k}.jpg`)).toString('base64');
}
const unused = [...onDisk].filter(k => !wanted.has(k));
if (unused.length) console.log(`Unused screenshots (not referenced by data.json): ${unused.join(', ')}`);

/* ---- check the journeys ---- */
const nodesById = {}, journeyOf = {};
for (const j of data.journeys) for (const n of j.nodes) { nodesById[n.id] = n; journeyOf[n.id] = j; }
const problems = [];
for (const j of data.journeys) {
  const matches = (e, s) => !e.when || Object.entries(e.when).every(([k, v]) => v.includes(s[k]));
  const walk = (s) => {
    const nodes = new Set([j.start]), edges = new Set();
    let cur = j.start, guard = 0;
    while (guard++ < 80) {
      const e = j.edges.find(x => x.from === cur && matches(x, s));
      if (!e) break;
      edges.add(e.id); nodes.add(e.to); cur = e.to;
      if (nodesById[cur]?.terminal) break;
    }
    return { nodes, edges, end: cur };
  };
  let combos = [{}];
  for (const c of j.controls) {
    const next = [];
    for (const p of combos) for (const o of c.options) next.push({ ...p, [c.id]: o.value });
    combos = next;
  }
  const seenN = new Set(), seenE = new Set();
  for (const s of combos) {
    const w = walk(s);
    if (!nodesById[w.end]?.terminal) problems.push(`${j.id}: ${JSON.stringify(s)} stops at "${w.end}", which is not an ending`);
    w.nodes.forEach(x => seenN.add(x));
    w.edges.forEach(x => seenE.add(x));
  }
  for (const n of j.nodes) if (!seenN.has(n.id)) problems.push(`${j.id}: step "${n.id}" cannot be reached by any combination`);
  for (const e of j.edges) {
    if (!nodesById[e.from] || !nodesById[e.to]) problems.push(`${j.id}: arrow "${e.id}" points at a step that does not exist`);
    else if (journeyOf[e.from] !== j || journeyOf[e.to] !== j) problems.push(`${j.id}: arrow "${e.id}" crosses into another journey`);
    else if (!seenE.has(e.id)) problems.push(`${j.id}: arrow "${e.id}" (${e.from} → ${e.to}) is never taken`);
  }
  // Cards are taller than one row, so two steps in the same column must sit far
  // enough apart vertically or they overlap on the canvas.
  const ROWH = 112, TALL = { screen: 176, email: 176 };
  for (const a of j.nodes) {
    for (const b of j.nodes) {
      if (a === b || a.col !== b.col || a.row >= b.row) continue;
      const need = Math.ceil((TALL[a.kind] || 46) / ROWH);
      if (b.row - a.row < need) problems.push(`${j.id}: "${a.id}" (row ${a.row}) and "${b.id}" (row ${b.row}) overlap in column ${a.col} — leave ${need} row(s) between them`);
    }
  }
  console.log(`${j.id}: ${j.nodes.length} steps, ${j.edges.length} arrows, ${combos.length} combinations`);
}
if (problems.length) {
  for (const p of problems) console.error(`  problem: ${p}`);
  console.error(`\n${problems.length} problem(s) — not written.`);
  process.exit(1);
}

/* ---- write ---- */
const filled = template
  .replace('__DATA__', JSON.stringify(data).replace(/<\//g, '<\\/'))
  .replace('__IMGS__', JSON.stringify(images))
  .replace('__APP__', app);

// template.html holds the head bits (title, fonts, styles) followed by the page
// body. Split at the stylesheet and wrap the two halves in a real document, so
// the served file is standards mode rather than quirks mode.
const cut = filled.indexOf('</style>') + '</style>'.length;
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${filled.slice(0, cut)}
</head>
<body>
${filled.slice(cut)}
</body>
</html>
`;
writeFileSync(out, html);
console.log(`\nwrote admin/atlas.html — ${Math.round(html.length / 1024)} KB, ${Object.keys(images).length} screenshots`);
