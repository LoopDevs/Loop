> **HISTORICAL — NOT CURRENT.** This was a pre-implementation research doc
> written before the stack was chosen. It references Next.js (superseded by
> React Router v7) and assumes a framework/auth posture that no longer
> matches the codebase. Kept for context only; see `docs/architecture.md`,
> `docs/standards.md`, and the ADRs in `docs/adr/` for the current design.

# Technical plan for a cross-platform gift card cashback app

**Capacitor is the clear best choice for wrapping your existing Next.js app into a native mobile shell, achievable within 2–4 weeks to TestFlight.** The architecture combines Capacitor's WebView wrapper with biometric-protected Stellar wallet keys stored in iOS Keychain/Android Keystore, social login via Google and Apple, and sponsored multisig accounts so users never touch crypto. This plan covers every layer—from framework selection through App Store approval—with specific libraries, code patterns, and architectural decisions ready for implementation.

---

## 1. Capacitor wins the framework comparison decisively

Three approaches were evaluated for wrapping an existing Next.js web app: Capacitor, React Native WebView, and Expo DOM Components. Capacitor is the only framework purpose-built for this exact use case.

**Capacitor (recommended)** wraps your entire React/Next.js frontend in a native WebView shell with **~100% code reuse**. You add `@capacitor/core` and `@capacitor/cli` to your existing project, configure a build target, and get iOS/Android apps that run your web code with native plugin access. The plugin ecosystem is mature (v8 as of 2025–2026), with official plugins for camera, push notifications, biometrics, splash screen, keyboard, and more. Timeline to TestFlight is **1–2 weeks** for a competent developer.

**React Native WebView** is fundamentally wrong for this use case. React Native renders native UI components, not HTML/CSS. Using `react-native-webview` to load your deployed app is an anti-pattern—you lose React Native's benefits while inheriting its build complexity. Communication between the WebView and React Native requires clunky `postMessage` bridges. App Store rejection risk is higher because reviewers can detect a heavyweight framework wrapping a simple WebView.

**Expo DOM Components** (SDK 52+) are intriguing but immature. The `"use dom"` directive renders React components in a WebView within an Expo shell. However, this requires restructuring your entire codebase into Expo's project format and Metro bundler—it's not "point at your URL." **3–5 weeks minimum**, making it impractical for the 2–4 week timeline.

| Factor                       | Capacitor  | RN WebView          | Expo DOM                |
| ---------------------------- | ---------- | ------------------- | ----------------------- |
| Code reuse from existing app | ~100%      | ~0% (wrapper only)  | ~70-90% (restructuring) |
| Time to TestFlight           | 1–2 weeks  | 2–3 weeks           | 3–5 weeks               |
| App Store approval risk      | Low-Medium | Medium-High         | Low                     |
| Native feature access        | Excellent  | Poor (from WebView) | Excellent               |
| Learning curve for web devs  | Very low   | High                | Medium                  |

---

## 2. Integrating Capacitor with your Next.js app

The critical architectural decision is whether to use **static export** (bundled) or **remote URL** (live server). Each has significant trade-offs.

**Static export** generates HTML/CSS/JS files bundled into the native binary. Set `output: 'export'` in `next.config.js` and `webDir: 'out'` in `capacitor.config.ts`. This gives offline support and fast loading but **kills SSR**—no `getServerSideProps`, Server Actions, or API routes. You must use client-side data fetching (SWR, React Query). Images require `unoptimized: true`.

**Remote URL** points the WebView at your deployed Next.js app via `server.url` in `capacitor.config.ts`. This preserves full SSR and API routes but requires internet connectivity. A known Android bug causes `Capacitor.isNativePlatform()` to return `false` after navigation to remote URLs—iOS works correctly.

**The recommended hybrid approach** uses environment variables to switch between modes:

```javascript
// next.config.js
const nextConfig = {
  ...(process.env.BUILD_TARGET === 'mobile' ? { output: 'export' } : {}),
  images: { unoptimized: process.env.BUILD_TARGET === 'mobile' },
};
```

