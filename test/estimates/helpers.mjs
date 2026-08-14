// Shared fetch stubbing for the estimates suites. The modules under test read
// their config lazily, so setting env per test is enough — no require-cache
// busting needed.

const ENV_KEYS = [
  'VALUATUM_TRUNK_URL',
  'VALUATUM_TRUNK_TOKEN',
  'WISDOM_REST_BASE',
  'WISDOM_API_TOKEN',
  'FORECAST_GATE_ENABLED',
  'OPENROUTER_API_KEY',
  'ESTIMATE_INTERPRET_MODEL',
  'ESTIMATE_INTERPRET_REASONING_EFFORT',
  'ESTIMATE_INTERPRET_TIMEOUT_MS',
];

/** A minimal Response stand-in: only what the modules under test read. */
export function jsonResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

/**
 * Install a fetch stub and a clean env for one test, restoring both afterwards.
 * `handler(url, init)` returns a response (or throws to simulate a transport
 * failure). Every call is recorded on the returned `calls` array.
 */
export function stubFetch(t, handler, env = {}) {
  const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;

  for (const key of ENV_KEYS) delete process.env[key];
  process.env.VALUATUM_TRUNK_URL = 'https://trunk.test';
  process.env.VALUATUM_TRUNK_TOKEN = 'test-token';
  Object.assign(process.env, env);

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };

  t.after(() => {
    globalThis.fetch = savedFetch;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  return calls;
}

/** Sleep stand-in for the polling loops: records the delay, returns instantly. */
export function fakeClock() {
  let now = 0;
  const slept = [];
  return {
    now: () => now,
    sleep: async (ms) => { slept.push(ms); now += ms; },
    slept,
    advance: (ms) => { now += ms; },
  };
}
