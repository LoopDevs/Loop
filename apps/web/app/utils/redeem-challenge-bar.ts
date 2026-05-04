/**
 * Builds an IIFE that, when executed inside a redeem-URL webview,
 * prepends a fixed-position bar at the top of the page showing the
 * challenge code and a Copy button. The bar sits over the merchant's
 * own DOM with the max z-index so CSS-heavy sites can't hide it;
 * the copy handler tries `navigator.clipboard.writeText` and falls
 * back to the legacy `execCommand('copy')` trick for older
 * WebViews that reject clipboard writes without a user gesture.
 *
 * Idempotent — the `document.getElementById` guard means a merchant
 * that does a full-page navigation won't end up with two bars
 * stacked. Inject once per `browserPageLoaded` event via
 * `openWebView`'s `scripts` option.
 *
 * The challenge code is JSON-encoded into the script body; it's an
 * alphanumeric string from CTX in practice but encoding removes
 * the injection footgun if that assumption ever changes.
 *
 * Shared by:
 * - `RedeemFlow` (in-purchase URL redeem)
 * - `/orders/:id` (revisiting a previously-placed URL-redeem order)
 */
export function buildChallengeBarScript(code: string): string {
  const safeCode = JSON.stringify(code);
  return `(function(){
    if (document.getElementById('loop-challenge-bar')) return;
    var code = ${safeCode};
    var bar = document.createElement('div');
    bar.id = 'loop-challenge-bar';
    bar.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'padding:10px 14px',
      'background:rgba(3,7,18,0.96)',
      'color:#fff',
      'font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
      'font-size:14px',
      'display:flex', 'align-items:center', 'gap:10px',
      'box-shadow:0 2px 10px rgba(0,0,0,0.2)',
      'padding-top:calc(10px + env(safe-area-inset-top))',
    ].join(';');
    var eyebrow = document.createElement('span');
    eyebrow.textContent = 'CODE';
    eyebrow.style.cssText = 'opacity:0.55;font-size:10px;font-weight:700;letter-spacing:0.08em;flex-shrink:0;';
    var value = document.createElement('span');
    value.textContent = code;
    value.style.cssText = 'font-family:ui-monospace,Menlo,monospace;font-weight:700;letter-spacing:0.08em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Copy';
    btn.style.cssText = 'margin-left:auto;background:#3b82f6;color:#fff;border:0;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0;';
    btn.addEventListener('click', function(){
      var done = function(){
        btn.textContent = 'Copied';
        setTimeout(function(){ btn.textContent = 'Copy'; }, 2000);
      };
      // A4-071: surface a visible failure label when neither path
      // works. Older WebViews that reject the async clipboard API
      // also commonly reject execCommand('copy') without a user
      // gesture; previously both arms swallowed and the operator
      // saw nothing change.
      var failed = function(){
        btn.textContent = 'Copy failed';
        setTimeout(function(){ btn.textContent = 'Copy'; }, 2500);
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(done, fallback);
        } else {
          fallback();
        }
      } catch (e) { fallback(); }
      function fallback(){
        try {
          var ta = document.createElement('textarea');
          ta.value = code;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          if (ok) { done(); } else { failed(); }
        } catch (e) { failed(); }
      }
    });
    bar.appendChild(eyebrow);
    bar.appendChild(value);
    bar.appendChild(btn);
    document.body.appendChild(bar);
    // Push the merchant page content down so the bar doesn't overlap
    // the page's own header / nav.
    var h = bar.offsetHeight;
    document.body.style.paddingTop = (h + 4) + 'px';
  })();`;
}
