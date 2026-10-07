'use client';
import { useState } from 'react';
import { Button, Checkbox, Input, Textarea } from '@heroui/react';
import type { AgentTask } from '@/types/agent';
import { agentRequest } from '@/utils/agentControl';

type Props = {
  task: AgentTask;
  token: string;
  runId: string;
  canEditCase: boolean;
  onSaved: (task: AgentTask, warning?: string) => void;
  onDirty: (dirty: boolean) => void;
};

export default function AgentPlanEditor({ task, token, runId, canEditCase, onSaved, onDirty }: Props) {
  const [drafts, setDrafts] = useState(
    task.plan.cases.map((item) => {
      const { method = '', path = '', ...options } = item.executionInfo || {};
      return {
        caseId: item.caseId,
        method: String(method),
        path: String(path),
        options: JSON.stringify(options, null, 2),
        questions: item.questions.join('\n'),
      };
    })
  );
  const [notes, setNotes] = useState(task.plan.notes || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saveToCases, setSaveToCases] = useState(false);
  const editable = !task.startedAt && ['needs_input', 'awaiting_confirmation', 'failed'].includes(task.state);

  const updateDraft = (index: number, field: string, value: string) => {
    setDrafts((current) => current.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
    onDirty(true);
    setError('');
  };

  return (
    <section className="space-y-4" aria-label="测试计划编辑">
      <p className="text-sm text-default-600">
        核对原用例、接口请求和断言。缺失的业务规则请补充，已核实的问题可以清除。保存计划后才能确认执行。
      </p>
      {task.plan.issues.length > 0 && (
        <div role="status" className="rounded-medium bg-warning-50 p-3 text-sm text-warning-800">
          <p className="font-semibold">仍需补充或确认</p>
          <ul className="list-disc pl-5">
            {task.plan.issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      {task.plan.cases.map((item, index) => (
        <details
          key={item.caseId}
          open={item.issues.length > 0 || undefined}
          className="rounded-medium border border-default-200 p-3"
        >
          <summary className="cursor-pointer font-medium break-words">
            #{item.caseId} {item.title}
            {item.issues.length > 0 ? ' · 待补充' : ' · 信息已齐全'}
          </summary>
          <div className="mt-3 space-y-3">
            <dl className="text-sm space-y-2">
              <div>
                <dt className="font-medium">原前置条件</dt>
                <dd className="whitespace-pre-wrap break-words text-default-600">{item.preConditions || '未填写'}</dd>
              </div>
              <div>
                <dt className="font-medium">原预期结果</dt>
                <dd className="whitespace-pre-wrap break-words text-default-600">{item.expectedResults || '未填写'}</dd>
              </div>
            </dl>
            {!!item.steps?.length && (
              <ol className="list-decimal pl-5 text-sm">
                {item.steps.map((step, i) => (
                  <li key={i} className="whitespace-pre-wrap break-words">
                    {step.step} → {step.result}
                  </li>
                ))}
              </ol>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[9rem_1fr]">
              <label className="flex min-w-0 flex-col rounded-medium bg-default-100 px-3 py-2 text-xs text-default-600">
                HTTP 方法 #{item.caseId}
                <select
                  aria-label={`HTTP 方法 #${item.caseId}`}
                  className="mt-1 min-w-0 bg-transparent text-sm text-foreground outline-offset-2"
                  value={drafts[index].method}
                  disabled={!editable || busy}
                  onChange={(event) => updateDraft(index, 'method', event.target.value)}
                >
                  <option value="" disabled>
                    请选择方法
                  </option>
                  {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((method) => (
                    <option key={method} value={method}>
                      {method}
                    </option>
                  ))}
                </select>
              </label>
              <Input
                label={`接口路径 #${item.caseId}`}
                placeholder="例如 /login"
                value={drafts[index].path}
                isDisabled={!editable || busy}
                onValueChange={(value) => updateDraft(index, 'path', value)}
              />
            </div>
            <Textarea
              label={`请求与断言配置 #${item.caseId}`}
              description="JSON：headers、query、body、assertions、extract、dependsOn、requiredVariables、preconditions。字段路径使用 /data/id，变量使用 {{TOKEN}}。"
              minRows={5}
              maxRows={18}
              value={drafts[index].options}
              isDisabled={!editable || busy}
              classNames={{ input: 'font-mono text-xs' }}
              onValueChange={(value) => updateDraft(index, 'options', value)}
            />
            <Textarea
              label={`待确认问题 #${item.caseId}`}
              description="每行一个问题。核实规则并更新断言后，删除已解决的问题。"
              value={drafts[index].questions}
              isDisabled={!editable || busy}
              onValueChange={(value) => updateDraft(index, 'questions', value)}
            />
          </div>
        </details>
      ))}
      <details className="text-sm">
        <summary className="cursor-pointer text-primary">查看断言与变量配置示例</summary>
        <pre className="mt-2 overflow-x-auto rounded-medium bg-default-100 p-3 text-xs">
          {JSON.stringify(
            {
              headers: { Authorization: 'Bearer {{TOKEN}}' },
              assertions: [
                { type: 'status', expected: 200 },
                { type: 'jsonExists', path: '/data/id' },
                { type: 'jsonEquals', path: '/data/id', expected: 7 },
              ],
              dependsOn: [1],
              extract: [{ name: 'ID', path: '/data/id', secret: false }],
            },
            null,
            2
          )}
        </pre>
      </details>
      <Textarea
        label="计划说明与业务规则补充"
        value={notes}
        isDisabled={!editable || busy}
        onValueChange={(value) => {
          setNotes(value);
          onDirty(true);
        }}
      />
      {editable && (
        <>
          {canEditCase && (
            <Checkbox isSelected={saveToCases} onValueChange={setSaveToCases} isDisabled={busy}>
              同时保存执行配置到原用例，供后续回归复用
            </Checkbox>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <Button
            color="primary"
            variant="flat"
            isLoading={busy}
            onPress={async () => {
              setBusy(true);
              setError('');
              try {
                const cases = drafts.map((item) => {
                  let options;
                  try {
                    options = JSON.parse(item.options);
                  } catch {
                    throw new Error(`#${item.caseId} 请求与断言配置不是有效 JSON`);
                  }
                  if (!options || typeof options !== 'object' || Array.isArray(options))
                    throw new Error(`#${item.caseId} 配置必须是 JSON 对象`);
                  return {
                    caseId: item.caseId,
                    executionInfo: { ...options, method: item.method, path: item.path },
                    questions: item.questions
                      .split('\n')
                      .map((line) => line.trim())
                      .filter(Boolean),
                  };
                });
                const saved = await agentRequest<AgentTask>(token, `/runs/${runId}/tasks/${task.id}/plan`, 'PUT', {
                  version: task.version,
                  cases,
                  notes,
                });
                let warning;
                try {
                  if (saveToCases) {
                    for (const item of cases)
                      await agentRequest(token, `/cases/${item.caseId}/execution`, 'PUT', {
                        executionInfo: item.executionInfo,
                      });
                  }
                } catch {
                  warning =
                    '计划已保存，但部分原用例配置保存失败。请检查权限或重新勾选保存，未保存的配置仍在本次计划中。';
                }
                onDirty(false);
                onSaved(saved, warning);
              } catch (error) {
                setError(error instanceof Error ? error.message : '保存计划失败');
              } finally {
                setBusy(false);
              }
            }}
          >
            保存并检查计划
          </Button>
        </>
      )}
    </section>
  );
}
