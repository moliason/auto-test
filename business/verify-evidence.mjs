import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ExcelJS from '../backend/node_modules/exceljs/excel.js';
import { chromium } from '@playwright/test';

const root = new URL('./', import.meta.url);
const state = JSON.parse(readFileSync(new URL('.env.study.json', root), 'utf8'));
const dir = new URL(`evidence/${state.studyId}/`, root);
const baseUrl = 'http://localhost:8011';
const login = await (
  await fetch(baseUrl + '/users/signin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: state.email, password: state.password }),
  })
).json();
async function api(path) {
  const response = await fetch(baseUrl + path, { headers: { Authorization: `Bearer ${login.access_token}` } });
  assert.equal(response.status, 200, path);
  return response.json();
}
const checked = [];
for (const mode of ['agent', 'baseline']) {
  const rounds = mode === 'agent' ? state.agentRunIds.length : state.baselineRunIds.length;
  for (let round = 1; round <= rounds; round++) {
    const record = JSON.parse(readFileSync(new URL(`${mode}-${round}.json`, dir), 'utf8'));
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(fileURLToPath(new URL(`${mode}-${round}.xlsx`, dir)));
    const content = JSON.stringify(record) + JSON.stringify(book.model);
    assert.ok(!content.includes(state.password) && !content.includes(login.access_token));
    assert.ok(!/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+/.test(content));
    const run = await api(`/runs/${record.runId}`);
    assert.equal(run.run.state, 2);
    assert.deepEqual(Object.fromEntries(run.statusCounts.map((item) => [item.status, Number(item.count)])), {
      1: 7,
      2: 2,
      4: 1,
    });
    const results = mode === 'agent' ? record.task.results : record.results;
    assert.equal(results.filter((item) => item.request).length, 9);
    assert.equal(results.find((item) => item.caseId === state.caseIds[8]).request, null);
    const created = results.find((item) => item.caseId === state.caseIds[3]).response.body;
    const currentCase = await api(`/cases/${created.id}`);
    assert.equal(currentCase.title, '业务验收用例');
    assert.equal(currentCase.priority, 1);
    if (mode === 'agent') {
      const task = await api(`/agent/runs/${record.runId}/tasks/${record.taskId}`);
      assert.deepEqual(task, record.task, 'Saved task history changed');
      const history = await api(`/agent/runs/${record.runId}/tasks`);
      assert.ok(history.tasks.some((item) => item.id === task.id && item.state === 'completed'));
      const overview = Object.fromEntries(
        book
          .getWorksheet('执行概览')
          .getSheetValues()
          .filter(Boolean)
          .map((row) => [row[1], row[2]])
      );
      assert.equal(overview['HTTP 与断言累计耗时(ms)'], task.executionMeasurements.requests.durationMs);
      assert.equal(overview['保存与回填累计耗时(ms)'], task.executionMeasurements.persistence.durationMs);
      assert.equal(overview['报告整理耗时(ms)'], task.executionMeasurements.reportDurationMs);
      for (const [index, measurement] of task.measurements.entries()) {
        const row = book.getWorksheet('模型用量').getRow(index + 3).values;
        assert.equal(row[2], measurement.calls);
        assert.equal(row[5], measurement.durationMs ?? '未记录');
        assert.equal(row[11], measurement.tokens.total_tokens.value ?? '未记录');
        assert.equal(row[12], measurement.tokens.total_tokens.recordedCalls);
      }
      const evidenceRows = book.getWorksheet('完整执行证据').getSheetValues().filter(Boolean).slice(1);
      for (const result of results) {
        for (const [name, value] of [
          ['请求', result.request],
          ['实际响应', result.response],
          ['断言与差异', result.assertions],
        ]) {
          const parts = evidenceRows
            .filter((row) => row[1] === result.caseId && row[2] === name)
            .sort((a, b) => a[3] - b[3]);
          assert.deepEqual(JSON.parse(parts.map((row) => row[4]).join('')), value);
        }
      }
    }
    checked.push({
      mode,
      round,
      runId: record.runId,
      taskId: record.taskId ?? null,
      createdCaseId: created.id,
      verified: true,
    });
  }
}
const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true });
try {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
  await page.addInitScript((token) => localStorage.setItem('unittcms-auth-token', JSON.stringify(token)), login);
  const record = JSON.parse(readFileSync(new URL('agent-4.json', dir), 'utf8'));
  await page.goto(`http://localhost:8010/zh-CN/projects/${state.projectId}/runs/${record.runId}`);
  await page.getByRole('button', { name: '接口测试 Agent', exact: true }).click();
  await page.getByRole('combobox', { name: '历史执行记录', exact: true }).selectOption(String(record.taskId));
  await page.getByRole('heading', { name: `任务 #${record.taskId} · 已完成` }).waitFor();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('执行与整理耗时', { exact: true }).click();
  for (const value of [
    record.task.executionMeasurements.requests.durationMs,
    record.task.executionMeasurements.persistence.durationMs,
    record.task.executionMeasurements.reportDurationMs,
  ])
    assert.ok((await dialog.innerText()).includes(`${value} ms`));
  await dialog.getByRole('checkbox', { name: '仅看失败与未执行' }).check();
  const cases = dialog.locator('details').filter({ has: page.locator('summary', { hasText: /^#\d+ / }) });
  assert.equal(await cases.count(), 3);
  for (const section of await cases.all()) assert.notEqual(await section.getAttribute('open'), null);
  await page.screenshot({ path: fileURLToPath(new URL('report.png', dir)) });
} finally {
  await browser.close();
}
writeFileSync(
  new URL('verification.json', dir),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      checked,
      historyUnchanged: true,
      liveBusinessReadback: true,
      excelEvidenceAndMetrics: true,
      secretsRedacted: true,
      reportUi: true,
    },
    null,
    2
  ) + '\n'
);
console.log(JSON.stringify({ verified: checked.length, historyUnchanged: true, excelEvidenceAndMetrics: true }));
