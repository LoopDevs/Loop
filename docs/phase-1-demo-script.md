# Phase 1 demo video — shot script

A tight, recordable script for the Phase-1 acceptance demo. Target
runtime ~10–12 minutes. Records on a physical iOS device for the iOS
half and a physical Android device for the Android half. Voiceover
recorded after via QuickTime / a video editor — easier than narrating
live and lets each take focus on the on-screen flow.

The video must prove all three deliverable acceptance criteria:

> Download and install from app stores / testflight  
> Purchase a discounted giftcard with XLM/USDC  
> Redeem giftcard at merchant (in-store/online)

## Recording setup

- iOS native screen recording (Control Center → Screen Recording).
  Disables incoming notification banners while recording — verify
  Settings → Notifications → Show Previews is set to "Never" before
  starting so a stray text doesn't land mid-shot.
- Android native screen recording (Quick Settings → Screen Record).
- Test wallet funded per `reference_test_wallet.md`. Pre-load enough
  XLM for the $0.02 Aerie purchase plus margin (~5 XLM is plenty).
- Pick a merchant where you'll actually redeem on-camera. Aerie's
  $0.02 minimum is for the _purchase_ shot; for the _redeem_ shot use
  a merchant where you can show the gift-card balance landing in the
  user's app account (e.g. Amazon: redeemUrl flow shows the credit
  added to the user's Amazon account).
- Both devices on the same network as a desk Mac running QuickTime,
  so screen-mirroring is available as a backup recording surface.

## Shot list

Each section below is one continuous take. Stitch + add voiceover in
post.

### 1. Cold install — ~30s per platform

**iOS take.**

1. Open TestFlight on the iPhone (already invited as internal tester).
2. Tap "Install" on the Loop entry.
3. Wait for download bar to fill (~10–15s).
4. Tap "Open" → Loop launches.

**Android take.**

1. Open the APK link (Drive / Diawi / direct link). Phone prompts
   "Install from this source?".
2. Tap "Install" → "Open".
3. Loop launches.

### 2. First-run onboarding — ~60s per platform

The onboarding flow under `LOOP_PHASE_1_ONLY=true` skips the currency
picker (step 5) and wallet intro (step 7) — the demo cuts straight
from "How it works" to email entry. Record this without the cuts so
the narration can call out the streamlined flow.

