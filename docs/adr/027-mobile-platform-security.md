# ADR-027 — Mobile platform security: SSL pinning, App Attest, Play Integrity, jailbreak / root, binary tamper

**Status:** Accepted (Phase-1 deferral)
**Date:** 2026-04-26
**Audit ref:** A2-1204
**Supersedes:** none
**Superseded by:** none

## Context

The Loop mobile binary is a Capacitor v8 shell (apps/mobile) that loads a static React Router build. It carries the cashback flow end-to-end: bearer-token auth, **external-wallet linking** (the user enters their existing Stellar pubkey; the app does NOT generate or hold a Stellar private key — A4-096), gift-card code reveal, withdrawal initiation. The audit (A2-1204) flagged that none of the platform-native binary-integrity controls are wired:

- **SSL / certificate pinning** — TLS to `api.loopfinance.io` uses the system trust store, not a pinned leaf or pinned-CA. A device with an attacker-installed root CA (corp MDM, malware) can MITM API traffic.
- **App Attest (iOS) / Play Integrity (Android)** — no per-request attestation that the calling client is a genuine, unmodified Loop binary running on a non-rooted device. The backend can't distinguish a real client from a curl script with stolen tokens.
- **Jailbreak / root detection** — no runtime check; a jailbroken iOS or rooted Android phone runs the app with full filesystem + keychain access for any other process.
- **Binary tamper detection** — no runtime self-check that the JS bundle (`apps/web/build/...`) hasn't been swapped (e.g. via a modded IPA / APK). Capacitor loads whatever `index.html` is on disk.

Each of the four is a separate body of work with its own native-plugin spike, App Store / Play Store review implications, and operator runbook.

## Decision

**Phase 1: defer all four. Phase 2: revisit after first launch metrics.**

Rationale per control:

| Control                         | Phase-1 mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | What we lose by deferring                                                                                                                                                                     | Phase-2 trigger                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **SSL / cert pinning**          | TLS via system trust + Fly's edge cert; refresh-token in Keychain / EncryptedSharedPreferences (ADR-006) so a MITM that captures bearer tokens can't replay across sessions; admin endpoints already require step-up (A2-1609 tracking).                                                                                                                                                                                                                                                             | Targeted MITM of a single user via injected root CA can read API responses + replay an intercepted access token (≤15 min).                                                                    | First confirmed MITM event in production telemetry, OR enterprise customer requirement.          |
| **App Attest / Play Integrity** | Backend can't distinguish genuine client from scripted reuse of stolen tokens.                                                                                                                                                                                                                                                                                                                                                                                                                       | Bot-driven scraping or token replay from a non-mobile context. Phase-1 traffic shape (single brand, no high-value scraping target) doesn't warrant the per-request Apple / Google quota cost. | Bot-traffic spike in `/api/orders` rate-limit telemetry, OR reaching ≥10K MAU.                   |
| **Jailbreak / root detection**  | App-lock on cold start with biometric-or-device-credential fallback, a global task-switcher privacy overlay, Keychain-backed refresh tokens (ADR-006), and bearer tokens kept in memory only (Zustand). A4-096: the app does NOT hold a Stellar private key — users link an external wallet (`users.stellar_address`); backend signs payouts from `LOOP_STELLAR_OPERATOR_SECRET`. So a rooted device can replay refresh tokens until rotation, but cannot exfiltrate a Stellar secret from this app. | Rooted-device user can extract refresh token + replay until refresh-token rotation (CTX-side, every refresh call).                                                                            | Phase-2 fraud-rate signals OR App Store rejection.                                               |
| **Binary tamper detection**     | Capacitor binary distribution is the App Store / Play Store; sideloaded modified IPAs are out-of-scope for the threat model that Phase-1 protects.                                                                                                                                                                                                                                                                                                                                                   | A user who deliberately sideloads a tampered Loop binary can intercept their own data — this is self-inflicted and not a control we owe them.                                                 | Distribution path moves outside the official stores (e.g. enterprise distribution, web install). |

## Consequences

**Positive**

- Ships Phase 1 without four parallel native-plugin spikes that would each block on App Store review feedback.
- Each control has a clear "why now" Phase-2 trigger so the deferral isn't open-ended.
- The existing Phase-1 controls (Keychain / EncryptedSharedPreferences refresh tokens, app-lock, bearer-in-memory, system-cert TLS) are layered enough that the marginal value of each deferred control is low at expected Phase-1 traffic.

**Negative**

- A targeted MITM on a single user with a corporate-MDM-installed root CA can read response payloads. Mitigated by token TTL + in-flight HSTS at the API edge but not eliminated.
- A rooted-device user can extract their own refresh token and replay until next rotation. Mitigated by CTX-side rotation-on-refresh and the access-token 15min TTL.
- Bot reuse of mobile-app tokens isn't currently distinguishable from genuine clients. The per-IP rate limits (ADR-022 routing-policy section) cap volume but don't differentiate intent.

**Neutral**

- All four controls remain listed in the Phase-2 roadmap (`docs/roadmap.md` §"Mobile platform hardening").
- The deferred plugins (`@nativescript/jailbreak-detection`, `@capgo/capacitor-secure-screen`, etc.) are not yet vetted for the @capacitor/core@8 line; Phase-2 spike includes the version-compatibility check.

## Phase-2 implementation order

When the trigger conditions hit, implement in this order:

1. **App Attest + Play Integrity** — highest ROI per request; integrates as a one-line per-request header from a Capacitor plugin with Apple / Google as the verifier-of-record.
2. **SSL pinning** — pin against the Fly intermediate CA (rotates on a known cadence) rather than the leaf cert; cuts MITM surface without locking us into a single cert lifetime.
3. **Jailbreak / root detection** — soft signal only (warn-and-allow, don't block); blocking would surprise legitimate users on debuggable Android builds and produce App Store review pushback.
4. **Binary tamper detection** — last; only matters once we ship outside the official stores.

## References

- ADR-005 §"Phase-1 known limitations" — companion deferral list.
- ADR-006 — Keychain / EncryptedSharedPreferences for refresh tokens (the in-place mitigation).
- A2-1207 (this session) — `enableTaskSwitcherPrivacyOverlay` rename pinning the same "name vs behaviour drift" honesty.
- A2-1609 — admin step-up auth (Phase-2 lever for the credentialed-attacker case that App Attest doesn't help with).
