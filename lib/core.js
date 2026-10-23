// Platform-neutral pieces shared by the CLI (Node) and the browser extension / web app.
import { dequantize } from '@gltf-transform/functions';
import { zipSync } from 'fflate';

export const API_BASE = 'https://api.tripo3d.ai';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const TRIANGLES = 4;
// Extensions used only to shrink the web preview file; dropped once data is decoded.
const WEB_ONLY_EXTENSIONS = ['EXT_meshopt_compression', 'KHR_mesh_quantization'];

export function parseProjectId(input) {
  const m = String(input).match(UUID_RE);
  if (!m) throw new Error(`Could not find a project id in "${input}"`);
  return m[0].toLowerCase();
}

// Same endpoint the Studio workspace calls when it opens /workspace/generate/<id>.
export const projectUrl = (id) => `${API_BASE}/v2/studio/project/detail/v3/${id}?locale=en`;

export function parseProjectResponse(status, text, { hasToken } = {}) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Unexpected response (${status}) from Tripo API: ${text.slice(0, 200)}`);
  }
  if (status >= 400 || body.code !== 0) {
    const hint = hasToken ? '' : ' If the model is private, you need to be logged in / pass a token.';
    throw new Error(`Tripo API error ${status} code=${body.code}: ${body.message}.${hint}`);
  }
  return body.data;
}

export const modelUrlOf = (project) => project.model_url || project.operator?.model_url;

export const slug = (s) =>
  (s || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'model';

export function generatorOf(project) {
  const op = project.operator || {};
  return op.image_to_model || op.text_to_model || op.multiview_to_model || {};
}

export function recipe(project) {
  const op = project.operator || {};
  const gen = generatorOf(project);
  const flags = Object.fromEntries(Object.entries(op).filter(([k, v]) => k.startsWith('is_') && typeof v === 'boolean'));
  const genParams = Object.fromEntries(
    Object.entries(gen).filter(([k, v]) => v !== null && typeof v !== 'object' && !/url/.test(k)),
  );
  return {
    project_id: project.id,
    name: project.project_name,
    owner: project.owner_name,
    visibility: project.visibility,
    category: project.category,
    style: project.style,
    operation: op.type,
    generator: op.image_to_model ? 'image_to_model' : op.text_to_model ? 'text_to_model' : op.multiview_to_model ? 'multiview_to_model' : op.type,
    model_version: op.model_version || gen.model_version,
    generation_params: genParams,
    flags,
    created_at: op.created_at ? new Date(op.created_at * 1000).toISOString() : undefined,
  };
}

export function extrasOf(project) {
  const jobs = [];
  (generatorOf(project).generate_image || []).forEach((u, i) => jobs.push([u, `input_${i}`]));
  (project.cover_image || []).forEach((u, i) => jobs.push([u, `preview_${i}`]));
  if (project.point_cloud_model_url) jobs.push([project.point_cloud_model_url, 'point_cloud']);
  return jobs;
}

export async function cleanDoc(doc) {
  await doc.transform(dequantize());
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (WEB_ONLY_EXTENSIONS.includes(ext.extensionName)) ext.dispose();
  }
  return doc;
}

export const extOf = (mime) =>
  ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/ktx2': 'ktx2' })[mime] || 'bin';

// Width/height straight from PNG/JPEG/WebP headers (no decoder needed).
export function imageSize(b) {
  if (!b || b.length < 24) return {};
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] === 0x89 && b[1] === 0x50) return { width: dv.getUint32(16), height: dv.getUint32(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { height: dv.getUint16(o + 5), width: dv.getUint16(o + 7) };
      }
      o += 2 + dv.getUint16(o + 2);
    }
  }
  if (b[8] === 0x57 && b[9] === 0x45 && b[12] === 0x56 && b[15] === 0x20) {
    return { width: (dv.getUint16(26, true) & 0x3fff), height: (dv.getUint16(28, true) & 0x3fff) };
  }
  return {};
}

export function describe(doc) {
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
  const textures = root.listTextures().map((t) => {
    const img = t.getImage();
    return { name: t.getName(), mimeType: t.getMimeType(), ...imageSize(img), bytes: img?.byteLength };
  });
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

const f6 = (v) => (Math.round(v * 1e6) / 1e6).toString();

// Returns { mtl, textures: [{ file, data }], chunks() } where chunks() yields OBJ text pieces
// so huge meshes never have to live in a single string.
export function buildOBJ(doc, name, { scale = 1 } = {}) {
  const mtlFile = `${name}.mtl`;
  const mtl = ['# Exported by tripo-export'];
  const textures = [];
  const matNames = new Map();
  const tex = (t, base) => {
    if (!t?.getImage()) return null;
    const file = `${base}.${extOf(t.getMimeType())}`;
    textures.push({ file, data: t.getImage() });
    return file;
  };
  for (const [i, mat] of doc.getRoot().listMaterials().entries()) {
    const mname = (mat.getName() || `material_${i}`).replace(/\s+/g, '_');
    matNames.set(mat, mname);
    const [r, g, b, a] = mat.getBaseColorFactor();
    mtl.push('', `newmtl ${mname}`, `Kd ${f6(r)} ${f6(g)} ${f6(b)}`, `d ${f6(a)}`, 'illum 2');
    mtl.push(`Pm ${f6(mat.getMetallicFactor())}`, `Pr ${f6(mat.getRoughnessFactor())}`);
    const color = tex(mat.getBaseColorTexture(), `${mname}_basecolor`);
    if (color) mtl.push(`map_Kd ${color}`);
    const normal = tex(mat.getNormalTexture(), `${mname}_normal`);
    if (normal) mtl.push(`norm ${normal}`, `map_Bump -bm 1 ${normal}`);
    // glTF metallicRoughness texture: G = roughness, B = metallic (R = occlusion when ORM-packed).
    const orm = tex(mat.getMetallicRoughnessTexture(), `${mname}_metallicRoughness`);
    if (orm) mtl.push(`map_Pr -imfchan g ${orm}`, `map_Pm -imfchan b ${orm}`);
    const em = tex(mat.getEmissiveTexture(), `${mname}_emissive`);
    if (em) mtl.push(`map_Ke ${em}`);
  }

  function* chunks() {
    let buf = ['# Exported by tripo-export', `mtllib ${mtlFile}`];
    const line = function* (l) {
      buf.push(l);
      if (buf.length >= 50000) {
        yield buf.join('\n') + '\n';
        buf = [];
      }
    };
    let base = 0;
    for (const prim of primitives(doc)) {
      const { p, n, uv, idx, count } = prim;
      yield* line(`o ${(prim.name || 'mesh').replace(/\s+/g, '_')}`);
      for (let i = 0; i < count; i++) {
        yield* line(`v ${f6(p[i * 3] * scale)} ${f6(p[i * 3 + 1] * scale)} ${f6(p[i * 3 + 2] * scale)}`);
      }
      if (uv) for (let i = 0; i < count; i++) yield* line(`vt ${f6(uv[i * 2])} ${f6(1 - uv[i * 2 + 1])}`);
      if (n) for (let i = 0; i < count; i++) yield* line(`vn ${f6(n[i * 3])} ${f6(n[i * 3 + 1])} ${f6(n[i * 3 + 2])}`);
      if (prim.material) yield* line(`usemtl ${matNames.get(prim.material)}`);
      const fmt = uv && n ? (k) => `${k}/${k}/${k}` : uv ? (k) => `${k}/${k}` : n ? (k) => `${k}//${k}` : (k) => `${k}`;
      for (let t = 0; t < idx.length; t += 3) {
        yield* line(`f ${fmt(idx[t] + 1 + base)} ${fmt(idx[t + 1] + 1 + base)} ${fmt(idx[t + 2] + 1 + base)}`);
      }
      base += count;
    }
    if (buf.length) yield buf.join('\n') + '\n';
  }
  return { objFile: `${name}.obj`, mtlFile, mtl: mtl.join('\n') + '\n', textures, chunks };
}

