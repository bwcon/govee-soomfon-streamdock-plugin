import os, zipfile, shutil

plugin_dir = os.path.dirname(os.path.abspath(__file__))
plugin_uuid = "com.soomfon.govee"
build_dir = os.path.join(plugin_dir, "build")
pkg_name = f"{plugin_uuid}.sdPlugin"
pkg_dir = os.path.join(build_dir, pkg_name)
out_zip = os.path.join(plugin_dir, f"{plugin_uuid}.streamDockPlugin")

if os.path.exists(build_dir): shutil.rmtree(build_dir)
os.makedirs(pkg_dir, exist_ok=True)

# Copy needed files and folders
items_to_copy = ["manifest.json", "package.json", "index.js", "images", "ui", "node_modules"]

for item in items_to_copy:
    src = os.path.join(plugin_dir, item)
    dst = os.path.join(pkg_dir, item)
    if os.path.isdir(src):
        shutil.copytree(src, dst)
    elif os.path.isfile(src):
        shutil.copy2(src, dst)

# Create .streamDockPlugin zip
with zipfile.ZipFile(out_zip, 'w', zipfile.ZIP_DEFLATED) as zipf:
    for root, dirs, files in os.walk(pkg_dir):
        for file in files:
            full_path = os.path.join(root, file)
            arc_name = os.path.relpath(full_path, build_dir)
            zipf.write(full_path, arc_name)

print("Packaged Govee plugin:", out_zip)
