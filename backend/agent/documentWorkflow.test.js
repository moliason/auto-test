import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createAgentDatabase } from './database.fixture.js';
import tasksRoute from '../routes/agent/tasks.js';
import { runAgent } from './runner.js';
import { saveDocumentCases } from './documentCases.js';

let db, app, launch;
const auth = (userId = 1) => `Bearer ${jwt.sign({ userId }, 'agent-test-only')}`;
const input = { document: { name: 'api.md', content: 'GET /plain\n正常查询返回 200。响应包含 text 字段。' } };
const proposal = {
  operations: [{ id: 'plain', method: 'GET', path: '/plain', evidence: 'GET /plain' }],
  rules: [
    {
      id: 'ok',
      operationId: 'plain',
      description: '正常查询返回 200',
      evidence: '正常查询返回 200',
      assertion: { type: 'status', expected: 200 },
    },
  ],
  questions: [],
  reason: '依据文档先验证正常查询',
  cases: [
    {
      key: 'first',
      title: '正常查询',
      purpose: '验证文档状态码',
      scenario: 'normal',
      ruleIds: ['ok'],
      evidenceCaseIds: [],
      dependsOnKeys: [],
      questions: [],
      executionInfo: { method: 'GET', path: '/plain', assertions: [{ type: 'status', expected: 200 }] },
    },
  ],
};
const tool = (name, args = {}) => ({
  message: {
    tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  },
  finish_reason: 'tool_calls',
});

beforeEach(async () => {
  vi.stubEnv('SECRET_KEY', 'agent-test-only');
  vi.stubEnv('TEST_AGENT_ALLOWED_ORIGINS', 'http://127.0.0.1:4010');
  db = await createAgentDatabase();
  await db.models.Run.update({ agentEnvironment: { baseUrl: 'http://127.0.0.1:4010' } }, { where: { id: 1 } });
  launch = vi.fn().mockResolvedValue(undefined);
  app = express();
  app.use(express.json());
  app.use('/agent', tasksRoute(db, { launch }));
});
afterEach(async () => {
  await db.close();
  vi.unstubAllEnvs();
});

describe('document generation and confirmation', () => {
  it('requires the actual run project developer, validates imports and makes no requests', async () => {
    expect(
      (await request(app).post('/agent/runs/1/tasks/document?projectId=2').set('Authorization', auth(2)).send(input))
        .status
    ).toBe(403);
    expect(
      (await request(app).post('/agent/runs/1/tasks/document').set('Authorization', auth(3)).send(input)).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/agent/runs/1/tasks/document')
          .set('Authorization', auth(4))
          .send({ ...input, limits: { maxRounds: 99 } })
      ).status
    ).toBe(400);
    const response = await request(app).post('/agent/runs/1/tasks/document').set('Authorization', auth(4)).send(input);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ state: 'preparing', results: [], plan: { cases: [] } });
    expect(launch).toHaveBeenCalledWith(db, response.body.id, 'prepare');
    expect(await db.models.Case.count()).toBe(0);
  });
  it('generates managed cases and freezes reviewed scope and budget only on explicit confirmation', async () => {
    const created = await request(app).post('/agent/runs/1/tasks/document').set('Authorization', auth()).send(input);
    const completion = vi
      .fn()
      .mockResolvedValueOnce(tool('read_cases'))
      .mockResolvedValueOnce(tool('submit_document_cases', proposal));
    await runAgent(db, created.body.id, 'prepare', { completion });
    const task = await db.models.AgentTask.findByPk(created.body.id);
    expect(task.state, task.error || JSON.stringify(task.plan.issues)).toBe('awaiting_confirmation');
    expect(task.plan.cases).toHaveLength(1);
    const item = task.plan.cases[0];
    expect((await db.models.Case.findByPk(item.caseId)).description).toContain('来源 ok');
    expect(await db.models.RunCase.count({ where: { runId: 1, caseId: item.caseId } })).toBe(1);
    expect(await db.models.CaseStep.count({ where: { caseId: item.caseId } })).toBe(1);
    const url = `/agent/runs/1/tasks/${task.id}/confirm`;
    expect((await request(app).post(url).set('Authorization', auth()).send({ version: task.version })).status).toBe(
      400
    );
    expect(
      (
        await request(app)
          .post(url)
          .set('Authorization', auth(3))
          .send({ version: task.version, confirmed: true, preconditionsConfirmed: true })
      ).status
    ).toBe(403);
    const confirmed = await request(app)
      .post(url)
      .set('Authorization', auth())
      .send({ version: task.version, confirmed: true, preconditionsConfirmed: true });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(202);
    expect(confirmed.body.plan.workflow.confirmed).toMatchObject({
      allowedOperationIds: ['plain'],
      initialCaseIds: [item.caseId],
    });
    expect(confirmed.body.results).toEqual([]);
    expect(launch).toHaveBeenLastCalledWith(db, task.id, 'execute');
  });
  it('keeps missing rules pending and blocks invented assertions', async () => {
    const created = await request(app).post('/agent/runs/1/tasks/document').set('Authorization', auth()).send(input);
    const changed = structuredClone(proposal);
    changed.rules[0].assertion.expected = 201;
    changed.cases[0].executionInfo.assertions[0].expected = 201;
    changed.questions = ['请确认异常返回状态码'];
    await saveDocumentCases(db, created.body.id, changed);
    const task = await db.models.AgentTask.findByPk(created.body.id);
    expect(task.state).toBe('needs_input');
    expect(task.plan.issues.join('；')).toContain('预期值未出现在原文');
    expect(task.results).toEqual([]);
  });
  it('remaps stable dependencies and rolls back incomplete supplemental batches', async () => {
    const created = await request(app).post('/agent/runs/1/tasks/document').set('Authorization', auth()).send(input);
    const changed = structuredClone(proposal);
    changed.cases.push({
      ...structuredClone(changed.cases[0]),
      key: 'second',
      dependsOnKeys: ['first'],
      executionInfo: { ...changed.cases[0].executionInfo, query: { id: '2' } },
    });
    await saveDocumentCases(db, created.body.id, changed);
    const task = await db.models.AgentTask.findByPk(created.body.id);
    expect(task.plan.cases[1].executionInfo.dependsOn).toEqual([task.plan.cases[0].caseId]);
    await task.update({ state: 'running' });
    const count = await db.models.Case.count();
    await expect(
      saveDocumentCases(db, task.id, {
        cases: [
          {
            ...structuredClone(changed.cases[0]),
            key: 'third',
            executionInfo: { method: 'DELETE', path: '/plain', assertions: [{ type: 'status', expected: 200 }] },
          },
        ],
        questions: [],
        reason: '越界操作',
      })
    ).rejects.toThrow('范围');
    expect(await db.models.Case.count()).toBe(count);
    await task.reload();
    expect(task.plan.cases).toHaveLength(2);
  });
});
