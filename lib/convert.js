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
import { dequantize, textureCompress } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { zipSync } from 'fflate';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRIANGLES = 4;
// Extensions used only to shrink the web preview file; dropped once data is decoded.
const WEB_ONLY_EXTENSIONS = ['EXT_meshopt_compression', 'KHR_mesh_quantization'];

export const LOCAL_FORMATS = ['glb', 'gltf', 'obj', 'stl', '3mf'];
export const BLENDER_FORMATS = ['fbx', 'usdz', 'blend'];
export const ALL_FORMATS = [...LOCAL_FORMATS, ...BLENDER_FORMATS];

export async function createIO() {
  await MeshoptDecoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
}

export async function loadClean(io, file, { textureSize } = {}) {
  const doc = await io.read(file);
  await doc.transform(dequantize());
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (WEB_ONLY_EXTENSIONS.includes(ext.extensionName)) ext.dispose();
  }
  if (textureSize) {
    await doc.transform(textureCompress({ encoder: sharp, resize: [textureSize, textureSize] }));
  }
  return doc;
}

const extOf = (mime) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/ktx2': 'ktx2' })[mime] || 'bin';

export async function describe(doc) {
  const root = doc.getRoot();
  let vertices = 0;
  let triangles = 0;
  const meshes = root.listMeshes().map((m) => {
    const prims = m.listPrimitives().map((p) => {
      const v = p.getAttribute('POSITION')?.getCount() ?? 0;
      const idx = p.getIndices();
      const t = p.getMode() === TRIANGLES ? (idx ? idx.getCount() : v) / 3 : 0;
      vertices += v;
      triangles += t;
      return { vertices: v, triangles: t, attributes: p.listSemantics(), material: p.getMaterial()?.getName() };
    });
    return { name: m.getName(), primitives: prims };
  });
  const textures = [];
  for (const t of root.listTextures()) {
    const img = t.getImage();
    const meta = img ? await sharp(Buffer.from(img)).metadata().catch(() => ({})) : {};
    textures.push({ name: t.getName(), mimeType: t.getMimeType(), width: meta.width, height: meta.height, bytes: img?.byteLength });
  }
  return {
    vertices,
    triangles,
    meshes,
    materials: root.listMaterials().map((m) => m.getName()),
    textures,
    skins: root.listSkins().length,
    animations: root.listAnimations().map((a) => a.getName()),
    nodes: root.listNodes().length,
  };
}

// ---- geometry flattening (world space, triangles only) ----

function normalMatrix(m) {
  const [a00, a01, a02, , a10, a11, a12, , a20, a21, a22] = m;
  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;
  let det = a00 * b01 + a01 * b11 + a02 * b21;
  if (!det) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  det = 1 / det;
  // inverse-transpose of the upper 3x3 (column-major in, row-major out)
  return [
    b01 * det, b11 * det, b21 * det,
    (-a22 * a01 + a02 * a21) * det, (a22 * a00 - a02 * a20) * det, (-a21 * a00 + a01 * a20) * det,
    (a12 * a01 - a02 * a11) * det, (-a12 * a00 + a02 * a10) * det, (a11 * a00 - a01 * a10) * det,
  ];
}