**Detecting native vs. web context** is essential for conditional features. The primary API is `Capacitor.isNativePlatform()` and `Capacitor.getPlatform()` (returns `'ios'`, `'android'`, or `'web'`). Wrap this in a React hook:

```typescript
import { Capacitor } from '@capacitor/core';
export function useNativePlatform() {
  const [isNative, setIsNative] = useState(false);
  useEffect(() => setIsNative(Capacitor.isNativePlatform()), []);
  return isNative;
}
```

**Navigation and safe areas** require careful handling. The WebView has no browser chrome—no URL bar, no back button. All navigation is your app's UI. For safe areas (notch, status bar), add `viewport-fit=cover` to your meta tag and use CSS `env(safe-area-inset-top)` variables. Android's hardware back button needs explicit handling via `@capacitor/app`'s `backButton` event listener. Set all input font sizes to **16px minimum** to prevent iOS auto-zoom.

**Deep linking** uses Universal Links (iOS) and App Links (Android) via the built-in `@capacitor/app` plugin. Host an `apple-app-site-association` file at `/.well-known/` on your domain for iOS, and `assetlinks.json` for Android. Listen for `appUrlOpen` events to route incoming URLs to the correct Next.js page.

**Build workflow** is straightforward: `npm run build && npx cap sync` copies web assets to native projects. Open in Xcode with `npx cap open ios` or Android Studio with `npx cap open android`. During development, set `server.url` to your local dev server IP for hot reload.

---

## 3. Biometric authentication protects tokens in hardware

The biometric flow stores JWT refresh tokens behind Face ID/Touch ID/fingerprint using platform-native secure storage. The token is physically inaccessible without biometric verification.

**Plugin recommendation: `@capgo/capacitor-native-biometric` (v8.x)**—actively maintained, combines biometric verification AND credential storage in one package. It uses iOS Keychain with `kSecAttrAccessControl` biometry protection and Android Keystore with `BiometricPrompt` + `CryptoObject`. Alternative: pair `@aparajita/capacitor-biometric-auth` with `@aparajita/capacitor-secure-storage` for separation of concerns.

The complete authentication lifecycle works as follows. After initial login (email/password or social), check biometric availability and offer setup. Store the refresh token as a "credential" with `NativeBiometric.setCredentials()`. When the app reopens, check for stored credentials, prompt biometric verification with `NativeBiometric.verifyIdentity()`, retrieve the token, and refresh the session. If biometrics fail, fall back to full re-login.

```typescript
// Store after login
await NativeBiometric.setCredentials({
  username: userId,
  password: refreshToken,
  server: 'api.yourapp.com',
  accessControl: 'BIOMETRY_ANY',
});

// Retrieve on app resume (auto-prompts biometric)
const creds = await NativeBiometric.getCredentials({ server: 'api.yourapp.com' });
const session = await api.refreshSession(creds.password);
```

**iOS requires** `NSFaceIDUsageDescription` in Info.plist—the app **crashes** without it. Enable Keychain Sharing capability in Xcode. **Android requires** `USE_BIOMETRIC` permission in AndroidManifest.xml and `androidx.biometric:biometric:1.1.0` dependency. Android distinguishes strong biometry (fingerprint) from weak biometry (face/iris); only strong biometry reliably works for app-level authentication.

**Security principle**: biometric verification is a UX convenience, not a security boundary. Always validate tokens server-side. Store access tokens in memory only (JavaScript variable), never in persistent storage. Rotate refresh tokens on every use.

---

## 4. Stellar 2-of-3 multisig makes crypto invisible to users

The wallet architecture uses Stellar's **native protocol-level multisig** (no smart contracts needed) with three Ed25519 signing keys distributed across device, server, and recovery party. Any two keys authorize transactions. Users never see public keys, transaction hashes, or blockchain terminology.

**Stellar multisig mechanics** assign each signer a weight (0–255) and each operation type a threshold. For 2-of-3, set all three signers to weight 1 and all thresholds to 2. Stellar categorizes operations into low (trustline flags, bumps), medium (payments, offers, trustlines), and high (signer changes, account merge). Each additional signer costs **0.5 XLM** in base reserves.

