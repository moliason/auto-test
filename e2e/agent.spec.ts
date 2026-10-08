import { test, expect } from '@playwright/test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const api = process.env.E2E_API_URL || 'http://localhost:8011';

test('real Agent flow: missing information, confirmation, HTTP results, history and Excel', async ({
  page,
  request,
}, testInfo) => {
  const backend = path.resolve('backend');
  const env = parseEnv(readFileSync(path.join(backend, '.env'), 'utf8'));
  // Seed before starting the backend so project grants are loaded in its process environment.
  const seeded = JSON.parse(readFileSync(path.join(backend, '.env.agent-demo.json'), 'utf8'));
  const login = await request.post(`${api}/users/signin`, {
    data: { email: env.ADMIN_EMAIL || 'admin666@local', password: env.ADMIN_PASSWORD || '666666' },
  });
  expect(login.ok()).toBeTruthy();
  const token = await login.json();
  const environment = await request.get(`${api}/agent/runs/${seeded.runId}/environment`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  expect(environment.ok()).toBeTruthy();
  expect((await environment.json()).issues, '初始化演示后须重启后端加载项目授权').toEqual([]);
  await page.addInitScript((value) => localStorage.setItem('unittcms-auth-token', JSON.stringify(value)), token);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/zh-CN/projects/${seeded.projectId}/runs/${seeded.runId}`);
  await page.getByRole('checkbox', { name: '全选', exact: true }).check();
  await page.getByRole('button', { name: '接口测试 Agent', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('本次选中', { exact: false })).toContainText('8');
  const create = dialog.getByRole('button', { name: '整理选中用例的测试计划' });
  await expect(create).toBeEnabled();
  const createdResponse = page.waitForResponse(
    (response) => response.url().endsWith(`/agent/runs/${seeded.runId}/tasks`) && response.request().method() === 'POST'
  );
  await create.click();
  const created = await (await createdResponse).json();
  await expect(dialog.getByRole('heading', { name: `任务 #${created.id} · 待补充信息` })).toBeVisible({
    timeout: 180000,
  });
  await expect(dialog.getByRole('button', { name: '确认并开始执行' })).toHaveCount(0);
  await dialog.getByRole('combobox', { name: `HTTP 方法 #${seeded.missingCaseId}`, exact: true }).selectOption('GET');
  await dialog.getByLabel(`接口路径 #${seeded.missingCaseId}`, { exact: true }).fill('/plain');
  await dialog
    .getByLabel(`请求与断言配置 #${seeded.missingCaseId}`, { exact: true })
    .fill(JSON.stringify({ assertions: [{ type: 'status', expected: 200 }] }));
  // Fixture expectations are explicit. Resolve any model questions using those documented fixture rules.
  for (const id of seeded.caseIds) {
    const section = dialog
      .locator('details')
      .filter({ has: page.locator('summary', { hasText: new RegExp(`^#${id} `) }) })
      .first();
    if ((await section.getAttribute('open')) === null) await section.locator('summary').first().click();
    await dialog.getByLabel(`待确认问题 #${id}`, { exact: true }).fill('');
  }
  await dialog.getByRole('checkbox', { name: '同时保存执行配置到原用例，供后续回归复用' }).check();
  await dialog.getByRole('button', { name: '保存并检查计划' }).click();
  await expect(dialog.getByRole('heading', { name: `任务 #${created.id} · 待确认执行` })).toBeVisible();
  const execute = dialog.getByRole('button', { name: '确认并开始执行' });
  await expect(execute).toBeDisabled();
  await dialog.getByRole('checkbox', { name: '已核对用例、请求参数、断言和测试环境' }).check();
  await expect(execute).toBeDisabled();
  await dialog.getByRole('checkbox', { name: '已准备测试数据、认证信息及其他前置条件' }).check();
  await expect(execute).toBeEnabled();
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(dialog).toBeVisible();
    const overflow = await dialog.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
    expect(overflow).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`agent-plan-${width}.png`) });
  }
  await execute.click();
  await expect(dialog.getByRole('heading', { name: `任务 #${created.id} · 已完成` })).toBeVisible({ timeout: 330000 });
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const task = await (await request.get(`${api}/agent/runs/${seeded.runId}/tasks/${created.id}`, { headers })).json();
  expect(task.summary).toEqual({ total: 8, passed: 3, failed: 4, unexecuted: 1, requestErrors: 2 });
  expect([...task.results].sort((a, b) => a.caseId - b.caseId).map((item: { status: string }) => item.status)).toEqual([
    'passed',
    'passed',
    'failed',
    'error',
    'error',
    'failed',
    'skipped',
    'passed',
  ]);
  const report = dialog.getByRole('region', { name: 'Agent 执行报告' });
  expect(task.executionMeasurements.requests).toMatchObject({ recorded: 7, total: 7 });
  expect(task.executionMeasurements.persistence).toMatchObject({ recorded: 8, total: 8 });
  expect(task.executionMeasurements.reportDurationMs).toBeGreaterThanOrEqual(0);
  await report.getByText('执行与整理耗时', { exact: true }).click();
  await expect(
    report.getByText(`${task.executionMeasurements.persistence.durationMs} ms（8/8 条已记录）`, { exact: true })
  ).toBeVisible();
  await expect(report.getByText('失败数量包含 2 条请求异常。', { exact: false })).toBeVisible();
  await report
    .locator('summary')
    .filter({ hasText: new RegExp(`^#${seeded.caseIds[2]} `) })
    .click();
  await expect(report.getByRole('cell', { name: '100', exact: true })).toBeVisible();
  await expect(report.getByRole('cell', { name: '90', exact: true })).toBeVisible();
  await report.getByRole('checkbox', { name: '仅看失败与未执行' }).check();
  await expect(report.locator('summary').filter({ hasText: new RegExp(`^#${seeded.caseIds[0]} `) })).toHaveCount(0);
  const failedCase = report
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: new RegExp(`^#${seeded.caseIds[2]} `) }) })
    .first();
  await expect(failedCase.getByRole('cell', { name: '90', exact: true })).toBeVisible();
  await expect(
    failedCase
      .locator('details')
      .filter({ has: page.locator('summary', { hasText: '实际响应' }) })
      .locator('pre')
  ).toBeVisible();
  await report.getByText('模型调用与 Token 用量', { exact: true }).click();
  await expect(report.getByRole('table', { name: '模型用量' })).toBeVisible();
  expect(task.measurements.map((item: { phase: string }) => item.phase)).toEqual(['prepare', 'execute']);
  expect(
    task.measurements.every(
      (item: { calls: number; timedCalls: number }) => item.calls > 0 && item.timedCalls === item.calls
    )
  ).toBe(true);
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth + 1)).toBe(false);
  }
  await report.getByRole('checkbox', { name: '仅看失败与未执行' }).uncheck();
  await expect(report.locator('summary').filter({ hasText: new RegExp(`^#${seeded.caseIds[0]} `) })).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '导出本次 Excel 报告' }).click();
  await (await downloaded).saveAs(testInfo.outputPath('agent-report.xlsx'));
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByText(`Agent #${created.id}`, { exact: true })).toHaveCount(8);
  const run = await (await request.get(`${api}/runs/${seeded.runId}`, { headers })).json();
  expect(
    Object.fromEntries(
      run.statusCounts.map((item: { status: number; count: string }) => [item.status, Number(item.count)])
    )
  ).toEqual({ '1': 3, '2': 4, '4': 1 });
  // Reopen the same history after leaving the dialog; evidence must still be available.
  await page.getByRole('button', { name: '接口测试 Agent', exact: true }).click();
  await dialog.getByRole('combobox', { name: '历史执行记录', exact: true }).selectOption(String(created.id));
  await expect(dialog.getByRole('heading', { name: `任务 #${created.id} · 已完成` })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('agent-report.png') });
  expect(errors).toEqual([]);
});
