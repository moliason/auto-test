import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import ExcelJS from '../backend/node_modules/exceljs/excel.js';

const root = new URL('./', import.meta.url);
const state = JSON.parse(readFileSync(new URL('.env.study.json', root), 'utf8'));
const fixtureText = readFileSync(new URL('cases.json', root), 'utf8');
const fixtures = JSON.parse(fixtureText);
const baseUrl = 'http://localhost:8011';
const outputDir = new URL(`evidence/${state.studyId}/`, root);
mkdirSync(outputDir, { recursive: true });
const loginResponse = await fetch(baseUrl + '/users/signin', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: state.email, password: state.password }),
});
assert.equal(loginResponse.status, 200);
const token = await loginResponse.json();
const headers = { Authorization: `Bearer ${token.access_token}` };
const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true });
try {
  for (let round = 1; round <= state.agentRunIds.length; round++) {
    const output = new URL(`agent-${round}.json`, outputDir);
    if (existsSync(output)) {
      console.log(`Agent round ${round}: existing evidence retained`);
      continue;
    }
    const pendingPath = new URL(`agent-${round}.pending.json`, outputDir);
    if (existsSync(pendingPath))
      throw new Error(
        `Round ${round} has a retained task handle; inspect it before resuming, do not repeat business writes`
      );
    const runId = state.agentRunIds[round - 1];
    const page = await browser.newPage({
      locale: 'zh-CN',
      viewport: { width: 1440, height: 1000 },
      reducedMotion: 'reduce',
    });
    await page.addInitScript((value) => localStorage.setItem('unittcms-auth-token', JSON.stringify(value)), token);
    const actions = [];
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    async function step(label, category, operation) {
      const start = performance.now();
      const event = { label, category, at: new Date().toISOString() };
      actions.push(event);
      try {
        const result = await operation();
        event.ok = true;
        return result;
      } catch (error) {
        event.ok = false;
        throw error;
      } finally {
        event.durationMs = Math.round(performance.now() - start);
      }
    }
    const start = performance.now();
    await step('打开测试运行', 'navigation', () =>
      page.goto(`http://localhost:8010/zh-CN/projects/${state.projectId}/runs/${runId}`)
    );
    await step('选择全部运行用例', 'selection', () =>
      page.getByRole('checkbox', { name: '全选', exact: true }).check()
    );
    await step('打开 Agent 面板', 'navigation', () =>
      page.getByRole('button', { name: '接口测试 Agent', exact: true }).click()
    );
    const dialog = page.getByRole('dialog');
    const createdPromise = page.waitForResponse(
      (response) => response.url().endsWith(`/agent/runs/${runId}/tasks`) && response.request().method() === 'POST'
    );
    await step('整理计划', 'request', () => dialog.getByRole('button', { name: '整理选中用例的测试计划' }).click());
    const created = await (await createdPromise).json();
    // Retain the handle before waiting: a rerun must inspect an existing task, never silently resend.
    writeFileSync(
      new URL(`agent-${round}.pending.json`, outputDir),
      JSON.stringify({ runId, taskId: created.id, actions }, null, 2)
    );
    let task;
    await step('等待准备完成', 'system_wait', async () => {
      const deadline = Date.now() + 320000;
      while (Date.now() < deadline) {
        task = await (await fetch(`${baseUrl}/agent/runs/${runId}/tasks/${created.id}`, { headers })).json();
        if (task.state !== 'preparing') return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error('Preparation observation timed out; task handle retained');
    });
    assert.ok(['needs_input', 'awaiting_confirmation'].includes(task.state), task.error || task.state);
    if (round > 3) {
      assert.equal(task.state, 'awaiting_confirmation');
      assert.ok(task.events.some((event) => event.type === 'configuration_reused'));
      assert.ok(!task.events.some((event) => event.type === 'model'));
    }
    const readyPlan = task.plan;
    const resolutions = [];
    if (round === 1) {
      assert.equal(task.state, 'needs_input');
      const missingId = state.caseIds[4];
      const config = { ...fixtures[4].executionInfo, dependsOn: [state.caseIds[3]] };
      const { method, path, ...options } = config;
      await step('补充查询方法', 'supplement', () =>
        dialog.getByRole('combobox', { name: `HTTP 方法 #${missingId}`, exact: true }).selectOption(method)
      );
      await step('补充查询路径', 'supplement', () =>
        dialog.getByLabel(`接口路径 #${missingId}`, { exact: true }).fill(path)
      );
      await step('补充查询断言与前置变量', 'supplement', () =>
        dialog.getByLabel(`请求与断言配置 #${missingId}`, { exact: true }).fill(JSON.stringify(options))
      );
    }
    for (const item of task.plan.cases) {
      if (!item.questions.length) continue;
      const fixture = fixtures[state.caseIds.indexOf(item.caseId)];
      resolutions.push({
        caseId: item.caseId,
        questions: item.questions,
        basis: fixture.expectedResults,
        source: 'business/cases.json + business/README.md',
      });
      const section = dialog
        .locator('details')
        .filter({ has: page.locator('summary', { hasText: new RegExp(`^#${item.caseId} `) }) })
        .first();
      if ((await section.getAttribute('open')) === null)
        await step(`展开 #${item.caseId}`, 'navigation', () => section.locator('summary').first().click());
      await step(`按冻结规则确认 #${item.caseId} 的问题`, 'supplement', () =>
        dialog.getByLabel(`待确认问题 #${item.caseId}`, { exact: true }).fill('')
      );
    }
    if (round === 1 || resolutions.length) {
      await step('复用已确认配置', 'confirmation', () =>
        dialog.getByRole('checkbox', { name: '同时保存执行配置到原用例，供后续回归复用' }).check()
      );
      await step('保存并校验计划', 'save', () => dialog.getByRole('button', { name: '保存并检查计划' }).click());
    }
    await dialog.getByRole('heading', { name: `任务 #${created.id} · 待确认执行` }).waitFor();
    const confirmedTask = await (await fetch(`${baseUrl}/agent/runs/${runId}/tasks/${created.id}`, { headers })).json();
    for (const item of confirmedTask.plan.cases) {
      const fixture = fixtures[state.caseIds.indexOf(item.caseId)];
      for (const key of ['method', 'path', 'body', 'query', 'headers', 'assertions', 'extract'])
        assert.deepEqual(
          item.executionInfo[key],
          fixture.executionInfo[key],
          `Frozen oracle mismatch #${item.caseId} ${key}`
        );
      assert.deepEqual(
        item.executionInfo.dependsOn || [],
        (fixture.executionInfo.dependsOn || []).map((id) => state.caseIds[id - 1])
      );
    }
    await step('确认请求与预期', 'confirmation', () =>
      dialog.getByRole('checkbox', { name: '已核对用例、请求参数、断言和测试环境' }).check()
    );
    await step('确认前置准备', 'confirmation', () =>
      dialog.getByRole('checkbox', { name: '已准备测试数据、认证信息及其他前置条件' }).check()
    );
    await step('启动执行', 'request', () => dialog.getByRole('button', { name: '确认并开始执行' }).click());
    await step('等待执行及报告', 'system_wait', () =>
      dialog.getByRole('heading', { name: `任务 #${created.id} · 已完成` }).waitFor({ timeout: 330000 })
    );
    task = await (await fetch(`${baseUrl}/agent/runs/${runId}/tasks/${created.id}`, { headers })).json();
    assert.deepEqual(task.summary, { total: 10, passed: 7, failed: 2, unexecuted: 1, requestErrors: 0 });
    for (const fixture of fixtures)
      assert.equal(
        task.results.find((result) => result.caseId === state.caseIds[fixture.id - 1]).status,
        fixture.expectedStatus
      );
    assert.equal(task.results.find((result) => result.caseId === state.caseIds[8]).request, null);
    await step('筛选失败及未执行', 'review', () => dialog.getByRole('checkbox', { name: '仅看失败与未执行' }).check());
    const downloadPromise = page.waitForEvent('download');
    await step('导出报告', 'export', () => dialog.getByRole('button', { name: '导出本次 Excel 报告' }).click());
    const excelPath = new URL(`agent-${round}.xlsx`, outputDir);
    await (await downloadPromise).saveAs(decodeURIComponent(excelPath.pathname).replace(/^\//, ''));
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(decodeURIComponent(excelPath.pathname).replace(/^\//, ''));
    const overview = Object.fromEntries(
      book
        .getWorksheet('执行概览')
        .getSheetValues()
        .filter(Boolean)
        .map((row) => [row[1], row[2]])
    );
    assert.equal(overview['通过'], 7);
    assert.equal(overview['失败（含请求异常）'], 2);
    assert.equal(overview['未执行（含跳过）'], 1);
    await step('关闭报告回看原运行', 'navigation', () =>
      dialog.getByRole('button', { name: '关闭', exact: true }).click()
    );
    assert.equal(await page.getByText(`Agent #${task.id}`, { exact: true }).count(), 10);
    const run = await (await fetch(`${baseUrl}/runs/${runId}`, { headers })).json();
    assert.deepEqual(Object.fromEntries(run.statusCounts.map((item) => [item.status, Number(item.count)])), {
      1: 7,
      2: 2,
      4: 1,
    });
    await step('重开历史报告', 'navigation', () =>
      page.getByRole('button', { name: '接口测试 Agent', exact: true }).click()
    );
    await step('选择已完成历史', 'selection', () =>
      page.getByRole('combobox', { name: '历史执行记录', exact: true }).selectOption(String(task.id))
    );
    await page.getByRole('heading', { name: `任务 #${task.id} · 已完成` }).waitFor();
    assert.deepEqual(errors, []);
    const artifact = {
      mode: 'agent',
      measurementType: 'browser-script-not-human',
      round,
      runId,
      taskId: task.id,
      fixtureSha256: createHash('sha256').update(fixtureText).digest('hex'),
      scriptWallMs: Math.round(performance.now() - start),
      actions,
      resolutions,
      initialIssues: readyPlan.issues,
      task,
      verification: {
        frozenOracle: true,
        statuses: true,
        excel: true,
        backfill: true,
        history: true,
        pageErrors: errors,
      },
    };
    const text = JSON.stringify(artifact, null, 2);
    assert.ok(!text.includes(state.password) && !text.includes(token.access_token), 'Credential in evidence');
    writeFileSync(output, text + '\n');
    console.log(
      JSON.stringify({
        round,
        runId,
        taskId: task.id,
        summary: task.summary,
        actions: actions.length,
        supplements: actions.filter((action) => action.category === 'supplement').length,
      })
    );
    await page.close();
  }
} finally {
  await browser.close();
}