```typescript
// Configure 2-of-3 multisig
.addOperation(Operation.setOptions({
  signer: { ed25519PublicKey: serverKey.publicKey(), weight: 1 },
}))
.addOperation(Operation.setOptions({
  signer: { ed25519PublicKey: recoveryKey.publicKey(), weight: 1 },
}))
.addOperation(Operation.setOptions({
  masterWeight: 1,
  lowThreshold: 2,
  medThreshold: 2,
  highThreshold: 2,
}))
```

**Device key storage uses Keychain/Keystore, not WebAuthn passkeys.** This is the most critical architectural decision. Stellar classic accounts use **Ed25519** signing, but WebAuthn passkeys use **secp256r1 (P-256)**—a fundamentally incompatible curve. Passkeys cannot directly sign Stellar transactions. While Stellar Protocol 21 added secp256r1 support in Soroban smart contracts, this only works for Soroban operations, not classic payments and trustlines needed for a gift card app.

The recommended approach: generate an Ed25519 keypair on device, store the private key in iOS Keychain / Android Keystore with biometric access control. The Secure Enclave itself only supports P-256, but Keychain items can be **protected by** Secure Enclave biometric checks while storing arbitrary data (the Ed25519 key bytes). When the user taps "Confirm," the biometric prompt fires, the key is decrypted in memory, the transaction is signed, and the key is wiped from memory.

**Account sponsorship eliminates all user costs.** The business sponsors every reserve and fee using Stellar's CAP-0033 "sandwich transaction" pattern: `BeginSponsoringFutureReserves` → create account + trustlines + signers → `EndSponsoringFutureReserves`. Total cost per user: **~2.5 XLM** (~$0.25–0.50) covering account creation (1 XLM), two extra signers (1 XLM), and one USDC trustline (0.5 XLM). Transaction fees are paid via **fee-bump transactions** (CAP-0015) where the business wraps the user's signed transaction without re-signing.

**The transaction flow feels like a normal app interaction:**

1. User taps "Redeem $10 Amazon Gift Card"
2. Server validates balance, builds Stellar payment transaction, signs with server key
3. Server sends transaction XDR to device
4. App shows "Confirm with Face ID" → biometric prompt → device key signs
5. Doubly-signed XDR returns to server → server wraps in fee-bump → submits to network
6. User sees "Here's your Amazon gift card! 🎁"

**Recovery when a user loses their device**: the server key + recovery key together meet the 2-of-3 threshold. After identity verification, the server builds a `setOptions` transaction to remove the old device key (weight → 0) and add a new one (weight → 1). Both server and recovery party sign. Add a **24–48 hour delay** before completion so legitimate users can intervene against unauthorized recovery attempts.

**Primary library: `@stellar/stellar-sdk`** (official TypeScript SDK). For mobile, `Keypair.random()` needs a crypto polyfill (`react-native-get-random-values` or similar). Also consider `@stellar/typescript-wallet-sdk` for higher-level wallet operations and SEP-10 authentication.

---

## 5. Social login and Apple's mandatory Sign-in requirement

If you offer Google Sign-In, you **must** also offer Sign in with Apple per App Store Guideline 4.8. Non-compliance results in immediate rejection.

**Recommended plugin: `@capgo/capacitor-social-login`**—an actively maintained all-in-one package supporting Google, Apple, and Facebook. It's a fork of the now-archived `@codetrix-studio/capacitor-google-auth` with native Credential Manager support on Android. For Apple-only, `@capacitor-community/apple-sign-in` (v7.1.0) is a focused alternative.

**Google Sign-In** returns an `idToken` containing email and profile info. Request the `email` and `profile` scopes. The email is always the user's actual Google account email. **Apple Sign-In** has a critical gotcha: the user's real email and name are **only provided on the first authorization**. Subsequent sign-ins return only the user identifier (`sub`) and, if the user chose "Hide My Email," a relay address like `xxx@privaterelay.appleid.com`. You **must capture and store email/name on first sign-in**—Apple will never provide it again. To send emails to relay addresses, register your outbound email domain in Apple Developer Portal with an SPF DNS record.

