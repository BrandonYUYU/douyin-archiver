/**
 * format.js — small display helpers. Pure, so they can be tested.
 */

/**
 * Chrome's action badge fits about four characters, so large totals have to be
 * abbreviated rather than truncated (a silent "1234" → "123" would be worse than
 * useless — it would misreport the archive size).
 */
export function formatBadgeCount(total) {
  const n = Number(total);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return String(Math.floor(n));
  if (n < 100_000) {
    const thousands = n / 1000;
    // 1.2k up to 9.9k, then 10k..99k without the decimal.
    return thousands < 10
      ? `${Math.floor(thousands * 10) / 10}k`.replace('.0k', 'k')
      : `${Math.floor(thousands)}k`;
  }
  return '99k+';
}

/** Human-readable duration for the popup's "last run" line. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  if (total < 60) return `${Math.round(total)}s`;
  const minutes = Math.floor(total / 60);
  const seconds = Math.round(total % 60);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
