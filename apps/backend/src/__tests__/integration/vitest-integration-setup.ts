// pre-import setup for integration suite — ADR 013
import { fileURLToPath } from 'node:url';

// pinned so NODE_ENV and fixture env can't drift
process.env['NODE_ENV'] = 'test';

process.env['CONFIG_PATH'] ??= fileURLToPath(
  new URL('../../../config.integration.yaml', import.meta.url),
);
