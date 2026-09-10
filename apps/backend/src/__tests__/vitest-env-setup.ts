// Vitest setup — pins CONFIG_PATH to the committed fixture so a developer's local config never influences a test run.
import { fileURLToPath } from 'node:url';

process.env['CONFIG_PATH'] ??= fileURLToPath(new URL('../../config.test.yaml', import.meta.url));
