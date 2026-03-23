# 001 — Static export over remote URL for Capacitor

## Status

Accepted

## Date

2026-03-05

## Context

The Loop mobile app wraps the web app using Capacitor v8. Capacitor supports two loading strategies:

1. **Static export** — the web app is built to static HTML/JS/CSS and bundled into the native binary. All data fetching is client-side against the backend API.
2. **Remote URL** — the Capacitor WebView loads the deployed web app URL. Full SSR is preserved.

## Decision

Use static export for the Capacitor mobile build, with a separate SSR build for the standalone web app. A `BUILD_TARGET=mobile` environment flag switches between modes in `react-router.config.ts`.

## Consequences

**Benefits:**

- App loads from disk — instant first paint, no network round-trip for the shell
- Eliminates the known Android bug where `Capacitor.isNativePlatform()` returns `false` after navigating to a remote URL
- Enables OTA updates via Capacitor Live Update — web asset changes can be pushed to users without an App Store release
- Cleaner App Store review experience — the binary contains real assets, not a browser pointing at a URL
- Forces the correct architecture: the web app becomes a pure API client, which is right

**Trade-offs:**

- React Router server-side loaders cannot fetch data from a database — all data fetching must be client-side via TanStack Query against `apps/backend`
- Web content changes require either a new app build or a Live Update push (not a simple server-side deploy for mobile users)
- Slightly more complex build pipeline — two build targets instead of one
