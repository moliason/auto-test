import { environmentIssues, executionIssues } from './execution.js';

export function environmentVariables(environment = {}, projectId) {
  const variables = { ...(environment.variables || {}) };
  const secrets = [];
  const issues = [];
  let grants = {};
  try {
    grants = JSON.parse(process.env.TEST_AGENT_SECRET_GRANTS || '{}');
  } catch {
    /* Invalid or absent grants never authorize a secret. */
  }
  for (const name of Array.isArray(environment.secretVariables) ? environment.secretVariables : []) {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (!Number.isSafeInteger(projectId) || !Array.isArray(grants?.[projectId]) || !grants[projectId].includes(name)) {
      delete variables[name];
      issues.push(`当前项目未授权使用认证变量 ${name}，请由管理员配置 TEST_AGENT_SECRET_GRANTS`);
      continue;
    }
    const value = process.env[`TEST_AGENT_SECRET_${name}`];
    if (!value) issues.push(`请在后端配置认证变量 TEST_AGENT_SECRET_${name}`);
    else {
      variables[name] = value;
      secrets.push(value);
    }
  }
  return { variables, secrets, issues };
}

export function buildPlan(snapshots, environment = {}, proposals = null, notes = '', projectId) {
  if (!Array.isArray(snapshots) || !snapshots.length || snapshots.length > 20)
    throw new Error('请选择 1 至 20 条运行内用例');
  if (
    proposals !== null &&
    (!Array.isArray(proposals) ||
      proposals.length !== snapshots.length ||
      new Set(proposals.map((item) => item?.caseId)).size !== snapshots.length ||
      proposals.some((item) => !snapshots.some((snapshot) => snapshot.caseId === item?.caseId)))
  )
    throw new Error('计划必须且只能包含本次选中的全部用例');
  if (typeof notes !== 'string' || notes.length > 2000) throw new Error('计划说明最多 2000 字符');
  const resolved = environmentVariables(environment, projectId);
  const plan = {
    environment,
    notes,
    cases: [],
    order: [],
    issues: [...environmentIssues(environment), ...resolved.issues],
  };
  for (const snapshot of snapshots) {
    const proposal = proposals?.find((item) => item.caseId === snapshot.caseId) || snapshot;
    const executionInfo = proposal.executionInfo ?? null;
    const questions = proposal.questions ?? [];
    if (
      !Array.isArray(questions) ||
      questions.length > 20 ||
      questions.some((question) => typeof question !== 'string' || question.length > 1000)
    )
      throw new Error('待确认问题格式无效');
    if (
      executionInfo !== null &&
      (typeof executionInfo !== 'object' ||
        Array.isArray(executionInfo) ||
        JSON.stringify(executionInfo).length > 64000)
    )
      throw new Error('执行信息格式无效或超过上限');
    const issues = [
      ...executionIssues(executionInfo),
      ...questions.filter((question) => question.trim()).map((question) => `待确认：${question}`),
    ];
    const dependsOn = Array.isArray(executionInfo?.dependsOn) ? [...new Set(executionInfo.dependsOn)] : [];
    for (const id of dependsOn) {
      if (id === snapshot.caseId) issues.push('用例不能依赖自身');
      else if (!snapshots.some((item) => item.caseId === id)) issues.push(`前置用例 #${id} 未选中，请将其加入本次测试`);
    }
    plan.cases.push({ ...snapshot, executionInfo, questions, dependsOn, dependencyIds: [], issues });
  }
  const pending = new Set(plan.cases.map((item) => item.caseId));
  for (let round = 0; round < plan.cases.length; round++) {
    for (const item of plan.cases) {
      if (pending.has(item.caseId) && item.dependsOn.every((id) => !pending.has(id))) {
        pending.delete(item.caseId);
        plan.order.push(item.caseId);
      }
    }
  }
  if (pending.size) plan.issues.push(`存在循环依赖：${[...pending].map((id) => `#${id}`).join('、')}`);
  for (const caseId of plan.order) {
    const item = plan.cases.find((entry) => entry.caseId === caseId);
    const dependencies = new Set(item.dependsOn);
    for (const id of item.dependsOn)
      for (const ancestor of plan.cases.find((entry) => entry.caseId === id)?.dependencyIds || [])
        dependencies.add(ancestor);
    item.dependencyIds = plan.order.filter((id) => dependencies.has(id));
    const available = new Set(Object.keys(resolved.variables));
    for (const id of item.dependencyIds) {
      const extract = plan.cases.find((entry) => entry.caseId === id)?.executionInfo?.extract;
      for (const entry of Array.isArray(extract) ? extract : [])
        if (typeof entry?.name === 'string') available.add(entry.name);
    }
    const text = JSON.stringify({
      path: item.executionInfo?.path,
      headers: item.executionInfo?.headers,
      query: item.executionInfo?.query,
      body: item.executionInfo?.body,
      environmentHeaders: environment.headers,
    });
    const required = new Set([...text.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)].map((match) => match[1]));
    for (const name of Array.isArray(item.executionInfo?.requiredVariables) ? item.executionInfo.requiredVariables : [])
      required.add(name);
    for (const name of required)
      if (!available.has(name)) item.issues.push(`缺少变量 ${name}：请配置环境变量或声明提供此变量的前置用例`);
  }
  for (const item of plan.cases) for (const issue of item.issues) plan.issues.push(`#${item.caseId} ${issue}`);
  return plan;
}

export function reportSummary(task) {
  const results = task.results || [];
  const total = task.plan?.cases?.length || 0;
  const passed = results.filter((item) => item.status === 'passed').length;
  const failed = results.filter((item) => ['failed', 'error'].includes(item.status)).length;
  return {
    total,
    passed,
    failed,
    unexecuted: Math.max(0, total - passed - failed),
    requestErrors: results.filter((item) => item.status === 'error').length,
  };
}
