# App Store Connect — metadata reference

Every text field App Store Connect requires for the iOS submission,
drafted from Loop's actual Tranche-1 surface so the operator can
copy-paste during release week instead of authoring under deadline.
Mirror these into App Store Connect → My Apps → **Loop** → **App
Information** + the version-specific tabs.

The Google Play Console fields (Play Store description, short
description, etc.) are similar in shape — re-use the App Description
and Promotional Text below. Play has different size limits (short
description = 80 chars; full description = 4000 chars; same as App
Store).

---

## App Information (set once per app, not per version)

### Name

```
Loop
```

30-char limit. "Loop" is 4 chars — leave the headroom for any future
rename without a metadata-only resubmission.

### Subtitle

```
Crypto gift cards, save now
```

30-char limit (this draft is 27). The subtitle indexes for App Store
search; lead with the two highest-intent terms (`crypto gift cards`,
`save`).

### Primary Category

```
Finance
```

### Secondary Category

```
Shopping
```

Loop is dual-natured — Tranche-1 is a discount-gift-card store with
crypto checkout (Shopping), Tranche-2 is a cashback/yield product
(Finance). Pick Finance as primary so Tranche-2 messaging slots in
without an App Store Connect re-categorization (which can pause
review while Apple validates the new category placement).

### Bundle ID

```
io.loopfinance.app
```

### SKU (App Store Connect-internal — never shown to users)

```
loop-ios-1
```

### Content Rights

