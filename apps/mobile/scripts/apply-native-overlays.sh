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
#   - Android + iOS launcher icons + splash — Loop wordmark on
#     near-black. `cap add ios` / `cap add android` reset both the
#     iOS appiconset and the Android mipmap / drawable resources back
#     to Capacitor placeholders; the overlay re-applies the branded
#     assets on every sync.
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

# A2-406: copy only when the destination differs from the source.
# Naked `cp src dest` rewrites the file (and bumps mtime) every run,
# which churns Xcode's incremental build cache and makes
# `git status` on the gitignored native trees noisy. `cmp -s`
# returns 0 only when the bytes match exactly; on first run (dest
# absent) it returns non-zero and we `cp`.
cp_if_changed() {
  local src=$1
  local dest=$2
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    return 0
  fi
  cp "$src" "$dest"
}

# ─── Android: backup rules (audit A-033) ────────────────────────────────────
if [ -d "$ANDROID_DIR" ]; then
  ANDROID_XML_DIR="$ANDROID_DIR/app/src/main/res/xml"
  ANDROID_MANIFEST="$ANDROID_DIR/app/src/main/AndroidManifest.xml"
  ANDROID_JAVA_DIR="$ANDROID_DIR/app/src/main/java/io/loopfinance/app"

  say "Copying backup rules XML into $ANDROID_XML_DIR"
  mkdir -p "$ANDROID_XML_DIR"
  cp_if_changed "$OVERLAY_DIR/android/app/src/main/res/xml/backup_rules.xml" "$ANDROID_XML_DIR/backup_rules.xml"
  cp_if_changed "$OVERLAY_DIR/android/app/src/main/res/xml/data_extraction_rules.xml" "$ANDROID_XML_DIR/data_extraction_rules.xml"
  # A2-1213: tightened FileProvider scope. Capacitor's default
  # file_paths.xml grants whole-root access (`path="."`) to both
  # external-storage and the cache directory. The overlay scopes the
  # provider down to `<cache>/share/` only — the single dir share-image
  # PNGs land in (apps/web/app/native/share.ts).
  cp_if_changed "$OVERLAY_DIR/android/app/src/main/res/xml/file_paths.xml" "$ANDROID_XML_DIR/file_paths.xml"
  # A4-079: production network-security policy. Capacitor's default
  # ships cleartext-localhost / 10.0.2.2 exemptions intended for
  # dev workflow but inherited by production. The overlay drops the
  # cleartext exemption entirely so the OS default (HTTPS-only on
  # API 28+) applies. Devs who need cleartext-localhost should use
  # a `src/debug/res/xml/network_security_config.xml` Gradle build
  # variant locally — that variant overrides `src/main` only for
  # debug builds, leaving release / store builds strict.
  cp_if_changed "$OVERLAY_DIR/android/app/src/main/res/xml/network_security_config.xml" "$ANDROID_XML_DIR/network_security_config.xml"

  # MainActivity override — disables WebView overscroll so the fixed
  # tab bar isn't dragged by the visual viewport during rubber-band.
  # `cap add android` regenerates the default no-op MainActivity, so
  # this overlay must be reapplied after every cap sync / cap add.
  say "Copying MainActivity override into $ANDROID_JAVA_DIR"
  mkdir -p "$ANDROID_JAVA_DIR"
  cp_if_changed "$OVERLAY_DIR/android/app/src/main/java/io/loopfinance/app/MainActivity.java" "$ANDROID_JAVA_DIR/MainActivity.java"

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
      cp_if_changed "$SRC_DIR/ic_launcher.png" "$DEST_DIR/ic_launcher.png"
      cp_if_changed "$SRC_DIR/ic_launcher_round.png" "$DEST_DIR/ic_launcher_round.png"
      cp_if_changed "$SRC_DIR/ic_launcher_foreground.png" "$DEST_DIR/ic_launcher_foreground.png"
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
    cp_if_changed "$VALUES_SRC" "$VALUES_DEST"
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
    cp_if_changed "$STYLES_SRC" "$STYLES_DEST"
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
      cp_if_changed "$SPLASH_SRC" "$DEST/splash.png"
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
    cp_if_changed "$SPLASH_ICON_SRC" "$DEST/splash_icon.png"
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

  # Release-signing config (Phase-1 mobile submission). signing.gradle
  # injects `signingConfigs.release` into the Capacitor-generated
  # build.gradle, driven by an out-of-tree keystore.properties. The
  # keystore.properties.example template lives next to it so the
  # operator can copy + fill in. Both files are kept under
  # native-overlays/ and re-applied on every cap sync.
  SIGNING_GRADLE_SRC="$OVERLAY_DIR/android/app/signing.gradle"
  SIGNING_GRADLE_DEST="$ANDROID_DIR/app/signing.gradle"
  if [ -f "$SIGNING_GRADLE_SRC" ]; then
    cp_if_changed "$SIGNING_GRADLE_SRC" "$SIGNING_GRADLE_DEST"
    say "Copied signing.gradle"
  fi

  KEYSTORE_EXAMPLE_SRC="$OVERLAY_DIR/android/keystore.properties.example"
  KEYSTORE_EXAMPLE_DEST="$ANDROID_DIR/keystore.properties.example"
  if [ -f "$KEYSTORE_EXAMPLE_SRC" ]; then
    cp_if_changed "$KEYSTORE_EXAMPLE_SRC" "$KEYSTORE_EXAMPLE_DEST"
    say "Copied keystore.properties.example"
  fi

  # Wire signing.gradle into build.gradle. Idempotent — only inserts
  # `apply from: 'signing.gradle'` if it is not already there. Anchored
  # on the existing `apply from: 'capacitor.build.gradle'` line that
  # `cap add android` always emits; if a future Capacitor template drops
  # that anchor we fail loudly so the next sync shouts instead of
  # silently producing unsigned release builds.
  ANDROID_BUILD_GRADLE="$ANDROID_DIR/app/build.gradle"
  if [ -f "$ANDROID_BUILD_GRADLE" ] && [ -f "$SIGNING_GRADLE_DEST" ]; then
    if ! grep -q "apply from: 'signing.gradle'" "$ANDROID_BUILD_GRADLE"; then
      if ! grep -q "apply from: 'capacitor.build.gradle'" "$ANDROID_BUILD_GRADLE"; then
        say "ERROR: app/build.gradle is missing the 'apply from: capacitor.build.gradle' anchor."
        say "       Update apply-native-overlays.sh to match the new Capacitor template."
        exit 1
      fi
      say "Adding 'apply from: signing.gradle' to app/build.gradle"
      if sed --version >/dev/null 2>&1; then
        sed -i "s|apply from: 'capacitor.build.gradle'|apply from: 'capacitor.build.gradle'\napply from: 'signing.gradle'|" "$ANDROID_BUILD_GRADLE"
      else
        sed -i '' "s|apply from: 'capacitor.build.gradle'|apply from: 'capacitor.build.gradle'\\
