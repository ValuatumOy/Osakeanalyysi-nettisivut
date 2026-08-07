// Turns a Valuatum report PDF into the plain text the extraction prompt is built from.
// Uses poppler's pdftotext with -layout, which keeps the report's table columns aligned well
// enough that financial rows survive as readable rows.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function pdfToText(pdfPath) {
  try {
    const { stdout } = await run('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-'], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('pdftotext is not installed. Install poppler-utils.');
    }
    throw new Error(`pdftotext failed for ${pdfPath}: ${error.message}`);
  }
}

export async function pdfPageCount(pdfPath) {
  try {
    const { stdout } = await run('pdfinfo', [pdfPath]);
    return Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1]) || null;
  } catch {
    return null;
  }
}

/**
 * Report id used by the catalog and by report-content filenames: the PDF stem lowercased with
 * separators stripped, e.g. TeslaInc_05082026.pdf -> teslainc-05082026. A same-day collision
 * suffix survives into the id: TeslaInc_05082026_2.pdf -> teslainc-05082026-2.
 */
export function reportIdFromPdf(pdfPath) {
  const stem = path.basename(pdfPath, path.extname(pdfPath));
  const m = stem.match(/^(.*?)[_\-\s]*(\d{8})(?:[_\-](\d+))?$/);
  const nameStem = (m ? m[1] : stem)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!m) return nameStem;
  return `${nameStem}-${m[2]}${m[3] ? `-${m[3]}` : ''}`;
}
