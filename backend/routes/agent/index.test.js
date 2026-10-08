import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Sequelize, DataTypes } from 'sequelize';
import defineUser from '../../models/users.js';
import defineProject from '../../models/projects.js';
import defineFolder from '../../models/folders.js';
import defineCase from '../../models/cases.js';
import defineRun from '../../models/runs.js';
import defineMember from '../../models/members.js';
import agentRoute from './index.js';
import editRunRoute from '../runs/edit.js';

let app;
let db;
beforeEach(async () => {
  vi.stubEnv('SECRET_KEY', 'agent-test-only');
  vi.stubEnv('TEST_AGENT_SECRET_GRANTS', JSON.stringify({ 1: ['TOKEN'] }));
  vi.stubEnv('TEST_AGENT_SECRET_TOKEN', 'test-only-token');
  db = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const User = defineUser(db, DataTypes),
    Project = defineProject(db, DataTypes),
    Folder = defineFolder(db, DataTypes);
  const Case = defineCase(db, DataTypes),
    Run = defineRun(db, DataTypes),
    Member = defineMember(db, DataTypes);
  Project.rawAttributes.userId.references.model = 'users';
  Folder.rawAttributes.projectId.references.model = 'projects';
  Folder.rawAttributes.parentFolderId.references.model = 'folders';
  Case.rawAttributes.folderId.references.model = 'folders';
  Run.rawAttributes.projectId.references.model = 'projects';
  await db.sync();
  await User.bulkCreate(
    [1, 2, 3, 4].map((id) => ({ id, email: `${id}@example.test`, password: 'unused', username: `User ${id}`, role: 1 }))
  );
  await Project.bulkCreate([
    { id: 1, name: 'Own project', userId: 1, isPublic: false },
    { id: 2, name: 'Other project', userId: 2, isPublic: false },
  ]);
  await Folder.bulkCreate([
    { id: 1, name: 'Own folder', projectId: 1 },
    { id: 2, name: 'Other folder', projectId: 2 },
  ]);
  await Case.bulkCreate(
    [1, 2].map((id) => ({
      id,
      folderId: id,
      title: 'Original title',
      description: 'Original description',
      preConditions: 'Original preconditions',
      expectedResults: 'Original expectation',
      caseNo: 1,
      state: 0,
      priority: 2,
      type: 0,
      automationStatus: 1,
      template: 0,
    }))
  );
  await Run.bulkCreate([1, 2].map((id) => ({ id, projectId: id, name: 'Test run' })));
  await Member.bulkCreate([
    { userId: 3, projectId: 1, role: 2 },
    { userId: 4, projectId: 1, role: 1 },
  ]);
  app = express();
  app.use(express.json());
  app.use('/agent', agentRoute(db));
  app.use('/runs', editRunRoute(db));
});
afterEach(async () => {
  await db.close();
  vi.unstubAllEnvs();
});
const auth = (userId = 1) => `Bearer ${jwt.sign({ userId }, 'agent-test-only')}`;

describe('Agent execution configuration permissions', () => {
  it('cannot change a run project or set an environment through ordinary editing', async () => {
    for (const body of [{ projectId: 2 }, { agentEnvironment: { secretVariables: ['TOKEN'] } }]) {
      const response = await request(app).put('/runs/1').set('Authorization', auth(3)).send(body);
      expect(response.status).toBe(400);
    }
    expect((await db.models.Run.findByPk(1)).projectId).toBe(1);
    expect((await db.models.Run.findByPk(1)).agentEnvironment).toBeNull();
    expect(
      (
        await request(app)
          .put('/runs/1')
          .set('Authorization', auth(3))
          .send({ id: 1, projectId: 1, name: 'Edited', agentEnvironment: null })
      ).status
    ).toBe(200);
  });
  it('rejects another project secret name even for that project owner', async () => {
    const response = await request(app)
      .put('/agent/runs/2/environment')
      .set('Authorization', auth(2))
      .send({
        environment: { baseUrl: 'http://127.0.0.1:4010', secretVariables: ['TOKEN'], projectId: 1 },
      });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain('test-only-token');
    expect((await db.models.Run.findByPk(2)).agentEnvironment).toBeNull();
  });
  it('requires authentication and prevents cross-project case edits', async () => {
    expect((await request(app).put('/agent/cases/1/execution').send({ executionInfo: {} })).status).toBe(401);
    expect(
      (await request(app).put('/agent/cases/2/execution').set('Authorization', auth()).send({ executionInfo: {} }))
        .status
    ).toBe(403);
    expect(
      (await request(app).put('/agent/cases/1/execution').set('Authorization', auth(3)).send({ executionInfo: {} }))
        .status
    ).toBe(403);
  });

  it('allows developers to save incomplete execution drafts while preserving text cases', async () => {
    const response = await request(app)
      .put('/agent/cases/1/execution')
      .set('Authorization', auth(4))
      .send({ executionInfo: { method: 'GET' } });
    expect(response.status).toBe(200);
    expect(response.body.issues.length).toBeGreaterThan(0);
    const saved = await db.models.Case.findByPk(1);
    expect(saved.toJSON()).toMatchObject({
      title: 'Original title',
      description: 'Original description',
      preConditions: 'Original preconditions',
      expectedResults: 'Original expectation',
      executionInfo: { method: 'GET' },
    });
  });

  it('requires a project manager to update the environment and limits visibility to project reporters', async () => {
    const environment = {
      baseUrl: 'http://127.0.0.1:4010',
      headers: { Authorization: 'Bearer {{TOKEN}}' },
      secretVariables: ['TOKEN'],
    };
    for (const userId of [2, 3, 4]) {
      expect(
        (await request(app).put('/agent/runs/1/environment').set('Authorization', auth(userId)).send({ environment }))
          .status
      ).toBe(403);
    }
    expect(
      (await request(app).put('/agent/runs/1/environment').set('Authorization', auth()).send({ environment })).status
    ).toBe(200);
    const visible = await request(app).get('/agent/runs/1/environment').set('Authorization', auth(3));
    expect(visible.status).toBe(200);
    expect(visible.body.environment).toEqual(environment);
    expect((await request(app).get('/agent/runs/1/environment').set('Authorization', auth(2))).status).toBe(403);
    expect((await request(app).get('/agent/runs/2/environment').set('Authorization', auth())).status).toBe(403);
  });

  it('refuses literal authentication secrets and malformed input without persisting them', async () => {
    const response = await request(app)
      .put('/agent/runs/1/environment')
      .set('Authorization', auth())
      .send({ environment: { baseUrl: 'http://127.0.0.1:4010', headers: { Authorization: 'Bearer real-secret' } } });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain('real-secret');
    expect((await db.models.Run.findByPk(1)).agentEnvironment).toBeNull();
    expect(
      (await request(app).put('/agent/cases/1/execution').set('Authorization', auth()).send({ executionInfo: [] }))
        .status
    ).toBe(400);
    expect((await request(app).get('/agent/runs/not-an-id/environment').set('Authorization', auth())).status).toBe(400);
  });
});
