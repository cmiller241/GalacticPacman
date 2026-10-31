#!/usr/bin/env bash
# tools/build-exe.sh
#
# Builds a standalone Windows release of Asteroid Bob with all Lua
# compiled to stripped bytecode (no readable source in the build).
#
#   bash tools/build-exe.sh
#
# Output: build/AsteroidBob/ (AsteroidBob.exe + the DLLs it needs) and
# build/AsteroidBob-win64.zip, ready to hand to someone.
#
# Needs LÖVE 11.x installed at LOVE_DIR and 7-Zip on PATH.

set -euo pipefail

LOVE_DIR="${LOVE_DIR:-/c/Program Files/LOVE}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build"
STAGE="$BUILD/stage"
OUT="$BUILD/AsteroidBob"

rm -rf "$BUILD"
mkdir -p "$STAGE" "$OUT"
cd "$ROOT"

# --- Case check: Windows folders ignore case, but the exe reads from a
# zip, which doesn't. A require("lua.setup.worldGen") for WorldGen.lua
# works under `love .` and crashes in the release, so catch it here. ---
ALL_FILES="$(find lua tiled -type f)"
BAD=0
while IFS= read -r hit; do
  mod="$(sed -E 's/.*require\("([^"]+)"\).*/\1/' <<< "$hit")"
  path="$(tr . / <<< "$mod").lua"
  [ -f "$path" ] || continue   # missing entirely (old dead code) -- not a case problem
  grep -qxF "$path" <<< "$ALL_FILES" || { echo "CASE MISMATCH: $hit (file on disk has different capitalization)"; BAD=1; }
done < <(grep -rnoE 'require\("[^"]+"\)' main.lua lua)
[ "$BAD" = 0 ] || { echo "Fix the require() names above to match the filenames exactly."; exit 1; }

# --- Lua: everything the game requires (main, conf, lua/, Tiled maps) ---
LIST="$BUILD/lua-files.txt"
{ echo main.lua; echo conf.lua; find lua tiled -name "*.lua"; } > "$LIST"
while read -r f; do mkdir -p "$STAGE/$(dirname "$f")"; done < "$LIST"

# Release builds don't open a console window next to the game.
mkdir -p "$BUILD/src"
sed 's/t\.console *= *true/t.console = false/' conf.lua > "$BUILD/src/conf.lua"
grep -v '^conf.lua$' "$LIST" > "$BUILD/lua-files-main.txt"

"$LOVE_DIR/lovec.exe" tools/bytecode "$ROOT" "$STAGE" "$BUILD/lua-files-main.txt"
echo conf.lua > "$BUILD/lua-files-conf.txt"
"$LOVE_DIR/lovec.exe" tools/bytecode "$BUILD/src" "$STAGE" "$BUILD/lua-files-conf.txt"

# --- Assets: only formats the game loads (skips .clip/.psd/.pdf sources) ---
mkdir -p "$STAGE/img" "$STAGE/sounds"
find img -maxdepth 1 -type f \( -iname "*.png" -o -iname "*.jpg" \) -exec cp {} "$STAGE/img/" \;
cp sounds/* "$STAGE/sounds/"

# --- Package: .love is a zip; a fused exe is love.exe + .love appended ---
( cd "$STAGE" && 7z a -tzip -mx=9 "$BUILD/AsteroidBob.love" . > /dev/null )
cat "$LOVE_DIR/love.exe" "$BUILD/AsteroidBob.love" > "$OUT/AsteroidBob.exe"
cp "$LOVE_DIR"/*.dll "$LOVE_DIR/license.txt" "$OUT/"

( cd "$BUILD" && 7z a -tzip "AsteroidBob-win64.zip" AsteroidBob > /dev/null )

echo "Done: $OUT/AsteroidBob.exe"
echo "      $BUILD/AsteroidBob-win64.zip"
