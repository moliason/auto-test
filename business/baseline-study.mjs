import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { chromium } from '@playwright/test';
import ExcelJS from '../backend/node_modules/exceljs/excel.js';
import { renderVariables, redact } from '../backend/agent/execution.js';

const root = new URL('./', import.meta.url);
const state = JSON.parse(readFileSync(new URL('.env.study.json', root), 'utf8'));
const fixtureText = readFileSync(new URL('cases.json', root), 'utf8');
const fixtures = JSON.parse(fixtureText);
const baseUrl = 'http://localhost:8011';
const outputDir = new URL(`evidence/${state.studyId}/`, root);
mkdirSync(outputDir, { recursive: true });
const login = await (
  await fetch(baseUrl + '/users/signin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: state.email, password: state.password }),
  })
).json();
const auth = { Authorization: `Bearer ${login.access_token}` };
const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true });
try {
  for (let round = 1; round <= 3; round++) {
    const output = new URL(`baseline-${round}.json`, outputDir);
    if (existsSync(output)) {
      console.log(`Baseline ${round}: existing evidence retained`);
      continue;
    }
    const pendingPath = new URL(`baseline-${round}.pending.json`, outputDir);
    if (existsSync(pendingPath) && !process.argv.includes('--resume'))
      throw new Error(`Baseline ${round} has retained progress; inspect before repeating business writes`);
    const runId = state.baselineRunIds[round - 1];
    const retained = existsSync(pendingPath) ? JSON.parse(readFileSync(pendingPath, 'utf8')) : null;
    const timingVersion = retained?.timingVersion ?? (retained ? 1 : 2);
    if (retained) {
      assert.equal(retained.runId, runId);
      assert.equal(retained.results.length, fixtures.length, 'Only a completed HTTP phase can resume UI backfill');
      for (const fixture of fixtures)
        assert.equal(retained.results.find((item) => item.fixtureId === fixture.id)?.status, fixture.expectedStatus);
    }
    const actions = retained?.actions || [],
      results = retained?.results || [];
    const attemptStartIndex = actions.length;
    async function step(label, category, operation) {
      const event = { label, category, at: new Date().toISOString() };
      actions.push(event);
      const start = performance.now();
      try {
        const value = await operation();
        event.ok = true;
        return value;
      } catch (error) {
        event.ok = false;
        throw error;
      } finally {
        event.durationMs = Math.round(performance.now() - start);
        writeFileSync(pendingPath, JSON.stringify({ runId, results, actions, timingVersion }, null, 2));
      }
    }
    const start = performance.now();
    const variables = {
      BIZ_EMAIL: state.email,
      BIZ_PASSWORD: state.password,
      BIZ_PROJECT_NAME: `${state.studyId}-baseline-${round}`,
    };
    const secrets = [state.password, login.access_token];
    writeFileSync(pendingPath, JSON.stringify({ runId, results, actions, timingVersion }, null, 2));
    for (const fixture of fixtures) {
      if (retained) continue;
      const dependencyFailed = (fixture.executionInfo.dependsOn || []).some(
        (id) => results.find((result) => result.fixtureId === id)?.status !== 'passed'
      );
      let result = {
        fixtureId: fixture.id,
        caseId: state.caseIds[fixture.id - 1],
        title: fixture.title,
        status: 'skipped',
        request: null,
        response: null,
        assertions: [],
        durationMs: 0,
      };
      if (dependencyFailed) {
        await step(`检查 #${fixture.id} 前置失败并跳过`, 'script_dependency_check', async () => {
          result.reason = '前置用例未通过，不发送请求';
        });
      } else {
        const config = await step(
          `#${fixture.id} 解析${round === 1 ? '首次' : '复用'}请求配置`,
          'script_client_prepare',
          async () => ({
            method: fixture.executionInfo.method,
            path: renderVariables(fixture.executionInfo.path, variables, true),
            headers: renderVariables(fixture.executionInfo.headers || {}, variables),
            query: renderVariables(fixture.executionInfo.query || {}, variables),
            body: renderVariables(fixture.executionInfo.body, variables),
          })
        );
        const url = new URL(config.path, baseUrl);
        for (const [key, value] of Object.entries(config.query)) url.searchParams.set(key, String(value));
        const request = {
          method: config.method,
          url: url.href,
          headers: { ...config.headers, ...(config.body ? { 'Content-Type': 'application/json' } : {}) },
          body: config.body ?? null,
        };
        const requestActionIndex = actions.length;
        const response = await step(`#${fixture.id} 发送业务请求`, 'script_http', async () => {
          const received = await fetch(url, {
            method: request.method,
            headers: request.headers,
            body: request.body === null ? undefined : JSON.stringify(request.body),
            signal: AbortSignal.timeout(5000),
            redirect: 'manual',
          });
          return { status: received.status, body: await received.json() };
        });
        const assertions = await step(`#${fixture.id} 逐条核对预期`, 'script_assertions', async () =>
          fixture.executionInfo.assertions.map((rule) => {
            let actual = response.status,
              exists = true;
            if (rule.type !== 'status') {
              actual = response.body;
              for (const part of rule.path.slice(1).split('/')) {
                const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
                if (
                  actual === null ||
                  typeof actual !== 'object' ||
                  !Object.hasOwn(actual, key) ||
                  (Array.isArray(actual) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= actual.length))
                ) {
                  exists = false;
                  actual = null;
                  break;
                }
                actual = actual[key];
              }
            }
            return {
              ...rule,
              actual,
              passed: rule.type === 'jsonExists' ? exists : exists && isDeepStrictEqual(actual, rule.expected),
            };
          })
        );
        result = {
          ...result,
          status: assertions.every((item) => item.passed) ? 'passed' : 'failed',
          request,
          response,
          assertions,
          // Each step records duration before its checkpoint write in finally.
          durationMs: actions[requestActionIndex].durationMs + actions[requestActionIndex + 1].durationMs,
        };
        if (result.status === 'passed')
          for (const extraction of fixture.executionInfo.extract || []) {
            const value = extraction.path
              .slice(1)
              .split('/')
              .reduce((parent, key) => parent[key], response.body);
            variables[extraction.name] = value;
            if (extraction.secret !== false) secrets.push(value);
          }
        result = redact(result, secrets);
      }
      assert.equal(result.status, fixture.expectedStatus);
      results.push(result);
      writeFileSync(pendingPath, JSON.stringify({ runId, results, actions, timingVersion }, null, 2));
    }
    const page = await browser.newPage({
      locale: 'zh-CN',
      viewport: { width: 1440, height: 1000 },
      reducedMotion: 'reduce',
    });
    await page.addInitScript((value) => localStorage.setItem('unittcms-auth-token', JSON.stringify(value)), login);
    await step('从请求客户端切换至测试运行', 'browser_navigation', () =>
      page.goto(`http://localhost:8010/zh-CN/projects/${state.projectId}/runs/${runId}`)
    );
    await page.waitForLoadState('networkidle');
    const backfillStarted = performance.now();
    for (const result of results) {
      const row = page.getByRole('row').filter({ has: page.getByText(result.title, { exact: true }) });
      const bounds = await row.boundingBox();
      if (bounds && (bounds.y < 100 || bounds.y + bounds.height > 750)) {
        await step(`#${result.fixtureId} 滚动至可操作区域`, 'browser_scroll', () =>
          row.evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
        );
        await page.waitForTimeout(350);
      }
      await step(`#${result.fixtureId} 打开状态菜单`, 'browser_status', () =>
        row
          .locator('button[title]')
          .filter({ has: page.locator('svg') })
          .first()
          .click()
      );
      const status = result.status === 'passed' ? '通过' : result.status === 'failed' ? '失败' : '跳过';
      await step(`#${result.fixtureId} 选择${status}`, 'browser_status', () =>
        page.getByRole('menuitem', { name: status, exact: true }).click()
      );
      await page.getByRole('menu', { name: 'test case actions' }).waitFor({ state: 'hidden' });
      await row.locator(`button[title="${status}"]`).waitFor();
      // HeroUI exit animation still restores focus after the menu becomes hidden.
      await page.waitForTimeout(350);
    }
    await step('滚动至运行状态', 'browser_scroll', () =>
      page
        .getByRole('button', { name: /状态/ })
        .evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
    );
    await page.waitForTimeout(350);
    await step('打开运行状态', 'browser_status', () => page.getByRole('button', { name: /状态/ }).click());
    await step('标记运行审核中', 'browser_status', () =>
      page.getByRole('option', { name: '审核中', exact: true }).click()
    );
    const saved = page.waitForResponse(
      (response) => response.url().includes(`/runcases/update?runId=${runId}`) && response.request().method() === 'POST'
    );
    await step('保存人工状态', 'browser_save', () => page.getByRole('button', { name: '更新', exact: true }).click());
    assert.ok((await saved).ok());
    const backfillScriptMs = Math.round(performance.now() - backfillStarted);
    const run = await (await fetch(`${baseUrl}/runs/${runId}`, { headers: auth })).json();
    assert.equal(run.run.state, 2);
    assert.deepEqual(Object.fromEntries(run.statusCounts.map((item) => [item.status, Number(item.count)])), {
      1: 7,
      2: 2,
      4: 1,
    });
    const reportStarted = performance.now();
    await step('打开报告导出菜单', 'browser_export', () =>
      page.getByRole('button', { name: '导出', exact: true }).click()
    );
    const downloadPromise = page.waitForEvent('download');
    await step('选择 Excel 导出', 'browser_export', () =>
      page.getByRole('menuitem', { name: 'excel', exact: true }).click()
    );
    const reportPath = new URL(`baseline-${round}.xlsx`, outputDir);
    await (await downloadPromise).saveAs(fileURLToPath(reportPath));
    const bytes = readFileSync(reportPath);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes);
    assert.ok(book.worksheets.length > 0);
    const rows = book.worksheets.flatMap((sheet) => sheet.getSheetValues().filter(Boolean));
    for (const fixture of fixtures)
      assert.ok(
        rows.some(
          (row) =>
            row[1] === fixture.title &&
            row[3] === { passed: '通过', failed: '失败', skipped: '跳过' }[fixture.expectedStatus]
        ),
        `Excel mismatch: ${fixture.id}`
      );
    const reportScriptMs = Math.round(performance.now() - reportStarted);
    await step('刷新并核对人工来源', 'browser_review', () => page.reload());
    await page.getByText('人工', { exact: true }).first().waitFor();
    assert.equal(await page.getByText('人工', { exact: true }).count(), 10);
    const artifact = {
      mode: 'baseline',
      measurementType: 'script-client-plus-browser-manual-status-simulation-not-human',
      timingVersion,
      round,
      runId,
      fixtureSha256: createHash('sha256').update(fixtureText).digest('hex'),
      scriptWallMs: Math.round(performance.now() - start),
      resumedUiOnly: !!retained,
      attemptStartIndex,
      wallTimeScope: retained ? '本次恢复的 UI 阶段；中断前请求耗时见 results，不是完整端到端耗时' : '完整脚本运行',
      backfillScriptMs,
      reportScriptMs,
      actions,
      results,
      summary: { total: 10, passed: 7, failed: 2, unexecuted: 1 },
      verification: { frozenOracle: true, actualHttp: true, manualSource: true, backfill: true, excel: true },
      limitations: [
        '请求参数与断言由脚本解析和核对，不计作真实人员填写和判断',
        '浏览器逐条回填是真实 UI 操作，耗时为自动化脚本耗时',
        '原人工 Excel 不包含 Agent 的完整证据，原始请求响应另存 JSON；报告能力不同，耗时不能直接代表相同报告质量',
      ],
    };
    const text = JSON.stringify(artifact, null, 2);
    assert.ok(!secrets.some((value) => text.includes(value)), 'Credential in baseline evidence');
    writeFileSync(output, text + '\n');
    console.log(JSON.stringify({ round, runId, summary: artifact.summary, actions: actions.length }));
    await page.close();
  }
} finally {
  await browser.close();
}