apply from: 'signing.gradle'|" "$ANDROID_BUILD_GRADLE"
      fi
      if ! grep -q "apply from: 'signing.gradle'" "$ANDROID_BUILD_GRADLE"; then
        say "ERROR: sed completed but 'apply from: signing.gradle' is still missing."
        say "       Inspect app/build.gradle by hand."
        exit 1
      fi
    else
      say "app/build.gradle already wires signing.gradle, skipping"
    fi
  fi

  # Location permissions — required for the "locate me" control on
  # the map. `navigator.geolocation` inside the Capacitor WebView
  # still goes through the Android runtime permission gate, and
  # without these uses-permission entries the first getCurrentPosition
  # call silently fails with PERMISSION_DENIED. Kept as separate
  # lines so the regex guard stays simple + idempotent.
  for PERM in ACCESS_COARSE_LOCATION ACCESS_FINE_LOCATION; do
    if ! grep -q "android.permission.$PERM" "$ANDROID_MANIFEST"; then
      say "Adding $PERM uses-permission to AndroidManifest.xml"
      if sed --version >/dev/null 2>&1; then
        sed -i "s|<uses-permission android:name=\"android.permission.INTERNET\" />|<uses-permission android:name=\"android.permission.INTERNET\" />\n    <uses-permission android:name=\"android.permission.$PERM\" />|" "$ANDROID_MANIFEST"
      else
        sed -i '' "s|<uses-permission android:name=\"android.permission.INTERNET\" />|<uses-permission android:name=\"android.permission.INTERNET\" />\\
    <uses-permission android:name=\"android.permission.$PERM\" />|" "$ANDROID_MANIFEST"
      fi
    fi
  done

  # Patch AndroidManifest.xml only if the attributes are missing, so a
  # hand-edited manifest is left alone.
  if ! grep -q 'android:fullBackupContent' "$ANDROID_MANIFEST"; then
    # A2-1209: fail loudly if the sed anchor is missing. The patch is
    # anchored to `android:allowBackup="true"`. If a future Capacitor
    # template flips that to `false` or removes the attribute, the
    # bare `sed` would silently no-op and leave the backup-rules
    # attributes unset — A-033's protection vanishes without a single
    # CI signal. Pre-flight the anchor and bail with a pointer at the
    # overlay script so the next run shouts instead of regressing.
    if ! grep -q 'android:allowBackup="true"' "$ANDROID_MANIFEST"; then
      say "ERROR: AndroidManifest.xml is missing the 'android:allowBackup=\"true\"' anchor."
      say "       The backup-content overlay (A-033) needs that attribute to splice in"
      say "       fullBackupContent / dataExtractionRules. Update apply-native-overlays.sh"
      say "       to match whatever the new Capacitor template uses, or hand-add the"
      say "       attributes to AndroidManifest.xml directly."
      exit 1
    fi
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
    # A2-1209: post-condition check. The sed should have inserted the
    # attributes. If `grep` doesn't see them now, the regex didn't
    # match for a different reason (escaped quotes, indentation, etc.)
    # — fail loudly rather than pretend success.
    if ! grep -q 'android:fullBackupContent' "$ANDROID_MANIFEST"; then
      say "ERROR: sed completed but android:fullBackupContent is still missing from"
      say "       AndroidManifest.xml. Inspect the file by hand and adjust the"
      say "       overlay script. A-033 protection is NOT in place."
      exit 1
    fi
  else
    say "AndroidManifest.xml already has backup-content attributes, skipping"
  fi
