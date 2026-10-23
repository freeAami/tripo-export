# Usage: blender -b --factory-startup --python blender_convert.py -- <in.glb> <out-file> <format>
import sys
import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
src, out, fmt = argv[0], argv[1], argv[2]

bpy.ops.wm.read_factory_settings(use_empty=True)


def supported(op, **kwargs):
    """Drop keyword args this Blender version's operator doesn't know."""
    names = {p.identifier for p in op.get_rna_type().properties}
    return {k: v for k, v in kwargs.items() if k in names}


bpy.ops.import_scene.gltf(filepath=src)

if fmt == "fbx":
    op = bpy.ops.export_scene.fbx
    op(filepath=out, **supported(op, path_mode="COPY", embed_textures=True, add_leaf_bones=False, use_selection=False))
elif fmt == "usdz":
    op = bpy.ops.wm.usd_export
    op(filepath=out, **supported(op, export_materials=True, export_textures=True, export_textures_mode="NEW"))
elif fmt == "blend":
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=out, compress=True)
else:
    raise SystemExit(f"unsupported format {fmt}")
print(f"TRIPO_EXPORT_OK {out}")
