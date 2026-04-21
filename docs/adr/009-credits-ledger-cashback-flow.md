# ADR 009: Credits ledger and cashback flow

Status: Proposed
Date: 2026-04-21
Related: ADR 010 (principal switch + payment rails), ADR 011 (admin panel)

## Context

Loop's product is evolving from a gift-card affiliate surface into a
cashback product. Users buy gift cards through Loop, earn cashback on
each purchase, accrue a balance in their regional currency (GBP / USD
/ EUR), earn interest on that balance, and can withdraw to a bank
account when they want to cash out.

This is **platform credit**, not a crypto wallet and not a bank
account. Users never top up — the balance only ever grows from Loop
paying them cashback (and interest on that cashback). Legally, this
is closer to airline miles with a cash-out, or an Amazon account
balance, than to a deposit-taking institution.

Two constraints shape the design:

1. **Zero crypto UX.** Users see a GBP / USD / EUR balance. They do
   not manage keys, see addresses, sign transactions, or even
   know a Stellar-settled layer exists.
2. **A clean ledger with interest.** We want a single source of
   truth for every movement (cashback credit, interest accrual,
   withdrawal, spend) so an auditor or support engineer can
   reconstruct any user's balance history from first principles.

Earlier exploration (captured in session notes 2026-04-21) looked
at embedded wallets via Privy / dfns / Turnkey. All three were
rejected because exposing the wallet primitives — passkeys, seed
phrases, recovery factors — didn't match the product framing. The
product is store credit; a wallet would be a distraction.

## Decision

### Off-chain Postgres ledger is the source of truth

Every user has a single balance row per currency, and every movement
is recorded as an immutable append-only transaction row:

```sql
CREATE TABLE user_credits (
  user_id       UUID PRIMARY KEY REFERENCES users(id),
  currency      CHAR(3)  NOT NULL,               -- 'GBP' | 'USD' | 'EUR'
  balance_minor BIGINT   NOT NULL DEFAULT 0,     -- integer minor units
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE credit_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  type            TEXT NOT NULL,  -- see `CreditTransactionType` below
  amount_minor    BIGINT NOT NULL,                -- signed
  currency        CHAR(3) NOT NULL,
  reference_type  TEXT,                           -- 'order' | 'payout' | null
  reference_id    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX credit_transactions_user_created
  ON credit_transactions(user_id, created_at DESC);
```

Transaction types:

| Type         | Sign     | Source                                                 |
| ------------ | -------- | ------------------------------------------------------ |
| `cashback`   | positive | Order completion, per ADR 010                          |
| `interest`   | positive | Nightly accrual batch, per-user                        |
| `spend`      | negative | User pays for a gift card from their balance (ADR 010) |
| `withdrawal` | negative | User requests a bank payout                            |
| `refund`     | positive | Reversal of a failed `spend` or `withdrawal`           |
| `adjustment` | either   | Manual support correction, audited                     |

Balance updates are always paired with an insert into
`credit_transactions` inside the same transaction. The
`user_credits.balance_minor` is a materialised sum that we can
recompute from the transaction log as an audit check.

### Treasury sits behind the ledger

User-owed money is backed by Loop-controlled reserves:

- **USD** → USDC held in custody (Anchorage / BitGo / Fireblocks —
  provider selected in a follow-up ADR when we're ready to
  commercially commit).
- **EUR** → EURC, same custody model.
- **GBP** → segregated GBP at a UK corporate bank, ring-fenced from
  Loop operating funds.

Yield is generated on the stablecoin pools via DeFindex (Stellar
Soroban) at Loop's treasury level and flows into Loop's operating
account. Users see an interest rate; Loop bears the risk of the
underlying yield strategy.

### Loop-issued stablecoins are a later upgrade, not a launch requirement

USDLOOP / EURLOOP / GBPLOOP are valuable to issue once scale makes
the float economics outweigh the compliance cost (typically ~100k
active balances). Until then the treasury runs on third-party
regulated stablecoins (USDC / EURC) and a GBP corporate bank account.

The ledger architecture above is invariant to the treasury asset:
when a LOOP stablecoin is issued, it's a treasury-side swap, not a
ledger migration. Nothing in the Postgres schema references a
specific token.

### Interest accrual

A nightly batch job computes `balance_minor × daily_rate` per user
per currency, inserts a `credit_transactions (type=interest)` row,
and updates `user_credits.balance_minor`. The daily rate is
configured per currency, feature-flagged off until counsel confirms
the framing of "interest on promotional credits" in each target
market.

### Withdrawal rails

Out of scope for this ADR — see ADR 010 for the principal-switch
plumbing. Withdrawal triggers a `credit_transactions (type=
withdrawal)` row, a debit of `user_credits`, and kicks an external
payout through a partner (Stripe / Modulr / Wise Business).
Withdrawal v1 is support-ticket-gated so we ship the visible product
before the full integration.

## Alternatives considered

1. **Per-user on-chain wallet (Privy / Turnkey / dfns).** Rejected:
   the product framing is store credit, and every wallet primitive
   we exposed to users was a distraction or a footgun.
2. **Full custody as a bank-like product.** Rejected: imposes
   banking-regulation costs (EMI authorisation, safeguarding,
   continuous auditing) for a product that only needs to track
   promotional credit.
3. **Event-sourced ledger with no materialised balance.** Considered.
   Append-only transactions plus materialised balance is the middle
   ground — O(1) balance reads, full history available, reconciliation
   by replay. Pure event-sourcing would require a projection layer
   we don't otherwise need.
4. **Stablecoin-per-user omnibus holdings at the issuer.** Rejected:
   adds per-user wallet management with no user-visible benefit.
   Treasury is easier to run as a single omnibus per currency.

## Consequences

- Schema is two tables. Every feature in the product (cashback,
  interest, spend, withdrawal, refunds) is a different
  `credit_transactions.type` — cheap to add.
- Loop becomes custodian of user-owed credit. Regulatory framing as
  "promotional credit with cash-out option" must be confirmed per
  market, with particular attention to the interest-accrual line
  (easy to accidentally structure as a deposit).
- DeFindex integration lives at the treasury level — users never
  interact with Stellar, Soroban, or contract invocations.
- Future LOOP-stablecoin issuance is a treasury-asset swap at
  scheduled maintenance windows, not a schema migration.

## References

- `docs/roadmap.md` (when updated with the cashback product line).
- Session transcript 2026-04-21, exploration of wallet /
  custody / stablecoin trade-offs.
