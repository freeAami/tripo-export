import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { parseProjectId, projectUrl, parseProjectResponse, modelUrlOf } from './core.js';

export { parseProjectId, modelUrlOf };
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

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

export async function fetchProject(id, { token } = {}) {
  const res = await fetch(projectUrl(id), { headers: headers(token) });
  return parseProjectResponse(res.status, await res.text(), { hasToken: !!token });
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