export function buildSTL(doc, { scale = 1 } = {}) {
  const prims = [...primitives(doc)];
  const tris = prims.reduce((s, p) => s + p.idx.length / 3, 0);
  const out = new Uint8Array(84 + tris * 50);
  const dv = new DataView(out.buffer);
  new TextEncoder().encodeInto('Exported by tripo-export', out);
  dv.setUint32(80, tris, true);
  let o = 84;
  const f = (v) => { dv.setFloat32(o, v, true); o += 4; };
  for (const { p, idx } of prims) {
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      f(nx / l); f(ny / l); f(nz / l);
      for (const k of [a, b, c]) { f(p[k] * scale); f(p[k + 1] * scale); f(p[k + 2] * scale); }
      o += 2;
    }
  }
  return out;
}

// 3MF is Z-up in millimetres; glTF is Y-up in metres.
export function build3MF(doc, { scale = 1 } = {}) {
  const enc = new TextEncoder();
  const chunks = [];
  const items = [];
  let id = 1;
  chunks.push(enc.encode(
    '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>',
  ));
  for (const { name, p, idx, count } of primitives(doc)) {
    chunks.push(enc.encode(`<object id="${id}" name="${(name || 'mesh').replace(/[<>&"]/g, '_')}" type="model"><mesh><vertices>`));
    for (let s = 0; s < count; s += 50000) {
      const v = [];
      for (let i = s; i < Math.min(count, s + 50000); i++) {
        const x = p[i * 3] * scale * 1000, y = p[i * 3 + 1] * scale * 1000, z = p[i * 3 + 2] * scale * 1000;
        v.push(`<vertex x="${f6(x)}" y="${f6(-z)}" z="${f6(y)}"/>`);
      }
      chunks.push(enc.encode(v.join('')));
    }
    chunks.push(enc.encode('</vertices><triangles>'));
    for (let s = 0; s < idx.length; s += 150000) {
      const t = [];
      for (let k = s; k < Math.min(idx.length, s + 150000); k += 3) t.push(`<triangle v1="${idx[k]}" v2="${idx[k + 1]}" v3="${idx[k + 2]}"/>`);
      chunks.push(enc.encode(t.join('')));
    }
    chunks.push(enc.encode('</triangles></mesh></object>'));
    items.push(`<item objectid="${id}"/>`);
    id++;
  }
  chunks.push(enc.encode(`</resources><build>${items.join('')}</build></model>`));
  const model = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let off = 0;
  for (const c of chunks) { model.set(c, off); off += c.length; }
  return zipSync({
    '[Content_Types].xml': enc.encode(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    ),
    '_rels/.rels': enc.encode(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    ),
    '3D/3dmodel.model': model,
  }, { level: 6 });
}
