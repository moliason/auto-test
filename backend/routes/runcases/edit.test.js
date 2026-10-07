import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createAgentDatabase } from '../../agent/database.fixture.js';
import editRoute from './edit.js';

let app, db, task;
const auth = (userId = 1) => `Bearer ${jwt.sign({ userId }, 'agent-test-only')}`;
beforeEach(async () => {
  vi.stubEnv('SECRET_KEY', 'agent-test-only');
  db = await createAgentDatabase();
  await db.models.Case.bulkCreate(
    [1, 2, 3].map((id) => ({
      id,
      folderId: id === 2 ? 2 : 1,
      title: `Case ${id}`,
      caseNo: id,
      state: 0,
      priority: 2,
      type: 0,
      automationStatus: 1,
      template: 0,
    }))
  );
  task = await db.models.AgentTask.create({
    runId: 1,
    state: 'completed',
    results: [{ caseId: 1, status: 'passed', response: { status: 200 } }],
  });
  await db.models.RunCase.bulkCreate([
    { id: 1, runId: 1, caseId: 1, status: 1, executionSource: 'agent', agentTaskId: task.id },
    { id: 2, runId: 2, caseId: 2, status: 0 },
  ]);
  app = express();
  app.use(express.json());
  app.use('/runcases', editRoute(db));
});
afterEach(async () => {
  await db.close();
  vi.unstubAllEnvs();
});

describe('Manual run case updates alongside Agent results', () => {
  it('marks manual changes while retaining immutable Agent history', async () => {
    const response = await request(app)
      .post('/runcases/update?runId=1')
      .set('Authorization', auth(3))
      .send([{ id: 1, caseId: 1, status: 2, editState: 'changed' }]);
    expect(response.status).toBe(200);
    expect(response.body[0]).toMatchObject({ status: 2, executionSource: 'manual', agentTaskId: null });
    expect((await task.reload()).results).toEqual([{ caseId: 1, status: 'passed', response: { status: 200 } }]);
  });
  it('rejects foreign cases, mismatched row IDs and invalid status atomically', async () => {
    for (const entry of [
      { id: 2, caseId: 1, status: 2, editState: 'changed' },
      { id: 2, caseId: 2, status: 2, editState: 'changed' },
      { id: -1, caseId: 2, status: 0, editState: 'new' },
      { id: 1, caseId: 1, status: 9, editState: 'changed' },
    ]) {
      const response = await request(app)
        .post('/runcases/update?runId=1')
        .set('Authorization', auth())
        .send([{ id: 1, caseId: 1, status: 2, editState: 'changed' }, entry]);
      expect([400, 409]).toContain(response.status);
      expect((await db.models.RunCase.findByPk(1)).status).toBe(1);
      expect((await db.models.RunCase.findByPk(2)).status).toBe(0);
    }
    expect((await request(app).post('/runcases/update?runId=1').set('Authorization', auth(2)).send([])).status).toBe(
      403
    );
  });
  it('preserves adding, removing, unchanged rows and deselecting unsaved cases', async () => {
    const response = await request(app)
      .post('/runcases/update?runId=1')
      .set('Authorization', auth())
      .send([
        { id: 1, caseId: 1, status: 1, editState: 'notChanged' },
        { id: -1, caseId: 3, status: 0, editState: 'deleted' },
      ]);
    expect(response.status).toBe(200);
    expect(response.body[0].executionSource).toBe('agent');
    const added = await request(app)
      .post('/runcases/update?runId=1')
      .set('Authorization', auth())
      .send([{ id: -1, caseId: 3, status: 0, editState: 'new' }]);
    expect(added.status).toBe(200);
    expect(added.body[0]).toMatchObject({ caseId: 3, executionSource: 'manual' });
    const removed = await request(app)
      .post('/runcases/update?runId=1')
      .set('Authorization', auth())
      .send([{ id: added.body[0].id, caseId: 3, editState: 'deleted' }]);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual([]);
  });
});
