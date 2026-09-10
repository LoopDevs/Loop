// CTX `/ws` connection owner — single-socket topic pubsub (ADR 052)
import { z } from 'zod';
import { config } from '../config/index.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'ctx-ws' });

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

const WsMessageSchema = z
  .object({
    type: z.enum(['ok', 'error', 'event']),
    action: z.string().optional(),
    error: z.string().optional(),
    topic: z.string().optional(),
    event: z.string().optional(),
    data: z.unknown().optional(),
    subscriptions: z.array(z.string()).optional(),
  })
  .passthrough();

export interface CtxWsTopicHandler {
  topic: string;
  events: ReadonlySet<string>;
  onEvent: (eventName: string, data: unknown) => void | Promise<void>;
  onSubscribed?: (info: { resubscribe: boolean }) => void;
}

export type CtxWsStatus = 'disabled' | 'connecting' | 'connected';

const handlers: CtxWsTopicHandler[] = [];
const subscribedTopics = new Set<string>();
const everSubscribedTopics = new Set<string>();

let socket: WebSocket | null = null;
let status: CtxWsStatus = 'disabled';
let reconnectTimer: NodeJS.Timeout | null = null;
let backoffMs = BACKOFF_INITIAL_MS;
let stopped = true;

export function getCtxWsStatus(): CtxWsStatus {
  return status;
}

export function getCtxWsSubscribedTopics(): string[] {
  return [...subscribedTopics].sort();
}

export function registerCtxWsTopic(handler: CtxWsTopicHandler): void {
  if (handlers.some((h) => h.topic === handler.topic)) {
    throw new Error(`CTX ws topic '${handler.topic}' is already registered`);
  }
  handlers.push(handler);
  if (socket !== null && socket.readyState === WebSocket.OPEN) {
    socket.send(subscribeCommand(handler.topic));
  }
}

export function startCtxWs(): void {
  stopped = false;
  connect();
}

export function stopCtxWs(): void {
  stopped = true;
  status = 'disabled';
  subscribedTopics.clear();
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

function subscribeCommand(topic: string): string {
  return JSON.stringify({ action: 'subscribe', topic });
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
    for (const handler of handlers) {
      ws.send(subscribeCommand(handler.topic));
    }
  };

  ws.onmessage = (event) => {
    handleMessage(typeof event.data === 'string' ? event.data : '');
  };

  ws.onerror = () => {
    // A close event always follows; reconnect is scheduled there.
  };

  ws.onclose = (event) => {
    if (socket === ws) socket = null;
    subscribedTopics.clear();
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
      if (msg.action === 'subscribe') handleSubscribeAck(msg);
      return;

    case 'error':
      // e.g. "not authorized" on subscribe — no point hammering CTX
      // with instant retries; the backoff loop handles cadence after
      // the server closes, and a manual creds fix needs a redeploy
      // anyway.
      log.error({ action: msg.action, error: msg.error }, 'CTX ws returned an error');
      return;

    case 'event':
      dispatchEvent(msg.event ?? '', msg.data);
      return;
  }
}

function handleSubscribeAck(msg: {
  subscriptions?: string[] | undefined;
  topic?: string | undefined;
}): void {
  for (const topic of ackedTopics(msg)) {
    markTopicSubscribed(topic);
  }
  if (handlers.every((h) => subscribedTopics.has(h.topic))) status = 'connected';
}

function ackedTopics(msg: {
  subscriptions?: string[] | undefined;
  topic?: string | undefined;
}): string[] {
  if (msg.subscriptions !== undefined) return msg.subscriptions;
  if (msg.topic !== undefined) return [msg.topic];
  const oldestUnacked = handlers.find((h) => !subscribedTopics.has(h.topic));
  return oldestUnacked === undefined ? [] : [oldestUnacked.topic];
}

function markTopicSubscribed(topic: string): void {
  const handler = handlers.find((h) => h.topic === topic);
  if (handler === undefined || subscribedTopics.has(topic)) return;
  subscribedTopics.add(topic);
  backoffMs = BACKOFF_INITIAL_MS;
  log.info({ topic }, 'CTX ws topic subscription active');
  const resubscribe = everSubscribedTopics.has(topic);
  everSubscribedTopics.add(topic);
  if (handler.onSubscribed !== undefined) handler.onSubscribed({ resubscribe });
}

function dispatchEvent(eventName: string, data: unknown): void {
  const handler = handlers.find((h) => h.events.has(eventName));
  if (handler === undefined) return;
  void Promise.resolve(handler.onEvent(eventName, data)).catch((err: unknown) => {
    log.error({ topic: handler.topic, event: eventName, err }, 'CTX ws event handling failed');
  });
}

export function __handleCtxWsMessageForTests(raw: string): void {
  handleMessage(raw);
}

export function __dropCtxWsSessionForTests(): void {
  subscribedTopics.clear();
  status = 'connecting';
}

export function __resetCtxWsForTests(): void {
  stopCtxWs();
  handlers.length = 0;
  everSubscribedTopics.clear();
  backoffMs = BACKOFF_INITIAL_MS;
  stopped = true;
  status = 'disabled';
}