else
  say "Android project not present at $ANDROID_DIR — skipping (run \`npx cap add android\` first)"
fi

# ─── iOS: usage-description copy reconciliation (audit A-034 / A2-405) ─────
#
# A2-405: the script previously only Add'd a usage-description key when
# absent — if a developer (or a manual Xcode UI edit) left a stale or
# drifted copy in the live Info.plist, this overlay would never
# reconcile it. Fixed by Set-or-Add: read the current value, compare
# with the canonical, and rewrite only if they differ. Idempotent —
# match → no plutil write at all, drift / missing → single
# `plutil -replace`. We use `plutil` instead of `PlistBuddy -c "Set …"`
# because PlistBuddy's `-c` string is parsed with single-quote pairing,
# so an apostrophe in the canonical value (e.g. "someone else's") aborts
# the Set with `Parse Error: Unclosed Quotes`. `plutil -replace` takes
# the value as a normal argv and creates the key if missing, so the
# same call covers both Add and Set without escape gymnastics.
plist_set_or_add_string() {
  local key=$1
  local desired=$2
  local current
  if current=$(/usr/libexec/PlistBuddy -c "Print :$key" "$IOS_PLIST" 2>/dev/null); then
    if [ "$current" = "$desired" ]; then
      say "Info.plist :$key already matches — skipping"
      return 0
    fi
    say "Info.plist :$key drifted — reconciling to canonical copy"
  else
    say "Adding :$key to Info.plist"
  fi
  plutil -replace "$key" -string "$desired" "$IOS_PLIST"
}

