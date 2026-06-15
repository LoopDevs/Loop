# Cold Audit — Catalog Operator Tooling (V20)

> Vertical: `tools/ctx-catalog/**` — operator scripts that mutate a **shared
> production CTX catalog** (`PUT /merchants/:id`, `POST /files`, `POST
/merchants`, status disable) and resolve brand data via external APIs
> (logo.dev, Tavily, scraping). Branch `fix/stranded-order-hardening`.
> Adversarial cold read against Part-1 dimensions §2/§4/§14 + checklist V20.
> Risk-proportionate: these are one-shot operator scripts, not server code —
> but the ones that write to prod, and the review servers that gate those
> writes, are judged at production severity.

## Coverage

Files examined in full (47 active + 1 archived spot-check + README + cross-cutting sweeps):

**Direct prod writers (`PUT`/`POST` to spend.ctx.com)**

- `ctx-content-apply.mjs` (logo/cover S3 upload + info PUT; review-gated, --apply)
- `ctx-name-ai-apply.mjs` (rename PUT; --apply)
- `ctx-name-decountry.mjs` (rename PUT; --apply, collision-refusal)
- `tillo-allocate.mjs` / `svs-allocate.mjs` / `ezpin-allocate.mjs` (create+config / link discounts; --dry-run)
- `ezpin-availability-sweep.mjs` (status:disabled / discount-trim PUT; --apply)
- `archive/ctx-apply.mjs` (spot-checked — the consumed mass writer: --dry-run default, --apply gate)

**Prod reads (admin token, GET-only)**

- `pull-fresh.mjs`, `pull-tillo-svs.mjs`, `pull-ezpin-catalogs.mjs`, `pull-ezpin-retailer.mjs`, `supplier-pull.mjs`, `recount.mjs`

**Local transforms / plan builders (no network or external-only)**

- `ctx-content-merge.mjs`, `ctx-content-expand.mjs`, `ctx-content-group.mjs`, `ctx-content-to-review.mjs`, `ctx-merge-intros.mjs`, `ctx-note-apply.mjs`, `ctx-text-fix.mjs`, `ctx-text-clean.mjs`, `ctx-text-template.mjs`, `ctx-consolidate-scan.mjs`, `ctx-consolidate-finalize.mjs`, `supplier-dedup.mjs`

**External resolve / scrape (logo.dev / Tavily / arbitrary web)**

- `ctx-logo-resolve.mjs`, `ctx-logo-resource.mjs`, `ctx-domain-resolve.mjs`, `resolve-missing-domains.mjs`, `fetch-logos.mjs`, `scrape-media.mjs`, `scrape-media-proxied.mjs`, `scrape-merchant-images-v2.mjs`, `scrape-headers-deep.mjs`, `source-images-search.mjs`, `source-images-tavily.mjs`, `warm-img-cache.mjs`

**Review servers (trust gate before apply)**

- `review-server.mjs`, `domain-review-server.mjs`

**QC scanners / visualizers (read-only → /tmp reports/images)**

- `ctx-image-validate.mjs`, `ctx-anomalies.mjs`, `ctx-dup-scan.mjs`, `ctx-provider-gaps.mjs`, `logo-dims.mjs`, `logo-opacity-scan.mjs`, `build-logo-sheets.mjs`, `build-logo-montages.mjs`, `build-cover-sheets.mjs`

**DB writer**

- `demo-seed.mjs` (Postgres, not CTX)

Cross-cutting sweeps run over the whole tree (incl. `archive/`): hardcoded-secret
grep (clean), token/key/proxy-log grep, git-tracking state, token-source parity
vs README, `.listen()` bind-address grep.

Not examined line-by-line: the 34 `archive/*.mjs` consumed one-shot passes
(`ctx-apply.mjs` spot-checked as representative; the rest are documented as
non-re-runnable — their `/tmp` inputs are gone). The shared SSRF-relevant fetch
helper `logo-dims.mjs#imageDimensions` was examined as it is imported by several
scrapers.

## Summary

