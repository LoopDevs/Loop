/**
 * CTX `/ws` giftcard-topic client — event-driven order-mirror
 * maintenance (ADR 052).
 *
 * ctx owns the order lifecycle; this maintainer subscribes to the
 * giftcard topic with the operator API key and applies status events
 * onto the local mirror rows:
 *
 *   GET {GIFT_CARD_API_BASE_URL}/ws        (http → ws upgrade)
 *   headers: X-Api-Key / X-Api-Secret      (operator API creds)
 *   → send  {"action":"subscribe","topic":"giftcard"}
 *   ← recv  {"type":"event","topic":"giftcard",
 *            "event":"system.giftcard.paid","data":{...card}}
 *
 * The operator-scoped payload carries `operatorReference` — the Loop
 * order row id — so events key straight onto the mirror (fallback:
 * `ctx_order_id`). Payloads never carry redemption secrets (CTX
 * builds them `ShowDetails:false`); on `fulfilled` we do one
 * authoritative `GET /gift-cards/:id` for the codes.
 *
 * Same lifecycle discipline as `merchants/ws-maintainer.ts`:
 * undici WebSocket with the operator auth headers on the upgrade
 * (the env schema guarantees the creds at boot), exponential
 * reconnect (1s → 60s, ±25% jitter), and the mirror sweep
 * (`orders/ctx-mirror-sweep.ts`) as the missed-event safety net —
 * the ws has no replay.
 */
import { z } from 'zod';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { CtxGiftCardSchema } from '../orders/ctx-order.js';
import { applyCtxCardStatus, resolveOrderForCard } from '../orders/mirror-apply.js';

const log = logger.child({ module: 'giftcard-ws' });

const SUBSCRIBE_COMMAND = JSON.stringify({ action: 'subscribe', topic: 'giftcard' });
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

const GIFTCARD_EVENTS = new Set([
  'system.giftcard.created',
  'system.giftcard.paid',
  'system.giftcard.fulfilled',
  'system.giftcard.rejected',
  'system.giftcard.refunded',
  'system.giftcard.display_status_updated',
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

export type GiftcardWsStatus = 'disabled' | 'connecting' | 'connected';

let socket: WebSocket | null = null;
let status: GiftcardWsStatus = 'disabled';
let reconnectTimer: NodeJS.Timeout | null = null;
let backoffMs = BACKOFF_INITIAL_MS;
let stopped = true;

/** Current connection state, surfaced by /health. */
export function getGiftcardWsStatus(): GiftcardWsStatus {
  return status;
}

export function startGiftcardWs(): void {
  stopped = false;
  connect();
}

export function stopGiftcardWs(): void {
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
    ws = new WebSocket(wsUrl(), {
      headers: {
        'X-Api-Key': config.ctx.credentials.key,
        'X-Api-Secret': config.ctx.credentials.secret,
      },
    } as unknown as string[]);
  } catch (err) {
    log.error({ err }, 'CTX giftcard ws construction failed');
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
    /* a close event always follows; reconnect is scheduled there */
  };

  ws.onclose = (event) => {
    if (socket === ws) socket = null;
    if (stopped) return;
    log.warn(
      { code: event.code, reason: event.reason, backoffMs },
      'CTX giftcard ws closed — scheduling reconnect',
    );
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer !== null) return;
  status = 'connecting';
  const jitter = 1 + (Math.random() - 0.5) * 0.5;
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
    log.warn({ raw: raw.slice(0, 200) }, 'CTX giftcard ws sent non-JSON message — ignoring');
    return;
  }
  const message = WsMessageSchema.safeParse(parsed);
  if (!message.success) {
    log.warn({ raw: raw.slice(0, 200) }, 'CTX giftcard ws message has unexpected shape — ignoring');
    return;
  }

  const msg = message.data;
  switch (msg.type) {
    case 'ok':
      if (msg.action === 'subscribe') {
        status = 'connected';
        backoffMs = BACKOFF_INITIAL_MS;
        log.info('CTX ws giftcard subscription active');
        // Events during a disconnect window are unrecoverable — the
        // mirror sweep is the standing reconciler, no resync here.
      }
      return;

    case 'error':
      log.error({ action: msg.action, error: msg.error }, 'CTX giftcard ws returned an error');
      return;

    case 'event':
      void handleGiftcardEvent(msg.event ?? '', msg.data).catch((err: unknown) => {
        log.error({ event: msg.event, err }, 'CTX giftcard ws event handling failed');
      });
      return;
  }
}

async function handleGiftcardEvent(eventName: string, data: unknown): Promise<void> {
  if (!GIFTCARD_EVENTS.has(eventName)) return;

  const cardParsed = CtxGiftCardSchema.safeParse(data);
  if (!cardParsed.success) {
    log.warn(
      { event: eventName, issues: cardParsed.error.issues.slice(0, 5) },
      'CTX giftcard ws event payload failed validation — ignoring',
    );
    return;
  }
  const card = cardParsed.data;

  const order = await resolveOrderForCard(card);
  if (order === null) return;
  await applyCtxCardStatus(order, card);
}

/** Test seam: feeds a raw ws frame through the message handler. */
export function __handleGiftcardWsMessageForTests(raw: string): void {
  handleMessage(raw);
}

/** Test seam: resets module state between tests. */
export function __resetGiftcardWsForTests(): void {
  stopGiftcardWs();
  backoffMs = BACKOFF_INITIAL_MS;
  stopped = true;
}
