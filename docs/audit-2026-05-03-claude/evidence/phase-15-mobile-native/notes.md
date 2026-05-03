# Phase 15 - Mobile Shell and Native Bridges

Status: complete
Owner: lead (Claude)

## Files reviewed

- apps/mobile/{capacitor.config.ts,package.json,README.md}
- apps/mobile/scripts/apply-native-overlays.sh
- apps/mobile/native-overlays/\* (Android backup-rules, iOS Info.plist additions)
- apps/mobile/ios/App/App/{Info.plist,App.entitlements}
- apps/mobile/android/app/src/main/AndroidManifest.xml
- apps/web/app/native/\* (15 wrappers)

## Findings filed

- A4-055 Medium — purchase-storage writes Stellar memo + address + merchant info to plaintext preferences
- A4-056 Medium — loadPendingOrder silently destroys legacy records without expiresAt
- A4-059 Low — share temp PNGs never cleaned

## No-finding-but-reviewed

- Refresh tokens correctly Keychain-bound via @aparajita/capacitor-secure-storage.
- Android backup rules exclude CapacitorStorage.xml + secure-storage.
- NSFaceIDUsageDescription present in Info.plist.
- Capacitor plugin parity declared in both apps/web/package.json and apps/mobile/package.json.
