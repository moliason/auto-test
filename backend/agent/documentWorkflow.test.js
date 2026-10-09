import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createAgentDatabase } from './database.fixture.js';
import tasksRoute from '../routes/agent/tasks.js';
import { runAgent } from './runner.js';
import { saveDocumentCases } from './documentCases.js';
import { createDemoServer } from '../../demo/server.mjs';
import { documentAcceptance } from './documentPlan.js';
import downloadRoute from '../routes/runs/download.js';
import ExcelJS from 'exceljs';

let db, app, launch;
let server, baseUrl;
beforeAll(async () => {
  server = createDemoServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
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
  vi.stubEnv('TEST_AGENT_ALLOWED_ORIGINS', baseUrl);
  db = await createAgentDatabase();
  await db.models.Run.update({ agentEnvironment: { baseUrl } }, { where: { id: 1 } });
  launch = vi.fn().mockResolvedValue(undefined);
  app = express();
  app.use(express.json());
  app.use('/agent', tasksRoute(db, { launch }));
  app.use('/runs', downloadRoute(db));
});

async function confirmedDocument({ path = '/plain', expected = 200, limits = {} } = {}) {
  const source = {
    document: {
      name: 'api.md',
      content: `GET ${path}\n正常查询返回 ${expected}。支持可选 query 参数 probe（字符串）。`,
    },
    limits,
  };
  const created = await request(app).post('/agent/runs/1/tasks/document').set('Authorization', auth()).send(source);
  expect(created.status).toBe(202);
  const draft = structuredClone(proposal);
  Object.assign(draft.operations[0], { path, evidence: `GET ${path}` });
  Object.assign(draft.rules[0], { evidence: `正常查询返回 ${expected}`, assertion: { type: 'status', expected } });
  Object.assign(draft.cases[0].executionInfo, { path, assertions: [{ type: 'status', expected }] });
  await saveDocumentCases(db, created.body.id, draft);
  const task = await db.models.AgentTask.findByPk(created.body.id);
  const confirmed = await request(app)
    .post(`/agent/runs/1/tasks/${task.id}/confirm`)
    .set('Authorization', auth())
    .send({ version: task.version, confirmed: true, preconditionsConfirmed: true });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(202);
  await task.reload();
  return task;
}

