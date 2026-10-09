import { buildPlan } from './plan.js';
import { caseFingerprint, documentPlanIssues } from './documentPlan.js';
import { configurationIssues } from './credentials.js';
import { getNextProjectCaseNo } from '../utils/caseNumber.js';

// Creating the managed cases, their run membership and the immutable task snapshot is one transaction.
export async function saveDocumentCases(sequelize, taskId, proposal) {
  const { AgentTask: Task, Run, Case, Folder, RunCase, Step, CaseStep } = sequelize.models;
  return sequelize.transaction(async (transaction) => {
    const task = await Task.findByPk(taskId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!task || !['preparing', 'running'].includes(task.state)) throw new Error('任务已停止');
    const initial = task.state === 'preparing';
    const workflow = structuredClone(task.plan.workflow);
    if (!workflow) throw new Error('任务未导入接口文档');
    if (
      !Array.isArray(proposal.cases) ||
      proposal.cases.length > 20 ||
      typeof proposal.reason !== 'string' ||
      !proposal.reason.trim() ||
      proposal.reason.length > 2000
    )
      throw new Error('请提交用例数组及 1 至 2000 字符的生成依据');
    if (
      !Array.isArray(proposal.questions) ||
      proposal.questions.length > 20 ||
      proposal.questions.some((entry) => typeof entry !== 'string' || entry.length > 1000)
    )
      throw new Error('待确认问题格式无效');
    if (initial) {
      if (!Array.isArray(proposal.operations) || !Array.isArray(proposal.rules))
        throw new Error('初始计划必须包含 operations 和 rules 数组');
      workflow.operations = proposal.operations;
      workflow.rules = proposal.rules;
      workflow.allowedOperationIds = Array.isArray(proposal.operations) ? proposal.operations.map((op) => op?.id) : [];
      workflow.questions = proposal.questions;
    } else {
      if (proposal.operations !== undefined || proposal.rules !== undefined)
        throw new Error('已确认的接口与规则不能由模型修改');
      if (proposal.questions.some((entry) => entry.trim()))
        throw Object.assign(new Error(proposal.questions.join('；')), { needsInput: true });
    }
    const round = initial ? 0 : workflow.rounds.length;
    const keys = new Set(task.plan.cases.map((item) => item.key));
    const fingerprints = new Set(task.plan.cases.map((item) => caseFingerprint(item.executionInfo)));
    const accepted = [];
    const duplicateKeys = [];
    for (const item of proposal.cases) {
      if (
        !item ||
        typeof item.key !== 'string' ||
        !/^[\w-]{1,60}$/.test(item.key) ||
        keys.has(item.key) ||
        typeof item.title !== 'string' ||
        !item.title.trim() ||
        item.title.length > 200 ||
        typeof item.purpose !== 'string' ||
        !item.purpose.trim() ||
        item.purpose.length > 2000 ||
        !['normal', 'abnormal', 'boundary'].includes(item.scenario) ||
        !Array.isArray(item.ruleIds) ||
        !item.ruleIds.length ||
        item.ruleIds.length > 30 ||
        !Array.isArray(item.dependsOnKeys) ||
        item.dependsOnKeys.some((key) => typeof key !== 'string') ||
        !Array.isArray(item.evidenceCaseIds) ||
        item.evidenceCaseIds.some((id) => !task.results.some((result) => result.caseId === id))
      )
        throw new Error('用例编号、目的、场景类型、规则或依赖证据格式无效');
      keys.add(item.key);
      if (configurationIssues(item.executionInfo).length)
        throw Object.assign(new Error('生成配置含明文或无效凭据，请补充认证变量引用'), { needsInput: true });
      if (item.executionInfo?.dependsOn?.length) throw new Error('生成用例请使用 dependsOnKeys 声明依赖');
      const fingerprint = caseFingerprint(item.executionInfo);
      if (item.executionInfo && fingerprints.has(fingerprint)) duplicateKeys.push(item.key);
      else {
        accepted.push(item);
        fingerprints.add(fingerprint);
      }
    }
    if (initial && accepted.length > 6) throw new Error('首轮最多生成 6 条用例，其他有效场景在读取执行结果后补测');
    if (!initial && !accepted.length) return { stopReason: 'no_new_cases', duplicateKeys };
    if (!initial && round > workflow.limits.maxRounds) return { stopReason: 'max_rounds', duplicateKeys };
    if (task.plan.cases.length + accepted.length > workflow.limits.maxCases) {
      if (!initial) return { stopReason: 'max_cases', duplicateKeys };
      throw new Error('初始用例超过本次用例预算');
    }
    const run = await Run.findByPk(task.runId, { transaction });
    let folder;
    if (workflow.folderId)
      folder = await Folder.findOne({ where: { id: workflow.folderId, projectId: run.projectId }, transaction });
    if (workflow.folderId && !folder)
      throw Object.assign(new Error('生成用例目录已移出当前项目'), { needsInput: true });
    if (!folder && accepted.length)
      folder = await Folder.create(
        { name: `文档测试 #${task.id} · ${workflow.document.name}`, projectId: run.projectId },
        { transaction }
      );
    if (folder) workflow.folderId = folder.id;
    const caseMap = new Map(task.plan.cases.map((item) => [item.key, item.caseId]));
    const records = [];
    let caseNo = folder ? await getNextProjectCaseNo(sequelize, Folder, folder.id, transaction) : 1;
    for (const item of accepted) {
      const record = await Case.create(
        {
          title: item.title,
          state: 0,
          caseNo: caseNo++,
          priority: 1,
          type: 1,
          automationStatus: 1,
          template: 1,
          folderId: folder.id,
        },
        { transaction }
      );
      records.push(record);
      caseMap.set(item.key, record.id);
    }
    const snapshots = [...task.plan.cases];
    for (const [index, item] of accepted.entries()) {
      if (item.dependsOnKeys.some((key) => !caseMap.has(key)))
        throw new Error('依赖编号不存在或已被去重，请引用有效的用例 key');
      const executionInfo =
        item.executionInfo == null
          ? null
          : { ...item.executionInfo, dependsOn: item.dependsOnKeys.map((key) => caseMap.get(key)) };
      const linked = (Array.isArray(workflow.rules) ? workflow.rules : []).filter((rule) =>
        item.ruleIds.includes(rule?.id)
      );
      const expectedResults = linked.map((rule) => `${rule.id}：${rule.description}`).join('\n') || '待确认文档规则';
      const description = `${item.purpose}\n场景：${item.scenario}\n生成依据：${proposal.reason}\n${linked.map((rule) => `来源 ${rule.id}：${rule.evidence}`).join('\n')}`;
      const preConditions = (executionInfo?.preconditions || []).join('\n');
      await records[index].update({ description, expectedResults, preConditions, executionInfo }, { transaction });
      const step = {
        step: `${executionInfo?.method || '待确认方法'} ${executionInfo?.path || '待确认路径'}`,
        result: expectedResults,
      };
      const createdStep = await Step.create(step, { transaction });
      await CaseStep.create({ caseId: records[index].id, stepId: createdStep.id, stepNo: 1 }, { transaction });
      await RunCase.create({ runId: task.runId, caseId: records[index].id, status: 0 }, { transaction });
      snapshots.push({
        caseId: records[index].id,
        key: item.key,
        title: item.title,
        description,
        expectedResults,
        preConditions,
        steps: [{ ...step, stepNo: 1 }],
        executionInfo,
        questions: item.questions || [],
        ruleIds: item.ruleIds,
        purpose: item.purpose,
        scenario: item.scenario,
        reason: proposal.reason,
        evidenceCaseIds: item.evidenceCaseIds,
        round,
      });
    }
    const plan = {
      ...task.plan,
      ...(snapshots.length
        ? buildPlan(snapshots, task.plan.environment, null, proposal.reason, run.projectId)
        : { cases: [], order: [], issues: ['文档信息不足，尚未生成可执行用例'] }),
      workflow,
    };
    const contractIssues = documentPlanIssues(plan);
    if (initial) {
      const invalid = contractIssues.filter(
        (issue) =>
          !issue.startsWith('文档待确认：') &&
          !(
            snapshots.length === 0 &&
            ['尚未提取可执行的接口规则，请补全文档后重新生成', '请选择文档内允许执行的接口操作'].includes(issue)
          )
      );
      if (invalid.length)
        throw new Error(
          `请修正生成结构后重新提交：${invalid.join('；')}。每条断言（包括 status）都要有单独的 rule 及对应 ruleId；不要给用例添加未关联的断言。`
        );
    }
    plan.issues.push(...contractIssues);
    if (!initial && plan.issues.length) throw Object.assign(new Error(plan.issues.join('；')), { needsInput: true });
    workflow.rounds.push({
      index: round,
      reason: proposal.reason,
      caseIds: records.map((record) => record.id),
      duplicateKeys,
      at: new Date().toISOString(),
    });
    await task.update(
      {
        plan,
        state: initial ? (plan.issues.length ? 'needs_input' : 'awaiting_confirmation') : 'running',
        version: task.version + 1,
      },
      { transaction }
    );
    return { saved: true, cases: plan.cases, issues: plan.issues, round, duplicateKeys };
  });
}
