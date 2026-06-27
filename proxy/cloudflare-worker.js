/**
 * LE RADAR Stream Proxy (Cloudflare Worker)
 *
 * Purpose:
 * - Makes any radio stream (HTTP or HTTPS) playable directly inside the LE RADAR PWA.
 * - Adds proper CORS headers so the <audio> element works from GitHub Pages.
 * - Forwards ICY metadata if present.
 *
 * How to deploy (free):
 * 1. Go to https://dash.cloudflare.com → Workers & Pages → Create Worker
 * 2. Paste this code
 * 3. Deploy
 * 4. Your worker URL will be something like https://req-stream-proxy.yourname.workers.dev
 *
 * Usage in LE RADAR:
 *   Set a global PROXY in app.js:
 *   const PROXY_BASE = 'https://req-stream-proxy.yourname.workers.dev';
 *
 * Then the player will use:
 *   `${PROXY_BASE}/?url=${encodeURIComponent(originalStream)}`
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');

    if (!target) {
      return new Response(JSON.stringify({
        error: 'Missing ?url= parameter',
        example: `${url.origin}/?url=https://example.com/stream`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Basic validation
    if (!target.startsWith('http')) {
      return new Response('Invalid URL', { status: 400 });
    }

    try {
      const upstream = await fetch(target, {
        headers: {
          'User-Agent': 'LE-RADAR-Proxy/1.0',
          'Icy-MetaData': '1',
        },
      });

      // Create new headers with CORS + streaming friendly values
      const headers = new Headers(upstream.headers);

      // Critical for browser audio + CORS
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      headers.set('Access-Control-Expose-Headers', 'icy-metaint, icy-name, icy-genre');

      // Force audio content type if missing
      if (!headers.get('content-type')?.includes('audio')) {
        headers.set('content-type', 'audio/mpeg');
      }

      // Important for live streaming
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