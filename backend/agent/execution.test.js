import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDemoServer } from '../../demo/server.mjs';
import {
  environmentIssues,
  executeHttpCase,
  executionIssues,
  readJsonPointer,
  redact,
  renderVariables,
} from './execution.js';

let server;
let environment;
beforeAll(async () => {
  server = createDemoServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  environment = { baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 1000 };
  vi.stubEnv('TEST_AGENT_ALLOWED_ORIGINS', environment.baseUrl);
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  vi.unstubAllEnvs();
});

const login = {
  method: 'POST',
  path: '/login',
  body: { username: 'demo', password: 'demo-password' },
  assertions: [
    { type: 'status', expected: 200 },
    { type: 'jsonExists', path: '/token' },
    { type: 'jsonEquals', path: '/user/id', expected: 7 },
  ],
  extract: [{ name: 'TOKEN', path: '/token', secret: true }],
};

describe('HTTP execution with real local requests', () => {
  it('overrides environment authorization irrespective of header name casing', async () => {
    const result = await executeHttpCase({
      execution: {
        method: 'GET',
        path: '/profile',
        headers: { authorization: 'Bearer demo-token' },
        assertions: [{ type: 'status', expected: 200 }],
      },
      environment: { ...environment, headers: { Authorization: 'Bearer wrong-environment-token' } },
    });
    expect(result.evidence.status).toBe('passed');
    expect(
      Object.keys(result.evidence.request.headers).filter((key) => key.toLowerCase() === 'authorization')
    ).toHaveLength(1);
  });
  it('executes all three assertion types and reuses an extracted token', async () => {
    const result = await executeHttpCase({ execution: login, environment });
    expect(result.evidence.status).toBe('passed');
    expect(result.evidence.assertions).toHaveLength(3);
    expect(result.extractedVariables).toEqual({ TOKEN: 'demo-token' });
    expect(JSON.stringify(result.evidence)).not.toContain('demo-token');
    expect(JSON.stringify(result.evidence)).not.toContain('demo-password');
    const profile = await executeHttpCase({
      execution: {
        method: 'GET',
        path: '/profile',
        headers: { Authorization: 'Bearer {{TOKEN}}' },
        assertions: [{ type: 'jsonEquals', path: '/id', expected: 7 }],
      },
      environment,
      variables: result.extractedVariables,
      secrets: result.secrets,
    });
    expect(profile.evidence.status).toBe('passed');
    expect(profile.evidence.request.headers.Authorization).toBe('[REDACTED]');
  });

  it('records an actual mismatch as failed with the expected and actual values', async () => {
    const { evidence } = await executeHttpCase({
      execution: {
        method: 'GET',
        path: '/broken-total',
        assertions: [{ type: 'jsonEquals', path: '/total', expected: 100 }],
      },
      environment,
    });
    expect(evidence.status).toBe('failed');
    expect(evidence.assertions[0]).toMatchObject({ expected: 100, actual: 90, passed: false });
    expect(evidence.durationMs).toBeGreaterThanOrEqual(0);
    expect(evidence.finishedAt).toBeTruthy();
  });

  it('does not treat a missing JSON field as a null value', async () => {
    const { evidence } = await executeHttpCase({
      execution: {
        method: 'GET',
        path: '/broken-total',
        assertions: [{ type: 'jsonEquals', path: '/missing', expected: null }],
      },
      environment,
    });
    expect(evidence.status).toBe('failed');
    expect(evidence.assertions[0].exists).toBe(false);
  });

  it('records network errors and timeouts without marking them passed', async () => {
    for (const path of ['/disconnect', '/slow']) {
      const { evidence } = await executeHttpCase({
        execution: { method: 'GET', path, assertions: [{ type: 'status', expected: 200 }] },
        environment: { ...environment, timeoutMs: 100 },
      });
      expect(evidence.status).toBe('error');
      expect(evidence.reason).toBeTruthy();
      expect(evidence.assertions).toEqual([]);
    }
  });

  it('refuses incomplete execution information before making a request', async () => {
    for (const execution of [
      {},
      { method: 'GET', path: '/profile', assertions: [] },
      { ...login, path: '//external.example' },
    ]) {
      const { evidence } = await executeHttpCase({ execution, environment });
      expect(evidence.status).toBe('skipped');
      expect(evidence.request).toBeNull();
    }
  });

  it('refuses undefined variables and unapproved target origins', async () => {
    const missing = await executeHttpCase({ execution: { ...login, path: '/users/{{ID}}' }, environment });
    expect(missing.evidence.status).toBe('skipped');
    expect(missing.evidence.reason).toContain('ID');
    const unapproved = await executeHttpCase({ execution: login, environment: { baseUrl: 'http://example.test' } });
    expect(unapproved.evidence.status).toBe('skipped');
    expect(unapproved.evidence.request).toBeNull();
  });

  it('sends typed body variables and encodes query values', async () => {
    const { evidence } = await executeHttpCase({
      execution: {
        method: 'POST',
        path: '/echo',
        body: { count: '{{COUNT}}' },
        query: { text: '{{TEXT}}' },
        assertions: [
          { type: 'jsonEquals', path: '/body/count', expected: 7 },
          { type: 'jsonEquals', path: '/query/text', expected: 'a&b=c' },
        ],
      },
      environment,
      variables: { COUNT: 7, TEXT: 'a&b=c' },
    });
    expect(evidence.status).toBe('passed');
    expect(evidence.request.url).toContain('text=a%26b%3Dc');
  });

  it('does not follow redirects and bounds response size', async () => {
    const redirect = await executeHttpCase({
      execution: { method: 'GET', path: '/redirect', assertions: [{ type: 'status', expected: 302 }] },
      environment,
    });
    expect(redirect.evidence.status).toBe('passed');
    expect(redirect.evidence.response.status).toBe(302);
    const large = await executeHttpCase({
      execution: { method: 'GET', path: '/large', assertions: [{ type: 'status', expected: 200 }] },
      environment,
    });
    expect(large.evidence.status).toBe('error');
    expect(large.evidence.reason).toContain('1 MiB');
  });

  it('supports status assertions on non-JSON responses and fails JSON assertions', async () => {
    const { evidence } = await executeHttpCase({
      execution: {
        method: 'GET',
        path: '/plain',
        assertions: [
          { type: 'status', expected: 200 },
          { type: 'jsonExists', path: '/ok' },
        ],
      },
      environment,
    });
    expect(evidence.status).toBe('failed');
    expect(evidence.assertions.map((item) => item.passed)).toEqual([true, false]);
  });

  it('does not publish extracted variables from failed tests', async () => {
    const result = await executeHttpCase({
      execution: { ...login, assertions: [{ type: 'status', expected: 201 }] },
      environment,
    });
    expect(result.evidence.status).toBe('failed');
    expect(result.extractedVariables).toEqual({});
    expect(JSON.stringify(result.evidence)).not.toContain('demo-token');
  });
});

