import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { DataTypes, Sequelize } from 'sequelize';
import defineUser from '../../models/users.js';
import defineProject from '../../models/projects.js';
import defineFolder from '../../models/folders.js';
import defineMember from '../../models/members.js';
import defineCase from '../../models/cases.js';
import defineStep from '../../models/steps.js';
import defineCaseStep from '../../models/caseSteps.js';
import aiRoute from './ai.js';

const draft = {
  title: 'Login with wrong password',
  description: 'Check rejection',
  priority: 1,
  preConditions: 'Existing test account',
  expectedResults: 'Login rejected',
  steps: [{ step: 'Submit incorrect password', result: 'Login rejected' }],
};
let app;
let sequelize;
let provider;

beforeEach(async () => {
  vi.stubEnv('SECRET_KEY', 'test-only-secret');
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-only-provider-key');
  vi.stubEnv('DEEPSEEK_MODEL', 'deepseek-flash');
  vi.stubEnv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com');
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const User = defineUser(sequelize, DataTypes);
  const Project = defineProject(sequelize, DataTypes);
  const Folder = defineFolder(sequelize, DataTypes);
  const Member = defineMember(sequelize, DataTypes);
  const Case = defineCase(sequelize, DataTypes);
  defineStep(sequelize, DataTypes);
  defineCaseStep(sequelize, DataTypes);
  // Production migrations use plural table names; legacy model references use singular names.
  Project.rawAttributes.userId.references.model = 'users';
  Folder.rawAttributes.projectId.references.model = 'projects';
  Folder.rawAttributes.parentFolderId.references.model = 'folders';
  Case.rawAttributes.folderId.references.model = 'folders';
  await sequelize.sync();
  await User.bulkCreate(
    [1, 2, 3].map((id) => ({
      id,
      email: `user${id}@example.test`,
      username: `User ${id}`,
      password: 'unused',
      role: 1,
    }))
  );
  await Project.create({ id: 1, name: 'Test project', isPublic: false, userId: 1 });
  await Folder.create({ id: 1, name: 'Test folder', projectId: 1 });
  await Member.create({ userId: 3, projectId: 1, role: 2 });
  app = express();
  app.use(express.json());
  app.use('/cases', aiRoute(sequelize));
  provider = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ cases: [draft] }) } }],
    }),
  });
  vi.stubGlobal('fetch', provider);
});

