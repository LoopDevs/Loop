// Signed CTX requests: the operator key proves itself with a secp256k1 signature over a canonical digest of the request,
// in place of X-Api-Secret. Format and test vector live in spend-api/doc/handover-loop.md ("Authenticating").
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';

export type RequestBody = RequestInit['body'];

export const SIGNATURE_HEADER = 'X-Signature';
export const SIGNATURE_SCHEME_HEADER = 'X-Signature-Scheme';
export const SIGNATURE_TIMESTAMP_HEADER = 'X-Signature-Timestamp';
export const SIGNATURE_NONCE_HEADER = 'X-Signature-Nonce';
export const SIGNATURE_SCHEME = 'secp256k1';

// btcec's compact recoverable encoding: 27 + recovery id, plus 4 for a compressed public key.
const COMPACT_RECOVERY_BASE = 27 + 4;
const NONCE_BYTES = 16;

export interface CtxSignatureInput {
  method: string;
  /** Path plus query exactly as sent, e.g. `/gift-cards?page=1`. */
  uri: string;
  body: RequestBody;
  apiKey: string;
  clientId: string;
  userId: string;
  timestamp: string;
  nonce: string;
}

export type CtxSignatureHeaders = Record<
  | typeof SIGNATURE_HEADER
  | typeof SIGNATURE_SCHEME_HEADER
  | typeof SIGNATURE_TIMESTAMP_HEADER
  | typeof SIGNATURE_NONCE_HEADER,
  string
>;

export function requestUri(url: string | URL): string {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  return `${parsed.pathname}${parsed.search}`;
}

// The signature covers the exact bytes on the wire, so only body types whose bytes are known up front can be signed.
export function bodyBytes(body: RequestBody): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array();
  if (typeof body === 'string') return utf8ToBytes(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof URLSearchParams) return utf8ToBytes(body.toString());
  throw new Error('signed CTX requests need a string, bytes or URLSearchParams body');
}

export function bodyHash(body: RequestBody): string {
  return bytesToHex(sha256(bodyBytes(body)));
}

export function canonicalString(input: CtxSignatureInput): string {
  return [
    input.method.toUpperCase(),
    input.uri,
    bodyHash(input.body),
    input.timestamp,
    input.nonce,
    input.apiKey,
    input.clientId,
    input.userId,
  ].join('\n');
}

export function signatureDigest(input: CtxSignatureInput): Uint8Array {
  return sha256(utf8ToBytes(canonicalString(input)));
}

export function newNonce(): string {
  return bytesToHex(randomBytes(NONCE_BYTES));
}

export function unixNow(): string {
  return String(Math.floor(Date.now() / 1000));
}

export function signCtxRequest(
  input: CtxSignatureInput,
  privateKeyHex: string,
): CtxSignatureHeaders {
  const signature = secp256k1.sign(signatureDigest(input), hexToBytes(privateKeyHex));
  const compact = new Uint8Array(65);
  compact[0] = COMPACT_RECOVERY_BASE + signature.recovery;
  compact.set(signature.toBytes('compact'), 1);
  return {
    [SIGNATURE_HEADER]: bytesToHex(compact),
    [SIGNATURE_SCHEME_HEADER]: SIGNATURE_SCHEME,
    [SIGNATURE_TIMESTAMP_HEADER]: input.timestamp,
    [SIGNATURE_NONCE_HEADER]: input.nonce,
  };
}

export function signingPublicKey(privateKeyHex: string): string {
  return bytesToHex(secp256k1.getPublicKey(hexToBytes(privateKeyHex), true));
}
