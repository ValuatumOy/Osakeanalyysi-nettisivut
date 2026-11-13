export function directoryIdentity(title, heading) {
  const match = String(title || '').match(/^(.*?)\s*\(([^)]+)\)\s*(?:Stock|Valuation)/)
    || String(heading || '').match(/^(.*?)\s*\(([^)]+)\)\s*Stock Analysis/i);
  return match ? { name: match[1].trim(), ticker: match[2].trim() } : null;
}