afterEach(async () => {
  await sequelize.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const post = (action, body, userId = 1, query = 'folderId=1') =>
  request(app)
    .post(`/cases/ai/${action}?${query}`)
    .set('Authorization', `Bearer ${jwt.sign({ userId }, 'test-only-secret')}`)
    .send(body);

describe('AI case generation', () => {
  it('requires sign-in and project editing permission before calling the provider', async () => {
    expect((await request(app).post('/cases/ai/generate?folderId=1').send({ requirements: 'Login' })).status).toBe(401);
    for (const userId of [2, 3]) {
      expect((await post('generate', { requirements: 'Login' }, userId)).status).toBe(403);
      expect((await post('save', { cases: [draft], reviewed: true }, userId)).status).toBe(403);
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it.each(['', 'folderId=0', 'folderId=no', 'folderId=1&folderId=2'])(
    'rejects invalid folder query %s',
    async (query) => {
      expect((await post('generate', { requirements: 'Login' }, 1, query)).status).toBe(400);
      expect(provider).not.toHaveBeenCalled();
    }
  );

  it('rejects missing folders', async () => {
    expect((await post('generate', { requirements: 'Login' }, 1, 'folderId=999')).status).toBe(404);
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([null, '', '   ', 42, 'x'.repeat(10001)])('rejects invalid requirements %#', async (requirements) => {
    expect((await post('generate', { requirements })).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it('returns drafts without writing cases or exposing the provider key', async () => {
    const res = await post('generate', { requirements: 'Wrong passwords must be rejected.' });
    expect(res.status).toBe(200);
    expect(res.body.cases).toEqual([draft]);
    expect(await sequelize.models.Case.count()).toBe(0);
    const [url, options] = provider.mock.calls[0];
    expect(String(url)).toBe('https://api.deepseek.com/chat/completions');
    expect(JSON.parse(options.body)).toMatchObject({
      model: 'deepseek-flash',
      response_format: { type: 'json_object' },
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(res.text).not.toContain('test-only-provider-key');
  });

  it('reports missing configuration without contacting the provider', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    expect((await post('generate', { requirements: 'Login' })).body.code).toBe('notConfigured');
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    'not json',
    '{}',
    '{"cases":[]}',
    JSON.stringify({ cases: [{ ...draft, priority: 99 }] }),
    JSON.stringify({ cases: [{ ...draft, steps: [] }] }),
  ])('rejects malformed model output %#', async (content) => {
    provider.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] }),
    });
    const res = await post('generate', { requirements: 'Login' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('invalidResponse');
  });

  it('rejects truncated output even when it is valid JSON', async () => {
    provider.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: 'length', message: { content: JSON.stringify({ cases: [draft] }) } }],
      }),
    });
    expect((await post('generate', { requirements: 'Login' })).body.code).toBe('invalidResponse');
  });

  it('returns controlled provider and timeout errors without upstream secrets', async () => {
    provider.mockResolvedValueOnce({ ok: false, status: 401 });
    expect((await post('generate', { requirements: 'Login' })).body).toEqual({ code: 'providerFailed' });
    provider.mockRejectedValueOnce(new DOMException('provider secret', 'TimeoutError'));
    const res = await post('generate', { requirements: 'Login' });
    expect(res.status).toBe(504);
    expect(res.body).toEqual({ code: 'timeout' });
  });
});

describe('Reviewed AI draft persistence', () => {
  it('saves edited cases and ordered steps while ignoring untrusted IDs and status fields', async () => {
    const res = await post('save', {
      reviewed: true,
      cases: [
        {
          ...draft,
          title: 'Edited title',
          folderId: 999,
          state: 1,
          automationStatus: 0,
          steps: [...draft.steps, { step: 'Retry', result: 'Rejected again' }],
        },
        draft,
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.cases.map((item) => item.caseNo)).toEqual([1, 2]);
    expect(res.body.cases[0]).toMatchObject({
      title: 'Edited title',
      folderId: 1,
      state: 0,
      automationStatus: 1,
      template: 1,
    });
    expect(await sequelize.models.Step.count()).toBe(3);
    const links = await sequelize.models.CaseStep.findAll({ order: [['id', 'ASC']] });
    expect(links.map((link) => link.stepNo)).toEqual([1, 2, 1]);
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    { cases: [draft] },
    { reviewed: true, cases: [] },
    { reviewed: true, cases: Array(7).fill(draft) },
    { reviewed: true, cases: [{ ...draft, title: ' ' }] },
    { reviewed: true, cases: [{ ...draft, steps: [{ step: 'x', result: '' }] }] },
  ])('rejects unreviewed or invalid drafts without writing %#', async (body) => {
    expect((await post('save', body)).status).toBe(400);
    expect(await sequelize.models.Case.count()).toBe(0);
  });

  it('rolls back all cases and steps when a later insert fails', async () => {
    await sequelize.query(
      "CREATE TRIGGER fail_step BEFORE INSERT ON steps WHEN NEW.step = 'FAIL' BEGIN SELECT RAISE(ABORT, 'test failure'); END;"
    );
    const res = await post('save', {
      reviewed: true,
      cases: [draft, { ...draft, steps: [{ step: 'FAIL', result: 'unused' }] }],
    });
    expect(res.status).toBe(500);
    expect(await sequelize.models.Case.count()).toBe(0);
    expect(await sequelize.models.Step.count()).toBe(0);
    expect(await sequelize.models.CaseStep.count()).toBe(0);
  });
});
