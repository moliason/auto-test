import { test, expect } from '@playwright/test';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import ExcelJS from '../backend/node_modules/exceljs/excel.js';

const api = process.env.E2E_API_URL || 'http://localhost:8011';

test('real OpenAPI YAML upload generates editable cases without sending HTTP before confirmation', async ({
  page,
  request,
}, testInfo) => {
  const env = parseEnv(readFileSync(path.resolve('backend/.env'), 'utf8'));
  const seeded = JSON.parse(readFileSync(path.resolve('backend/.env.agent-demo.json'), 'utf8'));
  const login = await request.post(`${api}/users/signin`, {
    data: { email: env.ADMIN_EMAIL || 'admin666@local', password: env.ADMIN_PASSWORD || '666666' },
  });
  expect(login.ok()).toBeTruthy();
  const token = await login.json();
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const createdRun = await request.post(`${api}/runs?projectId=${seeded.projectId}`, {
    headers,
    data: { name: `OpenAPI 文档审核 ${new Date().toISOString()}`, state: 0 },
  });
  expect(createdRun.ok()).toBeTruthy();
  const run = await createdRun.json();
  expect(
    (
      await request.put(`${api}/agent/runs/${run.id}/environment`, {
        headers,
        data: { environment: { baseUrl: 'http://127.0.0.1:4010' } },
      })
    ).ok()
  ).toBeTruthy();
  await page.addInitScript((value) => localStorage.setItem('unittcms-auth-token', JSON.stringify(value)), token);
  await page.goto(`/zh-CN/projects/${seeded.projectId}/runs/${run.id}`);
  await page.getByRole('button', { name: '接口测试 Agent', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('任务来源', { exact: true }).selectOption('document');
  await dialog.getByLabel('接口文档文件', { exact: true }).setInputFiles(path.resolve('demo/interface-testing.yaml'));
  const creating = page.waitForResponse(
    (response) => response.url().endsWith(`/runs/${run.id}/tasks/document`) && response.request().method() === 'POST'
  );
  await dialog.getByRole('button', { name: '从文档生成测试用例', exact: true }).click();
  const response = await creating;
  expect(response.status()).toBe(202);
  const created = await response.json();
  await expect
    .poll(
      async () =>
        (await (await request.get(`${api}/agent/runs/${run.id}/tasks/${created.id}`, { headers })).json()).state,
      { timeout: 250000, intervals: [2000, 5000] }
    )
    .not.toBe('preparing');
  const task = await (await request.get(`${api}/agent/runs/${run.id}/tasks/${created.id}`, { headers })).json();
  writeFileSync(testInfo.outputPath('openapi-prepared-task.json'), JSON.stringify(task, null, 2));
  expect(task.state, JSON.stringify({ error: task.error, issues: task.plan.issues })).toBe('awaiting_confirmation');
  expect(task.plan.workflow.document.format).toBe('openapi');
  expect(task.plan.workflow.document.operations).toHaveLength(2);
  expect(task.results).toEqual([]);
  expect(task.startedAt).toBeNull();
  expect(task.plan.cases.length).toBeGreaterThan(0);
  await expect(dialog.getByRole('heading', { name: `任务 #${task.id} · 待确认执行` })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '确认并开始执行', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('openapi-confirmation.png') });
});

test('real DeepSeek document import, confirmed loop, evidence and export', async ({ page, request }, testInfo) => {
  const env = parseEnv(readFileSync(path.resolve('backend/.env'), 'utf8'));
  const seeded = JSON.parse(readFileSync(path.resolve('backend/.env.agent-demo.json'), 'utf8'));
  const login = await request.post(`${api}/users/signin`, {
    data: { email: env.ADMIN_EMAIL || 'admin666@local', password: env.ADMIN_PASSWORD || '666666' },
  });
  expect(login.ok()).toBeTruthy();
  const token = await login.json();
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const createdRun = await request.post(`${api}/runs?projectId=${seeded.projectId}`, {
    headers,
    data: {
      name: `文档闭环验收 ${new Date().toISOString()}`,
      description: '独立演示数据，真实 DeepSeek 与真实 HTTP',
      state: 0,
    },
  });
  expect(createdRun.ok()).toBeTruthy();
  const run = await createdRun.json();
  expect(
    (
      await request.put(`${api}/agent/runs/${run.id}/environment`, {
        headers,
        data: { environment: { baseUrl: 'http://127.0.0.1:4010', timeoutMs: 5000 } },
      })
    ).ok()
  ).toBeTruthy();
  await page.addInitScript((value) => localStorage.setItem('unittcms-auth-token', JSON.stringify(value)), token);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/zh-CN/projects/${seeded.projectId}/runs/${run.id}`);
  await page.getByRole('button', { name: '接口测试 Agent', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('任务来源', { exact: true }).selectOption('document');
  const generate = dialog.getByRole('button', { name: '从文档生成测试用例', exact: true });
  await expect(generate).toBeDisabled();
  await dialog.getByLabel('接口文档文件', { exact: true }).setInputFiles(path.resolve('demo/interface-testing.md'));
  await dialog.getByLabel('用例总数上限', { exact: true }).fill('12');
  await dialog.getByLabel('模型调用总上限', { exact: true }).fill('30');
  await dialog.getByLabel('最多补测轮次', { exact: true }).fill('3');
  await dialog.getByLabel('执行时间上限（秒）', { exact: true }).fill('300');
  const creating = page.waitForResponse(
    (response) => response.url().endsWith(`/runs/${run.id}/tasks/document`) && response.request().method() === 'POST'
  );
  await generate.click();
  const createdResponse = await creating;
  expect(createdResponse.status()).toBe(202);
  const created = await createdResponse.json();
  await expect
    .poll(
      async () =>
        (await (await request.get(`${api}/agent/runs/${run.id}/tasks/${created.id}`, { headers })).json()).state,
      { timeout: 250000, intervals: [2000, 5000] }
    )
    .not.toBe('preparing');
  const ready = await (await request.get(`${api}/agent/runs/${run.id}/tasks/${created.id}`, { headers })).json();
  writeFileSync(testInfo.outputPath('prepared-task.json'), JSON.stringify(ready, null, 2));
  expect(ready.state, JSON.stringify({ error: ready.error, issues: ready.plan.issues })).toBe('awaiting_confirmation');
  expect(ready.results).toEqual([]);
  expect(Number.isFinite(Date.parse(ready.createdAt))).toBe(true);
  expect(ready.plan.cases.length).toBeLessThanOrEqual(6);
  expect(
    [
      ...new Set(
        ready.plan.workflow.rules
          .filter((rule) => rule.assertion.type === 'jsonEquals' && rule.assertion.path === '/query/probe')
          .map((rule) => rule.assertion.expected)
      ),
    ].sort()
  ).toEqual(['', 'alpha', '中文', '0', 'a b', 'a/b', '%'].sort());
  expect(
    ready.plan.workflow.rules.some(
      (rule) =>
        rule.assertion.type === 'jsonEquals' && rule.assertion.path === '/total' && rule.assertion.expected === 100
    )
  ).toBe(true);
  expect(ready.measurements[0].completedCalls).toBeGreaterThan(0);
  expect(ready.measurements[0].tokens.total_tokens.value).toBeGreaterThan(0);
  await expect(dialog.getByRole('heading', { name: `任务 #${created.id} · 待确认执行` })).toBeVisible();
  const execute = dialog.getByRole('button', { name: '确认并开始执行', exact: true });
  await expect(execute).toBeDisabled();
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth + 1)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`document-plan-${width}.png`) });
  }
  await dialog
    .getByRole('checkbox', { name: '已核对接口范围、允许的操作、规则依据和自动补测预算', exact: true })
    .check();
  await dialog.getByRole('checkbox', { name: '已准备测试数据、认证信息及其他前置条件', exact: true }).check();
  await execute.click();
  await expect(dialog.getByRole('button', { name: '停止当前任务', exact: true })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await (await request.get(`${api}/agent/runs/${run.id}/tasks/${created.id}`, { headers })).json()).state,
      { timeout: 330000, intervals: [2000, 5000] }
    )
    .not.toBe('running');
  const task = await (await request.get(`${api}/agent/runs/${run.id}/tasks/${created.id}`, { headers })).json();
  writeFileSync(testInfo.outputPath('completed-task.json'), JSON.stringify(task, null, 2));
  expect(task.state, JSON.stringify({ error: task.error, pending: task.plan.workflow.pending })).toBe('completed');
  expect(Number.isFinite(Date.parse(task.startedAt))).toBe(true);
  expect(Number.isFinite(Date.parse(task.finishedAt))).toBe(true);
  expect(task.plan.workflow.stopReason).toBe('no_new_cases');
  expect(task.plan.workflow.rounds.length).toBeGreaterThan(1);
  expect(task.results.length).toBeGreaterThan(ready.plan.cases.length);
  expect(task.summary.failed).toBeGreaterThan(0);
  expect(task.acceptance.verdict).toBe('failed');
  expect(task.measurements[1].tokens.total_tokens.value).toBeGreaterThan(0);
  for (const result of task.results) expect(result.request).not.toBeNull();
  const report = dialog.getByRole('region', { name: '文档验收', exact: true });
  await expect(report.getByRole('heading', { name: '文档验收 · 存在失败项', exact: true })).toBeVisible();
  await expect(report.getByText('停止原因：没有新的有效验证点', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('历史执行记录', { exact: true }).locator('option:checked')).toContainText('已完成');
  await expect(dialog.getByText('Invalid Date', { exact: false })).toHaveCount(0);
  const exported = await request.get(`${api}/runs/download/${run.id}?type=xlsx&agentTaskId=${task.id}`, { headers });
  expect(exported.ok()).toBeTruthy();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await exported.body());
  expect(workbook.getWorksheet('文档验收').getCell('C2').value).toBe(task.acceptance.verdict);
  expect(workbook.getWorksheet('文档验收').getCell('C3').value).toBe(task.plan.workflow.stopReason);
  expect(workbook.getWorksheet('用例结果').rowCount - 1).toBe(task.results.length);
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '导出本次 Excel 报告', exact: true }).click();
  await (await download).saveAs(testInfo.outputPath('document-agent-report.xlsx'));
  await page.screenshot({ path: testInfo.outputPath('document-report.png') });
  expect(errors).toEqual([]);
  writeFileSync(
    testInfo.outputPath('verification.json'),
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        projectId: seeded.projectId,
        runId: run.id,
        taskId: task.id,
        model: task.plan.model,
        provider: task.plan.provider,
        summary: task.summary,
        acceptance: task.acceptance,
        rounds: task.plan.workflow.rounds,
        measurements: task.measurements,
        note: '模型为真实官方 DeepSeek；HTTP 为本地可重复演示；不代表真实人员节省时间。',
      },
      null,
      2
    )
  );
});
