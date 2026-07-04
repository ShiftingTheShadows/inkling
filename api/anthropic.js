// Streaming proxy to the Anthropic Messages API.
// The client sends its own API key (stored locally in the browser); nothing is
// persisted server-side. Exists so the "Claude (built-in)" provider works as a
// real API call with model choice, sampling, and SSE streaming.

export const config = { runtime: 'edge' };

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { apiKey, model, system, messages, maxTokens, temperature, stream } = payload;
  if (!apiKey) return Response.json({ error: 'Missing Anthropic API key' }, { status: 400 });
  if (!Array.isArray(messages) || !messages.length) {
    return Response.json({ error: 'Missing messages' }, { status: 400 });
  }

  const body = {
    model: model || 'claude-haiku-4-5',
    max_tokens: Math.min(Number(maxTokens) || 1024, 32000),
    system: system || undefined,
    messages,
    stream: !!stream,
  };
  // Sampling params are rejected with a 400 on Opus 4.7+ / Sonnet 5 — only
  // forward temperature to models that still accept it.
  if (temperature != null && /^claude-(haiku-4-5|sonnet-4-6)/.test(body.model)) {
    body.temperature = Math.max(0, Math.min(1, Number(temperature)));
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  // Pass the upstream body straight through (SSE when streaming, JSON otherwise)
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-store',
    },
  });
};
