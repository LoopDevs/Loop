#!/usr/bin/env bash
# Applies the versioned native-config overlays from
# `apps/mobile/native-overlays/` to the generated (gitignored) native
# projects under `apps/mobile/ios` and `apps/mobile/android`.
#
# Run after `npx cap add ios`, `npx cap add android`, or `npx cap sync`.
# The overlays cover configuration that `cap sync` would otherwise
# overwrite on regeneration:
#
#   - Android backup exclusions (audit A-033) — stops auto-backup from
#     sweeping the Capacitor Preferences file (pending purchase state
#     and any pre-A-024 refresh-token residue) into Google Drive /
#     device-transfer. Post-A-024/ADR-006 refresh tokens live in
#     EncryptedSharedPreferences via @aparajita/capacitor-secure-storage
#     and are Keystore-bound, so even if they were backed up they
#     cannot be decrypted on a different device.
#   - iOS NSFaceIDUsageDescription (audit A-034) — required for the
#     biometric-auth plugin to work and for App Store approval.
#
# Idempotent: safe to run repeatedly. Each step checks for the
# required state before writing.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
OVERLAY_DIR="$ROOT_DIR/apps/mobile/native-overlays"
ANDROID_DIR="$ROOT_DIR/apps/mobile/android"
IOS_PLIST="$ROOT_DIR/apps/mobile/ios/App/App/Info.plist"

say() {
  printf '[apply-native-overlays] %s\n' "$*"
}

