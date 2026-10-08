import express from 'express';
import { DataTypes } from 'sequelize';
import { environmentIssues, executionIssues } from '../../agent/execution.js';
import { environmentVariables } from '../../agent/plan.js';
import authMiddleware from '../../middleware/auth.js';
import editableMiddleware from '../../middleware/verifyEditable.js';
import defineCase from '../../models/cases.js';
import defineRun from '../../models/runs.js';
import tasksRoute from './tasks.js';

export default function (sequelize) {
  const router = express.Router();
  const { verifySignedIn } = authMiddleware(sequelize);
  const { verifyProjectDeveloperFromCaseId, verifyProjectManagerFromRunId, verifyProjectReporterFromRunId } =
    editableMiddleware(sequelize);
  const Case = defineCase(sequelize, DataTypes);
  const Run = defineRun(sequelize, DataTypes);
  router.use(verifySignedIn);
  router.use(tasksRoute(sequelize));
  router.param('caseId', (req, res, next, value) =>
    /^[1-9]\d*$/.test(value) ? next() : res.status(400).json({ error: '用例编号无效' })
  );
  router.param('runId', (req, res, next, value) =>
    /^[1-9]\d*$/.test(value) ? next() : res.status(400).json({ error: '测试运行编号无效' })
  );

  router.put(
    '/cases/:caseId/execution',
    (req, res, next) => verifyProjectDeveloperFromCaseId(req, res, next).catch(next),
    async (req, res) => {
      const executionInfo = req.body?.executionInfo;
      if (
        executionInfo !== null &&
        (!executionInfo ||
          typeof executionInfo !== 'object' ||
          Array.isArray(executionInfo) ||
          JSON.stringify(executionInfo).length > 64000)
      ) {
        return res
          .status(400)
          .json({ error: '执行信息必须是 JSON 对象（最多 64000 字符），或 null 以取消接口执行配置' });
      }
      try {
        await Case.update({ executionInfo }, { where: { id: req.params.caseId } });
        return res.json({ executionInfo, issues: executionIssues(executionInfo) });
      } catch {
        return res.status(500).json({ error: '保存接口执行信息失败' });
      }
    }
  );

  router.get(
    '/runs/:runId/environment',
    (req, res, next) => verifyProjectReporterFromRunId(req, res, next).catch(next),
    async (req, res) => {
      try {
        const run = await Run.findByPk(req.params.runId);
        return res.json({
          environment: run.agentEnvironment || {},
          issues: [
            ...environmentIssues(run.agentEnvironment),
            ...environmentVariables(run.agentEnvironment || {}, run.projectId).issues,
          ],
        });
      } catch {
        return res.status(500).json({ error: '读取测试环境失败' });
      }
    }
  );

  router.put(
    '/runs/:runId/environment',
    (req, res, next) => verifyProjectManagerFromRunId(req, res, next).catch(next),
    async (req, res) => {
      const environment = req.body?.environment;
      if (
        !environment ||
        typeof environment !== 'object' ||
        Array.isArray(environment) ||
        JSON.stringify(environment).length > 16000
      ) {
        return res.status(400).json({ error: '测试环境必须是 JSON 对象（最多 16000 字符）' });
      }
      // Authentication uses backend secret references, so credentials never need to be returned to the client.
      const fields = { ...(environment.headers || {}), ...(environment.variables || {}) };
      if (
        Object.entries(fields).some(
          ([key, value]) =>
            /authorization|cookie|password|secret|token|api[-_]?key/i.test(key) &&
            (typeof value !== 'string' || !/^(Bearer |Basic )?\{\{[A-Za-z_][A-Za-z0-9_]*\}\}$/.test(value))
        )
      ) {
        return res
          .status(400)
          .json({ error: '认证值请使用 {{变量名}}，并在后端 TEST_AGENT_SECRET_变量名 中配置真实值' });
      }
      try {
        const run = await Run.findByPk(req.params.runId);
        const secretIssues = environmentVariables(environment, run.projectId).issues;
        if (secretIssues.length) return res.status(400).json({ error: secretIssues.join('；') });
        const agentEnvironment = Object.fromEntries(
          ['baseUrl', 'headers', 'variables', 'secretVariables', 'timeoutMs']
            .filter((key) => Object.hasOwn(environment, key))
            .map((key) => [key, environment[key]])
        );
        await Run.update({ agentEnvironment }, { where: { id: req.params.runId } });
        return res.json({ environment: agentEnvironment, issues: environmentIssues(agentEnvironment) });
      } catch {
        return res.status(500).json({ error: '保存测试环境失败' });
      }
    }
  );
  return router;
}
