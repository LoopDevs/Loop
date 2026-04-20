package io.loopfinance.app;

import android.os.Bundle;
import android.view.View;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Kill Android WebView overscroll (rubber-band + edge glow). CSS
        // `overscroll-behavior: none` alone doesn't cover every WebView
        // build and the bounce drags `position: fixed` elements (the
        // bottom tab bar) along with the visual viewport for ~500ms on
        // a page-level overscroll. Setting the WebView's OverScrollMode
        // to NEVER is the reliable native-layer disable.
        getBridge().getWebView().setOverScrollMode(View.OVER_SCROLL_NEVER);
    }
}
