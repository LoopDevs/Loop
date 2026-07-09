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
#   - iOS Release build config + Privacy Manifest wiring (A2-1201 /
#     M-4) — patches project.pbxproj so the Release
#     XCBuildConfiguration blocks reference release.xcconfig (not
#     debug.xcconfig, and not nothing) and PrivacyInfo.xcprivacy ships
#     in the App target's Resources build phase. Both were previously
#     operator-once manual Xcode steps that a clean `cap add ios` (or
#     a bare `cap sync` that skips this script) silently dropped —
#     see M-4 in docs/readiness-backlog-2026-07-03.md.
#
# Idempotent: safe to run repeatedly. Each step checks for the
# required state before writing.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
OVERLAY_DIR="$ROOT_DIR/apps/mobile/native-overlays"
ANDROID_DIR="$ROOT_DIR/apps/mobile/android"
IOS_PLIST="$ROOT_DIR/apps/mobile/ios/App/App/Info.plist"
IOS_PBXPROJ="$ROOT_DIR/apps/mobile/ios/App/App.xcodeproj/project.pbxproj"

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
  # ONE master PNG lives in the overlay (drawable/splash.png); it is
  # fanned out into every drawable folder (density + orientation) of
  # the generated project here so the Capacitor SplashScreen plugin
  # renders the same image whatever the device config. The overlay
  # deliberately does NOT keep per-density copies — they were
  # byte-identical dead weight (comprehensive-audit 2026-06-11, P10).
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
  # `baseConfigurationReference` wiring for the Release config used to
  # be an operator-side step done once after `cap add ios` (M-4 found
  # it unenforced — a clean regeneration silently kept Release builds
  # pointed at nothing / debug.xcconfig); it is now patched
  # automatically below, alongside the PrivacyInfo.xcprivacy
  # Resources-membership wiring (see the pbxproj patch further down).
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
  # Copy-Bundle-Resources membership used to be an operator-once step
  # in Xcode (M-4 found it unenforced — Capacitor's default App/
  # folder reference does NOT auto-pick up a file dropped in after
  # `cap add ios`, so an unwired manifest would ship silently and get
  # rejected at App Store review). It is now patched automatically
  # below: PBXFileReference + PBXBuildFile + PBXResourcesBuildPhase
  # membership, verified by the patch's own post-condition check.
  IOS_PRIVACY_SRC="$OVERLAY_DIR/ios/App/App/PrivacyInfo.xcprivacy"
  IOS_PRIVACY_DEST="$ROOT_DIR/apps/mobile/ios/App/App/PrivacyInfo.xcprivacy"
  if [ -f "$IOS_PRIVACY_SRC" ]; then
    cp_if_changed "$IOS_PRIVACY_SRC" "$IOS_PRIVACY_DEST"
    say "Copied iOS PrivacyInfo.xcprivacy"
  fi

  # ─── iOS: pbxproj wiring for release.xcconfig + PrivacyInfo.xcprivacy ────
  # (M-4) These two steps were "operator-once in Xcode" — see the two
  # comments above. Both are store-critical (a Release build silently
  # keeping CAPACITOR_DEBUG=true, or an App-Store binary rejected for a
  # missing Privacy Manifest) and neither is regenerated by a bare
  # `cap sync`, so leaving them manual was a silent regression waiting
  # to happen. This patches the plist-format project.pbxproj directly:
  # anchored on content that must already exist (the debug.xcconfig
  # PBXFileReference, the Info.plist PBXFileReference, the
  # `/* Release */` XCBuildConfiguration blocks) rather than on
  # hardcoded object ids — Capacitor's ios-template ships the file
  # verbatim on `cap add ios` so ids are stable in practice, but
  # anchoring on names/comments survives an id bump too. Idempotent,
  # and fails loudly (non-zero exit) if an expected anchor is missing
  # rather than silently no-op'ing, and again if post-patch
  # verification doesn't find what it just wrote.
  if [ -f "$IOS_PBXPROJ" ]; then
    if ! command -v python3 >/dev/null 2>&1; then
      say "ERROR: python3 is required to patch project.pbxproj (release.xcconfig +"
      say "       PrivacyInfo.xcprivacy wiring) and was not found on PATH."
      exit 1
    fi
    python3 - "$IOS_PBXPROJ" <<'PY'
