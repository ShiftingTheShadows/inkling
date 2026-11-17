// Proxy for greeting image uploads.
//
// F41: the destination is configurable. The default is freeimage.host, the host
// this feature shipped with, so an install that configures nothing sends the
// exact same request as before. The other options are imgbb (same key-in-query
// model) and a custom endpoint for anything self-hosted or S3/R2 behind a small
// upload worker, which receives the file as multipart `file` (plus `key` when a
// key is configured).
//
// Catbox was the original target here, but it sends no CORS headers on any
// response (blocking a direct browser fetch()) and also rejects non-browser
// clients outright (blocking a server-side proxy too) — there's no way to
// integrate it from this kind of app. freeimage.host works both server-to-
// server and doesn't block hosting-provider IPs, at the cost of needing a
// free API key (instant signup, no verification) instead of Catbox's
// no-signup model.
//
// The custom endpoint is user-supplied, so it goes through the same public-
// address gate as page reads (safeUrl + DNS resolution): a synced settings blob
// must not be able to turn this proxy into a request to 127.0.0.1 or a cloud
// metadata service.

import { safeUrl, assertPublicUrl } from './search.js';

export const config = { runtime: 'edge' };

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_HOSTS = ['freeimage', 'imgbb', 'custom'];
const DEFAULT_HOST = 'freeimage';

export function resolveImageHost(settings = {}) {
  const id = String(settings?.imageHost || DEFAULT_HOST);
  return IMAGE_HOSTS.includes(id) ? id : DEFAULT_HOST;
}

// freeimage and imgbb authenticate with the key; a custom endpoint may be open
// (a self-hosted upload route) or expect the key as a `key` field.
export function imageHostNeedsKey(host) {
  return host !== 'custom';
}

// Synchronous part of the custom-endpoint check: scheme and hostname rules.
// The DNS answer is verified separately, before the upload is attempted.
export function customEndpointProblem(endpoint) {
  const raw = String(endpoint || '').trim();
  if (!raw) return 'Missing custom image host URL';
  if (!safeUrl(raw)) return 'The custom image host URL must be a public http(s) address';
  return null;
}

export function imageUploadTarget(host, endpoint, apiKey) {
  const key = encodeURIComponent(String(apiKey || '').trim());
  if (host === 'imgbb') {
    return { url: `https://api.imgbb.com/1/upload?key=${key}`, field: 'image', extra: {} };
  }
  if (host === 'custom') {
    return { url: String(endpoint || '').trim(), field: 'file', extra: {} };
  }
  return { url: `https://freeimage.host/api/1/upload?key=${key}`, field: 'source', extra: { format: 'json' } };
}

// Each host answers with a different envelope. A custom endpoint may also
// answer with a bare URL as text, which is the simplest thing a self-hosted
// worker can return.
export function imageUrlFromResponse(host, json, text = '') {
  if (host === 'imgbb') return json?.data?.url || json?.data?.display_url || null;
  if (host === 'custom') {
    const bare = String(text || '').trim();
    return json?.url || json?.data?.url || json?.link || json?.href
      || (/^https?:\/\/\S+$/.test(bare) ? bare : null);
  }
  return json?.image?.url || json?.image?.display_url || null;
}

export async function uploadToHost({ host, endpoint, apiKey, file, fetchImpl = fetch }) {
  const id = IMAGE_HOSTS.includes(host) ? host : DEFAULT_HOST;
  const target = imageUploadTarget(id, endpoint, apiKey);
  const form = new FormData();
  form.append(target.field, file, file.name || 'upload');
  for (const [k, v] of Object.entries(target.extra)) form.append(k, v);
  if (id === 'custom' && String(apiKey || '').trim()) form.append('key', String(apiKey).trim());

  const upstream = await fetchImpl(target.url, { method: 'POST', body: form });
  const text = await upstream.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const url = imageUrlFromResponse(id, json, text);
  if (!upstream.ok || !url) {
    const message = json?.status_txt || json?.error?.message || json?.error
      || (typeof json?.message === 'string' ? json.message : null)
      || `Image host ${upstream.status}`;
    throw new Error(message);
  }
  return url;
}

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
  if (!(file instanceof File)) {
    return Response.json({ error: 'Missing file' }, { status: 400 });
  }
  const host = resolveImageHost({ imageHost: incoming.get('host') });
  const apiKey = String(incoming.get('apiKey') || '').trim();
  const endpoint = String(incoming.get('endpoint') || '').trim();
  if (imageHostNeedsKey(host) && !apiKey) {
    return Response.json({ error: 'Missing image host API key — add one in Settings' }, { status: 400 });
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return Response.json({ error: 'Image too large (max 20MB)' }, { status: 400 });
  }
  if (host === 'custom') {
    const problem = customEndpointProblem(endpoint);
    if (problem) return Response.json({ error: problem }, { status: 400 });
    try {
      await assertPublicUrl(endpoint);
    } catch (e) {
      return Response.json({ error: e.message }, { status: 400 });
    }
  }

  try {
    const url = await uploadToHost({ host, endpoint, apiKey, file });
    return Response.json({ url });
  } catch (e) {
    return Response.json({ error: e.message || 'Upload failed' }, { status: 502 });
  }
};
