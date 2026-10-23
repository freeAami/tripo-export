import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const API_BASE = 'https://api.tripo3d.ai';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function parseProjectId(input) {
  const m = String(input).match(UUID_RE);
  if (!m) throw new Error(`Could not find a project id in "${input}"`);
  return m[0].toLowerCase();
}

function headers(token) {
  const h = {
    'user-agent': UA,
    accept: 'application/json',
    origin: 'https://studio.tripo3d.ai',
    referer: 'https://studio.tripo3d.ai/',
    'x-tripo-device-id': randomUUID(),
  };
  if (token) h.authorization = `Bearer ${token.replace(/^Bearer\s+/i, '')}`;
  return h;
}

// Same endpoint the Studio workspace calls when it opens /workspace/generate/<id>.
export async function fetchProject(id, { token } = {}) {
  const url = `${API_BASE}/v2/studio/project/detail/v3/${id}?locale=en`;
  const res = await fetch(url, { headers: headers(token) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Unexpected response (${res.status}) from ${url}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || body.code !== 0) {
    const hint = token ? '' : ' If the model is private, pass --token (see README).';
    throw new Error(`Tripo API error ${res.status} code=${body.code}: ${body.message}.${hint}`);
  }
  return body.data;
}

export function modelUrlOf(project) {
  return project.model_url || project.operator?.model_url || null;
}

export async function download(url, dest, { onProgress } = {}) {
  const res = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://studio.tripo3d.ai/' } });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url.split('?')[0]}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  const body = Readable.fromWeb(res.body);
  if (onProgress) body.on('data', (c) => onProgress((done += c.length), total));
  await pipeline(body, createWriteStream(dest));
  return dest;
}
