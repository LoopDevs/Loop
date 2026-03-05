import type { Config } from '@react-router/dev/config';

export default {
  ssr: process.env['BUILD_TARGET'] !== 'mobile',
} satisfies Config;
