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
  key?: string;
  purpose?: string;
  scenario?: string;
  ruleIds?: string[];
  round?: number;
  reason?: string;
  evidenceCaseIds?: number[];
};

export type AgentLimits = { maxRounds: number; maxCases: number; maxModelCalls: number; timeoutMs: number };
export const defaultAgentLimits: AgentLimits = { maxRounds: 3, maxCases: 20, maxModelCalls: 24, timeoutMs: 300000 };
export const agentLimitFields = [
  { key: 'maxRounds', label: '最多补测轮次', min: 0, max: 5, scale: 1 },
  { key: 'maxCases', label: '用例总数上限', min: 1, max: 20, scale: 1 },
  { key: 'maxModelCalls', label: '模型调用总上限', min: 1, max: 40, scale: 1 },
  { key: 'timeoutMs', label: '执行时间上限（秒）', min: 1, max: 600, scale: 1000 },
] as const;
export const agentStopLabels: Record<string, string> = {
  no_new_cases: '没有新的有效验证点',
  max_rounds: '达到补测轮次上限',
  max_cases: '达到用例数量上限',
  max_model_calls: '达到模型调用上限',
  max_time: '达到执行时间上限',
  user_stopped: '用户主动停止',
  execution_fault: '环境或执行故障',
  service_interrupted: '服务重启中断',
  needs_confirmation: '需要补充规则或确认范围',
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
    workflow?: {
      document: {
        name: string;
        content: string;
        sourceText: string;
        sha256: string;
        format: string;
        requirements: string;
      };
      limits: AgentLimits;
      operations: { id: string; method: string; path: string; evidence?: string }[];
      allowedOperationIds: string[];
      rules: {
        id: string;
        operationId: string;
        description: string;
        evidence: string;
        assertion: Record<string, unknown>;
      }[];
      questions: string[];
      rounds: { index: number; reason: string; caseIds: number[]; duplicateKeys: string[]; at: string }[];
      excludedCases?: AgentCase[];
      stopReason?: string;
      confirmed?: { at: string; initialCaseIds: number[]; allowedOperationIds: string[]; limits: AgentLimits };
      pending?: { questions: string[]; proposal: unknown };
    };
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
  measurements?: {
    phase: string;
    calls: number;
    completedCalls: number;
    failedCalls: number;
    durationMs: number | null;
    timedCalls: number;
    tokens: Record<string, { value: number | null; recordedCalls: number }>;
  }[];
  executionMeasurements?: {
    requests: { durationMs: number | null; recorded: number; total: number };
    persistence: { durationMs: number | null; recorded: number; total: number };
    reportDurationMs: number | null;
  };
  summary: { total: number; passed: number; failed: number; unexecuted: number; requestErrors: number };
  acceptance?: {
    verdict: 'passed' | 'failed' | 'inconclusive';
    ruleCount: number;
    coveredRules: string[];
    uncoveredRules: { id: string; description: string }[];
    failedCaseIds: number[];
    unexecutedCaseIds: number[];
    stopReason: string | null;
  } | null;
};

export const agentStateLabels: Record<string, string> = {
  preparing: '整理计划中',
  needs_input: '待补充信息',
  awaiting_confirmation: '待确认执行',
  running: '执行中',
  completed: '已完成',
  failed: '任务失败',
  interrupted: '执行中断',
  stopped: '已停止',
};

export type AgentHistory = Pick<AgentTask, 'id' | 'state' | 'createdAt' | 'finishedAt' | 'summary'>;