**Token flow**: the mobile app receives an `idToken` from the social provider's native SDK, sends it to your backend, which verifies the JWT signature against the provider's public keys (Google: `oauth2.googleapis.com/tokeninfo`, Apple: `appleid.apple.com/auth/keys`). The backend extracts user info, finds or creates the user (keyed on `sub`, not email), and issues your own JWT access + refresh token pair. The refresh token is stored in biometric-protected Keychain/Keystore.

---

## 6. The login gate architecture keeps content secure before auth

**Use route-based auth gating within your web app (Option A)**, not separate native login screens. The login screen is a Next.js page that the Capacitor WebView loads. This maintains a single codebase, works identically on web and mobile, and allows updates without App Store releases.

The key pattern combines Capacitor's splash screen with auth state checking. Keep the native splash screen visible (set `launchShowDuration: 0` to control it manually) until the auth check completes. Check for stored biometric credentials. If found, prompt biometric → retrieve token → validate → navigate to main app → hide splash. If not found, navigate to login screen → hide splash.

```typescript
import { SplashScreen } from '@capacitor/splash-screen';

async function initApp() {
  const hasCredentials = await NativeBiometric.hasCredentials({ server: 'api.yourapp.com' });
  if (hasCredentials) {
    await attemptBiometricLogin();
  } else {
    navigateToLogin();
  }
  await SplashScreen.hide(); // Content only visible after auth decision
}
```

**Session management** stores access tokens in memory only (a JavaScript variable) and refresh tokens in biometric-protected storage. Intercept 401 responses to clear stored credentials and redirect to login. On app resume (`appStateChange` event), validate the current session and re-prompt biometrics if needed. Rotate refresh tokens on every use.

---

## 7. Passing App Store review requires deliberate native features

Apple's Guideline 4.2 ("Minimum Functionality") is the primary rejection risk. Apple rejects "lazy wrappers"—apps indistinguishable from visiting the website in Safari. They do **not** reject WebView-based apps that provide an "app-like" experience with native integration. Amazon, Instagram, and Basecamp all use WebViews extensively.

**Mandatory native features to implement** (aim for at least 4):

- **Push notifications** via `@capacitor/push-notifications` with APNs/FCM—the single strongest signal of native integration
- **Biometric authentication** (Face ID/Touch ID)—demonstrates OS-level integration
- **Native navigation patterns**—tab bar or navigation stack, not web hamburger menus
- **Offline handling**—meaningful error states, cached data, not blank screens or browser error pages
- **Haptic feedback** via `@capacitor/haptics` on key interactions

**Common rejection triggers to avoid**: browser-like loading bars, `alert()` dialogs instead of native alerts, missing safe area handling, white screens when offline, identical experience to mobile Safari, and missing `NSUsageDescription` keys in Info.plist (Capacitor includes camera/photo API references even if unused).

**Privacy Manifest** (`PrivacyInfo.xcprivacy`) has been mandatory since May 2024. You must declare data types collected, justify API usage with specific reason codes, and disclose third-party SDKs. **12% of Q1 2025 submissions** were rejected for Privacy Manifest violations.

**TestFlight process**: build your Next.js app → `npx cap sync ios` → open Xcode → Product → Archive → Distribute to App Store Connect. Internal testing (up to 100 testers) is **instant** with no Apple review. External testing (up to 10,000 testers) requires Beta App Review, typically **24–48 hours**. Builds expire after 90 days.

**In-app purchase considerations**: gift cards redeemable for physical goods/services likely **do not** require Apple IAP. Apple treats these as physical goods outside IAP requirements. Cashback rewards earned (not purchased digital goods) are also outside IAP. However, any premium subscription or digital feature access within the app **must** use IAP. Include a clear explanation in your App Review notes.

**Google Play is significantly more lenient**. Key requirements: target **Android 15 (API 35)** as of August 2025, use `.aab` bundle format, complete the Data Safety section honestly covering all SDK data collection, and comply with financial services policies for cashback apps. One-time $25 registration. New personal accounts must complete 14 days of closed testing with 20 testers before public distribution.

