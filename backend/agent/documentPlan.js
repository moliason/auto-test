import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { configurationIssues } from './credentials.js';
import { executionIssues } from './execution.js';

export const documentBudget = { maxRounds: 3, maxCases: 20, maxModelCalls: 24, timeoutMs: 300000 };

export function documentPlanIssues(plan) {
  const workflow = plan.workflow;
  if (!workflow) return [];
  if (!workflow.document || typeof workflow.document.sourceText !== 'string') return ['缺少接口文档来源'];
  const issues = [];
  if (
    workflow.confirmed &&
    (!isDeepStrictEqual(workflow.confirmed.rules, workflow.rules) ||
      !isDeepStrictEqual(workflow.confirmed.allowedOperationIds, workflow.allowedOperationIds) ||
      !isDeepStrictEqual(workflow.confirmed.limits, workflow.limits))
  )
    issues.push('已确认的规则、接口范围与预算发生变化，请创建新任务重新确认');
  const limits = workflow.limits || {};
  for (const [key, min, max] of [
    ['maxRounds', 0, 5],
    ['maxCases', 1, 20],
    ['maxModelCalls', 1, 40],
    ['timeoutMs', 1000, 600000],
  ])
    if (!Number.isSafeInteger(limits[key]) || limits[key] < min || limits[key] > max)
      issues.push(`${key} 须为 ${min} 至 ${max} 的整数`);
  if (
    !Array.isArray(workflow.operations) ||
    workflow.operations.length > 30 ||
    !Array.isArray(workflow.rules) ||
    workflow.rules.length > 60
  )
    return [...issues, '文档接口或规则格式无效'];
  if (
    !Array.isArray(workflow.questions) ||
    workflow.questions.length > 20 ||
    workflow.questions.some((question) => typeof question !== 'string' || question.length > 1000)
  )
    return [...issues, '文档待确认问题格式无效'];
  issues.push(...workflow.questions.filter((question) => question.trim()).map((question) => `文档待确认：${question}`));
  const source = `${workflow.document.sourceText}\n${workflow.document.requirements}`;
  const ids = new Set();
  for (const op of workflow.operations) {
    if (
      !op ||
      typeof op.id !== 'string' ||
      !op.id ||
      op.id.length > 150 ||
      ids.has(op.id) ||
      !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(op.method) ||
      typeof op.path !== 'string' ||
      !/^\/(?!\/)/.test(op.path) ||
      /[\\\s?#]/.test(op.path)
    ) {
      issues.push('文档接口编号、方法或相对路径无效');
      continue;
    }
    ids.add(op.id);
    if (workflow.document.format === 'openapi') {
      if (!workflow.document.operations?.some((entry) => entry.method === op.method && entry.path === op.path))
        issues.push(`${op.id} 不在上传的 OpenAPI 文档内`);
    } else if (
      typeof op.evidence !== 'string' ||
      !source.includes(op.evidence) ||
      !op.evidence.includes(op.path) ||
      !op.evidence.includes(op.method)
    )
      issues.push(`${op.id} 缺少包含请求方法和路径的原文依据`);
  }
  const ruleIds = new Set();
  for (const rule of workflow.rules) {
    if (
      !rule ||
      typeof rule.id !== 'string' ||
      !/^[\w-]{1,60}$/.test(rule.id) ||
      ruleIds.has(rule.id) ||
      !ids.has(rule.operationId) ||
      typeof rule.description !== 'string' ||
      !rule.description.trim() ||
      rule.description.length > 2000
    ) {
      issues.push('文档规则编号、接口归属或说明无效');
      continue;
    }
    ruleIds.add(rule.id);
    if (
      typeof rule.evidence !== 'string' ||
      rule.evidence.trim().length < 4 ||
      rule.evidence.length > 3000 ||
      !source.includes(rule.evidence)
    )
      issues.push(`规则 ${rule.id} 缺少可定位的原文依据`);
    const assertion = rule.assertion;
    if (
      executionIssues({ method: 'GET', path: '/', assertions: [assertion] }).length ||
      configurationIssues(assertion).length
    )
      issues.push(`规则 ${rule.id} 的断言无效或包含凭据`);
    else if (
      assertion.type !== 'jsonExists' &&
      !String(rule.evidence)
        .replace(/\s/g, '')
        .includes(
          (typeof assertion.expected === 'string' ? assertion.expected : JSON.stringify(assertion.expected)).replace(
            /\s/g,
            ''
          )
        )
    )
      issues.push(`规则 ${rule.id} 的预期值未出现在原文依据中`);
  }
  if (!workflow.operations.length || !workflow.rules.length)
    issues.push('尚未提取可执行的接口规则，请补全文档后重新生成');
  const allowed = Array.isArray(workflow.allowedOperationIds) ? workflow.allowedOperationIds : [];
  if (!allowed.length || allowed.some((id) => !ids.has(id))) issues.push('请选择文档内允许执行的接口操作');
  if (!Array.isArray(plan.cases)) return [...issues, '用例格式无效'];
  if ((plan.cases || []).length > limits.maxCases) issues.push('用例数量超过本次预算');
  for (const item of plan.cases || []) {
    if (!item || typeof item !== 'object') {
      issues.push('用例格式无效');
      continue;
    }
    const linked = Array.isArray(item.ruleIds)
      ? item.ruleIds.map((id) => workflow.rules.find((rule) => rule.id === id))
      : [];
    if (!linked.length || linked.some((rule) => !rule)) {
      issues.push(`#${item.caseId} 缺少有效的文档规则依据`);
      continue;
    }
    const op = workflow.operations.find((entry) => entry.id === linked[0].operationId);
    if (linked.some((rule) => rule.operationId !== op?.id) || !allowed.includes(op?.id))
      issues.push(`#${item.caseId} 超出已选择的接口范围`);
    const spec = item.executionInfo;
    if (!spec) continue; // Initial incomplete drafts remain editable; buildPlan reports the missing execution fields.
    const pathPattern = String(op?.path || '')
      .split(/(\{\{[^{}]+\}\}|\{[^{}]+\})/)
      .map((part) => (/^\{/.test(part) ? '[^/?#]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('');
    if (spec.method !== op?.method || typeof spec.path !== 'string' || !new RegExp(`^${pathPattern}$`).test(spec.path))
      issues.push(`#${item.caseId} 请求方法或路径超出文档接口范围`);
    try {
      const decoded = decodeURIComponent(spec.path);
      if (!new RegExp(`^${pathPattern}$`).test(decoded)) issues.push(`#${item.caseId} 路径解码后超出文档接口范围`);
      if (
        /[\\?#%]/.test(decoded) ||
        decoded.split('/').some((part) => part === '.' || part === '..') ||
        decoded.includes('//')
      )
        issues.push(`#${item.caseId} 路径包含可能改变接口范围的编码或目录跳转`);
    } catch {
      issues.push(`#${item.caseId} 路径编码无效`);
    }
    if (
      !Array.isArray(spec.assertions) ||
      spec.assertions.some((assertion) => !linked.some((rule) => isDeepStrictEqual(rule.assertion, assertion))) ||
      linked.some((rule) => !spec.assertions?.some((assertion) => isDeepStrictEqual(assertion, rule.assertion)))
    )
      issues.push(`#${item.caseId} 断言必须与关联的文档规则一致，修改预期请重新审核文档`);
    issues.push(...configurationIssues(spec).map((issue) => `#${item.caseId} ${issue}`));
  }
  return [...new Set(issues)];
}

export function caseFingerprint(execution) {
  const { method, path, query, body, assertions, headers = {} } = execution || {};
  const value = {
    method,
    path,
    query: query || {},
    body: body ?? null,
    headers: Object.fromEntries(Object.entries(headers).map(([key, entry]) => [key.toLowerCase(), entry])),
    assertions,
  };
  const normalized = JSON.parse(
    JSON.stringify(value, (_, entry) =>
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
        : entry
    )
  );
  if (Array.isArray(normalized.assertions))
    normalized.assertions.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function documentAcceptance(task) {
  const workflow = task.plan?.workflow;
  if (!workflow) return null;
  const covered = new Set();
  const failed = [];
  for (const result of task.results || []) {
    const item = task.plan.cases.find((entry) => entry.caseId === result.caseId);
    if (result.request && ['passed', 'failed'].includes(result.status))
      for (const id of item?.ruleIds || []) covered.add(id);
    if (['failed', 'error'].includes(result.status)) failed.push(result.caseId);
  }
  const rules = workflow.rules.filter((rule) => workflow.allowedOperationIds.includes(rule.operationId));
  const uncovered = rules.filter((rule) => !covered.has(rule.id));
  const unexecuted = task.plan.cases.filter(
    (item) => !(task.results || []).some((result) => result.caseId === item.caseId && result.request)
  );
  const complete =
    task.state === 'completed' &&
    workflow.stopReason === 'no_new_cases' &&
    !workflow.pending &&
    !task.plan.issues.length &&
    rules.length &&
    !uncovered.length &&
    !unexecuted.length;
  return {
    verdict: failed.length ? 'failed' : complete ? 'passed' : 'inconclusive',
    ruleCount: rules.length,
    coveredRules: rules.filter((rule) => covered.has(rule.id)).map((rule) => rule.id),
    uncoveredRules: uncovered.map((rule) => ({ id: rule.id, description: rule.description })),
    failedCaseIds: failed,
    unexecutedCaseIds: unexecuted.map((item) => item.caseId),
    rounds: workflow.rounds || [],
    stopReason: workflow.stopReason || null,
    pending: workflow.pending || null,
  };
}
