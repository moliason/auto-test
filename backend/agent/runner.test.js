import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoServer } from '../../demo/server.mjs';
import demoCases from '../../demo/cases.json';
import { createAgentDatabase } from './database.fixture.js';
import { buildPlan, reportSummary } from './plan.js';
import { persistEvidence, recoverAgentTasks, runAgent } from './runner.js';

let db;
let server;
let environment;
const snapshots = demoCases.map((item) => ({ ...item, caseId: item.id, questions: [], steps: [] }));
beforeAll(async () => {
  server = createDemoServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  environment = { baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 100 };
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(async () => {
  vi.stubEnv('TEST_AGENT_ALLOWED_ORIGINS', environment.baseUrl);
  db = await createAgentDatabase();
  await db.models.Case.bulkCreate(
    demoCases.map((item) => ({
      ...item,
      folderId: 1,
      caseNo: item.id,
      state: 0,
      priority: 2,
      type: 0,
      automationStatus: 1,
      template: 0,
    }))
  );
  await db.models.RunCase.bulkCreate(demoCases.map((item) => ({ runId: 1, caseId: item.id, status: 0 })));
});
afterEach(async () => {
  await db.close();
  vi.unstubAllEnvs();
});

const tool = (name, args = {}) => ({
  message: {
    tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  },
  finish_reason: 'tool_calls',
});

describe('Agent plans and controlled HTTP tools', () => {
  it('uses an explicitly authorized project secret for real HTTP execution', async () => {
    vi.stubEnv('TEST_AGENT_SECRET_GRANTS', JSON.stringify({ 1: ['TOKEN'] }));
    vi.stubEnv('TEST_AGENT_SECRET_TOKEN', 'demo-token');
    const source = [{ ...snapshots[1], executionInfo: { ...snapshots[1].executionInfo, dependsOn: [] } }];
    const task = await db.models.AgentTask.create({
      runId: 1,
      state: 'running',
      plan: buildPlan(source, { ...environment, secretVariables: ['TOKEN'] }, null, '', 1),
    });
    const completion = vi
      .fn()
      .mockResolvedValueOnce(tool('read_cases'))
      .mockResolvedValueOnce(tool('execute_case', { caseId: 2 }))
      .mockResolvedValueOnce(tool('get_results'))
      .mockResolvedValueOnce(tool('submit_report', { analysis: '授权认证调用成功' }));
    await runAgent(db, task.id, 'execute', { completion });
    await task.reload();
    expect(task.state).toBe('completed');
    expect(task.results[0].status).toBe('passed');
    expect(JSON.stringify(task.toJSON())).not.toContain('demo-token');
  });
  it('rechecks secret authorization at execution and never reads another project grant', async () => {
    vi.stubEnv('TEST_AGENT_SECRET_GRANTS', JSON.stringify({ 2: ['TOKEN'] }));
    vi.stubEnv('TEST_AGENT_SECRET_TOKEN', 'demo-token');
    const source = [{ ...snapshots[1], executionInfo: { ...snapshots[1].executionInfo, dependsOn: [] } }];
    const plan = buildPlan(source, { ...environment, secretVariables: ['TOKEN'] });
    const task = await db.models.AgentTask.create({ runId: 1, state: 'running', plan: { ...plan, projectId: 2 } });
    const completion = vi.fn();
    await runAgent(db, task.id, 'execute', { completion });
    await task.reload();
    expect(task.state).toBe('failed');
    expect(task.error).toContain('未授权');
    expect(completion).not.toHaveBeenCalled();
    expect(task.results.every((item) => item.request === null)).toBe(true);
    expect(JSON.stringify(task.toJSON())).not.toContain('demo-token');
  });
  it.each([{ extract: [] }, { extract: [{ name: 'PUBLIC_VALUE', path: '/token', secret: false }] }])(
    'never persists or sends assertion credentials to the model even without secret extraction: $extract',
    async ({ extract }) => {
      const source = [{ ...snapshots[0], executionInfo: { ...snapshots[0].executionInfo, extract } }];
      const task = await db.models.AgentTask.create({
        runId: 1,
        state: 'running',
        plan: buildPlan(source, environment),
      });
      const completion = vi
        .fn()
        .mockResolvedValueOnce(tool('read_cases'))
        .mockResolvedValueOnce(tool('execute_case', { caseId: 1 }))
        .mockResolvedValueOnce(tool('get_results'))
        .mockResolvedValueOnce(tool('submit_report', { analysis: '登录结果已核对' }));
      await runAgent(db, task.id, 'execute', { completion });
      await task.reload();
      expect(task.state).toBe('completed');
      expect(task.results[0].status).toBe('passed');
      expect(task.results[0].assertions.find((item) => item.path === '/token')).toMatchObject({
        passed: true,
        actual: '[REDACTED]',
      });
      expect(JSON.stringify(task.toJSON())).not.toContain('demo-token');
      expect(JSON.stringify(completion.mock.calls)).not.toContain('demo-token');
    }
  );
  it('persists phase, timings and provider usage including failures without changing old evidence', async () => {
    const task = await db.models.AgentTask.create({
      runId: 1,
      plan: buildPlan(snapshots.slice(0, 1), environment),
      events: [{ type: 'user_plan_edited', at: '2026-10-07T00:00:00.000Z' }],
    });
    const completion = vi
      .fn()
      .mockResolvedValueOnce({
        ...tool('read_cases'),
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('模型返回内容不完整或格式无效'), { usage: { total_tokens: 512 } })
      );
    await runAgent(db, task.id, 'prepare', { completion });
    await task.reload();
    expect(task.state).toBe('failed');
    expect(task.events[0]).toEqual({ type: 'user_plan_edited', at: '2026-10-07T00:00:00.000Z' });
    const calls = task.events.filter((event) => event.type === 'model');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ phase: 'prepare', call: 1, outcome: 'completed', usage: { total_tokens: 25 } });
    expect(calls[1]).toMatchObject({ phase: 'prepare', call: 2, outcome: 'failed', usage: { total_tokens: 512 } });
    for (const call of calls) {
      expect(call.durationMs).toBeGreaterThanOrEqual(0);
      expect(Date.parse(call.finishedAt)).toBeGreaterThanOrEqual(Date.parse(call.at));
    }
  });

  it('detects missing information, missing variables and circular dependencies', () => {
    expect(buildPlan(snapshots, environment).issues.join(' ')).toContain('#8');
    expect(buildPlan([snapshots[1]], environment).issues.join(' ')).toContain('前置用例 #1');
    expect(
      buildPlan(
        [{ ...snapshots[0], executionInfo: { ...snapshots[0].executionInfo, dependsOn: [2] } }, snapshots[1]],
        environment
      ).issues.join(' ')
    ).toContain('循环依赖');
    expect(buildPlan(snapshots.slice(0, 2), environment).issues).toEqual([]);
    expect(buildPlan(snapshots.slice(0, 2).reverse(), environment).order).toEqual([1, 2]);
  });

  it('preserves explicit business questions and refuses invented paths without API documentation', async () => {
    const source = [{ ...snapshots[7], questions: ['健康检查的实际接口路径是什么？'] }];
    const task = await db.models.AgentTask.create({ runId: 1, createdBy: 1, plan: buildPlan(source, environment) });
    const completion = vi
      .fn()
      .mockResolvedValueOnce(tool('read_cases'))
      .mockResolvedValueOnce(
        tool('submit_plan', {
          cases: [
            {
              caseId: 8,
              executionInfo: { method: 'GET', path: '/invented', assertions: [{ type: 'status', expected: 200 }] },
              questions: [],
            },
          ],
          notes: '待核对',
        })
      );
    await runAgent(db, task.id, 'prepare', { completion });
    await task.reload();
    expect(task.state).toBe('needs_input');
    expect(task.plan.cases[0].executionInfo).toBeNull();
    expect(task.plan.cases[0].questions).toEqual(source[0].questions);
    expect(task.results).toEqual([]);
    expect(task.events.some((event) => event.name === 'submit_plan')).toBe(true);
  });

  it('executes real requests, skips failed dependencies, persists evidence and retains history across runs', async () => {
    const plan = buildPlan(snapshots.slice(0, 7), environment);
    const task = await db.models.AgentTask.create({ runId: 1, state: 'running', startedAt: new Date(), plan });
    const completion = vi.fn().mockResolvedValueOnce(tool('read_cases'));
    for (let caseId = 1; caseId <= 7; caseId++) completion.mockResolvedValueOnce(tool('execute_case', { caseId }));
    completion
      .mockResolvedValueOnce(tool('execute_case', { caseId: 1 }))
      .mockResolvedValueOnce(tool('get_results'))
      .mockResolvedValueOnce(
        tool('submit_report', { analysis: '#3 total 实测 90，预期 100。原因尚待确认。#7 因前置 #6 失败跳过。' })
      );
    await runAgent(db, task.id, 'execute', { completion });
    await task.reload();
    expect(task.state).toBe('completed');
    expect(task.results.map((result) => result.status)).toEqual([
      'passed',
      'passed',
      'failed',
      'error',
      'error',
      'failed',
      'skipped',
    ]);
    expect(task.results[6].request).toBeNull();
    expect(task.results[6].reason).toContain('#6');
    const saves = task.events.filter((event) => event.type === 'evidence_saved');
    expect(saves.map((event) => event.caseId)).toEqual([1, 2, 3, 4, 5, 6, 7]); // Repeated execute_case does not save twice.
    expect(saves.every((event) => event.durationMs >= 0)).toBe(true);
    expect(
      task.events.find((event) => event.name === 'submit_report' && event.type === 'tool_finished').reportDurationMs
    ).toBeGreaterThanOrEqual(0);
    expect(reportSummary(task)).toEqual({ total: 7, passed: 2, failed: 4, unexecuted: 1, requestErrors: 2 });
    expect(JSON.stringify(task.results)).not.toContain('demo-token');
    expect((await db.models.RunCase.findAll({ order: [['caseId', 'ASC']] })).map((item) => item.status)).toEqual([
      1, 1, 2, 2, 2, 2, 4, 0,
    ]);
    expect((await db.models.Run.findByPk(1)).state).toBe(1); // Unselected case 8 is still untested.
    const second = await db.models.AgentTask.create({
      runId: 1,
      state: 'running',
      startedAt: new Date(),
      plan: buildPlan(snapshots.slice(0, 1), environment),
    });
    const secondCompletion = vi
      .fn()
      .mockResolvedValueOnce(tool('read_cases'))
      .mockResolvedValueOnce(tool('execute_case', { caseId: 1 }))
      .mockResolvedValueOnce(tool('get_results'))
      .mockResolvedValueOnce(tool('submit_report', { analysis: '本次 #1 通过。' }));
    await runAgent(db, second.id, 'execute', { completion: secondCompletion });
    expect((await db.models.AgentTask.findByPk(task.id)).results).toHaveLength(7);
    expect((await db.models.RunCase.findOne({ where: { runId: 1, caseId: 1 } })).agentTaskId).toBe(second.id);
    expect((await db.models.AgentTask.findByPk(second.id)).results).toHaveLength(1);
  });

  it('preserves completed evidence after a model failure and marks remaining cases unexecuted', async () => {
    const task = await db.models.AgentTask.create({
      runId: 1,
      state: 'running',
      startedAt: new Date(),
      plan: buildPlan(snapshots.slice(0, 2), environment),
    });
    const completion = vi
      .fn()
      .mockResolvedValueOnce(tool('read_cases'))
      .mockResolvedValueOnce(tool('execute_case', { caseId: 1 }))
      .mockRejectedValueOnce(new Error('模型连接失败'));
    await runAgent(db, task.id, 'execute', { completion });
    await task.reload();
    expect(task.state).toBe('failed');
    expect(task.error).toContain('模型连接失败');
    expect(task.results.map((item) => item.status)).toEqual(['passed', 'skipped']);
    expect(task.results[0].response.status).toBe(200);
    expect(task.results[1].reason).toContain('任务中止');
    expect(task.events.filter((event) => event.type === 'evidence_saved').map((event) => event.caseId)).toEqual([1, 2]);
    expect(task.events.some((event) => event.reportDurationMs !== undefined)).toBe(false);
    const lastCall = task.events.filter((event) => event.type === 'model').at(-1);
    expect(lastCall).toMatchObject({ phase: 'execute', outcome: 'failed', usage: null });
  });

  it('rejects unknown cases, changed tool parameters and out-of-order dependencies, then stops at the limit', async () => {
    const task = await db.models.AgentTask.create({
      runId: 1,
      state: 'running',
      plan: buildPlan(snapshots.slice(0, 2), environment),
    });
    const completion = vi
      .fn()
      .mockResolvedValueOnce(tool('read_cases'))
      .mockResolvedValueOnce(tool('execute_case', { caseId: 999 }))
      .mockResolvedValueOnce(tool('execute_case', { caseId: 1, path: '/override' }))
      .mockResolvedValueOnce(tool('execute_case', { caseId: 2 }));
    await runAgent(db, task.id, 'execute', { completion, maxCalls: 4 });
    await task.reload();
    expect(task.state).toBe('failed');
    expect(task.results.every((item) => item.status === 'skipped' && item.request === null)).toBe(true);
    expect(task.events.filter((event) => event.type === 'tool_finished' && event.ok === false)).toHaveLength(3);
  });

  it('does not run a task that has not been confirmed', async () => {
    const task = await db.models.AgentTask.create({
      runId: 1,
      state: 'awaiting_confirmation',
      plan: buildPlan(snapshots.slice(0, 1), environment),
    });
    const completion = vi.fn();
    await runAgent(db, task.id, 'execute', { completion });
    expect(completion).not.toHaveBeenCalled();
    expect((await task.reload()).results).toEqual([]);
  });

  it('recovers interrupted tasks without re-sending requests and keeps existing evidence', async () => {
    const task = await db.models.AgentTask.create({
      runId: 1,
      state: 'running',
      plan: buildPlan(snapshots.slice(0, 2), environment),
    });
    await persistEvidence(db, task.id, task.plan.cases[0], {
      status: 'passed',
      assertions: [],
      response: { status: 200 },
    });
    await recoverAgentTasks(db);
    await task.reload();
    expect(task.state).toBe('interrupted');
    expect(task.results.map((item) => item.status)).toEqual(['passed', 'skipped']);
    expect(task.results[1].reason).toContain('服务重启');
    await recoverAgentTasks(db);
    expect((await task.reload()).results).toHaveLength(2);
  });
});
