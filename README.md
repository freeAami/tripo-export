# tripo-export

Download your [Tripo Studio](https://studio.tripo3d.ai) models from the command line and export them locally to
**GLB, glTF, OBJ (+MTL & textures), STL, 3MF, FBX, USDZ or .blend**. No credits are used and you don't need to click Export on the website.

```bash
npm install
node bin/tripo-export.js https://studio.tripo3d.ai/workspace/generate/<project-id> -f glb,obj,fbx -o ~/Models/Tripo
```

## How it works (reverse-engineered)

When you open `studio.tripo3d.ai/workspace/generate/<id>`, the Studio web app (Nuxt) does this:

1. `GET https://api.tripo3d.ai/v2/studio/project/detail/v3/<id>?locale=en`
   returns the project: name, generation recipe (`operator.image_to_model` / `text_to_model`: prompt, model version,
   face limit, texture quality, PBR, ...), flags (`is_rigged`, `is_pbr`, ...) and a signed CDN `model_url`.
   Public projects need no login. Private ones need the `authorization: Bearer <token>` header that the site sends.
2. It downloads `model_url`: a GLB with all textures embedded (`tripo_pbr_model_<uuid>_meshopt.glb`) that is
   compressed with `EXT_meshopt_compression` + `KHR_mesh_quantization`. The viewer renders this file.
3. The website's **Export** button calls `POST /v2/studio/operation/export` (or `export-public-model`/`export-lite`)
   with a format (`gltf|fbx|obj|stl|usdz|3mf`), a texture size and an FBX preset. The conversion runs on Tripo's servers and is
   tied to your account or plan.

This tool does steps 1 and 2 itself, then decodes the meshopt/quantized data locally (glTF-Transform +
meshoptimizer). That gives the same mesh, UVs, normals and PBR textures the viewer shows, which it then writes to any format.

## Options

| Option | |
|---|---|
| `-o, --out <dir>` | output folder (default `./tripo_models`). Each model gets `<name>_<id8>/` |
| `-f, --format <list>` | `glb,gltf,obj,stl,3mf,fbx,usdz,blend` or `all` (default `glb,obj`) |
| `-t, --texture-size <px>` | downscale textures (e.g. `1024`) |
| `-s, --scale <n>` | scale OBJ/STL/3MF geometry |
| `--info` | print how the model was made (prompt, version, settings, mesh/texture stats) without exporting |
| `--extras` | also save the input image, preview renders and point-cloud GLB |
| `--keep-source` | keep the original compressed GLB as well |
| `--list <file>` | batch: one URL/id per line |
| `--token <jwt>` / `TRIPO_TOKEN` | needed for **private** models |

Every export also writes `model_info.json` (the generation recipe and mesh stats) and `project.json` (the raw API response).

`fbx`, `usdz` and `blend` run [Blender](https://www.blender.org/download/) headless (`brew install --cask blender` on macOS).
If Blender isn't found automatically, set `BLENDER=/path/to/blender`.

### Getting a token for private models

Log in at studio.tripo3d.ai, open DevTools (F12), go to **Network**, and click any request to `api.tripo3d.ai`.
Copy the value of the `authorization` request header (without `Bearer `) and pass it as `--token` or
`TRIPO_TOKEN`. Tokens expire, so copy a new one if you get an auth error.

## Notes

- Units: glTF is Y-up and in metres. 3MF is written Z-up in millimetres (×1000). Use `--scale` for STL/3MF printing sizes.
- OBJ: base color goes to `map_Kd` and the normal map to `norm`/`map_Bump`. The glTF metallic-roughness texture (G=roughness,
  B=metallic) goes to `map_Pr`/`map_Pm` with `-imfchan`.
- Rigged or animated models keep their skin and animation in GLB/glTF/FBX/blend. OBJ/STL/3MF contain only static geometry.
- The CDN `model_url` is signed and expires, so the tool always fetches a fresh one through the API.