describe('feedback loop against real HTTP', () => {
  it('lets a human narrow and restore the operation scope before freezing it', async () => {
    const created = await request(app)
      .post('/agent/runs/1/tasks/document')
      .set('Authorization', auth())
      .send({ document: { name: 'two.md', content: input.document.content + '\nGET /echo\n回显返回 200。' } });
    const draft = structuredClone(proposal);
    draft.operations.push({ id: 'echo', method: 'GET', path: '/echo', evidence: 'GET /echo' });
    draft.rules.push({
      id: 'echo-ok',
      operationId: 'echo',
      description: '回显成功',
      evidence: '回显返回 200',
      assertion: { type: 'status', expected: 200 },
    });
    draft.cases.push({
      ...structuredClone(draft.cases[0]),
      key: 'echo',
      ruleIds: ['echo-ok'],
      executionInfo: { method: 'GET', path: '/echo', assertions: [{ type: 'status', expected: 200 }] },
    });
    await saveDocumentCases(db, created.body.id, draft);
    const task = await db.models.AgentTask.findByPk(created.body.id);
    const narrowed = await request(app)
      .put(`/agent/runs/1/tasks/${task.id}/plan`)
      .set('Authorization', auth())
      .send({
        version: task.version,
        cases: task.plan.cases,
        allowedOperationIds: ['plain'],
        limits: { ...task.plan.workflow.limits, maxRounds: 1 },
      });
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.plan.cases).toHaveLength(1);
    expect(narrowed.body.plan.workflow.excludedCases).toHaveLength(1);
    expect(narrowed.body.state).toBe('awaiting_confirmation');
    const restored = await request(app)
      .put(`/agent/runs/1/tasks/${task.id}/plan`)
      .set('Authorization', auth())
      .send({
        version: narrowed.body.version,
        cases: narrowed.body.plan.cases,
        allowedOperationIds: ['plain', 'echo'],
      });
    expect(restored.status).toBe(200);
    expect(restored.body.plan.cases).toHaveLength(2);
    expect(restored.body.plan.workflow.excludedCases).toHaveLength(0);
    expect(restored.body.plan.workflow.limits.maxRounds).toBe(1);
  });
  it('executes, discovers a new validation point, supplements and stops without replacing failures', async () => {
    const task = await confirmedDocument({ expected: 201 });
    const first = task.plan.cases[0];
    const supplement = {
      reason: '原始请求返回 200，与规则 201 不符；补测可选 probe 参数是否影响结果',
      analysis: `#${first.caseId} 的状态断言失败。可能原因：服务与文档版本不同，尚未证实。`,
      questions: [],
      cases: [
        {
          ...structuredClone(proposal.cases[0]),
          key: 'probe',
          scenario: 'boundary',
          purpose: '验证可选参数为空的边界',
          evidenceCaseIds: [first.caseId],
          executionInfo: { ...first.executionInfo, query: { probe: '' }, dependsOn: [] },
        },
      ],
    };
    let secondId;
    const completion = vi
      .fn()
      .mockResolvedValueOnce(tool('read_cases'))
      .mockResolvedValueOnce(tool('execute_case', { caseId: first.caseId }))
      .mockResolvedValueOnce(tool('get_results'))
      .mockResolvedValueOnce(tool('submit_document_cases', supplement))
      .mockImplementationOnce(async (messages) => {
        const output = JSON.parse(messages.at(-1).content);
        secondId = output.cases.find((item) => item.key === 'probe').caseId;
        return tool('execute_case', { caseId: secondId });
      })
      .mockResolvedValueOnce(tool('get_results'))
      .mockResolvedValueOnce(
        tool('submit_document_cases', {
          cases: [],
          questions: [],
          reason: '已验证默认请求和可选参数边界，无新的文档内验证点',
          analysis: '两次状态断言失败；文档版本差异仅是推测，应由业务负责人确认。',
        })
      );
    await runAgent(db, task.id, 'execute', { completion });
    await task.reload();
    expect(task.state, task.error).toBe('completed');
    expect(task.plan.workflow.stopReason).toBe('no_new_cases');
    expect(task.plan.workflow.rounds.map((round) => round.caseIds)).toEqual([[first.caseId], [secondId]]);
    expect(task.results.map((result) => [result.status, result.response.status])).toEqual([
      ['failed', 200],
      ['failed', 200],
    ]);
    expect(task.plan.cases[0].executionInfo.assertions[0].expected).toBe(201);
    expect(task.results[0].snapshot.executionInfo.assertions[0].expected).toBe(201);
    expect(documentAcceptance(task)).toMatchObject({ verdict: 'failed', failedCaseIds: [first.caseId, secondId] });
    const read = await request(app).get(`/agent/runs/1/tasks/${task.id}`).set('Authorization', auth());
    expect(read.body.acceptance).toEqual(documentAcceptance(task));
    expect(read.body.summary).toMatchObject({ total: 2, passed: 0, failed: 2, unexecuted: 0 });
    const exported = await request(app)
      .get(`/runs/download/1?type=xlsx&agentTaskId=${task.id}`)
      .set('Authorization', auth())
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(exported.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.body);
    const sheet = workbook.getWorksheet('文档验收');
    expect(sheet.getCell('C2').value).toBe(read.body.acceptance.verdict);
    expect(sheet.getCell('C3').value).toBe(read.body.acceptance.stopReason);
    const rows = [];
    sheet.eachRow((row) => rows.push(row.values));
    expect(JSON.stringify(rows)).toContain(supplement.reason);
    expect(workbook.getWorksheet('用例结果').getCell('C2').value).toBe('失败');
  });
  it('deduplicates a renamed case and stops when no effective new point remains', async () => {
    const task = await confirmedDocument();
    const caseId = task.plan.cases[0].caseId;
    const completion = vi
      .fn()
      .mockResolvedValueOnce(tool('read_cases'))
      .mockResolvedValueOnce(tool('execute_case', { caseId }))
      .mockResolvedValueOnce(tool('get_results'))
      .mockResolvedValueOnce(
        tool('submit_document_cases', {
          cases: [{ ...structuredClone(proposal.cases[0]), key: 'renamed' }],
          questions: [],
          reason: '重复验证',
        })
      );
    await runAgent(db, task.id, 'execute', { completion });
    await task.reload();
    expect(task.plan.workflow.stopReason).toBe('no_new_cases');
    expect(task.results).toHaveLength(1);
    expect(await db.models.Case.count()).toBe(1);
  });
  it.each([
    [{ maxRounds: 0 }, 'max_rounds'],
    [{ maxCases: 1 }, 'max_cases'],
    [{ maxModelCalls: 2 }, 'max_model_calls'],
  ])('respects the confirmed budget %j', async (limits, reason) => {
    const task = await confirmedDocument({ limits });
    const completion = vi
      .fn()
      .mockResolvedValueOnce(tool('read_cases'))
      .mockResolvedValueOnce(tool('execute_case', { caseId: task.plan.cases[0].caseId }))
      .mockResolvedValueOnce(tool('get_results'));
    await runAgent(db, task.id, 'execute', { completion });
    await task.reload();
    expect(task.plan.workflow.stopReason).toBe(reason);
    expect(documentAcceptance(task).verdict).toBe('inconclusive');
    expect(completion.mock.calls.length).toBeLessThanOrEqual(limits.maxModelCalls || 40);
    expect(task.results[0].status).toBe('passed');
  });
  it('records time exhaustion without calling the next tool', async () => {
    const task = await confirmedDocument();
    const completion = vi.fn(
      async (_messages, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          if (signal.aborted) reject(signal.reason);
        })
    );
    await runAgent(db, task.id, 'execute', { completion, timeoutMs: 35 });
    await task.reload();
    expect(task.plan.workflow.stopReason).toBe('max_time');
    expect(task.results[0]).toMatchObject({ status: 'skipped', request: null });
  });
  it('preserves the request failure and stops before requesting supplements', async () => {
    const task = await confirmedDocument({ path: '/disconnect' });
    const completion = vi
      .fn()
      .mockResolvedValueOnce(tool('read_cases'))
      .mockResolvedValueOnce(tool('execute_case', { caseId: task.plan.cases[0].caseId }));
    await runAgent(db, task.id, 'execute', { completion });
    await task.reload();
    expect(task.plan.workflow.stopReason).toBe('execution_fault');
    expect(task.results[0].status).toBe('error');
    expect(task.results[0].request).not.toBeNull();
    expect(completion).toHaveBeenCalledTimes(2);
  });
  it('pauses for out-of-scope supplements without inserting or executing them', async () => {
    const task = await confirmedDocument();
    const completion = vi
      .fn()
      .mockResolvedValueOnce(tool('read_cases'))
      .mockResolvedValueOnce(tool('execute_case', { caseId: task.plan.cases[0].caseId }))
      .mockResolvedValueOnce(tool('get_results'))
      .mockResolvedValueOnce(
        tool('submit_document_cases', {
          cases: [
            {
              ...structuredClone(proposal.cases[0]),
              key: 'outside',
              executionInfo: { ...proposal.cases[0].executionInfo, path: '/admin' },
            },
          ],
          questions: [],
          reason: '尝试未确认的接口',
        })
      );
    await runAgent(db, task.id, 'execute', { completion });
    await task.reload();
    expect(task.state).toBe('needs_input');
    expect(task.plan.workflow.stopReason).toBe('needs_confirmation');
    expect(task.plan.workflow.pending.questions.join('；')).toContain('范围');
    expect(await db.models.Case.count()).toBe(1);
    expect(task.results).toHaveLength(1);
  });
  it('stops a pending model call through the authenticated endpoint', async () => {
    const task = await confirmedDocument();
    let notifyStarted;
    const started = new Promise((resolve) => {
      notifyStarted = resolve;
    });
    const completion = vi.fn(
      async (_messages, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          notifyStarted();
        })
    );
    const running = runAgent(db, task.id, 'execute', { completion });
    await started;
    expect((await request(app).post(`/agent/runs/1/tasks/${task.id}/stop`).set('Authorization', auth(2))).status).toBe(
      403
    );
    expect((await request(app).post(`/agent/runs/1/tasks/${task.id}/stop`).set('Authorization', auth())).status).toBe(
      202
    );
    await running;
    await task.reload();
    expect(task.state).toBe('stopped');
    expect(task.plan.workflow.stopReason).toBe('user_stopped');
    expect(task.results[0].request).toBeNull();
    expect(completion).toHaveBeenCalledTimes(1);
  });
  it('retains in-flight HTTP evidence when the user stops', async () => {
    const task = await confirmedDocument({ path: '/slow' });
    let notifyRequest;
    const received = new Promise((resolve) => {
      notifyRequest = resolve;
    });
    const listener = (req) => {
      if (req.url === '/slow') notifyRequest();
    };
    server.on('request', listener);
    const completion = vi
      .fn()
      .mockResolvedValueOnce(tool('read_cases'))
      .mockResolvedValueOnce(tool('execute_case', { caseId: task.plan.cases[0].caseId }));
    const running = runAgent(db, task.id, 'execute', { completion });
    await received;
    const stopped = await request(app).post(`/agent/runs/1/tasks/${task.id}/stop`).set('Authorization', auth());
    expect(stopped.status).toBe(202);
    await running;
    await task.reload();
    server.off('request', listener);
    expect(task.state).toBe('stopped');
    expect(task.plan.workflow.stopReason).toBe('user_stopped');
    expect(task.results[0].request.url).toContain('/slow');
    expect(task.results[0].status).toBe('error');
    expect(completion).toHaveBeenCalledTimes(2);
  });
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