import re
import sys

pbxproj_path = sys.argv[1]
with open(pbxproj_path) as f:
    text = f.read()
original_text = text

# Fixed, deterministic 24-hex-char object ids for the objects this
# script creates. Not Xcode-random — chosen once, greppable, and
# checked for collision before first use. Xcode's own generator uses
# effectively-random hex, so a collision with a real object id is not
# a practical concern; the check below is defense-in-depth, not a
# real expectation of ever firing.
REL_XCCONFIG_ID = "F00DBEEF0000000000000001"
PRIVACY_FILEREF_ID = "F00DBEEF0000000000000002"
PRIVACY_BUILDFILE_ID = "F00DBEEF0000000000000003"


def fail(message):
    sys.stderr.write("ERROR: " + message + "\n")
    sys.stderr.write(
        "       pbxproj format drift — update the pbxproj patch in\n"
        "       apps/mobile/scripts/apply-native-overlays.sh to match.\n"
    )
    sys.exit(1)


def assert_fresh_id(object_id):
    if object_id in text:
        fail(
            f"generated object id {object_id} unexpectedly already present in "
            "project.pbxproj (id collision or partial-apply state) — inspect by hand"
        )


changed = []

# ── 1. release.xcconfig PBXFileReference (sibling of debug.xcconfig, A2-1201) ──
if "/* release.xcconfig */ = {isa = PBXFileReference" not in text:
    m = re.search(
        r'^([ \t]*)([0-9A-F]{24}) /\* debug\.xcconfig \*/ = \{isa = PBXFileReference;[^\n]*\};\n',
        text,
        re.MULTILINE,
    )
    if not m:
        fail(
            "debug.xcconfig PBXFileReference not found (A2-1201 anchor) — "
            "cannot place release.xcconfig alongside it"
        )
    assert_fresh_id(REL_XCCONFIG_ID)
    indent = m.group(1)
    new_line = (
        f'{indent}{REL_XCCONFIG_ID} /* release.xcconfig */ = {{isa = PBXFileReference; '
        f"lastKnownFileType = text.xcconfig; name = release.xcconfig; "
        f"path = ../release.xcconfig; sourceTree = SOURCE_ROOT; }};\n"
    )
    text = text[: m.end()] + new_line + text[m.end() :]
    changed.append("release.xcconfig PBXFileReference")

# ── 2. release.xcconfig group membership (sibling of debug.xcconfig entry) ──
if f"{REL_XCCONFIG_ID} /* release.xcconfig */," not in text:
    m = re.search(r'^([ \t]*)([0-9A-F]{24}) /\* debug\.xcconfig \*/,\n', text, re.MULTILINE)
    if not m:
        fail("debug.xcconfig is not a child of any PBXGroup — cannot place release.xcconfig alongside it")
    indent = m.group(1)
    new_line = f'{indent}{REL_XCCONFIG_ID} /* release.xcconfig */,\n'
    text = text[: m.end()] + new_line + text[m.end() :]
    changed.append("release.xcconfig PBXGroup membership")

# ── 3. baseConfigurationReference on every Release XCBuildConfiguration ──
release_config_pattern = re.compile(
    r'(?P<head>[ \t]*[0-9A-F]{24} /\* Release \*/ = \{\n(?P<indent>[ \t]*)isa = XCBuildConfiguration;\n)'
    r'(?P<maybe_baseconfig>[ \t]*baseConfigurationReference[^\n]*\n)?'
)
release_matches = list(release_config_pattern.finditer(text))
if not release_matches:
    fail("no Release XCBuildConfiguration blocks found — Xcode project template drifted")

