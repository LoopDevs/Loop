/**
 * CTX `/ws` merchant-topic client — event-driven merchant-store
 * maintenance.
 *
 * The merchant catalog is fully loaded at boot (see `./sync.ts`) and
 * then kept current by subscribing to CTX's websocket merchant topic:
 *
 *   GET {GIFT_CARD_API_BASE_URL}/ws        (http → ws upgrade)
 *   headers: X-Api-Key / X-Api-Secret      (operator API creds)
 *   → send  {"action":"subscribe","topic":"merchant"}
 *   ← recv  {"type":"ok", ...}
 *   ← recv  {"type":"event","topic":"merchant",
 *            "event":"system.merchant.updated","data":{...merchant}}
 *
 * Event payloads are the same merchant JSON shape as the REST list
 * (spend-api builds both from `merchantToJson`), so they run through
 * the exact same Zod schema + `mapUpstreamMerchant` + denylist filter
 * as the sweep before touching the store. `system.merchant.deleted`
 * (and an update that maps to null, e.g. a merchant disabled upstream)
 * removes the record.
 *
 * Lifecycle:
 *   - Authenticates the upgrade with the operator API creds (the env
 *     schema guarantees them at boot). The interval sweep stays
 *     running alongside the maintainer as the missed-event safety net.
 *   - The socket is Node's built-in (undici) WebSocket — no new
 *     dependency; the non-standard `headers` init option carries the
 *     auth headers on the upgrade request.
 *   - Reconnect on close/error with exponential backoff (1s → 60s,
 *     ±25% jitter). Every reconnect after the first successful session
 *     triggers a full `refreshMerchants()` sweep, because events that
 *     fired while disconnected are gone — the ws has no replay.
 *   - CTX pings every 20s and drops the connection after 60s without a
 *     pong; undici answers pings automatically, so a dead TCP path
 *     surfaces as a close event → backoff → reconnect.
 */
import { z } from 'zod';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import {
  applyMerchantRemoval,
  applyMerchantUpsert,
  isMerchantDenylisted,
  refreshMerchants,
} from './sync.js';
import { UpstreamMerchantSchema, mapUpstreamMerchant } from './sync-upstream.js';

const log = logger.child({ module: 'merchants-ws' });

const SUBSCRIBE_COMMAND = JSON.stringify({ action: 'subscribe', topic: 'merchant' });
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

/** CTX event names carried by the `merchant` ws topic. */
const EVENT_DELETED = 'system.merchant.deleted';
const MERCHANT_EVENTS = new Set([
  'system.merchant.created',
  'system.merchant.updated',
  'system.merchant.status_changed',
  EVENT_DELETED,
  // Merchant-LINK mutations (linking/unlinking Loop, per-link status +
  // discount changes) arrive on the same topic with the same
  // merchant-shaped payload — CTX resolves the link to its merchant
  // before delivery, so the handling below is identical.
  'system.merchantlink.created',
  'system.merchantlink.updated',
  'system.merchantlink.status_changed',
]);

/**
 * Envelope for every server → client ws message. `data` stays untyped
 * here — merchant events run it through `UpstreamMerchantSchema`.
 */
