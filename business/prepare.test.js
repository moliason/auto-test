import { afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ files: new Map(), puts: [], creations: 0, fail: true }));
vi.mock('node:fs', () => ({
  readFileSync: (path) => fixture.files.get(String(path).split('/').at(-1)),
  writeFileSync: (path, text) => fixture.files.set(String(path).split('/').at(-1), text),
  existsSync: (path) => fixture.files.has(String(path).split('/').at(-1)),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

it('retries environment configuration after a saved run ID without creating a duplicate run', async () => {
  fixture.files.set(
    '.env',
    'PORT=8011\nTEST_AGENT_SECRET_GRANTS={"10":["BIZ_PASSWORD"]}\nTEST_AGENT_SECRET_BIZ_PASSWORD=fixture-password\n'
  );
  fixture.files.set('cases.json', '[]');
  fixture.files.set(
    '.env.study.json',
    JSON.stringify({
      studyId: 'recovery',
      userId: 1,
      email: 'fixture@local',
      password: 'fixture-password',
      projectId: 10,
      folderId: 1,
      caseIds: [],
      configured: true,
      agentRunIds: [],
      baselineRunIds: [],
    })
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      const path = new URL(url).pathname;
      if (path === '/users/signin') return { ok: true, json: async () => ({ access_token: 'fixture-session' }) };
      if (path === '/runs') {
        fixture.creations++;
        return { ok: true, json: async () => ({ id: 100 + fixture.creations }) };
      }
      if (path.endsWith('/environment') && options.method === 'GET')
        return { ok: true, json: async () => ({ environment: {} }) };
      if (path.endsWith('/environment') && options.method === 'PUT') {
        fixture.puts.push(path);
        if (fixture.fail) {
          fixture.fail = false;
          return { ok: false, status: 503 };
        }
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`Unexpected request ${path}`);
    })
  );
  await expect(import('./prepare.mjs')).rejects.toThrow('HTTP 503');
  expect(JSON.parse(fixture.files.get('.env.study.json')).agentRunIds).toEqual([101]);
  vi.resetModules();
  await import('./prepare.mjs');
  expect(fixture.puts.filter((path) => path === '/agent/runs/101/environment')).toHaveLength(2);
  expect(fixture.creations).toBe(6);
  const saved = JSON.parse(fixture.files.get('.env.study.json'));
  expect(saved.agentRunIds).toEqual([101, 102, 103]);
  expect(saved.configuredRunIds).toEqual([101, 102, 103]);
});
