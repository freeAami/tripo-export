#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseProjectId, fetchProject, modelUrlOf, download } from '../lib/api.js';
import { recipe, slug, extrasOf } from '../lib/core.js';
import { createIO, loadClean, describe, exportAll, ALL_FORMATS } from '../lib/convert.js';

const HELP = `tripo-export - download Tripo Studio models and export them locally

Usage:
  tripo-export <project-url-or-id> [...more] [options]

Options:
  -o, --out <dir>          Output folder (default: ./tripo_models)
  -f, --format <list>      Comma list of: ${ALL_FORMATS.join(', ')}, or "all"  (default: glb,obj)
  -t, --texture-size <px>  Downscale textures to at most <px> (e.g. 1024, 2048). Default: original
  -s, --scale <n>          Scale factor for OBJ/STL/3MF geometry (default: 1)
      --token <jwt>        Tripo login token for private models (or env TRIPO_TOKEN)
      --list <file>        Text file with one project URL/id per line
      --info               Only print how the model was made + mesh stats; don't export
      --extras             Also save input image, preview renders and point-cloud GLB
      --keep-source        Keep the original compressed web GLB (*_meshopt.glb)
  -h, --help               Show help

Formats fbx, usdz and blend use Blender in the background (set BLENDER=/path if not auto-detected).
`;

function parseArgs(argv) {
  const o = { inputs: [], out: 'tripo_models', formats: ['glb', 'obj'], scale: 1, token: process.env.TRIPO_TOKEN };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-o': case '--out': o.out = next(); break;
      case '-f': case '--format': {
        const v = next().toLowerCase();
        o.formats = v === 'all' ? ALL_FORMATS : v.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      }
      case '-t': case '--texture-size': o.textureSize = parseInt(next(), 10); break;
      case '-s': case '--scale': o.scale = parseFloat(next()); break;
      case '--token': o.token = next(); break;
      case '--list': o.list = next(); break;
      case '--info': o.info = true; break;
      case '--extras': o.extras = true; break;
      case '--keep-source': o.keepSource = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown option ${a}`);
        o.inputs.push(a);
    }
  }
  for (const f of o.formats) if (!ALL_FORMATS.includes(f)) throw new Error(`Unknown format "${f}"`);
  return o;
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function progress(label) {
  let last = 0;
  return (done, total) => {
    const now = Date.now();
    if (now - last < 200 && done !== total) return;
    last = now;
    const pct = total ? ` ${((done / total) * 100).toFixed(0)}%` : '';
    process.stdout.write(`\r  ${label}: ${mb(done)}${total ? ` / ${mb(total)}` : ''}${pct}   `);
    if (done === total) process.stdout.write('\n');
  };
}

function printInfo(r, stats) {
  console.log(`  Name:        ${r.name}  (${r.visibility}, by ${r.owner})`);
  console.log(`  Made with:   ${r.generator} · Tripo ${r.model_version}`);
  const g = r.generation_params;
  if (g.prompt) console.log(`  Prompt:      ${g.prompt}`);
  const keys = ['geometry_quality', 'texture_quality', 'face_limit', 'pbr', 'texture', 'quad', 'smart_poly', 'generate_parts', 'texture_alignment'];
  console.log(`  Settings:    ${keys.filter((k) => k in g).map((k) => `${k}=${g[k]}`).join(', ')}`);
  console.log(`  Flags:       ${Object.entries(r.flags).filter(([, v]) => v).map(([k]) => k).join(', ') || '-'}`);
  if (stats) {
    console.log(`  Mesh:        ${stats.vertices.toLocaleString()} vertices, ${stats.triangles.toLocaleString()} triangles, ${stats.meshes.length} mesh(es), ${stats.nodes} node(s)`);
    for (const t of stats.textures) console.log(`  Texture:     ${t.name} ${t.width}x${t.height} ${t.mimeType}`);
    if (stats.skins) console.log(`  Rig:         ${stats.skins} skin(s), animations: ${stats.animations.join(', ') || '-'}`);
  }
}

async function processOne(input, opts, io) {
  const id = parseProjectId(input);
  console.log(`\n[${id}]`);
  const project = await fetchProject(id, { token: opts.token });
  const r = recipe(project);
  const url = modelUrlOf(project);
  if (!url) throw new Error('Project has no model yet (generation may still be running).');

  const dir = path.join(opts.out, `${slug(project.project_name)}_${id.slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  const srcName = path.basename(new URL(url).pathname);
  const src = opts.keepSource ? path.join(dir, srcName) : path.join(os.tmpdir(), `${id}_${srcName}`);
  await download(url, src, { onProgress: progress('model') });

  const doc = await loadClean(io, src, { textureSize: opts.textureSize });
  const stats = await describe(doc);
  printInfo(r, stats);
  await writeFile(path.join(dir, 'model_info.json'), JSON.stringify({ ...r, source_file: srcName, mesh: stats }, null, 2));
  await writeFile(path.join(dir, 'project.json'), JSON.stringify(project, null, 2));
  if (opts.info) {
    if (!opts.keepSource) await rm(src, { force: true });
    return dir;
  }

  const base = slug(project.project_name);
  await exportAll(io, doc, dir, base, opts.formats, {
    scale: opts.scale,
    onWritten: (fmt, file) => console.log(`  wrote ${fmt.padEnd(5)} ${file}`),
  });

  if (opts.extras) {
    const extras = path.join(dir, 'extras');
    await mkdir(extras, { recursive: true });
    const jobs = extrasOf(project);
    for (const [u, name] of jobs) {
      const ext = path.extname(new URL(u).pathname) || '.bin';
      const f = path.join(extras, name + ext);
      try {
        await download(u, f);
        console.log(`  wrote extra ${f}`);
      } catch (e) {
        console.warn(`  skipped ${name}: ${e.message}`);
      }
    }
  }
  if (!opts.keepSource) await rm(src, { force: true });
  return dir;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message + '\n\n' + HELP);
    process.exit(2);
  }
  if (opts.list) {
    const lines = (await readFile(opts.list, 'utf8')).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    opts.inputs.push(...lines);
  }
  if (opts.help || !opts.inputs.length) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 2);
  }
  const io = await createIO();
  let failed = 0;
  for (const input of opts.inputs) {
    try {
      const dir = await processOne(input, opts, io);
      console.log(`  done -> ${path.resolve(dir)}`);
    } catch (e) {
      failed++;
      console.error(`  FAILED: ${e.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main();
