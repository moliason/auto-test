import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  clock: 0,
  saved: new Map(),
  cases: [
    {
      id: 1,
      title: 'HTTP',
      expectedStatus: 'passed',
      executionInfo: { method: 'GET', path: '/plain', assertions: [{ type: 'status', expected: 200 }] },
    },
  ],
}));
vi.mock('node:fs', () => ({
  readFileSync: (path) =>
    String(path).endsWith('cases.json')
      ? JSON.stringify(fixture.cases)
      : JSON.stringify({
          studyId: 'isolated-timing',
          email: 'test@local',
          password: 'test-password',
          caseIds: [1],
          baselineRunIds: [1],
        }),
  writeFileSync: (path, text) => {
    fixture.saved.set(String(path), text);
    fixture.clock += 1000;
  },
  mkdirSync: vi.fn(),
  existsSync: () => false,
}));
vi.mock('@playwright/test', () => ({
  chromium: {
    executablePath: () => 'unused',
    launch: async () => ({
      newPage: async () => {
        throw new Error('HTTP phase collected');
      },
      close: vi.fn(),
    }),
  },
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('excludes deliberately slow checkpoint writes from HTTP and assertion duration', async () => {
  vi.spyOn(performance, 'now').mockImplementation(() => fixture.clock);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      fixture.clock += 25;
      return {
        status: 200,
        json: async () => (String(url).endsWith('/users/signin') ? { access_token: 'operator-token' } : { ok: true }),
      };
    })
  );
  await expect(import('./baseline-study.mjs')).rejects.toThrow('HTTP phase collected');
  const checkpoint = JSON.parse([...fixture.saved.values()].at(-1));
  expect(checkpoint.timingVersion).toBe(2);
  expect(checkpoint.results[0].durationMs).toBe(25);
  expect(
    checkpoint.actions
      .filter((item) => ['script_http', 'script_assertions'].includes(item.category))
      .map((item) => item.durationMs)
  ).toEqual([25, 0]);
  expect(fixture.clock).toBeGreaterThan(4000);
});
