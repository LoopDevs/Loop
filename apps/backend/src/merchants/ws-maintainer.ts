// CTX `/ws` merchant-topic client — event-driven merchant-store maintenance
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

const EVENT_DELETED = 'system.merchant.deleted';
const MERCHANT_EVENTS = new Set([
  'system.merchant.created',
  'system.merchant.updated',
  'system.merchant.status_changed',
  EVENT_DELETED,
  // Merchant-LINK mutations arrive on the same topic with the same
  // merchant-shaped payload — CTX resolves the link to its merchant
  // before delivery, so the handling below is identical.
  'system.merchantlink.created',
  'system.merchantlink.updated',
  'system.merchantlink.status_changed',
]);

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
let hadSession = false;

export function getMerchantWsStatus(): MerchantWsStatus {
  return status;
}

export function startMerchantWs(): void {
  stopped = false;
  connect();
}

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

export function __handleWsMessageForTests(raw: string): void {
  handleMessage(raw);
}

export function __resetMerchantWsForTests(): void {
  stopMerchantWs();
  backoffMs = BACKOFF_INITIAL_MS;
  hadSession = false;
  stopped = true;
  status = 'disabled';
}
