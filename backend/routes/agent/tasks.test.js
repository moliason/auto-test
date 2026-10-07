import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createAgentDatabase } from '../../agent/database.fixture.js';
import { buildPlan } from '../../agent/plan.js';
import tasksRoute from './tasks.js';

let app, db, launch;
const executionInfo = { method: 'GET', path: '/plain', assertions: [{ type: 'status', expected: 200 }] };
const environment = { baseUrl: 'http://127.0.0.1:4010' };
const auth = (userId = 1) => `Bearer ${jwt.sign({ userId }, 'agent-test-only')}`;

beforeEach(async () => {
  vi.stubEnv('SECRET_KEY', 'agent-test-only');
  vi.stubEnv('TEST_AGENT_ALLOWED_ORIGINS', environment.baseUrl);
  db = await createAgentDatabase();
  await db.models.Run.update({ agentEnvironment: environment }, { where: { id: 1 } });
  await db.models.Case.bulkCreate(
    [1, 2, 3].map((id) => ({
      id,
      folderId: id === 2 ? 2 : 1,
      title: `Case ${id}`,
      caseNo: id,
      description: 'Original description',
      preConditions: 'Original precondition',
      expectedResults: 'Healthy',
      state: 0,
      priority: 2,
      type: 0,
      automationStatus: 1,
      template: 1,
      executionInfo: id === 3 ? null : executionInfo,
    }))
  );
  await db.models.RunCase.bulkCreate([1, 2, 3].map((id) => ({ runId: id === 2 ? 2 : 1, caseId: id, status: 0 })));
  await db.models.Step.create({ id: 1, step: 'Call health endpoint', result: 'HTTP 200' });
  await db.models.CaseStep.create({ caseId: 1, stepId: 1, stepNo: 1 });
  launch = vi.fn().mockResolvedValue(undefined);
  app = express();
  app.use(express.json());
  app.use('/agent', tasksRoute(db, { launch }));
});
afterEach(async () => {
  await db.close();
  vi.unstubAllEnvs();
});

