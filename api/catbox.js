// Proxy for image uploads to Catbox.
// Catbox's API sends no Access-Control-Allow-Origin header on any response,
// so a browser fetch() straight to catbox.moe always fails with a generic
// "Failed to fetch" (the request goes out, but the browser refuses to let JS
// read the response). Routing it through this same-origin endpoint sidesteps
// CORS entirely, since it's a server-to-server request from here.

export const config = { runtime: 'edge' };

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let incoming;
  try {
    incoming = await req.formData();
  } catch {
    return Response.json({ error: 'Expected multipart/form-data with a "file" field' }, { status: 400 });
  }

  const file = incoming.get('file');
  if (!(file instanceof File)) {
    return Response.json({ error: 'Missing file' }, { status: 400 });
  }
  if (file.size > 20 * 1024 * 1024) {
    return Response.json({ error: 'Image too large (max 20MB)' }, { status: 400 });
  }

  const upstreamForm = new FormData();
  upstreamForm.append('reqtype', 'fileupload');
  upstreamForm.append('fileToUpload', file, file.name || 'upload');

  let upstream;
  try {
    upstream = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: upstreamForm });
  } catch (e) {
    return Response.json({ error: `Could not reach Catbox: ${e.message}` }, { status: 502 });
  }

  const text = (await upstream.text()).trim();
  if (!upstream.ok || !/^https?:\/\//.test(text)) {
    return Response.json({ error: text || `Catbox ${upstream.status}` }, { status: 502 });
  }

  return Response.json({ url: text });
};