1. Splash → Welcome screen.
2. Tap through "How it works" (3 cards).
3. Tap through "Brands" (logo grid carousel).
4. **Email entry.** Type a real email (the demo account's). Tap
   "Send code".
5. **OTP code.** Switch to email app briefly to show the OTP arriving
   from `noreply@loopfinance.io` — proves real Resend integration.
   Switch back, type the 6-digit code.
6. **Biometric setup** (iOS Face ID / Android fingerprint). Authorize
   when prompted.
7. Welcome-in card → "Start exploring".
8. Land on the home screen with the merchant directory.

### 3. Browse the directory — ~45s

1. Scroll the home grid — show ~30 merchants with "Save N%" badges.
2. Show the Favourites strip (empty — first-run user).
3. Scroll back to top.

### 4. Map view — ~45s

1. Tap the Map tab in the bottom nav.
2. Pan around the US: zoom out to see country-level clustering.
3. Zoom into a major metro (NYC, LA, London) to show clusters
   breaking apart into individual pins.
4. Tap a single pin → merchant card slides up with name, logo,
   address, "Buy gift card" CTA.
5. Dismiss the card.

### 5. Search — ~20s

1. Tap the magnifying-glass icon in the Navbar (desktop) or pull-down
   search on mobile.
2. Type "Aerie".
3. Tap the Aerie result.

### 6. Merchant detail — ~30s

1. Aerie page renders: hero card, "Save 2%" badge, "Buy a gift card"
   CTA.
2. Show denomination range ($0.01 – $500).
3. Tap "Buy a gift card".

### 7. Create order — ~45s

1. Amount input — type `0.02`.
2. Show "You pay: $0.02 USD" (Tranche-1 has the discount baked in;
   Aerie's 2% savings on $0.02 rounds to 0 cents so the discount is
   imperceptible — call this out in voiceover as "smallest possible
   amount, real money flow").
3. Pick payment method: XLM (default).
4. Tap "Confirm".

### 8. Pay — ~90s

The most important shot — proves real on-chain payment.

1. Loop renders the deposit screen: deposit address, memo, XLM
   amount, QR code, SEP-7 deep-link ("Open in wallet").
2. Tap "Open in wallet" → switches to Lobstr / Freighter / Bluewallet
   (the test wallet, per `reference_test_wallet.md`).
3. Wallet pre-fills destination + memo + amount from SEP-7.
4. Authorize the payment (biometric / passcode).
5. Wallet shows "Sent" / tx hash.
6. Switch back to Loop.

### 9. Watch order progress — ~60s

The state machine is `pending_payment → paid → procuring →
fulfilled`. Each transition shows up in the order detail screen.
Record continuously even though there's idle waiting — it's
proof-of-life.

1. Order screen shows a spinner with "Waiting for payment".
2. **~10–30s in:** transitions to "Payment received" (watcher
   detected the deposit).
3. **~30–60s in:** transitions to "Procuring gift card" (procurement
   worker called CTX, paid in XLM, awaiting card).
4. **~60–90s in:** transitions to "Fulfilled" — gift card revealed.

If the procurement worker is slow, narrate around it ("CTX returns
the gift card in under a minute typically; here we got it in N
seconds"). Don't fake the timing.

### 10. Gift card revealed — ~30s

1. Show the redemption screen: merchant logo, gift card code (or
   redeemUrl), barcode rendered via JsBarcode.
2. Tap "Copy code" — confirm clipboard toast.
3. Tap "Open redemption page" — switches to in-app browser to
   Aerie's redemption URL.

### 11. Redeem on-camera — ~90s

This is the second-most-important shot. Two acceptable forms:

**Online redeem (preferred for Aerie).**

1. In-app browser shows Aerie's gift-card claim page.
2. Paste the code (already on clipboard).
3. Aerie's page accepts the code and shows "Balance: $0.02 added to
   your Aerie account" or equivalent.
4. (Optional) Switch to the Aerie app on the same device, sign in,
   show the gift-card balance reflected in the wallet.

**In-store scan (alternate).**

- Use the barcode shown in the Loop app at a participating store
  (Ace Hardware has 3,542 in-app store locations per the catalog;
  most US chains have one within a 15-min drive).
- Cashier scans the barcode → POS shows the discount applied.
- Receipt shows the gift-card balance reduction.

The deliverable wording is "in-store/online" so either path satisfies
acceptance. Online is faster to film and works regardless of geography.

### 12. Wrap — ~30s

1. Switch back to Loop's home screen.
2. Tap the Orders tab → show the just-completed order in the history
   list with "Fulfilled" status and timestamp.
3. End on the Loop logo / branded close card.

## Voiceover script outline

Roughly synced to the takes above. Adjust to match actual record
times.

- **0:00 – 0:30** — "Loop is a cross-platform gift-card cashback app.
  Today I'll buy a gift card with crypto and redeem it — end-to-end
  in under twelve minutes."
- **0:30 – 1:30** — "Installing from TestFlight on iOS, then the same
  build sideloaded on Android."
- **1:30 – 3:00** — "Email-OTP sign-in. Resend delivers the code from
  Loop's domain. Biometrics lock the app."
- **3:00 – 4:30** — "Browse 328 merchants — over 116 thousand
  in-store locations. Map view, search."
- **4:30 – 5:15** — "Buying from Aerie — minimum two cents for the
  demo. Discount baked into the charge."
- **5:15 – 6:45** — "Pay XLM from any Stellar wallet. Loop returns a
  deposit address and SEP-7 link. Real on-chain payment, real money."
- **6:45 – 8:15** — "State machine: pending payment → paid →
  procuring → fulfilled. Loop's procurement worker pays CTX, who
  issues the gift card."
- **8:15 – 9:30** — "Gift card revealed. Code, barcode, redemption
  link. Tap through to Aerie — balance reflected in their account."
- **9:30 – 10:00** — "Order history shows the completed purchase.
  That's the Phase 1 deliverable."

## Practical run-of-show

Do at least one **dry run end-to-end** the day before the recording.
The procurement worker will probably take 30–90s on the real run, so
plan a long-pause-then-resume in editing. The demo wallet's secret
key is sensitive — don't show the wallet's private-key screen on
camera. Record in airplane mode + Wi-Fi to avoid notification leakage
and incoming-call interruption.
