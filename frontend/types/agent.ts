export type AgentCase = {
  caseId: number;
  title: string;
  description?: string;
  preConditions?: string;
  expectedResults?: string;
  steps?: { step: string; result: string; stepNo: number }[];
  executionInfo: Record<string, unknown> | null;
  questions: string[];
  issues: string[];
};

export type AgentTask = {
  id: number;
  version: number;
  state: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  analysis: string | null;
  plan: {
    cases: AgentCase[];
    environment: Record<string, unknown>;
    issues: string[];
    notes: string;
    model: string;
    provider: string;
  };
  results: {
    caseId: number;
    title: string;
    status: string;
    reason: string;
    durationMs: number;
    startedAt: string;
    finishedAt: string;
    mappedToRun: boolean;
    snapshot: Record<string, unknown>;
    request: unknown;
    response: unknown;
    assertions: { type: string; path?: string; expected?: unknown; actual?: unknown; passed: boolean }[];
  }[];
  events: { at: string; type: string; name?: string; phase?: string; call?: number; ok?: boolean; error?: string }[];
  summary: { total: number; passed: number; failed: number; unexecuted: number; requestErrors: number };
};

export const agentStateLabels: Record<string, string> = {
  preparing: '整理计划中',
  needs_input: '待补充信息',
  awaiting_confirmation: '待确认执行',
  running: '执行中',
  completed: '已完成',
  failed: '任务失败',
  interrupted: '执行中断',
};

export type AgentHistory = Pick<AgentTask, 'id' | 'state' | 'createdAt' | 'finishedAt' | 'summary'>;
