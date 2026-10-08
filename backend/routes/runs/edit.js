import express from 'express';
import { isDeepStrictEqual } from 'node:util';
import { DataTypes } from 'sequelize';
import defineRun from '../../models/runs.js';
import authMiddleware from '../../middleware/auth.js';
import editableMiddleware from '../../middleware/verifyEditable.js';

export default function (sequelize) {
  const router = express.Router();
  const Run = defineRun(sequelize, DataTypes);
  const { verifySignedIn } = authMiddleware(sequelize);
  const { verifyProjectReporterFromRunId } = editableMiddleware(sequelize);

  router.put('/:runId', verifySignedIn, verifyProjectReporterFromRunId, async (req, res) => {
    const runId = req.params.runId;
    const updateRun = req.body;
    try {
      const testrun = await Run.findByPk(runId);
      if (!testrun) {
        return res.status(404).send('Run not found');
      }
      if (
        ['projectId', 'id', 'agentEnvironment'].some(
          (key) => Object.hasOwn(updateRun, key) && !isDeepStrictEqual(updateRun[key], testrun[key])
        )
      )
        return res.status(400).json({ error: '运行归属不能修改；测试环境请使用专用配置接口' });

      delete updateRun.Steps;
      await testrun.update(updateRun);
      res.json(testrun);
    } catch (error) {
      console.error(error);
      res.status(500).send('Internal Server Error');
    }
  });

  return router;
}