describe('Agent task lifecycle and permissions', () => {
  it('captures original text and ordered steps without executing before confirmation', async () => {
    const response = await request(app)
      .post('/agent/runs/1/tasks')
      .set('Authorization', auth(3))
      .send({ caseIds: [1, 3] });
    expect(response.status).toBe(202);
    expect(response.body.plan.cases[0]).toMatchObject({
      caseId: 1,
      description: 'Original description',
      steps: [{ step: 'Call health endpoint', result: 'HTTP 200', stepNo: 1 }],
    });
    expect(response.body.plan.issues.join(' ')).toContain('#3');
    expect(response.body.results).toEqual([]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(db, response.body.id, 'prepare');
    expect((await db.models.RunCase.findOne({ where: { runId: 1, caseId: 1 } })).status).toBe(0);
  });

  it('rejects unauthenticated, foreign-project and non-member case selections', async () => {
    expect(
      (
        await request(app)
          .post('/agent/runs/1/tasks')
          .send({ caseIds: [1] })
      ).status
    ).toBe(401);
    expect(
      (
        await request(app)
          .post('/agent/runs/1/tasks')
          .set('Authorization', auth(2))
          .send({ caseIds: [1] })
      ).status
    ).toBe(403);
    for (const caseIds of [[1, 1], [2], [], ['1']])
      expect(
        (await request(app).post('/agent/runs/1/tasks').set('Authorization', auth()).send({ caseIds })).status
      ).toBe(400);
    await db.models.RunCase.create({ runId: 1, caseId: 2, status: 0 });
    expect(
      (
        await request(app)
          .post('/agent/runs/1/tasks')
          .set('Authorization', auth())
          .send({ caseIds: [2] })
      ).status
    ).toBe(400);
    await db.models.RunCase.destroy({ where: { runId: 1, caseId: 1 } });
    expect(
      (
        await request(app)
          .post('/agent/runs/1/tasks')
          .set('Authorization', auth())
          .send({ caseIds: [1] })
      ).status
    ).toBe(400);
    expect(launch).not.toHaveBeenCalled();
  });

  it('requires complete information, the latest saved version and both confirmations', async () => {
    const task = await db.models.AgentTask.create({
      runId: 1,
      state: 'needs_input',
      plan: buildPlan([{ caseId: 3, title: 'Missing', executionInfo: null }], environment),
    });
    const url = `/agent/runs/1/tasks/${task.id}`;
    const confirmation = { version: 1, confirmed: true, preconditionsConfirmed: true };
    expect((await request(app).post(`${url}/confirm`).set('Authorization', auth()).send(confirmation)).status).toBe(
      409
    );
    expect(
      (
        await request(app)
          .put(`${url}/plan`)
          .set('Authorization', auth())
          .send({ version: 1, cases: [{ caseId: 2, executionInfo, questions: [] }] })
      ).status
    ).toBe(400);
    const saved = await request(app)
      .put(`${url}/plan`)
      .set('Authorization', auth())
      .send({ version: 1, cases: [{ caseId: 3, executionInfo, questions: [] }], notes: '已核对业务规则' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ state: 'awaiting_confirmation', version: 2 });
    expect((await request(app).post(`${url}/confirm`).set('Authorization', auth()).send(confirmation)).status).toBe(
      409
    );
    expect(
      (await request(app).post(`${url}/confirm`).set('Authorization', auth()).send({ version: 2, confirmed: true }))
        .status
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`${url}/confirm`)
          .set('Authorization', auth())
          .send({ ...confirmation, version: 2 })
      ).status
    ).toBe(202);
    expect(
      (
        await request(app)
          .post(`${url}/confirm`)
          .set('Authorization', auth())
          .send({ ...confirmation, version: 2 })
      ).status
    ).toBe(409);
    expect(
      (
        await request(app)
          .put(`${url}/plan`)
          .set('Authorization', auth())
          .send({ version: 2, cases: saved.body.plan.cases })
      ).status
    ).toBe(409);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(db, task.id, 'execute');
    expect((await db.models.Run.findByPk(1)).state).toBe(1);
    expect((await db.models.Case.findByPk(3)).executionInfo).toBeNull();
  });

  it('scopes reads, plan updates and confirmation to the authorized run', async () => {
    const task = await db.models.AgentTask.create({
      runId: 2,
      state: 'awaiting_confirmation',
      plan: buildPlan([{ caseId: 2, executionInfo }], environment),
    });
    const url = `/agent/runs/1/tasks/${task.id}`;
    expect((await request(app).get(url).set('Authorization', auth())).status).toBe(404);
    expect(
      (await request(app).put(`${url}/plan`).set('Authorization', auth()).send({ version: 1, cases: [] })).status
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(`${url}/confirm`)
          .set('Authorization', auth())
          .send({ version: 1, confirmed: true, preconditionsConfirmed: true })
      ).status
    ).toBe(404);
    expect((await request(app).get(`/agent/runs/2/tasks/${task.id}`).set('Authorization', auth())).status).toBe(403);
    expect((await request(app).get('/agent/runs/1/tasks').set('Authorization', auth())).body.tasks).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it('rechecks run membership and prevents simultaneous tasks in the same run', async () => {
    const plan = buildPlan([{ caseId: 1, executionInfo }], environment);
    const first = await db.models.AgentTask.create({ runId: 1, state: 'awaiting_confirmation', plan });
    const second = await db.models.AgentTask.create({ runId: 1, state: 'awaiting_confirmation', plan });
    const confirmation = { version: 1, confirmed: true, preconditionsConfirmed: true };
    await db.models.RunCase.destroy({ where: { runId: 1, caseId: 1 } });
    expect(
      (
        await request(app)
          .post(`/agent/runs/1/tasks/${first.id}/confirm`)
          .set('Authorization', auth())
          .send(confirmation)
      ).status
    ).toBe(409);
    await db.models.RunCase.create({ runId: 1, caseId: 1, status: 0 });
    expect(
      (
        await request(app)
          .post(`/agent/runs/1/tasks/${first.id}/confirm`)
          .set('Authorization', auth())
          .send(confirmation)
      ).status
    ).toBe(202);
    expect(
      (
        await request(app)
          .post(`/agent/runs/1/tasks/${second.id}/confirm`)
          .set('Authorization', auth())
          .send(confirmation)
      ).status
    ).toBe(409);
    await expect(db.models.AgentTask.create({ runId: 1, state: 'running', plan })).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
    });
    expect(launch).toHaveBeenCalledTimes(1);
    const history = await request(app).get('/agent/runs/1/tasks').set('Authorization', auth());
    expect(history.body.tasks.map((task) => task.id)).toEqual([second.id, first.id]);
  });
});
