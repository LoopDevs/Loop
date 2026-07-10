/**
 * Payout channel accounts (ADR 044 / S4-1).
 *
 * Sequence-number contention is the payout worker's throughput ceiling
 * (ADR 016 + hardening A8): every Stellar transaction from an account
 * consumes that account's next sequence number, so submits from the
 * SAME account must be strictly serial. A "channel account" is the
 * standard Stellar pattern for lifting that ceiling without touching
 * the money-holding topology: N pre-funded accounts act as the
 * transaction SOURCE (own the sequence number, pay the fee) while the
 * Payment operation's op-level `source` stays the real funding account
 * (the operator, or — for `kind='interest_mint'` rows — an ADR 031
 * issuer). N independent sequence streams → N payouts can submit
 * concurrently with zero risk of racing each other's `tx_bad_seq`.
 * Channels never hold or move the LOOP asset.
 *
 * `LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS` is the ONLY input — a
 * comma-separated list of Stellar secret keys, mirroring the
 * `IMAGE_PROXY_ALLOWED_HOSTS` comma-list convention elsewhere in this
 * backend's env surface. List length IS "N"; there is no separate
 * count var to drift out of sync with the secrets. Empty/unset →
 * zero channels → the payout worker's legacy single-sequence, fully
 * serial path (byte-identical behaviour — this is what "N=1-preserving"
 * means in the S4-1 tracker: no channels configured is the safe
 * default an operator opts out of, not a mode the code has to get
 * right as a special case).
 *
 * `parseEnv` (env.ts) boot-validates: each entry is a well-formed
 * Stellar secret, no two entries derive the same account, and no
 * channel account collides with the operator account or any
 * configured issuer account (a colliding channel would silently
 * reintroduce the exact sequence race channels exist to avoid). This
 * module re-derives + re-asserts the no-duplicate invariant as
 * defence-in-depth, mirroring `issuer-signers.ts`'s posture for test
 * environments that mock `env.js` inconsistently with `parseEnv`.
 */
import { Keypair } from '@stellar/stellar-sdk';
import { env } from '../env.js';

export interface ChannelSigner {
  /** Channel account's Stellar secret key (`S...`). Never logged. */
  secret: string;
  /** Channel account public key, derived from `secret`. */
  account: string;
}

let cached: readonly ChannelSigner[] | null = null;

/** Test seam: forces re-derivation after a test mutates the env mock. */
export function __resetPayoutChannelsForTests(): void {
  cached = null;
}

function parseChannelSecrets(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolves the configured payout channel accounts, in the order they
 * were listed (the payout worker shards claimed rows across this array
 * by index, so order only affects which channel a given row lands on —
 * not correctness). Empty array when
 * `LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS` is unset — the payout worker's
 * legacy no-channel path.
 */
export function resolvePayoutChannels(): readonly ChannelSigner[] {
  if (cached !== null) return cached;
  const secrets = parseChannelSecrets(env.LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS);
  const out: ChannelSigner[] = [];
  const seenAccounts = new Set<string>();
  for (const secret of secrets) {
    const account = Keypair.fromSecret(secret).publicKey();
    if (seenAccounts.has(account)) {
      throw new Error(
        `LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS lists account ${account} more than once — each ` +
          `channel must be a distinct account (ADR 044)`,
      );
    }
    seenAccounts.add(account);
    out.push({ secret, account });
  }
  cached = out;
  return cached;
}
