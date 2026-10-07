import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';
import { createAgentDatabase } from '../../agent/database.fixture.js';
import downloadRoute from './download.js';

let db, app, task;
const auth = (userId = 1) => `Bearer ${jwt.sign({ userId }, 'agent-test-only')}`;
beforeEach(async () => {
  vi.stubEnv('SECRET_KEY', 'agent-test-only');
  db = await createAgentDatabase();
  await db.models.Case.create({
    id: 1,
    folderId: 1,
    title: 'Current changed title',
    caseNo: 1,
    state: 0,
    priority: 2,
    type: 0,
    automationStatus: 1,
    template: 0,
  });
  await db.models.RunCase.create({ runId: 1, caseId: 1, status: 2, executionSource: 'manual' });
  task = await db.models.AgentTask.create({
    runId: 1,
    state: 'completed',
    startedAt: new Date(),
    finishedAt: new Date(),
    plan: {
      model: 'test-model',
      provider: 'test-provider',
      environment: { baseUrl: 'http://127.0.0.1:4010', headers: { Authorization: 'Bearer secret-not-for-export' } },
      cases: [1, 2, 3, 4].map((caseId) => ({
        caseId,
        title: `Original ${caseId}`,
        expectedResults: 'Expected at execution',
      })),
    },
    results: [
      {
        caseId: 1,
        title: 'Original 1',
        status: 'passed',
        mappedToRun: true,
        durationMs: 12,
        reason: '',
        snapshot: { title: 'Original 1', expectedResults: 'Expected at execution' },
        request: { method: 'GET', url: 'http://127.0.0.1:4010/large' },
        response: { status: 200, body: 'x'.repeat(70000) },
        assertions: [{ type: 'status', expected: 200, actual: 200, passed: true }],
      },
      {
        caseId: 2,
        title: 'Original 2',
        status: 'failed',
        durationMs: 10,
        reason: '值不一致',
        assertions: [{ type: 'jsonEquals', path: '/total', expected: 100, actual: 90, passed: false }],
      },
      { caseId: 3, title: 'Original 3', status: 'error', durationMs: 100, reason: '请求超时', assertions: [] },
    ],
    analysis: '推测：总额计算规则可能有误，需要结合业务规则核实。',
  });
  app = express();
  app.use('/runs', downloadRoute(db));
});
afterEach(async () => {
  await db.close();
  vi.unstubAllEnvs();
});

describe('Agent historical Excel reports', () => {
  it('exports persisted facts, complete long responses, historical expectations and distinct AI analysis', async () => {
    const response = await request(app)
      .get(`/runs/download/1?type=xlsx&agentTaskId=${task.id}`)
      .set('Authorization', auth(3))
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain('.xlsx');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(response.body);
    const overview = Object.fromEntries(
      book
        .getWorksheet('执行概览')
        .getSheetValues()
        .filter(Boolean)
        .map((row) => [row[1], row[2]])
    );
    expect(overview).toMatchObject({
      用例总数: 4,
      通过: 1,
      '失败（含请求异常）': 2,
      '未执行（含跳过）': 1,
      请求异常: 1,
      模型: 'test-model',
    });
    expect(book.getWorksheet('用例结果').getRow(2).values).toContain('Original 1');
    expect(book.getWorksheet('用例结果').getRow(2).values).toContain('通过');
    const evidence = book.getWorksheet('完整执行证据').getSheetValues().filter(Boolean);
    const chunks = evidence.filter((row) => row[1] === 1 && row[2] === '实际响应');
    expect(chunks.length).toBeGreaterThan(1);
    expect(JSON.parse(chunks.map((row) => row[4]).join('')).body).toBe('x'.repeat(70000));
    expect(JSON.stringify(book.getWorksheet('AI 分析').getSheetValues())).toContain('待核实推测');
    expect(JSON.stringify(book.model)).not.toContain('secret-not-for-export');
    expect(JSON.stringify(book.model)).not.toContain('Current changed title');
  });
  it('restricts public-project evidence to reporters and prevents task ID swapping', async () => {
    await db.models.Project.update({ isPublic: true }, { where: { id: 1 } });
    expect(
      (await request(app).get(`/runs/download/1?type=xlsx&agentTaskId=${task.id}`).set('Authorization', auth(2))).status
    ).toBe(403);
    expect(
      (await request(app).get(`/runs/download/2?type=xlsx&agentTaskId=${task.id}`).set('Authorization', auth(2))).status
    ).toBe(404);
    expect(
      (await request(app).get('/runs/download/1?type=xlsx&agentTaskId=invalid').set('Authorization', auth())).status
    ).toBe(400);
    expect(
      (await request(app).get(`/runs/download/1?type=csv&agentTaskId=${task.id}`).set('Authorization', auth())).status
    ).toBe(400);
  });
  it('keeps the existing platform Excel export available without an Agent task', async () => {
    const response = await request(app)
      .get('/runs/download/1?type=xlsx')
      .set('Authorization', auth())
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(response.status).toBe(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(response.body);
    expect(book.worksheets[0].getRow(2).values).toContain('Current changed title');
    expect(book.worksheets[0].getRow(2).values).toContain('失败');
  });
});
