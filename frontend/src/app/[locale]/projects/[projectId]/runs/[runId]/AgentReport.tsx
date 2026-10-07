'use client';
import type { AgentTask } from '@/types/agent';
import { agentStateLabels } from '@/types/agent';

export default function AgentReport({ task }: { task: AgentTask }) {
  const labels: Record<string, string> = { passed: '通过', failed: '失败', error: '请求异常', skipped: '未执行' };
  return (
    <section className="space-y-4" aria-label="Agent 执行报告">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['总数', task.summary.total],
          ['通过', task.summary.passed],
          ['失败', task.summary.failed],
          ['未执行', task.summary.unexecuted],
        ].map(([label, value]) => (
          <div key={label} className="rounded-medium border border-default-200 p-3">
            <div className="text-sm text-default-500">{label}</div>
            <div className="text-2xl font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>
      <p className="text-sm text-default-600">
        失败数量包含 {task.summary.requestErrors}{' '}
        条请求异常。统计来自本次实际执行记录，未执行包含前置失败跳过及尚无执行记录的用例。
      </p>
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-medium">执行来源 / 状态</dt>
          <dd>Agent / {agentStateLabels[task.state] || task.state}</dd>
        </div>
        <div>
          <dt className="font-medium">模型</dt>
          <dd>
            {task.plan.model} · {task.plan.provider === 'DeepSeek' ? 'DeepSeek 官方接口' : '配置的兼容接口'}
          </dd>
        </div>
        <div>
          <dt className="font-medium">开始时间</dt>
          <dd>{task.startedAt ? new Date(task.startedAt).toLocaleString() : '尚未开始'}</dd>
        </div>
        <div>
          <dt className="font-medium">结束时间</dt>
          <dd>{task.finishedAt ? new Date(task.finishedAt).toLocaleString() : '尚未结束'}</dd>
        </div>
      </dl>
      {task.plan.notes && (
        <p className="whitespace-pre-wrap break-words text-sm">
          <strong>计划说明与业务规则补充：</strong>
          {task.plan.notes}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-medium">执行时测试环境</summary>
        <pre className="mt-2 overflow-auto rounded-medium bg-default-100 p-3 text-xs">
          {JSON.stringify(task.plan.environment, null, 2)}
        </pre>
      </details>
      {task.error && (
        <p role="alert" className="rounded-medium bg-danger-50 p-3 text-sm text-danger">
          {task.error}。已有执行记录已保留。
        </p>
      )}
      <div className="space-y-2">
        {task.plan.cases.map((item) => {
          const result = task.results.find((entry) => entry.caseId === item.caseId);
          return (
            <details key={item.caseId} className="rounded-medium border border-default-200 p-3">
              <summary className="cursor-pointer break-words text-sm font-medium">
                #{item.caseId} {result?.title || item.title} ·{' '}
                {result ? labels[result.status] || result.status : '等待执行'}
                {result ? ` · ${result.durationMs} ms` : ''}
              </summary>
              <div className="mt-3 space-y-3 text-sm">
                {result?.reason && <p>{result.reason}</p>}
                <p className="whitespace-pre-wrap break-words">
                  <strong>原预期：</strong>
                  {String(result?.snapshot?.expectedResults || item.expectedResults || '未填写')}
                </p>
                {result ? (
                  <>
                    <p>回填原测试运行：{result.mappedToRun ? '已回填' : '未回填（用例可能已移出运行）'}</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr>
                            <th className="p-2">断言</th>
                            <th className="p-2">预期</th>
                            <th className="p-2">实际</th>
                            <th className="p-2">结果</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.assertions.map((assertion, i) => (
                            <tr key={i} className="border-t border-default-200">
                              <td className="p-2">
                                {assertion.type} {assertion.path}
                              </td>
                              <td className="p-2 break-all">{JSON.stringify(assertion.expected)}</td>
                              <td className="p-2 break-all">{JSON.stringify(assertion.actual)}</td>
                              <td className="p-2">{assertion.passed ? '通过' : '失败'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {Object.entries({
                      用例与预期快照: result.snapshot,
                      请求: result.request,
                      实际响应: result.response,
                    }).map(([label, value]) => (
                      <details key={label}>
                        <summary className="cursor-pointer text-primary">{label}</summary>
                        <pre className="mt-2 max-h-80 overflow-auto rounded-medium bg-default-100 p-3 text-xs">
                          {JSON.stringify(value, null, 2)}
                        </pre>
                      </details>
                    ))}
                  </>
                ) : (
                  <p className="text-default-500">尚无执行记录，不能判定通过。</p>
                )}
              </div>
            </details>
          );
        })}
      </div>
      <section className="rounded-medium border border-default-200 p-4" aria-label="AI 分析">
        <h3 className="font-medium">AI 总结与原因推测</h3>
        <p className="mt-1 text-xs text-default-500">推测需要进一步核实，已确认的事实以请求响应和断言证据为准。</p>
        <p className="mt-3 whitespace-pre-wrap break-words text-sm">
          {task.analysis || '尚未生成分析，已有执行记录仍可查看。'}
        </p>
      </section>
      <details>
        <summary className="cursor-pointer text-sm font-medium">工具调用记录（{task.events.length}）</summary>
        <ol className="mt-2 space-y-1 text-xs">
          {task.events.map((event, i) => (
            <li key={i} className="break-words">
              <time>{new Date(event.at).toLocaleTimeString()}</time> · {event.name || event.type}
              {event.call ? ` #${event.call}` : ''}
              {event.ok === false ? ` · 失败：${event.error}` : ''}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
