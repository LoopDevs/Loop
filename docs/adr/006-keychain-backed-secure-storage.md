# ADR-006: Keychain-backed secure storage for refresh tokens

- **Status**: Accepted
- **Date**: 2026-04-18
- **Deciders**: Engineering
- **Supersedes**: —
- **Superseded by**: —
- **Closes**: Audit A-024

## Context

`docs/standards.md` stated: **"Refresh tokens on mobile: Capacitor secure
storage only."** The actual implementation in
`apps/web/app/native/secure-storage.ts` used `@capacitor/preferences`,
which is backed by `SharedPreferences` on Android and
`NSUserDefaults` on iOS — neither of which is encrypted or keychain-
backed by default.

That means:

- **iOS**: `NSUserDefaults` is readable by anyone with filesystem
  access to an unlocked device backup or a jailbroken device.
- **Android**: `SharedPreferences` is world-readable inside the app's
  sandbox, and on rooted devices readable by any process.
- Without `fullBackupContent` / `dataExtractionRules` (audit A-033),
  both are also swept into cloud backup and device transfer channels.

The refresh token is long-lived and lets the holder mint fresh access
tokens — compromise of the stored value is equivalent to session
takeover.

## Decision

Add `@aparajita/capacitor-secure-storage` and route
`storeRefreshToken` / `getRefreshToken` / `storeEmail` / `getEmail`
through it on native. It's from the same author as the biometric
plugin we already ship and targets the same Capacitor 8 major.

- **iOS**: stores entries in the app's Keychain access group with
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Survives app
  relaunches; does not survive restore-to-a-different-device (which
  is the correct behaviour for a refresh token).
- **Android**: encrypts the value with a per-install AES-256 key held
  in the Android Keystore, then writes the ciphertext to
  `EncryptedSharedPreferences`. An attacker with a filesystem copy
  cannot decrypt without the device's hardware-backed key.

Web continues to use `sessionStorage` (unchanged). The audit scope was
mobile-specific.

### Migration for existing native installs

Users on a prior build will have a refresh token sitting in
Preferences. On first `getRefreshToken()` after the upgrade, we:

1. Read from SecureStorage.
2. If absent, read from Preferences. If present: write the value to
   SecureStorage, then delete it from Preferences. Return it.
3. If also absent in Preferences, return null (user will need to
   log in).

This happens once per install; subsequent reads skip the fallback.

## Consequences

- **New runtime dependency**: `@aparajita/capacitor-secure-storage@8.x`
  (MIT, same author as the biometric-auth plugin already in the tree).
  Adds two small native modules at build time; no measurable bundle
  impact on the web build because the plugin is dynamically imported
  and Capacitor's bundler tree-shakes it for web.
- **Standards alignment**: the written repo rule now matches the code.
- **Backup safety stacks with A-033**: even with `dataExtractionRules`
  in place, the Keychain / EncryptedSharedPreferences entries are
  themselves excluded from backup by default — so the token never
  leaves the device's hardware-backed keystore in any channel.
- **Test shape**: vitest tests mock the `SecureStorage` API alongside
  the existing `Preferences` mock. The added cases exercise the
  Preferences → SecureStorage one-shot migration and the post-migration
  read path.

## Related

- Audit A-024 — this ADR closes the finding.
- Audit A-033 — Android backup exclusions. Complementary; this ADR
  removes the sensitive value from the backup-able channel entirely.
- `apps/web/app/native/secure-storage.ts` — module that now routes
  through the new plugin.
- `@aparajita/capacitor-biometric-auth` — sibling plugin already in
  dependencies, same maintainer.
