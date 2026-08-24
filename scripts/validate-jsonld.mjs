#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlFiles = walk(root).filter(file => file.endsWith('.html'));
let blockCount = 0;

for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  // Blocks may carry marker attributes (data-page-freshness, data-pricing-offers) that the
  // build scripts use to find and rewrite their own node; without [^>]* those were skipped
  // silently and never validated at all.
  const blocks = html.matchAll(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of blocks) {
    try {
      JSON.parse(match[1]);
      blockCount += 1;
    } catch (error) {
      throw new Error(`${path.relative(root, file)} contains invalid JSON-LD: ${error.message}`);
    }
  }
}

console.log(`Validated ${blockCount} JSON-LD blocks in ${htmlFiles.length} HTML files.`);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name === '.git') return [];
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}