inserted_any = False
for m in reversed(release_matches):
    if m.group("maybe_baseconfig"):
        continue  # already wired (idempotent re-run)
    indent = m.group("indent")
    insert_at = m.end("head")
    new_line = f'{indent}baseConfigurationReference = {REL_XCCONFIG_ID} /* release.xcconfig */;\n'
    text = text[:insert_at] + new_line + text[insert_at:]
    inserted_any = True
if inserted_any:
    changed.append("Release baseConfigurationReference")

# ── 4. PrivacyInfo.xcprivacy PBXFileReference (sibling of Info.plist) ──
if "/* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference" not in text:
    m = re.search(
        r'^([ \t]*)([0-9A-F]{24}) /\* Info\.plist \*/ = \{isa = PBXFileReference;[^\n]*\};\n',
        text,
        re.MULTILINE,
    )
    if not m:
        fail("Info.plist PBXFileReference not found — cannot place PrivacyInfo.xcprivacy alongside it")
    assert_fresh_id(PRIVACY_FILEREF_ID)
    indent = m.group(1)
    new_line = (
        f'{indent}{PRIVACY_FILEREF_ID} /* PrivacyInfo.xcprivacy */ = {{isa = PBXFileReference; '
        f'lastKnownFileType = text.plist.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; }};\n'
    )
    text = text[: m.end()] + new_line + text[m.end() :]
    changed.append("PrivacyInfo.xcprivacy PBXFileReference")

# ── 5. PrivacyInfo.xcprivacy group membership (sibling of Info.plist entry) ──
if f"{PRIVACY_FILEREF_ID} /* PrivacyInfo.xcprivacy */," not in text:
    m = re.search(r'^([ \t]*)([0-9A-F]{24}) /\* Info\.plist \*/,\n', text, re.MULTILINE)
    if not m:
        fail("Info.plist is not a child of any PBXGroup — cannot place PrivacyInfo.xcprivacy alongside it")
    indent = m.group(1)
    new_line = f'{indent}{PRIVACY_FILEREF_ID} /* PrivacyInfo.xcprivacy */,\n'
    text = text[: m.end()] + new_line + text[m.end() :]
    changed.append("PrivacyInfo.xcprivacy PBXGroup membership")

# ── 6. PrivacyInfo.xcprivacy PBXBuildFile ──
if "/* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile" not in text:
    marker = "/* End PBXBuildFile section */\n"
    if marker not in text:
        fail("PBXBuildFile section end marker not found")
    assert_fresh_id(PRIVACY_BUILDFILE_ID)
    new_line = (
        f'\t\t{PRIVACY_BUILDFILE_ID} /* PrivacyInfo.xcprivacy in Resources */ = {{isa = PBXBuildFile; '
        f'fileRef = {PRIVACY_FILEREF_ID} /* PrivacyInfo.xcprivacy */; }};\n'
    )
    text = text.replace(marker, new_line + marker, 1)
    changed.append("PrivacyInfo.xcprivacy PBXBuildFile")

# ── 7. PrivacyInfo.xcprivacy membership in every PBXResourcesBuildPhase ──
begin_marker = "/* Begin PBXResourcesBuildPhase section */\n"
end_marker = "/* End PBXResourcesBuildPhase section */\n"
begin_idx = text.find(begin_marker)
end_idx = text.find(end_marker)
if begin_idx == -1 or end_idx == -1 or end_idx < begin_idx:
    fail("PBXResourcesBuildPhase section markers not found")
section = text[begin_idx:end_idx]
files_array_pattern = re.compile(r'([ \t]*)files = \(\n(.*?\n)?([ \t]*)\);\n', re.DOTALL)
section_matches = list(files_array_pattern.finditer(section))
if not section_matches:
    fail("no 'files = (...)' array found inside PBXResourcesBuildPhase section")
