const INITIALS = { 'Ø': 'O', 'Æ': 'A', 'Œ': 'O', 'Ð': 'D', 'Þ': 'T', 'Ł': 'L' };

export function directoryBucket(name) {
  const first = [...String(name ?? '').trim().normalize('NFD').replace(/\p{M}/gu, '')][0] || '';
  const initial = INITIALS[first.toUpperCase()] || first.toUpperCase();
  return /^[A-Z]$/.test(initial) ? initial : '0-9';
}

export function directoryPath(name) {
  return `/companies/${directoryBucket(name).toLowerCase()}.html`;
}
