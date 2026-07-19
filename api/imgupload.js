// Proxy for greeting image uploads (freeimage.host).
// Catbox was the original target here, but it sends no CORS headers on any
// response (blocking a direct browser fetch()) and also rejects non-browser
// clients outright (blocking a server-side proxy too) — there's no way to
// integrate it from this kind of app. freeimage.host works both server-to-
// server and doesn't block hosting-provider IPs, at the cost of needing a
// free API key (instant signup, no verification) instead of Catbox's
// no-signup model.

export const config = { runtime: 'edge' };

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let incoming;
  try {
    incoming = await req.formData();
  } catch {
    return Response.json({ error: 'Expected multipart/form-data with "file" and "apiKey" fields' }, { status: 400 });
  }

  const file = incoming.get('file');
  const apiKey = incoming.get('apiKey');
  if (!(file instanceof File)) {
    return Response.json({ error: 'Missing file' }, { status: 400 });
  }
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    return Response.json({ error: 'Missing image host API key — add one in Settings' }, { status: 400 });
  }
  if (file.size > 20 * 1024 * 1024) {
    return Response.json({ error: 'Image too large (max 20MB)' }, { status: 400 });
  }

  const upstreamForm = new FormData();
  upstreamForm.append('source', file, file.name || 'upload');
  upstreamForm.append('format', 'json');

  let upstream;
  try {
    upstream = await fetch(`https://freeimage.host/api/1/upload?key=${encodeURIComponent(apiKey.trim())}`, {
      method: 'POST',
      body: upstreamForm,
    });
  } catch (e) {
    return Response.json({ error: `Could not reach the image host: ${e.message}` }, { status: 502 });
  }

  let j = null;
  try { j = await upstream.json(); } catch {}
  const url = j?.image?.url || j?.image?.display_url;
  if (!upstream.ok || !url) {
    return Response.json({ error: j?.status_txt || j?.error?.message || `Image host ${upstream.status}` }, { status: 502 });
  }

  return Response.json({ url });
};
