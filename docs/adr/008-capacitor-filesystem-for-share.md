# ADR 008: Add `@capacitor/filesystem` to enable file-rich native share

Status: Accepted
Date: 2026-04-21

## Context

Completed gift-card orders render a `PurchaseComplete` view with the
merchant name, the redeemable code, the PIN, and a barcode. When a
user taps "Share", we want the resulting share sheet to contain
**both** a composited gift-card image (with the barcode) and the
text payload (code + PIN), matching the UX users expect from other
fintech / rewards apps.

The first pass relied on the browser Web Share API:

```ts
await navigator.share({ title, text, files: [file] });
```

This works on desktop browsers + iOS Safari + modern Android Chrome,
but **`navigator.share` is not exposed inside the Capacitor Android
WebView** — diagnostic logging confirmed the value is `undefined`.
The code silently fell back to the `@capacitor/share` plugin's
text-only call, so the user saw code+PIN in the share sheet but no
image.

`@capacitor/share`'s `files` field is the supported native path. It
expects an array of filesystem URIs (`file://` or
`content://` on Android, `file://` on iOS). Data URIs, blob URLs,
and in-memory `File` objects are rejected by the underlying
`Intent.ACTION_SEND` / `UIActivityViewController`.

## Decision

Add `@capacitor/filesystem` as a runtime dependency in both
`apps/web` and `apps/mobile` (same pattern as every other Capacitor
plugin we ship, per PR #151). The plugin provides a `writeFile` +
`getUri` pair that we wrap in a small helper to materialise a PNG
from a data URL into `Directory.Cache` and hand the resulting URI
to `Share.share({ files: [uri] })`.

`Directory.Cache` is the right home for these files: the OS
manages eviction when space is tight, we never back them up
(consistent with ADR 006 / audit A-033), and nothing here is
sensitive beyond the order itself (which the user is actively
sharing).

## Alternatives considered

1. **Ship text-only share forever.** Rejected — the barcode image
   is the single most useful piece of content a user shares with a
   recipient who's going to redeem the card, and the current UX
   reads as a half-built feature.

2. **OpenGraph unfurl via a server share-link.** Rejected for
   gift-card sharing specifically because the code + PIN are
   cashable; a public link that renders them in an OG image leaks
   value. The pattern fits a future referral / invite flow but not
   this one.

3. **Use `Capacitor.convertFileSrc` on a blob URL.** Doesn't help —
   `convertFileSrc` rewrites `file://` paths into webview-internal
   URLs, it can't turn a blob into a URI the share intent will
   accept.

4. **`data://` URL as the `files` entry.** Not supported by the
   Capacitor Share plugin's Android or iOS backend.

5. **Hand-roll an Android FileProvider.** Re-invents exactly what
   `@capacitor/filesystem` already ships, and drags us into
   maintaining native Java / Kotlin overlays.

## Consequences

- One new runtime dep on both web + mobile manifests; declared at
  the same version to keep `cap sync` hoisting happy (PR #151).
- `apps/web/app/native/share.ts` grows a `writeTempShareImage`
  helper (~30 lines) and a native-vs-web branch in `nativeShare`.
- Cache files are auto-evicted by the OS and the app doesn't keep
  its own cleanup bookkeeping. If we ever ship a "saved cards"
  feature we'd move to `Directory.Data` and manage retention.
- Web share path stays on `navigator.share({ files })` — unchanged.

## References

- Diagnostic log confirming `navigator.share` is undefined in
  Capacitor Android WebView — session transcript 2026-04-21.
- `@capacitor/share` docs, `files` field notes:
  <https://capacitorjs.com/docs/apis/share>
- PR #151 — "declare Capacitor plugins in both workspaces at the
  same version" convention.
