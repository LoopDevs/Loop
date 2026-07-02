#!/usr/bin/env node
/**
 * Sensitive-path reminder hook (hardening E8, 2026-07 plan).
 *
 * A PostToolUse hook (Edit|Write) that fires a one-time-per-path
 * reminder to run `/review-money-diff` when a change lands in a
 * money- or auth-sensitive directory. The whole point of the skills
 * + invariants docs is that they get USED; this is the mechanical
 * trigger so a contributor (human or model) can't forget.
 *
 * Reads the harness's PostToolUse JSON on stdin, inspects the edited
 * file path, and — if sensitive and not already reminded this session
 * — emits an `additionalContext` reminder. Non-blocking (exit 0): it
 * nudges, never denies. Fails silent on any parse error so a hook bug
 * can never wedge the editor.
 */
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SENSITIVE = [
  /apps\/backend\/src\/credits\//,
  /apps\/backend\/src\/payments\//,
  /apps\/backend\/src\/orders\//,
  /apps\/backend\/src\/wallet\//,
  /apps\/backend\/src\/auth\//,
  /apps\/backend\/src\/db\/schema\.ts$/,
  /apps\/backend\/src\/db\/migrations\//,
];

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // no stdin / malformed — nothing to do
  }
  const filePath = payload?.tool_input?.file_path ?? '';
  if (typeof filePath !== 'string' || filePath.length === 0) process.exit(0);
  if (filePath.includes('__tests__') || filePath.endsWith('.test.ts')) process.exit(0);
  if (!SENSITIVE.some((re) => re.test(filePath))) process.exit(0);

  // De-dup per session so a multi-file money change reminds once, not
  // on every edit. Keyed on the harness session id when present.
  const sessionId = payload?.session_id ?? 'nosession';
  const stamp = join(tmpdir(), `.loop-money-reminder-${sessionId}`);
  if (existsSync(stamp)) process.exit(0);
  try {
    mkdirSync(tmpdir(), { recursive: true });
    appendFileSync(stamp, '1');
  } catch {
    /* best-effort de-dup */
  }

  const reminder =
    'You are editing money/auth-sensitive code (credits/payments/orders/wallet/auth/schema/migrations). ' +
    'Before opening a PR: run the /review-money-diff skill (adversarial pass anchored on docs/invariants.md + docs/threat-model.md), ' +
    'and state in the PR which invariants the change preserves and how. This is where CI-green merge regressions have shipped before.';

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: reminder,
      },
    }),
  );
  process.exit(0);
}

main();