new_section = section
offset = 0
resources_changed = False
for m in section_matches:
    body = m.group(2) or ""
    if f"{PRIVACY_BUILDFILE_ID} /* PrivacyInfo.xcprivacy in Resources */," in body:
        continue
    item_indent = m.group(3) + "\t"
    insert_at = m.start(3) + offset
    new_line = f'{item_indent}{PRIVACY_BUILDFILE_ID} /* PrivacyInfo.xcprivacy in Resources */,\n'
    new_section = new_section[:insert_at] + new_line + new_section[insert_at:]
    offset += len(new_line)
    resources_changed = True
if resources_changed:
    text = text[:begin_idx] + new_section + text[end_idx:]
    changed.append("PrivacyInfo.xcprivacy PBXResourcesBuildPhase membership")

# ── Verification — fail loud if a patch step silently didn't take ──
errors = []

if "/* release.xcconfig */ = {isa = PBXFileReference" not in text:
    errors.append("release.xcconfig PBXFileReference missing after patch")

release_blocks = list(release_config_pattern.finditer(text))
if not release_blocks:
    errors.append("no Release XCBuildConfiguration blocks found after patch")
else:
    for m in release_blocks:
        baseconfig = m.group("maybe_baseconfig") or ""
        if "release.xcconfig" not in baseconfig:
            errors.append(
                "a Release XCBuildConfiguration block is missing baseConfigurationReference -> release.xcconfig"
            )

debug_config_pattern = re.compile(
    r'[ \t]*[0-9A-F]{24} /\* Debug \*/ = \{\n[ \t]*isa = XCBuildConfiguration;\n'
    r'([ \t]*baseConfigurationReference[^\n]*\n)?'
)
debug_blocks = list(debug_config_pattern.finditer(text))
if not debug_blocks:
    errors.append("no Debug XCBuildConfiguration blocks found after patch (unexpected)")
else:
    for m in debug_blocks:
        baseconfig = m.group(1) or ""
        if "debug.xcconfig" not in baseconfig:
            errors.append("a Debug XCBuildConfiguration block lost its debug.xcconfig baseConfigurationReference")

if "/* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference" not in text:
    errors.append("PrivacyInfo.xcprivacy PBXFileReference missing after patch")

if "/* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile" not in text:
    errors.append("PrivacyInfo.xcprivacy PBXBuildFile missing after patch")

begin_idx = text.find(begin_marker)
end_idx = text.find(end_marker)
section = text[begin_idx:end_idx] if begin_idx != -1 and end_idx != -1 else ""
if f"{PRIVACY_BUILDFILE_ID} /* PrivacyInfo.xcprivacy in Resources */," not in section:
    errors.append("PrivacyInfo.xcprivacy is not a member of any PBXResourcesBuildPhase after patch")

if errors:
    sys.stderr.write("ERROR: project.pbxproj verification failed after patching:\n")
    for e in errors:
        sys.stderr.write(f"  - {e}\n")
    sys.stderr.write(
        "       Inspect apps/mobile/ios/App/App.xcodeproj/project.pbxproj by hand "
        "and/or update the patch in apps/mobile/scripts/apply-native-overlays.sh.\n"
    )
    sys.exit(1)

if text != original_text:
    with open(pbxproj_path, "w") as f:
        f.write(text)
    print("[apply-native-overlays] Patched project.pbxproj: " + ", ".join(changed))
else:
    print(
        "[apply-native-overlays] project.pbxproj already fully patched "
        "(release.xcconfig + PrivacyInfo.xcprivacy wiring), skipping write"
    )
PY
  else
    say "iOS project.pbxproj not present at $IOS_PBXPROJ — skipping (run \`npx cap add ios\` first)"
  fi
else
  say "iOS Info.plist not present at $IOS_PLIST — skipping (run \`npx cap add ios\` first)"
fi

say "Done."
