/**
 * URL safety helpers for LE RADAR bots (CI fetch scripts).
 * Blocks private/link-local hosts to reduce SSRF risk on GitHub Actions runners.
 */

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,
  /^0\.\d+\.\d+\.\d+$/,
  /^\[::1\]$/,
  /^\[::ffff:/i,
  /^metadata\.google\.internal$/i,
];

function isPrivateOrLocalHost(hostname = '') {
  const host = String(hostname).toLowerCase();
  if (!host) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  return PRIVATE_HOST_PATTERNS.some((re) => re.test(host));
}

function isAllowedFetchUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') return false;
  try {
    const u = new URL(urlString.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (isPrivateOrLocalHost(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = { isAllowedFetchUrl, isPrivateOrLocalHost };