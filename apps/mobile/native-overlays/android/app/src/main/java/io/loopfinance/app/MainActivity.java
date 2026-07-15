package io.loopfinance.app;

import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // FE-01: FLAG_SECURE — block screenshots + screen recording and
        // blank the recents/app-switcher thumbnail. Loop is a money app:
        // every authed screen can surface a gift-card code + PIN, a
        // wallet balance, or an order receipt, and the whole UI is a
        // single Capacitor WebView (no per-Activity split to scope this
        // to "sensitive" screens without a JS<->native bridge). Setting
        // the flag once on the host Activity is the robust, no-plugin way
        // to cover the entire surface — the same posture most banking /
        // crypto apps take.
        //
        // This is the real screenshot-prevention control that
        // apps/web/app/native/task-switcher-overlay.ts documents it is
        // NOT (that helper is a JS-side blur for the iOS app-switcher
        // snapshot — iOS has no FLAG_SECURE equivalent). On Android
        // FLAG_SECURE also makes the recents thumbnail render blank, so it
        // supersedes the JS overlay's best-effort Android coverage.
        //
        // `cap add android` regenerates a default no-op MainActivity, so
        // this override is re-applied after every cap sync by
        // apps/mobile/scripts/apply-native-overlays.sh, and the
        // mobile-overlay-guard CI job asserts the flag survives that
        // regeneration.
        //
        // Tradeoff (see docs/audit/audit-2026-07/native-device-qa-handoff.md
        // FE-01): app-wide FLAG_SECURE also stops a user screenshotting a
        // non-sensitive screen (e.g. a cashback offer to share). Accepted
        // for launch; a per-route toggle would need a custom Capacitor
        // plugin that cannot be device-verified in this pass.
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        );

        // Kill Android WebView overscroll (rubber-band + edge glow). CSS
        // `overscroll-behavior: none` alone doesn't cover every WebView
        // build and the bounce drags `position: fixed` elements (the
        // bottom tab bar) along with the visual viewport for ~500ms on
        // a page-level overscroll. Setting the WebView's OverScrollMode
        // to NEVER is the reliable native-layer disable.
        getBridge().getWebView().setOverScrollMode(View.OVER_SCROLL_NEVER);
    }
}