export function* primitives(doc) {
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  const nodes = [];
  scene.traverse((n) => n.getMesh() && nodes.push(n));
  for (const node of nodes) {
    const m = node.getWorldMatrix();
    const nm = normalMatrix(m);
    for (const prim of node.getMesh().listPrimitives()) {
      if (prim.getMode() !== TRIANGLES) continue;
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const count = pos.getCount();
      const p = new Float32Array(count * 3);
      const tmp = [0, 0, 0];
      for (let i = 0; i < count; i++) {
        pos.getElement(i, tmp);
        const [x, y, z] = tmp;
        p[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
        p[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        p[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      }
      let n = null;
      const nrm = prim.getAttribute('NORMAL');
      if (nrm) {
        n = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          nrm.getElement(i, tmp);
          const [x, y, z] = tmp;
          const nx = nm[0] * x + nm[3] * y + nm[6] * z;
          const ny = nm[1] * x + nm[4] * y + nm[7] * z;
          const nz = nm[2] * x + nm[5] * y + nm[8] * z;
          const l = Math.hypot(nx, ny, nz) || 1;
          n[i * 3] = nx / l;
          n[i * 3 + 1] = ny / l;
          n[i * 3 + 2] = nz / l;
        }
      }
      const uvAttr = prim.getAttribute('TEXCOORD_0');
      const uv = uvAttr ? Float32Array.from(uvAttr.getArray()) : null;
      const idxAttr = prim.getIndices();
      const idx = idxAttr ? Uint32Array.from(idxAttr.getArray()) : Uint32Array.from({ length: count }, (_, i) => i);
      yield { name: node.getName() || node.getMesh().getName(), material: prim.getMaterial(), p, n, uv, idx, count };
    }
  }
}

class LineWriter {
  constructor(file) {
    this.s = createWriteStream(file);
    this.buf = [];
  }
  async line(l) {
    this.buf.push(l);
    if (this.buf.length >= 50000) await this.flush();
  }
  async flush() {
    if (!this.buf.length) return;
    if (!this.s.write(this.buf.join('\n') + '\n')) await once(this.s, 'drain');
    this.buf = [];
  }
  async close() {
    await this.flush();
    this.s.end();
    await once(this.s, 'finish');
  }
}

const f6 = (v) => (Math.round(v * 1e6) / 1e6).toString();

async function saveTexture(tex, dir, base) {
  if (!tex?.getImage()) return null;
  const file = `${base}.${extOf(tex.getMimeType())}`;
  await writeFile(path.join(dir, file), tex.getImage());
  return file;
}

export async function writeOBJ(doc, outDir, name, { scale = 1 } = {}) {
  await mkdir(outDir, { recursive: true });
  const objFile = path.join(outDir, `${name}.obj`);
  const mtlFile = `${name}.mtl`;
  const mtl = ['# Exported by tripo-export'];
  const matNames = new Map();
  for (const [i, mat] of doc.getRoot().listMaterials().entries()) {
    const mname = (mat.getName() || `material_${i}`).replace(/\s+/g, '_');
    matNames.set(mat, mname);
    const [r, g, b, a] = mat.getBaseColorFactor();
    mtl.push('', `newmtl ${mname}`, `Kd ${f6(r)} ${f6(g)} ${f6(b)}`, `d ${f6(a)}`, 'illum 2');
    mtl.push(`Pm ${f6(mat.getMetallicFactor())}`, `Pr ${f6(mat.getRoughnessFactor())}`);
    const color = await saveTexture(mat.getBaseColorTexture(), outDir, `${mname}_basecolor`);
    if (color) mtl.push(`map_Kd ${color}`);
    const normal = await saveTexture(mat.getNormalTexture(), outDir, `${mname}_normal`);
    if (normal) mtl.push(`norm ${normal}`, `map_Bump -bm 1 ${normal}`);
    // glTF metallicRoughness texture: G = roughness, B = metallic (R = occlusion when ORM-packed).
    const orm = await saveTexture(mat.getMetallicRoughnessTexture(), outDir, `${mname}_metallicRoughness`);
    if (orm) mtl.push(`map_Pr -imfchan g ${orm}`, `map_Pm -imfchan b ${orm}`);
    const em = await saveTexture(mat.getEmissiveTexture(), outDir, `${mname}_emissive`);
    if (em) mtl.push(`map_Ke ${em}`);
  }
  await writeFile(path.join(outDir, mtlFile), mtl.join('\n') + '\n');

  const w = new LineWriter(objFile);
  await w.line('# Exported by tripo-export');
  await w.line(`mtllib ${mtlFile}`);
  let base = 0;
  for (const prim of primitives(doc)) {
    const { p, n, uv, idx, count } = prim;
    await w.line(`o ${(prim.name || 'mesh').replace(/\s+/g, '_')}`);
    for (let i = 0; i < count; i++) {
      await w.line(`v ${f6(p[i * 3] * scale)} ${f6(p[i * 3 + 1] * scale)} ${f6(p[i * 3 + 2] * scale)}`);
    }
    if (uv) for (let i = 0; i < count; i++) await w.line(`vt ${f6(uv[i * 2])} ${f6(1 - uv[i * 2 + 1])}`);
    if (n) for (let i = 0; i < count; i++) await w.line(`vn ${f6(n[i * 3])} ${f6(n[i * 3 + 1])} ${f6(n[i * 3 + 2])}`);
    if (prim.material) await w.line(`usemtl ${matNames.get(prim.material)}`);
    const fmt = uv && n ? (k) => `${k}/${k}/${k}` : uv ? (k) => `${k}/${k}` : n ? (k) => `${k}//${k}` : (k) => `${k}`;
    for (let t = 0; t < idx.length; t += 3) {
      await w.line(`f ${fmt(idx[t] + 1 + base)} ${fmt(idx[t + 1] + 1 + base)} ${fmt(idx[t + 2] + 1 + base)}`);
    }
    base += count;
  }
  await w.close();
  return objFile;
}

export async function writeSTL(doc, file, { scale = 1 } = {}) {
  const prims = [...primitives(doc)];
  const tris = prims.reduce((s, p) => s + p.idx.length / 3, 0);
  const buf = Buffer.alloc(84 + tris * 50);
  buf.write('Exported by tripo-export', 0, 'ascii');
  buf.writeUInt32LE(tris, 80);
  let o = 84;
  for (const { p, idx } of prims) {
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      buf.writeFloatLE(nx / l, o); buf.writeFloatLE(ny / l, o + 4); buf.writeFloatLE(nz / l, o + 8);
      o += 12;
      for (const k of [a, b, c]) {
        buf.writeFloatLE(p[k] * scale, o); buf.writeFloatLE(p[k + 1] * scale, o + 4); buf.writeFloatLE(p[k + 2] * scale, o + 8);
        o += 12;
      }
      o += 2;
    }
  }
  await writeFile(file, buf);
  return file;
}

// 3MF is Z-up in millimetres; glTF is Y-up in metres.
export async function write3MF(doc, file, { scale = 1 } = {}) {
  const enc = new TextEncoder();
  const parts = [];
  let id = 1;
  const items = [];
  for (const { name, p, idx, count } of primitives(doc)) {
    const v = new Array(count);
    for (let i = 0; i < count; i++) {
      const x = p[i * 3] * scale * 1000, y = p[i * 3 + 1] * scale * 1000, z = p[i * 3 + 2] * scale * 1000;
      v[i] = `<vertex x="${f6(x)}" y="${f6(-z)}" z="${f6(y)}"/>`;
    }
    const t = new Array(idx.length / 3);
    for (let k = 0; k < idx.length; k += 3) t[k / 3] = `<triangle v1="${idx[k]}" v2="${idx[k + 1]}" v3="${idx[k + 2]}"/>`;
    parts.push(
      `<object id="${id}" name="${(name || 'mesh').replace(/[<>&"]/g, '_')}" type="model"><mesh><vertices>`,
      v.join(''),
      '</vertices><triangles>',
      t.join(''),
      '</triangles></mesh></object>',
    );
    items.push(`<item objectid="${id}"/>`);
    id++;
  }
  const head =
    '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>';
  const tail = `</resources><build>${items.join('')}</build></model>`;
  const chunks = [head, ...parts, tail].map((s) => enc.encode(s));
  const model = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let off = 0;
  for (const c of chunks) { model.set(c, off); off += c.length; }
  const zip = zipSync({
    '[Content_Types].xml': enc.encode(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    ),
    '_rels/.rels': enc.encode(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    ),
    '3D/3dmodel.model': model,
  }, { level: 6 });
  await writeFile(file, zip);
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
