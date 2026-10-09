import express from 'express';
import { DataTypes, Op } from 'sequelize';
import authMiddleware from '../../middleware/auth.js';
import editableMiddleware from '../../middleware/verifyEditable.js';
import defineAgentTask from '../../models/agentTasks.js';
import defineRun from '../../models/runs.js';
import defineRunCase from '../../models/runCases.js';
import defineCase from '../../models/cases.js';
import defineFolder from '../../models/folders.js';
import defineStep from '../../models/steps.js';
import defineCaseStep from '../../models/caseSteps.js';
import { buildPlan, reportSummary } from '../../agent/plan.js';
import { runAgent, finishTask, activeAgentControllers } from '../../agent/runner.js';
import { modelMeasurements, executionMeasurements } from '../../agent/measurements.js';
import { configurationIssues, protectConfiguration } from '../../agent/credentials.js';
import { parseInterfaceDocument } from '../../agent/documents.js';
import { documentBudget, documentPlanIssues, documentAcceptance } from '../../agent/documentPlan.js';

export default function (sequelize, { launch = runAgent } = {}) {
  const router = express.Router();
  const Task = defineAgentTask(sequelize, DataTypes);
  const Run = defineRun(sequelize, DataTypes);
  const RunCase = defineRunCase(sequelize, DataTypes);
  const Case = defineCase(sequelize, DataTypes);
  const Folder = defineFolder(sequelize, DataTypes);
  const Step = defineStep(sequelize, DataTypes);
  const CaseStep = defineCaseStep(sequelize, DataTypes);
  Case.belongsTo(Folder, { foreignKey: 'folderId' });
  Case.belongsToMany(Step, { through: CaseStep, foreignKey: 'caseId', otherKey: 'stepId' });
  const { verifySignedIn } = authMiddleware(sequelize);
  const { verifyProjectReporterFromRunId, verifyProjectDeveloperFromProjectId } = editableMiddleware(sequelize);
  router.use('/runs/:runId/tasks', verifySignedIn, (req, res, next) => {
    if (!/^[1-9]\d*$/.test(req.params.runId)) return res.status(400).json({ error: '测试运行编号无效' });
    return verifyProjectReporterFromRunId(req, res, next).catch(next);
  });
  router.param('taskId', (req, res, next, value) =>
    /^[1-9]\d*$/.test(value) ? next() : res.status(400).json({ error: '任务编号无效' })
  );

  router.use(
    ['/runs/:runId/tasks/document', '/runs/:runId/tasks/:taskId/plan', '/runs/:runId/tasks/:taskId/confirm'],
    async (req, res, next) => {
      if (!['POST', 'PUT'].includes(req.method)) return next();
      try {
        const task = req.params.taskId
          ? await Task.findOne({ where: { id: req.params.taskId, runId: req.params.runId } })
          : null;
        if (req.params.taskId && !task?.plan.workflow) return next();
        const run = await Run.findByPk(req.params.runId);
        req.query.projectId = run.projectId;
        return await verifyProjectDeveloperFromProjectId(req, res, next);
      } catch (error) {
        return next(error);
      }
    }
  );

  router.post('/runs/:runId/tasks/document', async (req, res) => {
    let document;
    let limits;
    try {
      document = parseInterfaceDocument(req.body?.document, req.body?.requirements || '');
      limits = { ...documentBudget, ...req.body?.limits };
      const issues = documentPlanIssues({
        cases: [],
        workflow: { document, limits, operations: [], rules: [], allowedOperationIds: [], questions: [] },
      });
      if (issues.some((issue) => /^(max|timeoutMs)/.test(issue)))
        throw new Error(issues.filter((issue) => /^(max|timeoutMs)/.test(issue)).join('；'));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    try {
      const run = await Run.findByPk(req.params.runId);
      const task = await Task.create({
        runId: run.id,
        createdBy: req.userId,
        state: 'preparing',
        plan: {
          environment: run.agentEnvironment || {},
          cases: [],
          order: [],
          issues: [],
          notes: '',
          model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
          provider: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').startsWith('https://api.deepseek.com')
            ? 'DeepSeek'
            : 'configured-proxy',
          workflow: { document, limits, operations: [], rules: [], allowedOperationIds: [], questions: [], rounds: [] },
        },
        events: [
          { type: 'document_imported', name: document.name, sha256: document.sha256, at: new Date().toISOString() },
        ],
      });
      void launch(sequelize, task.id, 'prepare').catch(() =>
        console.error('Agent document task could not persist state:', task.id)
      );
      return res.status(202).json({
        ...protectConfiguration(task.toJSON()),
        summary: reportSummary(task),
        measurements: modelMeasurements(task.events),
        executionMeasurements: executionMeasurements(task),
        acceptance: documentAcceptance(task),
      });
    } catch {
      return res.status(500).json({ error: '创建文档测试任务失败' });
    }
  });

  router.post('/runs/:runId/tasks', async (req, res) => {
    const { caseIds, interfaceDescription = '' } = req.body || {};
    if (
      !Array.isArray(caseIds) ||
      !caseIds.length ||
      caseIds.length > 20 ||
      new Set(caseIds).size !== caseIds.length ||
      caseIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
      typeof interfaceDescription !== 'string' ||
      interfaceDescription.length > 20000
    ) {
      return res.status(400).json({ error: '请选择 1 至 20 条不同的用例，接口说明最多 20000 字符' });
    }
    try {
      const run = await Run.findByPk(req.params.runId);
      const [memberships, cases] = await Promise.all([
        RunCase.findAll({ where: { runId: run.id, caseId: caseIds } }),
        Case.findAll({
          where: { id: caseIds },
          include: [
            { model: Folder, where: { projectId: run.projectId }, required: true, attributes: ['id'] },
            { model: Step, attributes: ['id', 'step', 'result'], through: { attributes: ['stepNo'] } },
          ],
        }),
      ]);
      if (memberships.length !== caseIds.length || cases.length !== caseIds.length)
        return res.status(400).json({ error: '用例必须属于当前项目并已加入此测试运行' });
      const snapshots = caseIds.map((caseId) => {
        const item = cases.find((entry) => entry.id === caseId);
        return {
          caseId,
          title: item.title,
          description: item.description,
          preConditions: item.preConditions,
          expectedResults: item.expectedResults,
          steps: (item.Steps || [])
            .map((step) => ({ step: step.step, result: step.result, stepNo: step.CaseStep.stepNo }))
            .sort((a, b) => a.stepNo - b.stepNo),
          executionInfo: item.executionInfo,
          questions: /待确认|needs confirmation/i.test(item.expectedResults || '')
            ? ['原用例业务预期包含待确认内容，请补充明确规则']
            : [],
        };
      });
      const plan = {
        ...buildPlan(snapshots, run.agentEnvironment || {}, null, '', run.projectId),
        interfaceDescription,
        model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
        provider: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').startsWith('https://api.deepseek.com')
          ? 'DeepSeek'
          : 'configured-proxy',
      };
      const reuse = plan.issues.length === 0 && !interfaceDescription.trim();
      if (reuse) plan.notes = '已复用原用例执行配置并完成校验，请核对请求、预期和前置条件后确认执行。';
      const task = await Task.create({
        runId: run.id,
        createdBy: req.userId,
        state: reuse ? 'awaiting_confirmation' : 'preparing',
        plan,
        events: reuse ? [{ type: 'configuration_reused', at: new Date().toISOString() }] : [],
      });
      if (!reuse)
        void launch(sequelize, task.id, 'prepare').catch(() =>
          console.error('Agent background task could not persist state:', task.id)
        );
      return res.status(202).json({
        ...protectConfiguration(task.toJSON()),
        summary: reportSummary(task),
        measurements: modelMeasurements(task.events),
        executionMeasurements: executionMeasurements(task),
        acceptance: documentAcceptance(task),
      });
    } catch {
      return res.status(500).json({ error: '创建 Agent 任务失败，请检查数据库及用例配置' });
    }
  });

  router.get('/runs/:runId/tasks', async (req, res) => {
    if (
      req.query.beforeId !== undefined &&
      (typeof req.query.beforeId !== 'string' || !/^[1-9]\d*$/.test(req.query.beforeId))
    )
      return res.status(400).json({ error: '分页参数无效' });
    try {
      const tasks = await Task.findAll({
        where: {
          runId: req.params.runId,
          ...(req.query.beforeId ? { id: { [Op.lt]: Number(req.query.beforeId) } } : {}),
        },
        order: [['id', 'DESC']],
        limit: 50,
      });
      return res.json({
        tasks: tasks.map((task) => ({
          id: task.id,
          state: task.state,
          createdAt: task.createdAt,
          finishedAt: task.finishedAt,
          summary: reportSummary(task),
        })),
        nextCursor: tasks.length === 50 ? tasks[tasks.length - 1].id : null,
      });
    } catch {
      return res.status(500).json({ error: '读取执行历史失败' });
    }
  });

  router.get('/runs/:runId/tasks/:taskId', async (req, res) => {
    try {
      const task = await Task.findOne({ where: { id: req.params.taskId, runId: req.params.runId } });
      if (!task) return res.status(404).json({ error: '任务不属于此测试运行或已删除' });
      return res.json({
        ...protectConfiguration(task.toJSON()),
        summary: reportSummary(task),
        measurements: modelMeasurements(task.events),
        executionMeasurements: executionMeasurements(task),
        acceptance: documentAcceptance(task),
      });
    } catch {
      return res.status(500).json({ error: '读取 Agent 任务失败' });
    }
  });

  router.put('/runs/:runId/tasks/:taskId/plan', async (req, res) => {
    if (!Number.isSafeInteger(req.body?.version)) return res.status(400).json({ error: '缺少计划版本，请重新加载' });
    if (configurationIssues(req.body?.cases).length)
      return res.status(400).json({ error: '认证信息请使用变量引用，不能保存明文或脱敏占位值' });
    try {
      const updated = await sequelize.transaction(async (transaction) => {
        const task = await Task.findOne({
          where: { id: req.params.taskId, runId: req.params.runId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!task) throw Object.assign(new Error('任务不存在'), { status: 404 });
        if (
          task.startedAt ||
          !['needs_input', 'awaiting_confirmation', 'failed'].includes(task.state) ||
          task.version !== req.body.version
        )
          throw Object.assign(new Error('计划已变化或已执行，请重新加载'), { status: 409 });
        const run = await Run.findByPk(task.runId, { transaction });
        let plan;
        try {
          plan = {
            ...task.plan,
            ...buildPlan(
              task.plan.cases,
              run.agentEnvironment || {},
              req.body.cases,
              req.body.notes || '',
              run.projectId
            ),
          };
          if (plan.workflow) {
            plan.workflow = {
              ...plan.workflow,
              limits: req.body.limits ?? plan.workflow.limits,
              allowedOperationIds: req.body.allowedOperationIds ?? plan.workflow.allowedOperationIds,
            };
            if (!Array.isArray(plan.workflow.allowedOperationIds)) throw new Error('允许执行的接口须为数组');
            const allCases = [...plan.cases, ...(task.plan.workflow.excludedCases || [])];
            const selected = allCases.filter((item) =>
              item.ruleIds?.some((id) =>
                plan.workflow.rules.some(
                  (rule) => rule.id === id && plan.workflow.allowedOperationIds.includes(rule.operationId)
                )
              )
            );
            plan.workflow.excludedCases = allCases.filter((item) => !selected.includes(item));
            Object.assign(plan, buildPlan(selected, plan.environment, null, plan.notes, run.projectId));
            plan.issues.push(...documentPlanIssues(plan));
          }
        } catch (error) {
          throw Object.assign(error, { status: 400 });
        }
        await task.update(
          {
            plan,
            version: task.version + 1,
            state: plan.issues.length ? 'needs_input' : 'awaiting_confirmation',
            error: null,
            finishedAt: null,
            events: [...task.events, { type: 'user_plan_edited', userId: req.userId, at: new Date().toISOString() }],
          },
          { transaction }
        );
        return task;
      });
      return res.json({
        ...protectConfiguration(updated.toJSON()),
        summary: reportSummary(updated),
        measurements: modelMeasurements(updated.events),
        executionMeasurements: executionMeasurements(updated),
        acceptance: documentAcceptance(updated),
      });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.status ? error.message : '保存计划失败' });
    }
  });

  router.post('/runs/:runId/tasks/:taskId/confirm', async (req, res) => {
    if (
      req.body?.confirmed !== true ||
      req.body?.preconditionsConfirmed !== true ||
      !Number.isSafeInteger(req.body?.version)
    )
      return res.status(400).json({ error: '请核对计划、测试环境及前置条件后确认执行' });
    try {
      const task = await sequelize.transaction(async (transaction) => {
        const current = await Task.findOne({
          where: { id: req.params.taskId, runId: req.params.runId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!current) throw Object.assign(new Error('任务不存在'), { status: 404 });
        if (current.state !== 'awaiting_confirmation' || current.version !== req.body.version)
          throw Object.assign(new Error('计划已变化、信息未补全或已经执行，请重新加载'), { status: 409 });
        const run = await Run.findByPk(current.runId, { transaction });
        const plan = {
          ...current.plan,
          ...buildPlan(current.plan.cases, current.plan.environment, null, current.plan.notes, run.projectId),
        };
        if (plan.workflow) {
          plan.issues.push(...documentPlanIssues(plan));
          plan.workflow = {
            ...plan.workflow,
            confirmed: {
              at: new Date().toISOString(),
              userId: req.userId,
              version: current.version,
              documentSha256: plan.workflow.document.sha256,
              limits: structuredClone(plan.workflow.limits),
              allowedOperationIds: [...plan.workflow.allowedOperationIds],
              rules: structuredClone(plan.workflow.rules),
              initialCaseIds: plan.cases.map((item) => item.caseId),
            },
          };
        }
        if (plan.issues.length) throw Object.assign(new Error(plan.issues.join('；')), { status: 400 });
        const ids = plan.cases.map((item) => item.caseId);
        const cases = await Case.count({
          where: { id: ids },
          include: [{ model: Folder, where: { projectId: run.projectId }, required: true }],
          transaction,
        });
        const included = await RunCase.count({ where: { runId: current.runId, caseId: ids }, transaction });
        if (cases !== ids.length || included !== ids.length)
          throw Object.assign(new Error('选中用例已移动或移出运行，请重新准备计划'), { status: 409 });
        if (await Task.count({ where: { runId: current.runId, state: 'running' }, transaction }))
          throw Object.assign(new Error('此测试运行已有 Agent 正在执行'), { status: 409 });
        await current.update(
          {
            plan,
            state: 'running',
            startedAt: new Date(),
            events: [
              ...current.events,
              { type: 'user_confirmed', userId: req.userId, version: current.version, at: new Date().toISOString() },
            ],
          },
          { transaction }
        );
        await Run.update({ state: 1 }, { where: { id: current.runId }, transaction });
        return current;
      });
      void launch(sequelize, task.id, 'execute').catch(() =>
        console.error('Agent background task could not persist state:', task.id)
      );
      return res.status(202).json({
        ...protectConfiguration(task.toJSON()),
        summary: reportSummary(task),
        measurements: modelMeasurements(task.events),
        executionMeasurements: executionMeasurements(task),
        acceptance: documentAcceptance(task),
      });
    } catch (error) {
      if (error.name === 'SequelizeUniqueConstraintError')
        return res.status(409).json({ error: '此测试运行已有 Agent 正在执行' });
      return res.status(error.status || 500).json({ error: error.status ? error.message : '启动执行失败' });
    }
  });
  router.post('/runs/:runId/tasks/:taskId/stop', async (req, res) => {
    try {
      const task = await Task.findOne({ where: { id: req.params.taskId, runId: req.params.runId } });
      if (!task) return res.status(404).json({ error: '任务不存在' });
      if (!['preparing', 'running'].includes(task.state)) return res.status(409).json({ error: '任务已停止' });
      const controller = activeAgentControllers.get(task.id);
      if (controller) controller.abort(new Error('用户主动停止'));
      else await finishTask(sequelize, task.id, 'stopped', '用户主动停止', null, { stopReason: 'user_stopped' });
      await task.reload();
      return res.status(202).json({
        ...protectConfiguration(task.toJSON()),
        stopRequested: true,
        summary: reportSummary(task),
        measurements: modelMeasurements(task.events),
        executionMeasurements: executionMeasurements(task),
        acceptance: documentAcceptance(task),
      });
    } catch {
      return res.status(500).json({ error: '停止任务失败' });
    }
  });
  return router;
}
