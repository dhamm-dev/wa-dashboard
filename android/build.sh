#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TOOLS=${DHEXBOT_TOOLS:-/home/dhexx/Projects/dhexbot-android-tools-20261115}
JAVA_HOME=${JAVA_HOME:-"$TOOLS/jdk-17.0.21+9"}
ANDROID_HOME=${ANDROID_HOME:-"$TOOLS/sdk"}
BUILD_TOOLS=${BUILD_TOOLS:-"$ANDROID_HOME/build-tools/36.0.0"}
PLATFORM=${ANDROID_PLATFORM:-"$ANDROID_HOME/platforms/android-36/android.jar"}
export JAVA_HOME
PATH="$JAVA_HOME/bin:$PATH"; export PATH
case "${1:-}" in
  staging) ORIGIN=https://wa-staging.dhexx.my.id; LABEL='Dhexbot Dev Staging' ;;
  production) ORIGIN=https://wa.dhexx.my.id; LABEL='Dhexbot Dev Production' ;;
  *) printf '%s\n' 'Usage: sh android/build.sh staging|production [unsigned|signed]' >&2; exit 2 ;;
esac
VARIANT=$1
MODE=${2:-unsigned}
case "$MODE" in unsigned|signed) ;; *) printf '%s\n' 'Choose unsigned or signed.' >&2; exit 2 ;; esac
test "$#" -le 2 || { printf '%s\n' 'Too many arguments.' >&2; exit 2; }
if [ "$MODE" = signed ]; then
  : "${DHEXBOT_KEYSTORE:?Set DHEXBOT_KEYSTORE to an existing keystore outside the project}"
  : "${DHEXBOT_STORE_PASSWORD:?Set DHEXBOT_STORE_PASSWORD}"
  : "${DHEXBOT_KEY_PASSWORD:?Set DHEXBOT_KEY_PASSWORD}"
  test -f "$DHEXBOT_KEYSTORE" && test -r "$DHEXBOT_KEYSTORE" || { printf '%s\n' 'Keystore is not a readable regular file.' >&2; exit 1; }
  KEY_PATH=$(realpath -- "$DHEXBOT_KEYSTORE")
  PROJECT_DIR=$(CDPATH= cd -- "$ROOT/.." && pwd -P)
  case "$KEY_PATH" in "$PROJECT_DIR/"*) printf '%s\n' 'Keystore must be outside the project.' >&2; exit 1 ;; esac
  export DHEXBOT_STORE_PASSWORD DHEXBOT_KEY_PASSWORD
fi
for f in "$JAVA_HOME/bin/javac" "$BUILD_TOOLS/aapt2" "$BUILD_TOOLS/d8" "$BUILD_TOOLS/zipalign" "$BUILD_TOOLS/apksigner" "$PLATFORM"; do
  test -e "$f" || { printf 'Missing tool: %s\n' "$f" >&2; exit 1; }
done
mkdir -p "$ROOT/build"
OUT=$(mktemp -d "$ROOT/build/$VARIANT.XXXXXXXX")
mkdir -p "$OUT/compiled" "$OUT/classes" "$OUT/test-classes" "$OUT/dex" "$OUT/generated/id/my/dhexx/dhexbot"
javac --release 8 -d "$OUT/test-classes" "$ROOT/src/main/java/id/my/dhexx/dhexbot/InputValidation.java" "$ROOT/src/main/java/id/my/dhexx/dhexbot/GoogleAuthorization.java" "$ROOT/src/main/java/id/my/dhexx/dhexbot/BotKeyOrder.java" "$ROOT/src/main/java/id/my/dhexx/dhexbot/AccountActionGuard.java" "$ROOT/src/main/java/id/my/dhexx/dhexbot/ScheduleTime.java" "$ROOT/src/main/java/id/my/dhexx/dhexbot/ScheduleRules.java" "$ROOT/src/main/java/id/my/dhexx/dhexbot/SignupOptions.java" "$ROOT"/src/test/java/id/my/dhexx/dhexbot/*.java
java -cp "$OUT/test-classes" id.my.dhexx.dhexbot.InputValidationTest
java -cp "$OUT/test-classes" id.my.dhexx.dhexbot.GoogleAuthorizationTest
java -cp "$OUT/test-classes" id.my.dhexx.dhexbot.BotKeyOrderTest
java -cp "$OUT/test-classes" id.my.dhexx.dhexbot.AccountActionGuardTest
java -cp "$OUT/test-classes" id.my.dhexx.dhexbot.ScheduleTimeTest
java -cp "$OUT/test-classes" id.my.dhexx.dhexbot.ScheduleRulesTest
java -cp "$OUT/test-classes" id.my.dhexx.dhexbot.SignupOptionsTest
printf 'package id.my.dhexx.dhexbot; public final class BuildConfig { public static final String ORIGIN = "%s"; public static final String LABEL = "%s"; }\n' "$ORIGIN" "$LABEL" > "$OUT/generated/id/my/dhexx/dhexbot/BuildConfig.java"
"$BUILD_TOOLS/aapt2" compile --dir "$ROOT/res" -o "$OUT/compiled"
"$BUILD_TOOLS/aapt2" link -I "$PLATFORM" --manifest "$ROOT/AndroidManifest.xml" --java "$OUT/generated" -o "$OUT/resources.apk" "$OUT"/compiled/*.flat
javac --release 8 -classpath "$PLATFORM" -d "$OUT/classes" "$OUT/generated/id/my/dhexx/dhexbot/BuildConfig.java" "$OUT/generated/id/my/dhexx/dhexbot/R.java" "$ROOT"/src/main/java/id/my/dhexx/dhexbot/*.java
"$BUILD_TOOLS/d8" --min-api 26 --lib "$PLATFORM" --output "$OUT/dex" "$OUT"/classes/id/my/dhexx/dhexbot/*.class
cp "$OUT/resources.apk" "$OUT/unsigned.apk"
jar uf "$OUT/unsigned.apk" -C "$OUT/dex" classes.dex
"$BUILD_TOOLS/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
if [ "$MODE" = signed ]; then
  "$BUILD_TOOLS/apksigner" sign --ks "$DHEXBOT_KEYSTORE" --ks-pass env:DHEXBOT_STORE_PASSWORD --key-pass env:DHEXBOT_KEY_PASSWORD --out "$OUT/dhexbot-$VARIANT-signed.apk" "$OUT/aligned.apk"
  "$BUILD_TOOLS/apksigner" verify --verbose "$OUT/dhexbot-$VARIANT-signed.apk"
  printf 'APK: %s\n' "$OUT/dhexbot-$VARIANT-signed.apk"
else
  printf 'Unsigned APK (not installable): %s\n' "$OUT/aligned.apk"
fi
