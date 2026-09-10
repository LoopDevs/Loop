// Sentry PII scrubber — A2-1308, A4-039, A4-074, OBS-04

import { REDACT_PATHS } from './logger.js';

// Derived from REDACT_PATHS to prevent drift between logger and Sentry scrubbing (OBS-04).
const SENSITIVE_KEYS: ReadonlySet<string> = new Set(
  REDACT_PATHS.map((path) => path.slice(path.lastIndexOf('.') + 1).toLowerCase()),
);

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER_RE = /Bearer\s+[A-Za-z0-9_.\-+/=]{16,}/g;
const STELLAR_SECRET_RE = /S[A-Z2-7]{55}/g;
// 32+ hex avoids nuking common UUID-shaped order ids (32-char without dashes)
const LONG_HEX_RE = /[a-fA-F0-9]{32,}/g;

export interface SentryEventLike {
  message?: string;
  request?: {
    headers?: Record<string, unknown>;
    data?: unknown;
    cookies?: Record<string, unknown>;
  };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  user?: Record<string, unknown>;
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      [k: string]: unknown;
    }>;
  };
  breadcrumbs?: Array<{
    message?: string;
    data?: Record<string, unknown>;
    [k: string]: unknown;
  }>;
}

export function scrubSentryString(s: string): string {
  return s
    .replace(EMAIL_RE, '[REDACTED_EMAIL]')
    .replace(BEARER_RE, '[REDACTED_BEARER]')
    .replace(STELLAR_SECRET_RE, '[REDACTED_STELLAR_SECRET]')
    .replace(LONG_HEX_RE, '[REDACTED_HEX]');
}

export function scrubSentryEvent<T extends SentryEventLike>(event: T): T {
  try {
    const scrubbed = { ...event };
    if (event.message !== undefined) {
      scrubbed.message = scrubSentryString(event.message);
    }
    if (event.request !== undefined) {
      scrubbed.request = {
        ...event.request,
        ...(event.request.headers !== undefined
          ? { headers: scrubObject(event.request.headers) }
          : {}),
        ...(event.request.data !== undefined ? { data: scrubAny(event.request.data) } : {}),
        ...(event.request.cookies !== undefined
          ? { cookies: scrubObject(event.request.cookies) }
          : {}),
      };
    }
    if (event.extra !== undefined) scrubbed.extra = scrubObject(event.extra);
    if (event.contexts !== undefined) scrubbed.contexts = scrubObject(event.contexts);
    if (event.tags !== undefined) scrubbed.tags = scrubObject(event.tags);
    // Guard null explicitly to avoid throwing and abandoning scrub of prior regions
    if (event.user !== undefined && event.user !== null) {
      scrubbed.user = scrubObject(event.user);
    }
    if (event.exception?.values !== undefined) {
      scrubbed.exception = {
        ...event.exception,
        values: event.exception.values.map((v) => ({
          ...v,
          ...(typeof v.value === 'string' ? { value: scrubSentryString(v.value) } : {}),
        })),
      };
    }
    if (event.breadcrumbs !== undefined) {
      scrubbed.breadcrumbs = event.breadcrumbs.map((b) => ({
        ...b,
        ...(typeof b.message === 'string' ? { message: scrubSentryString(b.message) } : {}),
        ...(b.data !== undefined ? { data: scrubObject(b.data) } : {}),
      }));
    }
    return scrubbed;
  } catch {
    return event;
  }
}

function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = value === null || value === undefined ? value : '[REDACTED]';
    } else {
      out[key] = scrubAny(value);
    }
  }
  return out;
}

function scrubAny(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(scrubAny);
  if (typeof value === 'object') return scrubObject(value as Record<string, unknown>);
  if (typeof value === 'string') return scrubSentryString(value);
  return value;
}
