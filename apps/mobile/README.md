# @loop/mobile

Capacitor v8 shell for iOS and Android. Loads the static web build from `apps/web/build/client/`.

## Prerequisites

- iOS: Xcode 15+, iOS 16+ target
- Android: Android Studio, API 35+ target
- Built web assets: `cd apps/web && npm run build:mobile`

## Workflow

```bash
# 1. Build the web static export
cd apps/web && npm run build:mobile

# 2. Sync to native projects
cd apps/mobile && npx cap sync

# 3. Open native IDE
npx cap open ios        # Xcode
npx cap open android    # Android Studio
```

## Live reload (dev)

1. Temporarily add to `capacitor.config.ts`:
   ```typescript
   server: { url: 'http://<your-local-ip>:5173', cleartext: true }
   ```
2. `cd apps/web && npm run dev`
3. `cd apps/mobile && npx cap sync && npx cap open ios`
4. Remove `server` block before committing.

## Native projects

- `ios/` — Xcode project (Capacitor-managed, do not edit manually)
- `android/` — Android Studio project (Capacitor-managed, do not edit manually)

Configure via `capacitor.config.ts` only. Use `npx cap sync` to apply changes.

## App ID

`io.loopfinance.app`
