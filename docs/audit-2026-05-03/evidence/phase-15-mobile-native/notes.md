# Phase 15 - Mobile Shell and Native Bridges

Status: in-progress

Required evidence:

- Capacitor config and package parity review
- native overlay review
- native wrapper inventory
- storage/biometrics/app-lock/share/clipboard/lifecycle review
- permissions and backup posture review

Findings:

- A4-027: Generated Android FileProvider grants broad cache/external storage access despite scoped overlay source.

Evidence captured:

- `artifacts/android-fileprovider-overlay-drift.txt` compares the current generated Android `file_paths.xml`, the versioned scoped overlay, the overlay script copy step, and the native share-image write path.

Observations:

- Capacitor package parity between `apps/web/package.json` and `apps/mobile/package.json` was spot-checked for native plugins used by `apps/web/app/native/**`; mobile declares the native runtime plugins.
- Android backup and data-extraction overlay source excludes `CapacitorStorage.xml`; the current generated manifest includes `fullBackupContent` and `dataExtractionRules`.
- iOS `Info.plist` currently includes `NSFaceIDUsageDescription` and `NSLocationWhenInUseUsageDescription`.
- Native bridge wrappers are concentrated under `apps/web/app/native/**`, with web components/routes importing those wrappers rather than Capacitor plugins directly.
