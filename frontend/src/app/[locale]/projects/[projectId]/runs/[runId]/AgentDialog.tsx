'use client';
import { useEffect, useState } from 'react';
import {
  Button,
  Checkbox,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Textarea,
} from '@heroui/react';
import AgentPlanEditor from './AgentPlanEditor';
import AgentReport from './AgentReport';
import { agentRequest } from '@/utils/agentControl';
import Config from '@/config/config';
import {
  agentStateLabels,
  agentLimitFields,
  defaultAgentLimits,
  type AgentHistory,
  type AgentTask,
} from '@/types/agent';

type Props = {
  runId: string;
  token: string;
  caseIds: number[];
  canManage: boolean;
  canEditCase: boolean;
  onClose: () => void;
  onResults: () => void;
};

export default function AgentDialog({ runId, token, caseIds, canManage, canEditCase, onClose, onResults }: Props) {
  const [task, setTask] = useState<AgentTask | null>(null);
  const [history, setHistory] = useState<AgentHistory[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [environmentOptions, setEnvironmentOptions] = useState('{}');
  const [environmentLoaded, setEnvironmentLoaded] = useState(false);
  const [environmentDirty, setEnvironmentDirty] = useState(false);
  const [description, setDescription] = useState('');
  const [sourceMode, setSourceMode] = useState(caseIds.length ? 'selected' : 'document');
  const [importedDocument, setDocument] = useState<{ name: string; content: string } | null>(null);
  const [limits, setLimits] = useState(defaultAgentLimits);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [planDirty, setPlanDirty] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [preconditionsConfirmed, setPreconditionsConfirmed] = useState(false);
  const [reload, setReload] = useState(0);
  const active = task && ['preparing', 'running'].includes(task.state);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      agentRequest<{ environment: Record<string, unknown> }>(token, `/runs/${runId}/environment`),
      agentRequest<{ tasks: AgentHistory[]; nextCursor: number | null }>(token, `/runs/${runId}/tasks`),
    ])
      .then(([environment, list]) => {
        if (cancelled) return;
        const { baseUrl = '', ...options } = environment.environment;
        setBaseUrl(String(baseUrl));
        setEnvironmentOptions(JSON.stringify(options, null, 2));
        setEnvironmentLoaded(true);
        setHistory(list.tasks);
        setCursor(list.nextCursor);
      })
      .catch((error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [token, runId, reload]);

  useEffect(() => {
    if (!active || !task) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const fresh = await agentRequest<AgentTask>(token, `/runs/${runId}/tasks/${task.id}`);
        if (cancelled) return;
        setTask(fresh);
        if (['preparing', 'running'].includes(fresh.state)) timer = setTimeout(poll, 2000);
        else {
          onResults();
          const list = await agentRequest<{ tasks: AgentHistory[]; nextCursor: number | null }>(
            token,
            `/runs/${runId}/tasks`
          );
          if (!cancelled) {
            setHistory(list.tasks);
            setCursor(list.nextCursor);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setError(error instanceof Error ? error.message : '获取执行进度失败');
          timer = setTimeout(poll, 5000);
        }
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Polling is tied to the selected task; parent callbacks do not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, active, runId, token]);

  const selectTask = async (id: number) => {
    if (planDirty && !window.confirm('计划有未保存的修改，确定切换执行记录吗？')) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setTask(await agentRequest<AgentTask>(token, `/runs/${runId}/tasks/${id}`));
      setPlanDirty(false);
      setConfirmed(false);
      setPreconditionsConfirmed(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : '读取执行记录失败');
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if ((planDirty || environmentDirty) && !window.confirm('存在未保存的修改，确定关闭吗？')) return;
    onClose();
  };

  return (
    <Modal
      isOpen
      size="5xl"
      scrollBehavior="inside"
      isDismissable={false}
      onClose={close}
      classNames={{ base: 'max-w-[calc(100vw-1rem)] sm:max-w-5xl', body: 'min-w-0' }}
    >
      <ModalContent>
        <ModalHeader className="flex-col gap-1">
          <span>接口测试 Agent</span>
          <span className="text-xs font-normal text-default-500">
            导入文档或选择用例 → 审核确认 → 执行与补测 → 验收报告
          </span>
        </ModalHeader>
        <ModalBody className="space-y-5 pb-6">
          {!environmentLoaded && !error && (
            <p role="status" className="text-sm text-default-500">
              正在读取测试环境与历史记录…
            </p>
          )}
          {error && (
            <div role="alert" className="rounded-medium bg-danger-50 p-3 text-sm text-danger">
              {error}{' '}
              <Button
                size="sm"
                variant="light"
                onPress={() => {
                  setError('');
                  if (task) void selectTask(task.id);
                  else setReload((value) => value + 1);
                }}
              >
                重新加载
              </Button>
            </div>
          )}
          {notice && (
            <p role="status" className="text-sm text-success-700">
              {notice}
            </p>
          )}
          <details className="rounded-medium border border-default-200 p-3" open={!baseUrl || undefined}>
            <summary className="cursor-pointer font-medium">
              测试环境{baseUrl ? ` · ${baseUrl}` : ' · 请先配置'}
            </summary>
            <div className="mt-3 space-y-3">
              <Input
                label="测试基地址"
                placeholder="http://127.0.0.1:4010"
                value={baseUrl}
                isDisabled={!canManage || busy || !environmentLoaded}
                onValueChange={(value) => {
                  setBaseUrl(value);
                  setEnvironmentDirty(true);
                }}
              />
              <Textarea
                label="环境参数（JSON）"
                description="可配置 timeoutMs、headers、variables、secretVariables。认证值使用 {{变量名}}，真实值放在后端 TEST_AGENT_SECRET_变量名。"
                minRows={3}
                value={environmentOptions}
                isDisabled={!canManage || busy || !environmentLoaded}
                onValueChange={(value) => {
                  setEnvironmentOptions(value);
                  setEnvironmentDirty(true);
                }}
                classNames={{ input: 'font-mono text-xs' }}
              />
              {canManage ? (
                <Button
                  size="sm"
                  variant="flat"
                  isDisabled={busy || !environmentLoaded}
                  onPress={async () => {
                    setBusy(true);
                    setError('');
                    setNotice('');
                    try {
                      const options = JSON.parse(environmentOptions);
                      if (!options || typeof options !== 'object' || Array.isArray(options))
                        throw new Error('环境参数必须是 JSON 对象');
                      const result = await agentRequest<{ issues: string[] }>(
                        token,
                        `/runs/${runId}/environment`,
                        'PUT',
                        { environment: { ...options, baseUrl } }
                      );
                      setEnvironmentDirty(false);
                      setConfirmed(false);
                      setPreconditionsConfirmed(false);
                      if (task && !task.startedAt) setPlanDirty(true);
                      setNotice(
                        result.issues.length
                          ? `已保存，仍需补充：${result.issues.join('；')}`
                          : '环境已保存。已有计划需再次保存，才会使用此环境。'
                      );
                    } catch (error) {
                      setError(error instanceof Error ? error.message : '保存环境失败');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  保存环境
                </Button>
              ) : (
                <p className="text-xs text-default-500">请联系项目管理者修改环境。</p>
              )}
            </div>
          </details>
          <section className="space-y-3" aria-label="创建 Agent 任务">
            <label className="flex flex-col gap-1 text-sm">
              任务来源
              <select
                aria-label="任务来源"
                className="rounded-medium border border-default-200 bg-background p-2"
                value={sourceMode}
                disabled={busy || !!active}
                onChange={(event) => setSourceMode(event.target.value)}
              >
                <option value="document" disabled={!canEditCase}>
                  导入接口文档，生成用例并自动补测
                </option>
                <option value="selected">执行已选中的用例</option>
              </select>
            </label>
            {sourceMode === 'document' ? (
              <>
                <label className="block space-y-2 text-sm">
                  <span className="font-medium">接口文档（Markdown / OpenAPI）</span>
                  <input
                    aria-label="接口文档文件"
                    type="file"
                    accept=".md,.json,.yaml,.yml"
                    disabled={busy || !!active || !canEditCase}
                    className="block w-full min-w-0 rounded-medium border border-default-200 p-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-default-100 file:px-3 file:py-1 focus-visible:outline-primary"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      setDocument(null);
                      setError('');
                      if (!file) return;
                      try {
                        if (!/\.(md|json|ya?ml)$/i.test(file.name) || file.size > 65536 || !file.size)
                          throw new Error('请选择 1 至 64 KiB 的 Markdown 或 OpenAPI 文件');
                        const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
                        setDocument({ name: file.name, content });
                      } catch (error) {
                        setError(error instanceof Error ? error.message : '文档读取失败，请使用 UTF-8 编码');
                      }
                    }}
                  />
                </label>
                <p className="text-xs text-default-500">
                  UTF-8，最多 64 KiB、30
                  个接口。生成的用例会加入当前测试运行；审核确认后才会发送请求。认证信息使用变量引用。
                </p>
                {importedDocument && (
                  <details className="text-sm">
                    <summary className="cursor-pointer">已选择：{importedDocument.name}</summary>
                    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-medium bg-default-100 p-3 text-xs">
                      {importedDocument.content}
                    </pre>
                  </details>
                )}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {agentLimitFields.map((field) => (
                    <Input
                      key={field.key}
                      label={field.label}
                      type="number"
                      min={field.min}
                      max={field.max}
                      step="1"
                      value={String(limits[field.key] / field.scale)}
                      isDisabled={busy || !!active}
                      onValueChange={(value) =>
                        setLimits((current) => ({ ...current, [field.key]: Number(value) * field.scale }))
                      }
                    />
                  ))}
                </div>
                <p className="text-xs text-default-500">
                  模型预算包含生成与执行；时间从确认执行起计算。范围和预算内的补测会自动进行。
                </p>
              </>
            ) : (
              <p className="text-sm">
                本次选中 <strong>{caseIds.length}</strong> 条用例。每次最多 20 条，请同时选中依赖的前置用例。
              </p>
            )}
            <Textarea
              label={sourceMode === 'document' ? '补充业务要求（可选）' : '接口说明与业务规则（可选）'}
              placeholder="粘贴接口方法、路径、参数约束及明确的业务规则，帮助 Agent 补充执行信息。"
              maxLength={sourceMode === 'document' ? 6000 : 20000}
              value={description}
              onValueChange={setDescription}
              isDisabled={busy || !!active}
            />
            <Button
              color="primary"
              isLoading={busy}
              isDisabled={
                !!active ||
                !environmentLoaded ||
                environmentDirty ||
                (sourceMode === 'document' ? !importedDocument || !canEditCase : !caseIds.length || caseIds.length > 20)
              }
              onPress={async () => {
                if (planDirty && !window.confirm('当前计划尚未保存，确定创建新任务吗？')) return;
                setBusy(true);
                setError('');
                setNotice('');
                try {
                  const created = await agentRequest<AgentTask>(
                    token,
                    `/runs/${runId}/tasks${sourceMode === 'document' ? '/document' : ''}`,
                    'POST',
                    sourceMode === 'document'
                      ? { document: importedDocument, requirements: description, limits }
                      : {
                          caseIds,
                          interfaceDescription: description,
                        }
                  );
                  setTask(created);
                  setPlanDirty(false);
                  setConfirmed(false);
                  setPreconditionsConfirmed(false);
                  setHistory((current) => [created, ...current]);
                } catch (error) {
                  setError(error instanceof Error ? error.message : '创建任务失败');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {sourceMode === 'document' ? '从文档生成测试用例' : '整理选中用例的测试计划'}
            </Button>
            {!caseIds.length && sourceMode === 'selected' && (
              <p className="text-xs text-default-500">关闭面板后在原运行列表勾选用例；也可以直接查看下面的历史报告。</p>
            )}
          </section>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col rounded-medium bg-default-100 px-3 py-2 text-xs text-default-600">
              历史执行记录
              <select
                aria-label="历史执行记录"
                className="mt-1 min-w-0 bg-transparent text-sm text-foreground outline-offset-2"
                value={task ? String(task.id) : ''}
                disabled={busy || !history.length}
                onChange={(event) => {
                  if (event.target.value) void selectTask(Number(event.target.value));
                }}
              >
                <option value="" disabled>
                  请选择执行记录
                </option>
                {history.map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    #{item.id} · {agentStateLabels[item.state] || item.state} ·{' '}
                    {new Date(item.createdAt).toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
            {cursor && (
              <Button
                size="sm"
                variant="flat"
                isDisabled={busy}
                onPress={async () => {
                  setBusy(true);
                  try {
                    const list = await agentRequest<{ tasks: AgentHistory[]; nextCursor: number | null }>(
                      token,
                      `/runs/${runId}/tasks?beforeId=${cursor}`
                    );
                    setHistory((current) => [...current, ...list.tasks]);
                    setCursor(list.nextCursor);
                  } catch (error) {
                    setError(error instanceof Error ? error.message : '读取历史失败');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                更早记录
              </Button>
            )}
          </div>
          {!history.length && <p className="text-sm text-default-500">尚无 Agent 执行记录。</p>}
          {task && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-default-200 pt-4">
                <h2 className="font-semibold">
                  任务 #{task.id} · {agentStateLabels[task.state] || task.state}
                </h2>
                <Button
                  size="sm"
                  variant="bordered"
                  isDisabled={busy}
                  onPress={async () => {
                    setBusy(true);
                    setError('');
                    try {
                      const response = await fetch(
                        `${Config.apiServer}/runs/download/${runId}?type=xlsx&agentTaskId=${task.id}`,
                        { headers: { Authorization: `Bearer ${token}` } }
                      );
                      if (!response.ok) throw new Error('导出失败，请检查权限或重试');
                      const url = URL.createObjectURL(await response.blob());
                      const link = document.createElement('a');
                      link.href = url;
                      link.download = `Agent测试报告-${task.id}.xlsx`;
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    } catch (error) {
                      setError(error instanceof Error ? error.message : '导出失败');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  导出本次 Excel 报告
                </Button>
              </div>
              {active && (
                <div className="flex flex-wrap items-center gap-3">
                  <p role="status" className="text-sm text-primary">
                    {task.state === 'preparing'
                      ? 'Agent 正在读取用例并整理缺失信息，尚未执行接口。'
                      : '正在执行已确认计划，结果会逐条更新。关闭面板后任务仍会继续。'}
                  </p>
                  <Button
                    size="sm"
                    color="danger"
                    variant="flat"
                    isDisabled={busy}
                    onPress={async () => {
                      setBusy(true);
                      setError('');
                      try {
                        setTask(
                          await agentRequest<AgentTask>(token, `/runs/${runId}/tasks/${task.id}/stop`, 'POST', {})
                        );
                        setNotice('停止请求已发送，正在保存已有证据。');
                      } catch (error) {
                        setError(error instanceof Error ? error.message : '停止失败');
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    停止当前任务
                  </Button>
                </div>
              )}
              {task.plan.workflow && !active && task.state !== 'awaiting_confirmation' && canEditCase && (
                <div className="rounded-medium bg-default-100 p-3 text-sm space-y-2">
                  <p>需要补充业务规则或扩大范围时，可以沿用文档创建新任务并重新确认。当前任务和原始证据会保留。</p>
                  <Button
                    size="sm"
                    variant="flat"
                    onPress={() => {
                      const workflow = task.plan.workflow!;
                      setSourceMode('document');
                      setDocument({ name: workflow.document.name, content: workflow.document.content });
                      setDescription(workflow.document.requirements);
                      setLimits(workflow.limits);
                      setNotice('已填入原文档，请在上方补充业务要求后重新生成。');
                    }}
                  >
                    沿用文档补充要求
                  </Button>
                </div>
              )}
              {task.state !== 'preparing' && !task.startedAt && (
                <AgentPlanEditor
                  key={`${task.id}-${task.version}-${task.state}`}
                  task={task}
                  token={token}
                  runId={runId}
                  canEditCase={canEditCase}
                  onDirty={(dirty) => {
                    setPlanDirty(dirty);
                    setConfirmed(false);
                    setPreconditionsConfirmed(false);
                  }}
                  onSaved={(saved, warning) => {
                    setTask(saved);
                    setPlanDirty(false);
                    setConfirmed(false);
                    setPreconditionsConfirmed(false);
                    setError(warning || '');
                    setNotice('计划已保存，请重新核对后确认。');
                  }}
                />
              )}
              {task.state === 'awaiting_confirmation' && (
                <div className="space-y-3 rounded-medium border border-primary-200 p-4">
                  <p className="break-all text-sm">
                    本次确认的测试环境：{String(task.plan.environment.baseUrl || '未配置')}
                  </p>
                  <Checkbox
                    isSelected={confirmed}
                    isDisabled={planDirty || environmentDirty || busy}
                    onValueChange={setConfirmed}
                  >
                    {task.plan.workflow
                      ? '已核对接口范围、允许的操作、规则依据和自动补测预算'
                      : '已核对用例、请求参数、断言和测试环境'}
                  </Checkbox>
                  <Checkbox
                    isSelected={preconditionsConfirmed}
                    isDisabled={planDirty || environmentDirty || busy}
                    onValueChange={setPreconditionsConfirmed}
                  >
                    已准备测试数据、认证信息及其他前置条件
                  </Checkbox>
                  {(planDirty || environmentDirty) && (
                    <p className="text-sm text-warning-700">有未保存的修改，请先保存环境和计划。</p>
                  )}
                  <Button
                    color="primary"
                    isDisabled={!confirmed || !preconditionsConfirmed || planDirty || environmentDirty || busy}
                    isLoading={busy}
                    onPress={async () => {
                      setBusy(true);
                      setError('');
                      setNotice('');
                      try {
                        setTask(
                          await agentRequest<AgentTask>(token, `/runs/${runId}/tasks/${task.id}/confirm`, 'POST', {
                            version: task.version,
                            confirmed,
                            preconditionsConfirmed,
                          })
                        );
                        setConfirmed(false);
                        setPreconditionsConfirmed(false);
                      } catch (error) {
                        setError(error instanceof Error ? error.message : '确认执行失败');
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    确认并开始执行
                  </Button>
                </div>
              )}
              <AgentReport task={task} />
            </>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={close}>
            关闭
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