Severity counts: **P0 = 3, P1 = 6, P2 = 9, P3 = 11.**

The good news first: **no hardcoded or committed secrets anywhere** in the
directory (incl. archive); the CTX admin token and logo.dev/Tavily keys are read
from env or `/tmp/*.txt` and never logged (one exception, T-04). Auth headers are
correct everywhere (`Bearer ${TOKEN}` + `x-client-id: ctx_admin`). The
purpose-built mass writers — the three allocators and `archive/ctx-apply.mjs` —
are the _best_-engineered: `--dry-run`, resumable done-files, inter-request
throttle, 429/5xx backoff.

The risk is concentrated in three places:

1. **The two review servers** — the human trust gate before any prod write —
   are themselves untrusted: they bind `0.0.0.0`, have no auth/CSRF, an open
   SSRF image proxy, two confirmed stored-XSS sinks, and non-atomic unvalidated
   writes of the production-apply decisions file (T-01, T-02, T-05, T-06, T-09).
2. **`demo-seed.mjs`** is a destructive, ledger-affecting DB writer with no
   production guard (T-03).
3. **Data-quality**: the catalog has no server-side verification that a
   scraped/searched logo/cover/domain _matches the brand_; the architecture
   relies entirely on the (compromised) review gate above. `scrape-merchant-
images-v2` and the name-search cover scripts will confidently attach
   wrong-brand or generic assets, and several plan-builders amplify one wrong
   decision across a whole brand group (T-07, T-08, T-10..T-13).

Plus a class of **orphan/duplicate-merchant** hazards in the allocators on
partial failure + stale-snapshot re-run (T-08), and **doc drift** in the README
(env-first token claim false for one writer; "directory is committed" false for
~15 untracked pipeline scripts) (T-15).

---

## Findings

### P0 — Critical

**T-01 (P0) — Review servers bind `0.0.0.0`, no auth, no CSRF; they are the
production-apply trust gate.**
`review-server.mjs:309` and `domain-review-server.mjs:140` call `.listen(PORT, …)`
with **no host argument** → Node binds all interfaces (`::`/`0.0.0.0`), despite
the doc comments and log lines promising "localhost". Neither server has any
auth, token, `Origin` check, or CSRF protection. Any host on the LAN/VPN can `GET
/data` (read the full catalog) and `POST /save` (overwrite the decisions file
that `ctx-content-apply.mjs` / `archive/ctx-apply.mjs --images` consume). Poisoning
that file = approving attacker-chosen images/text or silently rejecting good
ones, which then writes to production CTX.
_Impact:_ network-reachable tampering with the production-write approval set.
_Fix:_ `.listen(PORT, '127.0.0.1', …)`; optionally a loopback-only check + a
shared-secret header. _Ref:_ checklist §2 CSRF/CORS, V20 review-gating.

**T-02 (P0) — `review-server.mjs` `/img?u=` is an open, unauthenticated SSRF
proxy.**
`review-server.mjs:267-305` fetches an arbitrary attacker-controlled `u` URL
server-side with no scheme check, no host allowlist, and no private/loopback/
link-local block — directly contradicting the repo's own mandated
`IMAGE_PROXY_ALLOWED_HOSTS` policy (CLAUDE.md / audit A-025). It does set
`Referer: origin` and only returns `image/*`, limiting _body_ exfiltration, but
the request itself still reaches `http://169.254.169.254/…` (cloud metadata),
`http://localhost:…`, and internal hosts (port-scan via status/timing). Combined
with T-01 (0.0.0.0 + no auth) this is reachable from the network.
_Impact:_ SSRF to internal/metadata endpoints from the operator host.
_Fix:_ allowlist hosts (reuse the backend image-proxy allowlist) + reject
private/loopback/link-local IPs + scheme check. _Ref:_ checklist §2 SSRF.

