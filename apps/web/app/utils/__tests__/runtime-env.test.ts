// @vitest-environment jsdom
// Runtime deploy-env resolution — server process.env wins over baked
// values, window.__ENV__ wins in the browser, script payload is inert.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { runtimeEnv, runtimeEnvScript } from '../runtime-env';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete window.__ENV__;
});

describe('runtimeEnv', () => {
  it('prefers window.__ENV__ over baked values in the browser', () => {
    vi.stubEnv('VITE_API_URL', 'https://baked.example.com');
    window.__ENV__ = { API_URL: 'https://runtime.example.com' };
    expect(runtimeEnv().API_URL).toBe('https://runtime.example.com');
  });

  it('falls back to baked values when window.__ENV__ is absent', () => {
    vi.stubEnv('VITE_PHASE_1_ONLY', 'false');
    expect(runtimeEnv().PHASE_1_ONLY).toBe('false');
  });
});

describe('runtimeEnvScript', () => {
  it('emits only defined values and escapes < against script breakout', () => {
    window.__ENV__ = { API_URL: 'https://x.example.com/</script>' };
    const script = runtimeEnvScript();
    expect(script).not.toContain('</script>');
    expect(script).toContain('\\u003c/script');
    expect(script).not.toContain('LOOP_ENV');
  });
});
