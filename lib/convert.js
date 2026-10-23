import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { cleanDoc, buildOBJ, buildSTL, build3MF } from './core.js';

export { describe, primitives } from './core.js';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const LOCAL_FORMATS = ['glb', 'gltf', 'obj', 'stl', '3mf'];
export const BLENDER_FORMATS = ['fbx', 'usdz', 'blend'];
export const ALL_FORMATS = [...LOCAL_FORMATS, ...BLENDER_FORMATS];

export async function createIO() {
  await MeshoptDecoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
}

export async function loadClean(io, file, { textureSize } = {}) {
  const doc = await cleanDoc(await io.read(file));
  if (textureSize) {
    await doc.transform(textureCompress({ encoder: sharp, resize: [textureSize, textureSize] }));
  }
  return doc;
}

export async function writeOBJ(doc, outDir, name, opts = {}) {
  await mkdir(outDir, { recursive: true });
  const { objFile, mtlFile, mtl, textures, chunks } = buildOBJ(doc, name, opts);
  await writeFile(path.join(outDir, mtlFile), mtl);
  for (const t of textures) await writeFile(path.join(outDir, t.file), t.data);
  const file = path.join(outDir, objFile);
  const s = createWriteStream(file);
  for (const c of chunks()) if (!s.write(c)) await once(s, 'drain');
  s.end();
  await once(s, 'finish');
  return file;
}

export async function writeSTL(doc, file, opts = {}) {
  await writeFile(file, buildSTL(doc, opts));
  return file;
}

export async function write3MF(doc, file, opts = {}) {
  await writeFile(file, build3MF(doc, opts));
  return file;
}

export function findBlender() {
  const candidates = [
    process.env.BLENDER,
    '/Applications/Blender.app/Contents/MacOS/Blender',
    '/usr/bin/blender',
    '/usr/local/bin/blender',
    '/snap/bin/blender',
    '/opt/homebrew/bin/blender',
  ];
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    for (const v of ['4.5', '4.4', '4.3', '4.2', '4.1', '4.0', '5.0', '5.1']) {
      candidates.push(path.join(pf, 'Blender Foundation', `Blender ${v}`, 'blender.exe'));
    }
  }
  for (const c of candidates) if (c && existsSync(c)) return c;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const exe of ['blender', 'blender.exe']) {
      const p = path.join(dir, exe);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export async function blenderConvert(io, doc, outFile, format) {
  const blender = findBlender();
  if (!blender) {
    throw new Error(`${format.toUpperCase()} export needs Blender (free). Install it or set BLENDER=/path/to/blender.`);
  }
  const tmp = path.join(os.tmpdir(), `tripo-export-${process.pid}-${Date.now()}.glb`);
  await writeFile(tmp, await io.writeBinary(doc));
  try {
    const { stdout, stderr } = await execFileP(
      blender,
      ['-b', '--factory-startup', '--python', path.join(HERE, 'blender_convert.py'), '--', tmp, path.resolve(outFile), format],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    if (!stdout.includes('TRIPO_EXPORT_OK')) throw new Error(`Blender did not finish:\n${(stdout + stderr).slice(-2000)}`);
  } finally {
    await rm(tmp, { force: true });
  }
  return outFile;
}

export async function exportAll(io, doc, outDir, baseName, formats, opts = {}) {
  const written = [];
  for (const fmt of formats) {
    let out;
    switch (fmt) {
      case 'glb':
        out = path.join(outDir, `${baseName}.glb`);
        await writeFile(out, await io.writeBinary(doc));
        break;
      case 'gltf':
        out = path.join(outDir, 'gltf', `${baseName}.gltf`);
        await mkdir(path.dirname(out), { recursive: true });
        await io.write(out, doc);
        break;
      case 'obj':
        out = await writeOBJ(doc, path.join(outDir, 'obj'), baseName, opts);
        break;
      case 'stl':
        out = await writeSTL(doc, path.join(outDir, `${baseName}.stl`), opts);
        break;
      case '3mf':
        out = await write3MF(doc, path.join(outDir, `${baseName}.3mf`), opts);
        break;
      case 'fbx':
      case 'usdz':
      case 'blend':
        out = path.join(outDir, `${baseName}.${fmt}`);
        if (fmt === 'fbx') await mkdir(outDir, { recursive: true });
        await blenderConvert(io, doc, out, fmt);
        break;
      default:
        throw new Error(`Unknown format "${fmt}". Supported: ${ALL_FORMATS.join(', ')}`);
    }
    written.push(out);
    opts.onWritten?.(fmt, out);
  }
  return written;
}

export { readFile };