**T-03 (P0) — `demo-seed.mjs` is a destructive ledger writer with no production
guard.**
`demo-seed.mjs:40` defaults `DATABASE_URL` to local dev, but there is **no
`NODE_ENV`/`LOOP_ENV`/host check and no confirmation prompt** before
`DELETE FROM credit_transactions / pending_payouts / user_credits / orders WHERE
user_id = …` (lines 84-87) and fabricating a cashback balance. An operator with
`DATABASE_URL` exported to **production** (a common state after running deploy/
migration tooling in the same shell) who runs `node demo-seed.mjs` will delete a
real user's orders/credits/payouts and overwrite their balance. This violates
MEMORY.md's "user-state writes affecting ledger/payouts default to admin-only".
Queries are parameterized (no SQLi) and the pool is closed in `finally` — the
issue is purely the missing environment guard.
_Impact:_ destructive, ledger-affecting writes against prod if env is mispointed.
_Fix:_ hard-refuse unless host is localhost / `LOOP_ENV !== production`, plus a
`--yes` confirmation. _Ref:_ checklist §16/§25, MEMORY admin-only-user-writes.

### P1 — High

**T-04 (P1) — `scrape-media-proxied.mjs` logs the residential-proxy URL
(credential leak).**
`scrape-media-proxied.mjs:206` prints `proxy: ${process.env.PROXY_SERVER}` to
stdout. Residential-proxy server URLs are commonly `scheme://user:pass@host` —
so the proxy **password is written to console/CI logs**. The only active
secret-leak path found in the directory.
_Fix:_ redact to host:port only (strip userinfo). _Ref:_ checklist §2 secrets / §6 redaction.

**T-05 (P1) — `domain-review-server.mjs` `esc()` is broken → stored XSS from
catalog data.**
`domain-review-server.mjs:82`: the escape map key is `"\\""` (backslash-quote,
i.e. `\"`), **not** `"`. So when the input char is a double-quote,
`map['"']` is `undefined` and the quote is never escaped to `&quot;`. Merchant
`name`/`country`/`providers`/`domain` are rendered into double-quoted attributes
(`value="…"`, `href="…"`, `src="/favicon?d=…"`, lines 69-73). A merchant name
containing `"` breaks out of the attribute (`< >` are still escaped → attribute-
context injection, e.g. `" autofocus onfocus=…`). Catalog data is semi-trusted
scraped/supplier content, so this is a realistic stored-XSS sink in the trust
gate. _Fix:_ correct the key to `'"'`. _Ref:_ checklist §2 XSS.

