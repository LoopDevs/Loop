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

  say "Copying backup rules XML into $ANDROID_XML_DIR"
  mkdir -p "$ANDROID_XML_DIR"
  cp "$OVERLAY_DIR/android/app/src/main/res/xml/backup_rules.xml" "$ANDROID_XML_DIR/"
  cp "$OVERLAY_DIR/android/app/src/main/res/xml/data_extraction_rules.xml" "$ANDROID_XML_DIR/"

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