# ─── Android: backup rules (audit A-033) ────────────────────────────────────
if [ -d "$ANDROID_DIR" ]; then
  ANDROID_XML_DIR="$ANDROID_DIR/app/src/main/res/xml"
  ANDROID_MANIFEST="$ANDROID_DIR/app/src/main/AndroidManifest.xml"
  ANDROID_JAVA_DIR="$ANDROID_DIR/app/src/main/java/io/loopfinance/app"

  say "Copying backup rules XML into $ANDROID_XML_DIR"
  mkdir -p "$ANDROID_XML_DIR"
  cp "$OVERLAY_DIR/android/app/src/main/res/xml/backup_rules.xml" "$ANDROID_XML_DIR/"
  cp "$OVERLAY_DIR/android/app/src/main/res/xml/data_extraction_rules.xml" "$ANDROID_XML_DIR/"

  # MainActivity override — disables WebView overscroll so the fixed
  # tab bar isn't dragged by the visual viewport during rubber-band.
  # `cap add android` regenerates the default no-op MainActivity, so
  # this overlay must be reapplied after every cap sync / cap add.
  say "Copying MainActivity override into $ANDROID_JAVA_DIR"
  mkdir -p "$ANDROID_JAVA_DIR"
  cp "$OVERLAY_DIR/android/app/src/main/java/io/loopfinance/app/MainActivity.java" "$ANDROID_JAVA_DIR/"

  # Launcher icons — replaces the default Capacitor "C" icon with the
  # Loop square logo at every density. Both legacy PNGs (ic_launcher /
  # ic_launcher_round) and the adaptive foreground (larger canvas for
  # Android's shape-masking) are copied. `cap add android` resets these
  # back to Capacitor defaults, so the overlay re-applies them.
  for DENSITY in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
    SRC_DIR="$OVERLAY_DIR/android/app/src/main/res/mipmap-$DENSITY"
    DEST_DIR="$ANDROID_DIR/app/src/main/res/mipmap-$DENSITY"
    if [ -d "$SRC_DIR" ]; then
      mkdir -p "$DEST_DIR"
      cp "$SRC_DIR/ic_launcher.png" "$DEST_DIR/"
      cp "$SRC_DIR/ic_launcher_round.png" "$DEST_DIR/"
      cp "$SRC_DIR/ic_launcher_foreground.png" "$DEST_DIR/"
    fi
  done
  say "Copied Loop launcher icons into mipmap-* folders"

  # Adaptive-icon background color — Capacitor's default is white which
  # looks wrong behind the dark Loop mark. Overlay swaps it for the
  # brand near-black (#111111) so the shape mask fills with the same
  # colour as the padded foreground canvas — seamless.
  VALUES_SRC="$OVERLAY_DIR/android/app/src/main/res/values/ic_launcher_background.xml"
  VALUES_DEST="$ANDROID_DIR/app/src/main/res/values/ic_launcher_background.xml"
  if [ -f "$VALUES_SRC" ]; then
    cp "$VALUES_SRC" "$VALUES_DEST"
    say "Copied ic_launcher_background color override"
  fi

  # Splash theme — wires up Android 12+ windowSplashScreen* attrs so
  # the system splash uses the same #111111 + Loop mark as the
  # Capacitor splash that follows it. Without this overlay, cap-sync's
  # default styles.xml shows the launcher icon on a white background
  # for the first ~400ms of boot, before jumping to the dark Capacitor
  # splash — visible as a light flash on cold start.
  STYLES_SRC="$OVERLAY_DIR/android/app/src/main/res/values/styles.xml"
  STYLES_DEST="$ANDROID_DIR/app/src/main/res/values/styles.xml"
  if [ -f "$STYLES_SRC" ]; then
    cp "$STYLES_SRC" "$STYLES_DEST"
    say "Copied styles.xml splash theme override"
  fi

  # Splash drawable — Loop mark centered on #111111 at 2732x2732.
  # Copied into every drawable folder (density + orientation) so the
  # Capacitor SplashScreen plugin renders the same image whatever the
  # device config.
  SPLASH_SRC="$OVERLAY_DIR/android/app/src/main/res/drawable/splash.png"
  if [ -f "$SPLASH_SRC" ]; then
    for DRAWABLE in drawable drawable-land-mdpi drawable-land-hdpi \
      drawable-land-xhdpi drawable-land-xxhdpi drawable-land-xxxhdpi \
      drawable-port-mdpi drawable-port-hdpi drawable-port-xhdpi \
      drawable-port-xxhdpi drawable-port-xxxhdpi; do
      DEST="$ANDROID_DIR/app/src/main/res/$DRAWABLE"
      mkdir -p "$DEST"
      cp "$SPLASH_SRC" "$DEST/splash.png"
    done
    say "Copied Loop splash.png into drawable-* folders"
  fi

  # High-resolution splash_icon.png — referenced by
  # windowSplashScreenAnimatedIcon. Living in density-independent
  # drawable/ means Android scales a single 1024x1024 source cleanly
  # instead of upscaling the xxxhdpi mipmap foreground (432px) and
  # producing a blurry mark on 4x-density devices. Kept as a fallback
  # source even though styles.xml points at an AVD by default.
  SPLASH_ICON_SRC="$OVERLAY_DIR/android/app/src/main/res/drawable/splash_icon.png"
  if [ -f "$SPLASH_ICON_SRC" ]; then
    DEST="$ANDROID_DIR/app/src/main/res/drawable"
    mkdir -p "$DEST"
    cp "$SPLASH_ICON_SRC" "$DEST/splash_icon.png"
    say "Copied Loop splash_icon.png"
  fi

  # AVD splash XMLs — vector source + three variant AVDs. styles.xml
  # picks one via windowSplashScreenAnimatedIcon; swapping variants is
  # a one-line edit in styles.xml (which is also overlay-managed).
  DRAWABLE_DEST="$ANDROID_DIR/app/src/main/res/drawable"
  mkdir -p "$DRAWABLE_DEST"
  for XML in splash_icon_vector.xml splash_icon_anim_scale.xml splash_icon_anim_fade.xml splash_icon_anim_slide.xml splash_icon_anim_draw.xml splash_icon_anim_drop.xml splash_icon_anim_wipe.xml splash_icon_anim_bloom.xml; do
    SRC_XML="$OVERLAY_DIR/android/app/src/main/res/drawable/$XML"
    [ -f "$SRC_XML" ] && cp "$SRC_XML" "$DRAWABLE_DEST/"
  done
  say "Copied AVD splash drawables"

  # Patch AndroidManifest.xml only if the attributes are missing, so a
  # hand-edited manifest is left alone.
  if ! grep -q 'android:fullBackupContent' "$ANDROID_MANIFEST"; then
    say "Adding fullBackupContent / dataExtractionRules attributes to AndroidManifest.xml"
    # Insert after android:allowBackup="true"
    # NOTE: sed -i syntax differs between GNU and BSD. Handle both.
    if sed --version >/dev/null 2>&1; then
      # GNU sed
      sed -i 's|android:allowBackup="true"|android:allowBackup="true"\n        android:fullBackupContent="@xml/backup_rules"\n        android:dataExtractionRules="@xml/data_extraction_rules"|' "$ANDROID_MANIFEST"
    else
      # BSD sed (macOS) — -i needs a backup suffix; use '' for in-place
      sed -i '' "s|android:allowBackup=\"true\"|android:allowBackup=\"true\"\\
        android:fullBackupContent=\"@xml/backup_rules\"\\
        android:dataExtractionRules=\"@xml/data_extraction_rules\"|" "$ANDROID_MANIFEST"
    fi
  else
    say "AndroidManifest.xml already has backup-content attributes, skipping"
  fi
else
  say "Android project not present at $ANDROID_DIR — skipping (run \`npx cap add android\` first)"
fi

# ─── iOS: NSFaceIDUsageDescription (audit A-034) ────────────────────────────
if [ -f "$IOS_PLIST" ]; then
  FACE_ID_KEY="NSFaceIDUsageDescription"
  FACE_ID_VALUE="Loop uses Face ID to lock the app so your gift cards stay private, even if your unlocked device is in someone else's hands."

  if /usr/libexec/PlistBuddy -c "Print :$FACE_ID_KEY" "$IOS_PLIST" >/dev/null 2>&1; then
    say "Info.plist already has $FACE_ID_KEY, skipping"
  else
    say "Adding $FACE_ID_KEY to Info.plist"
    /usr/libexec/PlistBuddy -c "Add :$FACE_ID_KEY string $FACE_ID_VALUE" "$IOS_PLIST"
  fi
else
  say "iOS Info.plist not present at $IOS_PLIST — skipping (run \`npx cap add ios\` first)"
fi

say "Done."
