#!/bin/sh
# GalacticPacman/tools/deploy.sh — build the game and upload it to the
# web server over SFTP (WinSCP), so it can be played from a phone.
#
#   npm run deploy        (from GalacticPacman/)
#
# Login details come from the repo-root .env (git-ignored):
#   DEPLOY_HOST, DEPLOY_USER, DEPLOY_PASSWORD, DEPLOY_PATH, DEPLOY_HOSTKEY
# Only the files the game actually loads are uploaded.
set -e
GAME_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$GAME_DIR/../.env"
WINSCP="/c/Program Files (x86)/WinSCP/WinSCP.com"

[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE"; exit 1; }
set -a; . "$ENV_FILE"; set +a

cd "$GAME_DIR"
npm run build

# Stage exactly what the page needs.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/css" "$STAGE/dist" "$STAGE/img" "$STAGE/sounds"
cp index.html "$STAGE/"
# Stamp the bundle and stylesheet URLs with this deploy's time, so phones
# fetch the new code instead of a cached copy.
VERSION="$(date +%s)"
sed -i "s#dist/bundle.js#dist/bundle.js?v=$VERSION#; s#css/styles.css#css/styles.css?v=$VERSION#" "$STAGE/index.html"
cp css/styles.css "$STAGE/css/"
cp dist/bundle.js "$STAGE/dist/"
cp img/planet_texture_2.jpg "$STAGE/img/"
cp sounds/*.wav "$STAGE/sounds/"

# WinSCP script (holds the password, so it lives in the temp folder and
# is deleted on exit).
STAGE_WIN="$(cygpath -w "$STAGE")"
cat > "$STAGE/upload.txt" <<SCRIPT
option batch abort
option confirm off
open sftp://$DEPLOY_USER@$DEPLOY_HOST/ -password="$DEPLOY_PASSWORD" -hostkey="$DEPLOY_HOSTKEY"
# (Fails harmlessly if the folder already exists.)
option batch continue
mkdir "$DEPLOY_PATH"
option batch abort
put -transfer=binary "$STAGE_WIN\index.html" "$STAGE_WIN\css" "$STAGE_WIN\dist" "$STAGE_WIN\img" "$STAGE_WIN\sounds" "$DEPLOY_PATH/"
ls "$DEPLOY_PATH"
exit
SCRIPT
"$WINSCP" /ini=nul /script="$(cygpath -w "$STAGE/upload.txt")"
echo "Deployed to https://$DEPLOY_HOST/${DEPLOY_PATH#public_html/}/"
