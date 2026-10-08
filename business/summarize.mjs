import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('./', import.meta.url);
const state = JSON.parse(readFileSync(new URL('.env.study.json', root), 'utf8'));
const dir = new URL(`evidence/${state.studyId}/`, root);
const fixtureHash = createHash('sha256')
  .update(readFileSync(new URL('cases.json', root)))
  .digest('hex');
const rows = [];
for (let round = 1; round <= state.agentRunIds.length; round++) {
  for (const mode of round > 3 ? ['agent'] : ['baseline', 'agent']) {
    const record = JSON.parse(readFileSync(new URL(`${mode}-${round}.json`, dir), 'utf8'));
    assert.equal(record.fixtureSha256, fixtureHash);
    assert.ok(
      Object.values(record.verification).every((value) => (Array.isArray(value) ? value.length === 0 : value === true))
    );
    const browserActions = record.actions
      .slice(record.attemptStartIndex || 0)
      .filter((event) =>
        mode === 'baseline' ? event.category.startsWith('browser_') : event.category !== 'system_wait'
      );
    const measured = record.task?.executionMeasurements;
    rows.push({
      round,
      phase: round > 3 ? '修复后补充回归（不替换前三轮）' : round === 1 ? '首次（已有用例与共享请求基线）' : '重复回归',
      mode,
      runId: record.runId,
      taskId: record.taskId ?? null,
      browserActions: browserActions.length,
      browserCountScope: record.resumedUiOnly ? '仅最终成功的 UI 恢复段；中断记录另外保留' : '完整运行',
      allRecordedBrowserActions: record.actions.filter((event) =>
        mode === 'baseline' ? event.category.startsWith('browser_') : event.category !== 'system_wait'
      ).length,
      browserFieldSupplements: record.actions.filter((event) => event.category === 'supplement').length,
      scriptClientActions:
        mode === 'baseline' ? record.actions.filter((event) => event.category.startsWith('script_')).length : 0,
      scriptWallMs: record.resumedUiOnly ? null : record.scriptWallMs,
      resumedUiSegmentMs: record.resumedUiOnly ? record.scriptWallMs : null,
      httpAndAssertionsMs:
        mode === 'baseline'
          ? record.results.reduce((sum, item) => sum + item.durationMs, 0)
          : measured.requests.durationMs,
      backfillMs: mode === 'baseline' ? record.backfillScriptMs : measured.persistence.durationMs,
      reportMs: mode === 'baseline' ? record.reportScriptMs : measured.reportDurationMs,
      timingScope:
        mode === 'baseline'
          ? '回填为浏览器逐条选择状态+保存；报告为下载与读回原平台 Excel'
          : '回填为服务端保存事务；报告包含 AI 分析等待，不与模型耗时相加',
      modelCalls: mode === 'agent' ? record.task.measurements.reduce((sum, item) => sum + item.calls, 0) : 0,
      totalTokens:
        mode === 'agent' &&
        record.task.measurements.every((item) => item.tokens.total_tokens.recordedCalls === item.calls)
          ? record.task.measurements.reduce((sum, item) => sum + (item.tokens.total_tokens.value ?? 0), 0)
          : null,
      modelWaitMs:
        mode === 'agent' && record.task.measurements.every((item) => item.timedCalls === item.calls)
          ? record.task.measurements.reduce((sum, item) => sum + (item.durationMs ?? 0), 0)
          : null,
      tokenCoverage:
        mode === 'agent'
          ? record.task.measurements
              .map((item) => `${item.phase}:${item.tokens.total_tokens.recordedCalls}/${item.calls}`)
              .join(',')
          : '不调用模型',
      recordedFailedActions: record.actions.filter((event) => !event.ok).length,
      resumedCollection: !!record.resumedUiOnly,
      humanLaborMs: null,
    });
  }
}
const report = {
  studyId: state.studyId,
  fixtureSha256: fixtureHash,
  measurementType: '脚本模拟，非真实测试人员测量',
  rows,
  limitations: [
    '被测系统为作者授权的本地测试管理平台；三轮均使用新建私有项目，非高负载生产环境。',
    '已有文字用例和请求基线由同一份文件提供；用例编写、阅读文档与首次编写请求 JSON 的人工时间未测量。',
    '基线的请求准备、发送与核对由脚本完成，浏览器日志仅对实际 UI 操作计数；不得将 API 操作伪装为人类点击。',
    '逐条基线没有使用平台批量状态操作；结果仅适用于该操作路径，不能代表熟练用户的最优效率。',
    '基线报告为原平台 Excel 加另存请求证据；Agent 含 AI 分析及完整证据工作表，两者报告质量与阶段计时范围不同。',
    '未采集真实人工劳动时间，不计算或宣称人员效率提升比例。故意错误预期和错误前置只用于控制实验，不算发现产品缺陷。',
    '基线首轮采集因菜单动画/滚动问题中断后恢复，原请求没有重发；表中操作数和回填耗时只取最终成功 UI 段，不能作为完整首次使用成本。修复脚本的干预另见 collection-notes.md。',
    '第 4 轮是修复后的独立 Agent 复测，单独展示，不覆盖修复前三轮。模型耗时与报告计时可能重叠，不相加。',
  ],
};
writeFileSync(new URL('comparison.json', dir), JSON.stringify(report, null, 2) + '\n');
const table = [
  '# 三轮脚本模拟对比',
  '',
  `研究：${state.studyId}。同一用例与预期 SHA-256：\`${fixtureHash}\`。`,
  '',
  '**这些数值是脚本观察，不是真实人员效率。不同阶段计时范围不可直接相除作为减负比例。**',
  '',
  '| 轮次 | 流程 | 浏览器操作 | 补充字段 | 脚本客户端操作 | HTTP/断言 ms | 回填 ms | 报告 ms | 模型调用 | Token |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map(
    (row) =>
      `| ${row.round} | ${row.mode} | ${row.browserActions} | ${row.browserFieldSupplements} | ${row.scriptClientActions} | ${row.httpAndAssertionsMs} | ${row.backfillMs} | ${row.reportMs} | ${row.modelCalls} | ${row.totalTokens ?? '不适用'} |`
  ),
  '',
  '## 局限',
  '',
  ...report.limitations.map((text) => `- ${text}`),
  '',
  '完整阶段范围、覆盖率、操作时间戳与业务证据见同目录 JSON 和 Excel。',
  '',
];
writeFileSync(new URL('comparison.md', dir), table.join('\n'));
console.log(JSON.stringify({ studyId: state.studyId, rows: rows.length, fixtureHash }));