describe('Execution contract and evidence safety', () => {
  it('detects invalid methods, expectations, headers and extraction rules', () => {
    expect(executionIssues(login)).toEqual([]);
    expect(executionIssues({ ...login, method: 'CONNECT' })).not.toEqual([]);
    expect(executionIssues({ ...login, assertions: [{ type: 'status', expected: '200' }] })).not.toEqual([]);
    expect(executionIssues({ ...login, headers: { Host: 'elsewhere' } })).not.toEqual([]);
    expect(executionIssues({ ...login, extract: [{ path: '/token' }] })).not.toEqual([]);
    expect(environmentIssues({ ...environment, timeoutMs: 60000 })).not.toEqual([]);
  });

  it('uses own JSON fields, supports arrays, escapes and null', () => {
    const json = { 'a/b': [{ '~value': null }] };
    expect(readJsonPointer(json, '/a~1b/0/~0value')).toEqual({ exists: true, value: null });
    expect(readJsonPointer(json, '/toString')).toEqual({ exists: false });
    expect(readJsonPointer({}, '/missing')).toEqual({ exists: false });
    for (const part of ['length', 'map', '__proto__', 'constructor', '00', '01', '-1', '+0', '1.0', '1e0', '-', '2'])
      expect(readJsonPointer({ items: ['first', 'second'] }, `/items/${part}`)).toEqual({ exists: false });
    expect(readJsonPointer({ items: [] }, '/items/length')).toEqual({ exists: false });
    expect(readJsonPointer({ items: ['first'] }, '/items/0')).toEqual({ exists: true, value: 'first' });
    expect(readJsonPointer({ items: { length: 0, '01': 'object field' } }, '/items/length')).toEqual({
      exists: true,
      value: 0,
    });
    expect(readJsonPointer({ items: { '01': 'object field' } }, '/items/01')).toEqual({
      exists: true,
      value: 'object field',
    });
  });

  it('redacts nested credentials and known secrets in free text', () => {
    const evidence = redact(
      {
        Authorization: 'Bearer abc',
        body: { password: 'pwd', token: 'abc', note: 'secret is abc' },
        url: 'http://localhost/?q=a%2Bb',
      },
      ['abc', 'a+b']
    );
    expect(JSON.stringify(evidence)).not.toContain('abc');
    expect(JSON.stringify(evidence)).not.toContain('pwd');
    expect(evidence.url).toContain('[REDACTED]');
    expect(renderVariables('/users/{{ID}}', { ID: 'a/b' }, true)).toBe('/users/a%2Fb');
  });
});