const WsMessageSchema = z
  .object({
    type: z.enum(['ok', 'error', 'event']),
    action: z.string().optional(),
    error: z.string().optional(),
    topic: z.string().optional(),
    event: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

export type MerchantWsStatus = 'disabled' | 'connecting' | 'connected';

let socket: WebSocket | null = null;
let status: MerchantWsStatus = 'disabled';
let reconnectTimer: NodeJS.Timeout | null = null;
let backoffMs = BACKOFF_INITIAL_MS;
let stopped = true;
/** True once any session has subscribed OK — gates the reconnect resync. */
let hadSession = false;

/** Current connection state, surfaced by /health. */
export function getMerchantWsStatus(): MerchantWsStatus {
  return status;
}

/** Starts the maintainer. */
export function startMerchantWs(): void {
  stopped = false;
  connect();
}

/** Stops the maintainer and closes the socket. For graceful shutdown. */
export function stopMerchantWs(): void {
  stopped = true;
  status = 'disabled';
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket !== null) {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
    socket = null;
  }
}

function wsUrl(): string {
  const base = new URL(config.ctx.baseUrl);
  base.protocol = base.protocol === 'http:' ? 'ws:' : 'wss:';
  base.pathname = `${base.pathname.replace(/\/$/, '')}/ws`;
  return base.toString();
}

function connect(): void {
  if (stopped) return;
  status = 'connecting';

  let ws: WebSocket;
  try {
    // Non-standard undici extension: the init object's `headers` ride
    // the upgrade request, which is how CTX authenticates /ws.
    ws = new WebSocket(wsUrl(), {
      headers: {
        'X-Api-Key': config.ctx.credentials.key,
        'X-Api-Secret': config.ctx.credentials.secret,
      },
    } as unknown as string[]);
  } catch (err) {
    log.error({ err }, 'CTX ws construction failed');
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    ws.send(SUBSCRIBE_COMMAND);
  };

  ws.onmessage = (event) => {
    handleMessage(typeof event.data === 'string' ? event.data : '');
  };

  ws.onerror = () => {
    // A close event always follows; reconnect is scheduled there.
  };

  ws.onclose = (event) => {
    if (socket === ws) socket = null;
    if (stopped) return;
    log.warn(
      { code: event.code, reason: event.reason, backoffMs },
      'CTX ws closed — scheduling reconnect',
    );
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer !== null) return;
  status = 'connecting';
  const jitter = 1 + (Math.random() - 0.5) * 0.5; // ±25%
  const delay = Math.round(backoffMs * jitter);
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
  reconnectTimer.unref();
}

function handleMessage(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn({ raw: raw.slice(0, 200) }, 'CTX ws sent non-JSON message — ignoring');
    return;
  }
  const message = WsMessageSchema.safeParse(parsed);
  if (!message.success) {
    log.warn({ raw: raw.slice(0, 200) }, 'CTX ws message has unexpected shape — ignoring');
    return;
  }

  const msg = message.data;
  switch (msg.type) {
    case 'ok':
      if (msg.action === 'subscribe') {
        status = 'connected';
        backoffMs = BACKOFF_INITIAL_MS;
        log.info('CTX ws merchant subscription active');
        if (hadSession) {
          // Events during the disconnect window are unrecoverable —
          // resync the whole catalog (coalesces via the sweep mutex).
          log.info('Resyncing merchant catalog after ws reconnect');
          void refreshMerchants();
        }
        hadSession = true;
      }
      return;

    case 'error':
      // e.g. "not authorized" on subscribe — no point hammering CTX
      // with instant retries; the backoff loop handles cadence after
      // the server closes, and a manual creds fix needs a redeploy
      // anyway.
      log.error({ action: msg.action, error: msg.error }, 'CTX ws returned an error');
      return;

    case 'event':
      handleMerchantEvent(msg.event ?? '', msg.data);
      return;
  }
}

function handleMerchantEvent(eventName: string, data: unknown): void {
  if (!MERCHANT_EVENTS.has(eventName)) return;

  const merchantParsed = UpstreamMerchantSchema.safeParse(data);
  if (!merchantParsed.success) {
    log.warn(
      { event: eventName, issues: merchantParsed.error.issues.slice(0, 5) },
      'CTX ws merchant event payload failed validation — ignoring',
    );
    return;
  }
  const upstream = merchantParsed.data;

  if (eventName === EVENT_DELETED) {
    applyMerchantRemoval(upstream.id);
    log.info({ merchantId: upstream.id, event: eventName }, 'Merchant removed via ws event');
    return;
  }

  if (isMerchantDenylisted(upstream.id)) {
    log.info(
      { merchantId: upstream.id, merchantName: upstream.name },
      'Merchant ws event filtered by LOOP_MERCHANT_DENYLIST',
    );
    return;
  }

  const merchant = mapUpstreamMerchant(upstream);
  if (merchant === null) {
    // Disabled upstream — the sweep would drop it, so the event drops
    // it too.
    applyMerchantRemoval(upstream.id);
    log.info({ merchantId: upstream.id, event: eventName }, 'Merchant dropped via ws event');
    return;
  }

  applyMerchantUpsert(merchant);
  log.info(
    { merchantId: merchant.id, merchantName: merchant.name, event: eventName },
    'Merchant upserted via ws event',
  );
}

/** Test seam: feeds a raw ws frame through the message handler. */
export function __handleWsMessageForTests(raw: string): void {
  handleMessage(raw);
}

/** Test seam: resets module state between tests. */
export function __resetMerchantWsForTests(): void {
  stopMerchantWs();
  backoffMs = BACKOFF_INITIAL_MS;
  hadSession = false;
  stopped = true;
  status = 'disabled';
}
