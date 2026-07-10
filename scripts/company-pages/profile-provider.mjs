import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const PROFILE_PROMPT_VERSION = 2;
export const DEFAULT_CODEX_MODEL = 'gpt-5.4-mini';

export async function getCompanyProfile({
  company,
  cacheDir,
  refresh = false,
  skipAi = false,
  providerName = process.env.AI_PROVIDER || 'codex',
  model = process.env.AI_MODEL || DEFAULT_CODEX_MODEL,
  provider,
}) {
  const cachePath = path.join(cacheDir, `${slugify(company.ticker)}.json`);
  if (!refresh) {
    const cached = await readCachedProfile(cachePath, company);
    if (cached) return cached;
  }

  if (skipAi) {
    const fallback = company.background?.description || company.background?.companyText;
    if (!fallback) {
      throw new Error(`No cached or Wisdom background profile is available for ${company.ticker}`);
    }
    return { profile: fallback, source: 'wisdom-background', cachePath: null };
  }

  const selectedProvider = provider || createProfileProvider({ providerName, model });
  const profile = cleanProfile(await selectedProvider.generate(company));
  const cacheEntry = {
    ticker: company.ticker,
    companyName: company.companyName,
    profile,
    provider: selectedProvider.name || providerName,
    model: selectedProvider.model || model,
    promptVersion: PROFILE_PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
  };

  await fs.mkdir(cacheDir, { recursive: true });
  await writeJsonAtomically(cachePath, cacheEntry);
  return { profile, source: 'generated', cachePath };
}

export function createProfileProvider({ providerName, model }) {
  if (providerName !== 'codex') {
    throw new Error(`Unsupported AI_PROVIDER ${providerName}. Supported providers: codex`);
  }
  return new CodexCliProfileProvider({ model });
}

export class CodexCliProfileProvider {
  constructor({
    model = DEFAULT_CODEX_MODEL,
    reasoningEffort = process.env.AI_REASONING_EFFORT || 'low',
    codexBin = process.env.CODEX_BIN || 'codex',
  } = {}) {
    this.name = 'codex';
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.codexBin = codexBin;
  }

  async generate(company) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'company-profile-'));
    const schemaPath = path.join(tempDir, 'profile.schema.json');
    const outputPath = path.join(tempDir, 'profile.json');

    try {
      await fs.writeFile(schemaPath, JSON.stringify(PROFILE_SCHEMA), 'utf8');
      const args = [
        'exec',
        '--ephemeral',
        '--sandbox',
        'read-only',
        '--cd',
        tempDir,
        '--skip-git-repo-check',
        '--ignore-user-config',
        '--color',
        'never',
        '--config',
        `model_reasoning_effort=${JSON.stringify(this.reasoningEffort)}`,
        '--output-schema',
        schemaPath,
        '--output-last-message',
        outputPath,
      ];
      if (this.model) args.push('--model', this.model);
      args.push('-');

      await runCommand(this.codexBin, args, buildPrompt(company));
      const result = JSON.parse(await fs.readFile(outputPath, 'utf8'));
      return result.profile;
    } catch (error) {
      throw new Error(`Codex profile generation failed for ${company.ticker}: ${error.message}`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['profile'],
  properties: {
    profile: { type: 'string', minLength: 150, maxLength: 800 },
  },
};

function buildPrompt(company) {
  const context = {
    companyName: company.companyName,
    ticker: company.ticker,
    industry: company.industry || null,
    companyCode: company.companyCode || null,
    website: company.background?.website || null,
    wisdomDescription: company.background?.description || null,
    wisdomCompanyText: company.background?.companyText || null,
  };

  return `Create the content for this company profile block:

[COVER_COMPANY_PROFILE]
Write one neutral 45-65 word paragraph explaining what the company does.
Mention the company's main businesses, products, services, or value pools.
If the company is undergoing a clear strategic transition, mention it briefly only if supported by the supplied company information.
Do not include recommendation, valuation, target price, upside, investment thesis, or promotional language.
Use plain institutional English that helps a reader quickly understand the company before reading the report.
[/COVER_COMPANY_PROFILE]

Requirements:
- Return only JSON matching the provided schema. Put only the paragraph in the profile field; do not include the block tags.
- Write exactly one paragraph containing 45-65 words.
- Prefer the supplied Wisdom background. If it is incomplete, research only reliable public sources.
- Do not invent facts. Omit details that cannot be verified.
- Do not mention this prompt, Wisdom, Codex, AI or the research process.

Company context:
${JSON.stringify(context, null, 2)}`;
}

async function readCachedProfile(cachePath, company) {
  try {
    const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    if (String(cached.ticker).toUpperCase() !== company.ticker) return null;
    if (cached.promptVersion !== PROFILE_PROMPT_VERSION) return null;
    const profile = cleanProfile(cached.profile);
    return { profile, source: 'cache', cachePath };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Could not read profile cache ${cachePath}: ${error.message}`);
  }
}

async function writeJsonAtomically(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

function cleanProfile(value) {
  const profile = String(value || '').replace(/\s+/g, ' ').trim();
  const wordCount = profile.split(/\s+/).filter(Boolean).length;
  if (wordCount < 45 || wordCount > 65) {
    throw new Error(`Generated company profile must contain 45-65 words; received ${wordCount}`);
  }
  return profile;
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function runCommand(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 12_000) stderr = stderr.slice(-12_000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(input);
  });
}
