/**
 * LE RADAR Stream Proxy (Cloudflare Worker)
 *
 * Hardened relay for radio streams — blocks private IPs and limits CORS.
 * Deploy only if PROXY_BASE is set in app.js.
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

function isPrivateHost(hostname = '') {
  const host = String(hostname).toLowerCase();
  if (!host || host.endsWith('.local') || host.endsWith('.internal')) return true;
  return PRIVATE_HOST_PATTERNS.some((re) => re.test(host));
}

function isAllowedTarget(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (isPrivateHost(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function corsOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return 'https://azdak919.github.io';
  try {
    const u = new URL(origin);
    if (u.hostname === 'azdak919.github.io' || u.hostname.endsWith('.github.io')) {
      return origin;
    }
  } catch { /* ignore */ }
  return 'https://azdak919.github.io';
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': corsOrigin(request),
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');

    if (!target) {
      return new Response(JSON.stringify({
        error: 'Missing ?url= parameter',
        example: `${url.origin}/?url=https://example.com/stream`,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!isAllowedTarget(target)) {
      return new Response('Invalid or blocked URL', { status: 400 });
    }

    try {
      const upstream = await fetch(target, {
        headers: {
          'User-Agent': 'LE-RADAR-Proxy/1.1',
          'Icy-MetaData': '1',
        },
      });

      const headers = new Headers(upstream.headers);
      const allowOrigin = corsOrigin(request);

      headers.set('Access-Control-Allow-Origin', allowOrigin);
      headers.set('Vary', 'Origin');
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      headers.set('Access-Control-Expose-Headers', 'icy-metaint, icy-name, icy-genre');

      if (!headers.get('content-type')?.includes('audio')) {
        headers.set('content-type', 'audio/mpeg');
      }

      headers.set('Cache-Control', 'no-cache, no-store');

      return new Response(upstream.body, {
        status: upstream.status,
        headers,
      });
    } catch (err) {
      return new Response(`Proxy error: ${err.message}`, { status: 502 });
    }
  },
};