---

## 8. AI-assisted development accelerates the web layer, not the native layer

Claude Code and OpenAI Codex are most effective on the ~80% of this project that is React/TypeScript/Tailwind—exactly the code Capacitor wraps. The "last mile" of native builds, Xcode signing, and App Store submission remains manual.

**Claude Code** is Anthropic's terminal-native agentic coding tool. It reads your codebase autonomously, executes shell commands, and produces multi-file edits. **CLAUDE.md** is the highest-leverage configuration point—a project instruction file read at every session start. Keep it under 60–80 lines. Document build commands (`npm run build && npx cap sync`), architecture directories, and critical rules ("NEVER hardcode secrets," "All Stellar signing MUST happen client-side"). Use Plan Mode (Shift+Tab twice) before implementation to have Claude draft plans without modifying files.

**OpenAI Codex** has been reimagined as a cloud-based agent platform. Tasks run in isolated cloud containers preloaded with your GitHub repo, producing diffs that become PRs. Its key advantage is **native parallel execution**—multiple tasks running simultaneously in separate sandboxes. **AGENTS.md** is its equivalent of CLAUDE.md.

**The optimal dual-tool strategy**: use Claude Code as your primary daily driver for interactive coding and debugging. Use Codex Cloud for fire-and-forget parallel tasks like test generation, documentation, refactoring, and code review. While reviewing Claude's output on Feature A, have Codex generating tests for Feature B and docs for Feature C.

**What AI handles well**: boilerplate (CRUD, forms, API routes), UI components, test generation from specs, refactoring, configuration files, data transformation. **What AI handles poorly**: security-critical code (auth, encryption, wallet operations), native platform edge cases, architecture decisions, App Store deployment. Research shows **40–62% of AI-generated code contains security vulnerabilities**. All auth, crypto, and payment code requires mandatory human review.

**Recommended sprint structure** for AI-assisted development:

- **Weeks 1–2**: Foundation—Next.js setup, Capacitor integration, TypeScript interfaces, base UI components (AI-suitable: ~80%)
- **Weeks 3–4**: Authentication—social login, biometrics, token management (AI-suitable: ~50%, security-critical)
- **Weeks 5–6**: Stellar wallet—key management, transaction signing, sponsored accounts (AI-suitable: ~40%, crypto-critical)
- **Weeks 7–8**: Gift card marketplace—browsing, purchasing, cashback display (AI-suitable: ~85%, this is AI's sweet spot)
- **Weeks 9–10**: Native polish—push notifications, deep links, offline support, safe areas (AI-suitable: ~60%)
- **Weeks 11–12**: Testing, security audit, App Store submission (AI-suitable: ~60%, manual deployment)

**Critical process rules**: write specs before implementation, evolve CLAUDE.md/AGENTS.md every sprint, mandate human security review on all auth/crypto code, test on physical devices every sprint, and use test-driven patterns (write failing tests → AI implements → iterate).

---

## Conclusion: the architecture in one picture

The complete technical stack is **Next.js → Capacitor v8 → native iOS/Android shell** with `@capgo/capacitor-native-biometric` for biometrics, `@capgo/capacitor-social-login` for Google/Apple auth, and `@stellar/stellar-sdk` for wallet operations. Store Ed25519 device keys in Keychain/Keystore (not passkeys—curve incompatibility), sponsor all Stellar accounts and fees from a business funding account, and gate the entire app behind a route-based auth check held behind the native splash screen.

The riskiest element is **Apple's Guideline 4.2 rejection**—mitigated by implementing push notifications, biometrics, native navigation, and offline handling before first submission. The most architecturally complex element is the **Stellar multisig wallet**—but by abstracting all blockchain operations behind a simple "Confirm with Face ID" interaction, users will never know they're using crypto. The fastest path to TestFlight is 1–2 weeks for the basic wrapper with auth, extending to the full 12-week plan for the complete feature set including Stellar wallet integration.