- "Does your app contain, show, or access third-party content?"
  → **No** (gift cards are first-party content sourced from Loop's
  CTX integration; merchants are listed under Loop's own catalog).

### Age Rating questionnaire (full answer set)

All "None" / "No" unless noted. Result: **4+** rating.

| Question                                         | Answer |
| ------------------------------------------------ | ------ |
| Cartoon or Fantasy Violence                      | None   |
| Realistic Violence                               | None   |
| Sexual Content or Nudity                         | None   |
| Profanity or Crude Humor                         | None   |
| Alcohol, Tobacco, or Drug Use or References      | None   |
| Mature/Suggestive Themes                         | None   |
| Simulated Gambling                               | None   |
| Horror/Fear Themes                               | None   |
| Prolonged Graphic or Sadistic Realistic Violence | None   |
| Graphic Sexual Content and Nudity                | None   |
| Medical/Treatment Information                    | None   |
| Contests                                         | None   |
| Unrestricted Web Access                          | **No** |
| Gambling                                         | **No** |
| User-Generated Content                           | **No** |
| Made for Kids                                    | **No** |

The "Gambling" answer is **No** — gift cards are stored-value
instruments, not games of chance. Cashback rates are deterministic
percentages, not lottery payouts.

The "Unrestricted Web Access" answer is **No** — Loop opens external
URLs (gift-card redemption pages, Stellar wallets via SEP-7) but
doesn't render arbitrary user-supplied URLs. Reviewers occasionally
flag in-app browser flows under this question; cite the SEP-7 +
redemption-URL pattern in App Review notes if asked.

---

## Version Information (per release)

### Promotional Text (170 chars, can update without resubmission)

```
Buy gift cards from 100+ merchants with crypto. Save up to 15% instantly. Pay with XLM or USDC, redeem in-store or online. Phase 1 — discounts; Phase 2 — cashback.
```

Currently 175 chars — trim "instantly" or "Phase 1 — discounts; Phase
2 — cashback" if Apple rejects on length.

### Description (4000 chars)

```
Loop turns your crypto into instant savings on gift cards from over a hundred household-name merchants. Pay with XLM or USDC on the Stellar network, get a discounted gift card delivered straight to your phone, and redeem it in-store or online — same day, same hour, same minute the on-chain payment confirms.

Tranche 1 — what's live now:
• Browse a catalog of 300+ merchants across the US, UK, Europe, and Canada — Amazon, Apple, Aerie, Adidas, Ace Hardware, Airbnb, and more.
• See instant discounts on every card — typical savings 1% to 15% off the face value, baked into the charge before you pay.
• Pay with XLM or USDC from any Stellar wallet — Lobstr, Freighter, Bluewallet. SEP-7 deep links open your wallet pre-filled.
• Watch the on-chain payment confirm and the gift card arrive in under a minute, end-to-end.
• Redeem online via the merchant's claim page, or scan the in-app barcode at the register.
• Map view — find merchants with physical locations near you across 116,000+ store points.
• Email + biometric sign-in. Loop locks the app with Face ID or fingerprint so your gift cards stay private if your phone is unlocked to someone else.

What's coming in Tranche 2:
• Cashback flips from "instant discount" to "earn LOOP-asset rewards on every purchase" — credited to a Loop-managed Stellar wallet keyed to your account, no seed phrase to back up.
• Per-currency yield: USDC and EURC routed into curated DeFi vaults; GBPLOOP earning 3% APY paid as nightly on-chain mints.
• Cross-platform identity-bound wallet — same balance whether you open Loop on iOS, Android, or web.

What we don't do:
• No tracking — Loop never sells, shares, or rents your data.
• No advertising — no third-party ads in the app.
• No gambling — gift cards are stored-value instruments, not games of chance. Cashback rates are deterministic.
• No custodial holdings of your gift card after issuance — once a card is fulfilled, the redemption code is yours.

Privacy policy: https://loopfinance.io/privacy
Terms of service: https://loopfinance.io/terms
Support: hello@loopfinance.io
```

This draft is ~2200 chars — well under the 4000-char limit. Add or
trim per release.

### Keywords (100 chars total, comma-separated, no spaces around commas)

```
gift cards,crypto,XLM,USDC,Stellar,cashback,discount,wallet,merchant,save,shopping,finance
```

This draft is 99 chars. Apple ignores duplicates from name/subtitle,
so the lead "gift cards" is partially redundant with the subtitle —
keep it for the trailing search-relevance signal anyway.

### Support URL

```
https://loopfinance.io/support
```

The placeholder /support route doesn't exist yet — operator-side
follow-up: either ship a Loop-Finance support page with the FAQ and
hello@ contact, or change this to `https://loopfinance.io` (which
works) before submission.

### Marketing URL

```
https://loopfinance.io
```

### Privacy Policy URL

```
https://loopfinance.io/privacy
```

Page is wired in code with placeholder copy + a yellow "pending legal
review" banner. Apple accepts placeholder copy for TestFlight; final
wording lands before public App Store submission per the Phase-1
roadmap.

### What's New in This Version

For v1.0.0 (initial release):

```
Welcome to Loop. Buy gift cards from 100+ merchants with XLM or USDC, save up to 15% on every purchase, redeem the same minute the on-chain payment confirms.
```

For subsequent point releases, reference any user-visible change. Don't
list backend / infrastructure changes.

---

## App Privacy (privacy nutrition labels)

This section maps to the privacy declarations in
`apps/mobile/native-overlays/ios/App/App/PrivacyInfo.xcprivacy` —
keep them in sync. App Store Connect's UI is a form per data type
asking three questions: collected? linked-to-user? used-for-tracking?

### Data Used to Track You

**None.** Tracking requires linking the user's data with other apps'
or websites' data for advertising/analytics purposes. Loop does
neither.

### Data Linked to You

| Data Type        | Purpose           | Notes                                                          |
| ---------------- | ----------------- | -------------------------------------------------------------- |
| Email Address    | App Functionality | OTP sign-in via Loop's auth (Resend on the backend).           |
| User ID          | App Functionality | Loop's internal user_id; sent on every authenticated API call. |
| Purchase History | App Functionality | Order ledger — gift cards bought, amount, merchant, date.      |

### Data Not Linked to You

| Data Type        | Purpose           | Notes                                                                                                                           |
| ---------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Coarse Location  | App Functionality | Map "locate me" only — never persisted. Resolved client-side, not sent to backend.                                              |
| Crash Data       | Analytics         | Sentry-collected, sampled. PII redacted via `apps/backend/src/logger.ts` redactors + the web client's `beforeSend` Sentry hook. |
| Performance Data | Analytics         | Same Sentry pipeline. Latency / error counts only.                                                                              |

### Third-Party SDKs and their data collection

Apple's privacy form asks about each SDK that collects user data.

- **Sentry** (`@sentry/capacitor` + backend `@sentry/node`) — collects
  crash data + performance data, not linked, not for tracking. Opt-in
  via `VITE_SENTRY_DSN` build arg + `SENTRY_DSN` Fly secret; absent =
  no Sentry SDK initialised. Declared above as Crash Data + Performance
  Data, not linked.
- **@stellar/stellar-sdk** — pure crypto + HTTP client, no data
  collection.
- **Capacitor + plugins** — see each plugin's bundled
  `PrivacyInfo.xcprivacy` for required-reason API declarations
  (UserDefaults, FileTimestamp, DiskSpace, SystemBootTime). Apple
  aggregates these at archive time. Loop's main bundle declares no
  required-reason APIs of its own.

---

## Encryption Export Compliance

Apple asks: "Does your app use encryption?" and "Does your app
qualify for any of the [export-control] exemptions?".

Answers for v1.0.0:

| Question                                                   | Answer | Notes                                                                                                                                           |
| ---------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Does your app use encryption?                              | Yes    | TLS for HTTPS, Ed25519 for Stellar signatures.                                                                                                  |
| Is encryption limited to standard, exempt cryptography?    | Yes    | TLS via OS APIs; Ed25519 via published Stellar SDK. No proprietary algorithms.                                                                  |
| Does your app qualify for the export-compliance exemption? | Yes    | Per US EAR §740.17 (b)(1) — uses only standard cryptography for authenticating data integrity and protecting confidentiality of communications. |

This sets `ITSAppUsesNonExemptEncryption=NO` in Info.plist (already
the default; no overlay needed). If the answer ever changes, set the
key explicitly via `apply-native-overlays.sh`'s plist patcher.

---

## App Review Information

Apple's review team needs reviewer credentials + flow notes. Provide
in the per-version "App Review Information" tab.

### Sign-in required?

**Yes** — the gift-card purchase flow requires email OTP sign-in.

### Demo Account

- **Username**: provide a dedicated reviewer email mailbox (e.g.
  `apple-reviewer@loopfinance.io`).
- **Password**: not applicable — auth is OTP-only. Reviewer requests
  a code; Loop emails it; reviewer enters it.
- **Notes**: "Sign-in is via 6-digit OTP emailed by Loop's backend.
  Tap 'Sign in' → enter the reviewer email above → check inbox for
  the code → enter the code. The code expires in 10 minutes."

### Review Notes

Free-text field; provide:

```
Loop is a gift-card cashback app. Acceptance flow for review:

1. Sign in with the reviewer email (OTP-only). The code arrives from
   noreply@loopfinance.io within 30 seconds. Resend by tapping
   "Resend code".

2. Browse the merchant directory or the map view. The catalog has
   300+ merchants; Aerie (in the directory at the top of the A's)
   has a $0.01 minimum so a real-money smoke test costs ~2 cents.

3. To test a real purchase end-to-end:
   - Pick Aerie, set amount $0.02.
   - Loop returns a Stellar deposit address + memo + the XLM amount
     (~0.004 XLM at current rates). The address is Loop's treasury;
     the memo binds the on-chain payment to the order.
   - Pay via any Stellar wallet (Lobstr is free on the App Store).
     We have funded a test wallet for this purpose; secret key
     available on request via apple-review@loopfinance.io.
   - Loop's payment-watcher detects the deposit within ~30 seconds,
     marks the order paid, and the procurement worker pays our gift
     card supplier (CTX) in XLM. CTX returns the gift card code in
     under a minute.
   - The gift card code + barcode appear in the order screen. Tap
     "Redeem" to open Aerie's claim page in an in-app browser, paste
     the code, and the $0.02 balance appears in the Aerie account.

4. To skip the on-chain payment for a quicker review path: the
   "Orders" tab shows a previously-fulfilled $0.02 Aerie order on
   the reviewer account, so the gift-card redemption UI can be
   exercised without a fresh purchase.

Privacy policy: https://loopfinance.io/privacy
Tracking: none. No third-party ads. No data sold.
Encryption: TLS + Ed25519 signatures only — exempt under US EAR
§740.17 (b)(1).
```

### Contact Information

- **First name**: <operator first>
- **Last name**: <operator last>
- **Phone**: <operator phone, including country code>
- **Email**: hello@loopfinance.io (or operator's direct email).

Apple's reviewer occasionally calls / emails for clarification — the
contact must be reachable during US Pacific business hours during
review.

---

## Screenshots

Required sizes (iOS):

- **6.7" iPhone display** (1290×2796 portrait) — required.
- **6.5" iPhone display** (1242×2688 portrait) — recommended for
  pre-iPhone-15 fallback rendering.
- **5.5" iPhone display** (1242×2208 portrait) — required if Loop
  supports any device older than iPhone 8.
- **iPad Pro 12.9" 6th gen** (2048×2732 portrait) — required only if
  Loop ships a universal binary. Capacitor v8 builds universal by
  default, so include them.

Recommended shot list (5–10 screenshots per size):

1. Home — directory grid with the "Save N%" badges visible.
2. Map — multi-pin view zoomed to a US metro.
3. Merchant detail — Aerie or Amazon, showing denomination range +
   savings.
4. Order create — amount input + payment method picker (XLM/USDC).
5. Order paid — Stellar deposit address + memo + QR + SEP-7 button.
6. Order fulfilled — gift card code, barcode rendered.
7. Order history (Orders tab) — list of past purchases.
8. App-lock — Face ID/fingerprint prompt over the home screen.

Capture from a real device or the iOS Simulator (Xcode → Window →
Devices and Simulators → simulator → screenshot). Keep the status bar
clean (carrier "5G", battery 100%, no notifications) — Apple's
human-review pass occasionally rejects on visible system clutter.