**T-06 (P1) — `review-server.mjs` `srcBadge()` injects an unescaped value into an
HTML attribute → stored XSS.**
`review-server.mjs:213-218` interpolates `s` (the `logoSource`/`coverSource`
value from the scraped media JSON) **unescaped** into both
`style="color:…">'+s+'</div>'` (attribute + element text). Almost all other
untrusted text goes through `esc()` (line 234) — this is the one bypass. A source
string containing `"><script>…` executes. _Fix:_ `esc(s)` for both the color
class and the badge text; note `esc()` also doesn't escape `'` (fragile but
currently safe since attrs are double-quoted). _Ref:_ checklist §2 XSS.

**T-07 (P1) — Name→domain guessing + guaranteed fallbacks attach wrong/generic
brand assets (`scrape-merchant-images-v2.mjs`).**
`scrape-merchant-images-v2.mjs:126-153` resolves a domain via Clearbit
autocomplete on a mangled free-text name, then **blindly guesses `<slug>.com`
and accepts it on a 200/403/405** with no verification it is the right brand
(parked/squatted/unrelated domains pass). The "guaranteed" ladders (lines
302-328) then ensure every merchant gets _something_: scrape → favicon →
`ui-avatars` monogram (logo); scrape → Unsplash category stock → a single
hardcoded `DEFAULT_COVER` (cover). So a merchant can silently end up with a
stranger's logo or a generic stock photo while the script reports `✓`. Only
mitigation is provenance fields + the (compromised, see T-01) review gate.
_Impact:_ confidently-wrong brand assets pushed toward production.
_Fix:_ require brand-identity verification before accepting a guessed domain;
never auto-attach a monogram/stock cover without flagging it un-reviewed.
_Ref:_ checklist V6 catalog content quality, §1 correctness.

**T-08 (P1) — Allocator `create` partial-failure leaves orphan merchants and
re-creates duplicates on stale-snapshot re-run.**
`tillo-allocate.mjs:211-251`, `svs-allocate.mjs:195-229`, `ezpin-allocate.mjs:236-269`
each do a two-call create: `POST /merchants` then `PUT` (config + discounts +
`status:enabled`). If the `POST` succeeds but the `PUT` fails, the script logs
"created but config failed", `fail++`, `continue` — and crucially does **not**
add the key to the done-file. The new merchant exists upstream but isn't in the
stale `/tmp/ctx-fresh.json` snapshot the plan is built from, so on the next run
it is **re-planned as a fresh `create` → duplicate merchant**. There is also no
`Idempotency-Key` on `POST /merchants`, and `ctxFetch` retries POST on 5xx/429,
so a lost-response-after-success path also duplicates.
_Impact:_ orphaned (disabled-less) and duplicated merchants in the prod catalog.
_Fix:_ send an idempotency key on create; record the created id so re-runs link
rather than re-create; re-pull the snapshot between runs (or fold created ids in
locally). _Ref:_ checklist §3 idempotency, §4 partial-failure, §11.

**T-09 (P1) — Auto-approval defaults open the review gate for text/covers and for
un-inspected logos on a partial vision run (`ctx-content-to-review.mjs`).**
`ctx-content-to-review.mjs:52-56`: `cover/desc/instr/terms/intro ??= 'yes'` —
**all supplier + templated text and all covers auto-approve** and never reach the
human queue; only logos are scrutinized. Combined with `ctx-text-template.mjs`
fabricating brand-interpolated T&Cs/instructions (T-12), uninspected/fabricated
text flows to apply. Worse, `visionQCRan = visionRejects.size > 0` (line 62): if a
vision-QC pass **partially ran** (wrote a non-empty rejects file then aborted),
every low-confidence logo _not_ in the rejects set is treated as "PASSED" and
auto-approved despite never being inspected.
_Impact:_ un-reviewed content (incl. wrong logos) silently approved for prod.
_Fix:_ default text/covers to `pending`, not `yes`; gate `visionQCRan` on an
explicit completion sentinel, not "rejects file is non-empty". _Ref:_ V20 review-gating.

### P2 — Medium

**T-10 (P2) — Rep-logo fan-out clobbers members' real existing logos
(`ctx-content-expand.mjs:34-38`).** An approved rep logo is stamped onto every
group member, overwriting a member's own ctx-existing logo URL (keeping only the
"ctx-existing" source label). Any mis-grouping (T-11) turns one decision into N
wrong logos written to CTX.

**T-11 (P2) — Brand grouping false-merges (`ctx-content-group.mjs:52-54,75-80`).**
Group key = domain stem (shared/platform/aggregator domains collide unrelated
brands) or a leading-tier-word collapse ("Premium \*" → "premium"). False merges
feed the fan-out in T-10. Same over-aggressive `canon()` collision class appears
in `supplier-dedup.mjs:48-58` (the matcher the apply scripts consume) and
`ctx-note-apply.mjs:44` (`repId.startsWith(key)` returns the first prefix match →
can mutate the wrong brand's members).

**T-12 (P2) — Fabricated T&Cs / redemption instructions at scale
(`ctx-text-template.mjs:26-60`).** Synthesizes generic legally-flavored terms and
instructions ("balance applied immediately", "present the barcode at the till in
any participating store") and writes them as authoritative for thousands of
merchants — assertions that are false for online-only / non-store brands. Filled
only-when-empty (good), but auto-approved by T-09. Correctness/compliance risk.

**T-13 (P2) — Destructive text-blanking with no original-content backup
(`ctx-text-fix.mjs:97-104`).** Blanks `intro/description/instructions/terms`
group-wide on an LLM `why` flag (wrong-brand/misleading). A false-positive flag
wipes good supplier copy with no backup file — recoverable only by re-running the
whole merge from supplier pulls. The "empty beats wrong" stance is defensible but
the absence of a pre-fix snapshot is not.

**T-14 (P2) — Consolidation auto-merges exact-name clusters (disable loser +
union discounts) with no per-cluster human verify (`ctx-consolidate-scan.mjs:66-153`).**
Only fuzzy pass-2 candidates go to AI-verify; exact normalized-name collisions
silently produce disable + discount-union instructions. Aggressive normalization
can collapse two distinct brands in a country → one disabled merchant. Survivor
`score` uses `new Date(m.created)` → `NaN` on missing field → nondeterministic
keeper choice (could keep the empty record, disable the rich one); same in
`ctx-consolidate-finalize.mjs:51`.

**T-15 (P2) — README drift vs reality (`tools/ctx-catalog/README.md`).**
(a) "every script reads `process.env.CTX_TOKEN`, falling back to `/tmp`" is false
for `ctx-name-ai-apply.mjs:17` — a prod **writer** that reads `/tmp/ctx-token.txt`
**only** (no env override). (b) The README's whole rationale is "committed so they
survive machine loss", yet ~15 pipeline scripts (`ctx-content-*`,
`ctx-consolidate-*`, `ctx-logo-resolve`, `ctx-image-validate`, …) are
**untracked** in git — the exact machine-loss exposure the doc claims to close.
(c) README says logo.dev is a publishable `pk_` key, but `ctx-logo-resolve.mjs:14`
and `resolve-missing-domains.mjs:11` use the **secret `sk_`** Brand Search key
(`Authorization: Bearer`). (d) No `AGENTS.md` exists in the directory despite the
repo-wide per-package-AGENTS convention.

**T-16 (P2) — `ezpin-availability-sweep.mjs` mass-disables prod on a single
supplier signal with no blast-radius floor (`:139-171`).** `--apply` (no second
confirmation, no `--yes`) fires `PUT status:'disabled'` / discount-trim based
solely on EzPin `delivery_type === 0`. A supplier API regression returning 0 for
everything would mass-disable the catalog; there is no "abort if > N% / N
merchants would be disabled" sanity cap. Also writes
`statusReason:'administrator_error'` (line 151) — a misleading audit-trail reason
for an automated stock sweep.

**T-17 (P2) — `supplier-pull.mjs` token not trimmed + weak pull resilience
(`:17,21-32`).** `process.env.CTX_TOKEN || readFileSync(...).trim()` binds
`.trim()` to the file branch only → an env token with a trailing newline yields a
malformed `Authorization` header (401). `getJson` retries only 429 (not 5xx /
network) and has **no fetch timeout** → one transient 502 aborts the multi-
thousand-row pull with no resume; a hung socket hangs forever. (pull-fresh /
pull-tillo-svs got the trim right and have backoff, but share a latent
`getJson`-returns-`undefined`-after-exhaustion bug.)

**T-18 (P2) — SSRF-shaped arbitrary-URL server-side fetch across the scrapers
(no allowlist/private-IP guard).** `scrape-media.mjs:115-129`,
`scrape-merchant-images-v2`, `scrape-headers-deep` (via `logo-dims.mjs#imageDimensions`),
`source-images-*`, and `warm-img-cache.mjs:36-48` fetch extracted/searched URLs
(incl. supplier-controlled `website_url`) server-side with no allowlist or
private-IP block; an on-page `<img src="http://169.254.169.254/…">` would be
fetched. Proportionate to operator-on-dev-machine tooling (and the proxied
variant mostly egresses via proxy — though `logo-dims` bypasses the proxy with
bare `fetch`), but a real concern if ever run on a cloud box. Cheap fix: a
private/loopback reject in the shared `imageDimensions`/`validImage` helpers.

