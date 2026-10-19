#!/usr/bin/env bash
# Builds the SLOOP editor APK without Gradle: aapt2 -> javac -> d8 -> zipalign -> apksigner.
#   ANDROID_SDK   default /d/tools/android-sdk
#   ANDROID_HOME  also honoured
# Needs a JDK (17 is what this was tested with) on PATH.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_SDK:-${ANDROID_HOME:-/d/tools/android-sdk}}"
BT="$(ls -d "$SDK"/build-tools/*/ | sort -V | tail -1)"; BT="${BT%/}"
PLATFORM="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)"
AJAR="$PLATFORM/android.jar"
OUT="$here/build"

# the JDK tools are Windows programs: hand them Windows paths
w() { cygpath -w "$1"; }
OUTW="$(w "$OUT")"; HEREW="$(w "$here")"; AJARW="$(w "$AJAR")"
BTW="$(w "$BT")"

echo "build-tools $BT"
echo "platform    $PLATFORM"

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/assets"
cp "$here/../index.html" "$here/../theme.css" "$here/../i18n.js" "$here/../protocol.js" "$here/../app.js" "$here/../samples.js" "$here/../render.js" "$here/../sloop.wasm" "$here/../terminus.ttf" "$OUT/assets/"

"$BTW/aapt2" compile --dir "$HEREW/res" -o "$OUTW\\res.zip"
# About reads this back through ConsortFiles.version(), so a test install can be identified
"$BTW/aapt2" link -o "$OUTW\\base.apk" -I "$AJARW" \
    --manifest "$HEREW\\AndroidManifest.xml" -R "$OUTW\\res.zip" -A "$OUTW\\assets" \
    --replace-version --version-code 2 --version-name "0.9.1-$(date +%Y%m%d-%H%M)" \
    --auto-add-overlay --min-sdk-version 23 --target-sdk-version 36

find "$here/src" -name '*.java' | while read -r f; do w "$f"; done > "$OUT/sources.txt"
if ! javac --release 8 -encoding UTF-8 -classpath "$AJARW" -d "$OUTW\\classes" \
        @"$OUTW\\sources.txt" > "$OUT/javac.log" 2>&1; then
    cat "$OUT/javac.log"
    exit 1
fi

find "$OUT/classes" -name '*.class' | while read -r f; do w "$f"; done > "$OUT/classes.txt"
"$BTW\\d8.bat" --lib "$AJARW" --min-api 23 --output "$OUTW\\dex" @"$OUTW\\classes.txt"

cp "$OUT/base.apk" "$OUT/unsigned.apk"
( cd "$OUT/dex" && jar --update --file "$OUTW\\unsigned.apk" classes.dex )

"$BTW/zipalign" -f -p 4 "$OUTW\\unsigned.apk" "$OUTW\\aligned.apk"

KS="$(w "$HOME/.android/debug.keystore")"
if [ ! -f "$HOME/.android/debug.keystore" ]; then
    mkdir -p "$HOME/.android"
    keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
        -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
        -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
fi

"$BTW\\apksigner.bat" sign --ks "$KS" --ks-key-alias androiddebugkey \
    --ks-pass pass:android --key-pass pass:android \
    --out "$HEREW\\consort.apk" "$OUTW\\aligned.apk"
"$BTW\\apksigner.bat" verify --print-certs "$HEREW\\consort.apk" | head -3
# one obvious artifact at the project root, always the build that was just signed
cp "$here/consort.apk" "$here/../consort.apk"
ls -l "$here/consort.apk" "$here/../consort.apk"