if [ -f "$IOS_PLIST" ]; then
  plist_set_or_add_string \
    "NSFaceIDUsageDescription" \
    "Loop uses Face ID to lock the app so your gift cards stay private, even if your unlocked device is in someone else's hands."

  # Location when-in-use — required for `navigator.geolocation` in
  # the WKWebView to resolve on iOS 14+ and for App Store review.
  # When-in-use only (no always / background) — we only fetch a
  # one-shot position when the user taps the map's locate button.
  plist_set_or_add_string \
    "NSLocationWhenInUseUsageDescription" \
    "Loop uses your location to show nearby merchants on the map."

  # A2-1201: drop a release.xcconfig next to debug.xcconfig so the
  # Release configuration has an explicit `CAPACITOR_DEBUG = false`
  # rather than falling through to the framework default. The .pbxproj
  # reference (baseConfigurationReference for the Release config) is
  # an operator-side step done once after `cap add ios`; this overlay
  # ensures the file itself is always present and current so that
  # reference resolves.
  IOS_RELEASE_XCCONFIG_SRC="$OVERLAY_DIR/ios/release.xcconfig"
  IOS_RELEASE_XCCONFIG_DEST="$ROOT_DIR/apps/mobile/ios/release.xcconfig"
  if [ -f "$IOS_RELEASE_XCCONFIG_SRC" ]; then
    cp_if_changed "$IOS_RELEASE_XCCONFIG_SRC" "$IOS_RELEASE_XCCONFIG_DEST"
    say "Copied iOS release.xcconfig (A2-1201)"
  fi

  # App Icon + Splash — Loop wordmark on near-black, matching Android.
  # `cap add ios` regenerates the appiconset / Splash.imageset back to
  # the Capacitor blue-X placeholder; the overlay re-applies the
  # branded assets on every sync. App Store rejects icons with an
  # alpha channel, so the source PNGs are flat sRGB (verified via
  # `magick identify` — alpha=Undefined). If a future rev introduces
  # an alpha channel, flatten with `magick src -background black
  # -alpha remove dest` before checking it in.
  IOS_APPICON_SRC="$OVERLAY_DIR/ios/App/App/Assets.xcassets/AppIcon.appiconset"
  IOS_APPICON_DEST="$ROOT_DIR/apps/mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset"
  if [ -d "$IOS_APPICON_SRC" ]; then
    mkdir -p "$IOS_APPICON_DEST"
    cp_if_changed "$IOS_APPICON_SRC/AppIcon-512@2x.png" "$IOS_APPICON_DEST/AppIcon-512@2x.png"
    cp_if_changed "$IOS_APPICON_SRC/Contents.json" "$IOS_APPICON_DEST/Contents.json"
    say "Copied iOS AppIcon overlay"
  fi

  IOS_SPLASH_SRC="$OVERLAY_DIR/ios/App/App/Assets.xcassets/Splash.imageset"
  IOS_SPLASH_DEST="$ROOT_DIR/apps/mobile/ios/App/App/Assets.xcassets/Splash.imageset"
  if [ -d "$IOS_SPLASH_SRC" ]; then
    mkdir -p "$IOS_SPLASH_DEST"
    cp_if_changed "$IOS_SPLASH_SRC/splash-2732x2732.png" "$IOS_SPLASH_DEST/splash-2732x2732.png"
    cp_if_changed "$IOS_SPLASH_SRC/splash-2732x2732-1.png" "$IOS_SPLASH_DEST/splash-2732x2732-1.png"
    cp_if_changed "$IOS_SPLASH_SRC/splash-2732x2732-2.png" "$IOS_SPLASH_DEST/splash-2732x2732-2.png"
    cp_if_changed "$IOS_SPLASH_SRC/Contents.json" "$IOS_SPLASH_DEST/Contents.json"
    say "Copied iOS Splash overlay"
  fi

  # Privacy Manifest (Apple-required since 2024-05). Declares Loop's
  # data collection types, tracking flags, and required-reason API
  # categories. Capacitor + Sentry + Stellar pods ship their own
  # PrivacyInfo.xcprivacy entries; Apple aggregates at archive time.
  # Operator-once after `cap add ios`: Xcode → App target → Build
  # Phases → Copy Bundle Resources → ensure PrivacyInfo.xcprivacy is
  # listed. Capacitor's default folder reference for the App/ folder
  # usually picks it up automatically, but verify before the first
  # archive — the App-Store binary check rejects on missing manifest.
  IOS_PRIVACY_SRC="$OVERLAY_DIR/ios/App/App/PrivacyInfo.xcprivacy"
  IOS_PRIVACY_DEST="$ROOT_DIR/apps/mobile/ios/App/App/PrivacyInfo.xcprivacy"
  if [ -f "$IOS_PRIVACY_SRC" ]; then
    cp_if_changed "$IOS_PRIVACY_SRC" "$IOS_PRIVACY_DEST"
    say "Copied iOS PrivacyInfo.xcprivacy"
  fi
else
  say "iOS Info.plist not present at $IOS_PLIST — skipping (run \`npx cap add ios\` first)"
fi

say "Done."