### P3 — Low

**T-19 (P3)** — `ctx-logo-resolve.mjs:80` `pick()` does `r.domain.split('.')`
with no guard; a logo.dev result missing `domain` throws inside the un-try/caught
main loop → whole run dies with no resumability (re-queries the paid API from
scratch).

**T-20 (P3)** — No `Idempotency-Key` on any `POST /merchants` / `PUT` across all
writers (allocators, `ctx-content-apply`, `ctx-name-*-apply`, `archive/ctx-apply`).
Renames/links are idempotent-in-effect so low risk, but create is not (see T-08).

**T-21 (P3)** — No inter-request throttle on the `ctx-name-decountry.mjs:291-300`
and `ctx-name-ai-apply.mjs:99-124` prod PUT loops (fire as fast as the event loop
allows); failed ids are printed but never persisted to a retry manifest.

**T-22 (P3)** — `ctx-text-clean.mjs:91-96` silently truncates `terms` (legal
text) at 6000 chars; the `unwrapNewlines` regex (line 72) computes offsets
against the wrong (already-transformed) string → mangled descriptions.

**T-23 (P3)** — `/save` writes on both review servers
(`review-server.mjs:252-265`, `domain-review-server.mjs:100-113`) are non-atomic
(raw `writeFileSync`, no temp+rename → corruption on crash/disconnect),
unvalidated (no `JSON.parse`), and unbounded (`body += c` with no size cap →
memory DoS). The file is the production-apply input.

**T-24 (P3)** — Unguarded `JSON.parse(readFileSync(...))` inside request handlers
(`review-server.mjs:31`, `domain-review-server.mjs:94`) → a missing/malformed
input file throws an uncaught exception that crashes the running server.

**T-25 (P3)** — `recount.mjs:8-15` has no try/catch/retry around the prod CTX
pagination; a single failed page yields a truncated `/tmp/ctx-fresh.json` that
silently corrupts every downstream scanner that reads it.

**T-26 (P3)** — `build-logo-sheets.mjs:37` and `build-cover-sheets.mjs:30`
interpolate raw unescaped `logoUrl`/`url` into `<img src>` rendered in headless
Chromium with multi-second waits → script/remote-content execution from catalog
data in a local browser. (`build-logo-montages.mjs` does it safely from local
files + `esc()`.)

**T-27 (P3)** — `logo-opacity-scan.mjs:8` hardcodes an absolute machine path
(`/Users/ash/code/loop-app/apps/backend/`) to resolve `sharp` → breaks for any
other operator / CI.

**T-28 (P3)** — `ctx-domain-resolve.mjs:74-93` `liveMeta` fetches arbitrary
candidate domains server-side with `redirect:'follow'` and no SSRF guard (read-
only, writes to a review file — low risk, noted for completeness).

**T-29 (P3)** — `pull-ezpin-retailer.mjs:47` dumps a raw supplier row to stdout
(`sample row: …`) — uncontrolled echo of an upstream payload into logs.

**T-30 (P3)** — `source-images-tavily.mjs:84` brand-owned-domain check
`im.url.includes(root)` is a loose substring match (`adidas.com.evil.example`
passes); use a hostname-suffix comparison.

**T-31 (P3)** — `ctx-anomalies.mjs:33` mojibake regex and `ctx-image-validate.mjs`
64KB-range parse (progressive JPEG SOF beyond 64KB mis-flagged "unparseable") are
imprecise heuristics — human-triaged, harmless, but unreliable.

---

### Positive observations (defensive credit)

- No hardcoded/committed secrets anywhere in `tools/ctx-catalog/**` (incl.
  archive); tokens/keys read from env or `/tmp/*.txt`, never logged (sole
  exception T-04).
- Auth headers correct on every writer (`Bearer` + `x-client-id: ctx_admin`).
- The three allocators + `archive/ctx-apply.mjs` are well-engineered: `--dry-run`
  default/gate, resumable done-files, inter-request throttle, 429/5xx backoff,
  collision detection (`ctx-name-ai-apply` does a global post-rename collision
  check; `ctx-name-decountry` refuses to apply on induced collisions).
- `ctx-content-apply.mjs` refuses `--apply` without the review-decisions file and
  passes through existing CTX-S3 URLs verbatim (no needless re-upload).
- Many transforms correctly fill-only-when-empty (`ctx-merge-intros`,
  `ctx-text-template`) rather than clobbering supplier copy.
