import express from 'express';
import { DataTypes } from 'sequelize';
import defineRunCase from '../../models/runCases.js';
import defineRun from '../../models/runs.js';
import defineCase from '../../models/cases.js';
import defineFolder from '../../models/folders.js';
import authMiddleware from '../../middleware/auth.js';
import editableMiddleware from '../../middleware/verifyEditable.js';

export default function (sequelize) {
  const router = express.Router();
  const { verifySignedIn } = authMiddleware(sequelize);
  const { verifyProjectReporterFromRunId } = editableMiddleware(sequelize);
  const RunCase = defineRunCase(sequelize, DataTypes);
  const Run = defineRun(sequelize, DataTypes);
  const Case = defineCase(sequelize, DataTypes);
  const Folder = defineFolder(sequelize, DataTypes);
  Case.belongsTo(Folder, { foreignKey: 'folderId' });

  router.post('/include', verifySignedIn, verifyProjectReporterFromRunId, async (req, res) => {
    const { caseIds } = req.body ?? {};
    if (!Array.isArray(caseIds) || !caseIds.length || caseIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      return res.status(400).json({ error: 'caseIds must be a non-empty array of positive integers' });
    }
    const selectedIds = [...new Set(caseIds)];
    try {
      await sequelize.transaction(async (transaction) => {
        const run = await Run.findByPk(req.query.runId, { transaction });
        if (!run) throw Object.assign(new Error('Run not found'), { status: 404 });
        const cases = await Case.findAll({
          attributes: ['id'],
          where: { id: selectedIds },
          include: [{ model: Folder, attributes: [], where: { projectId: run.projectId }, required: true }],
          transaction,
        });
        if (cases.length !== selectedIds.length) {
          throw Object.assign(new Error('Some selected cases are missing or belong to another project'), {
            status: 400,
          });
        }
        // The unique (runId, caseId) index also handles concurrent/repeated submissions without resetting results.
        await RunCase.bulkCreate(
          selectedIds.map((caseId) => ({ runId: run.id, caseId, status: 0 })),
          {
            transaction,
            ignoreDuplicates: true,
          }
        );
      });
      res.json({ success: true });
    } catch (error) {
      if (error.status === 400 || error.status === 404) return res.status(error.status).json({ error: error.message });
      console.error('Error adding cases to run:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.post('/update', verifySignedIn, verifyProjectReporterFromRunId, async (req, res) => {
    const runId = req.query.runId;
    const runCases = req.body;
    if (
      !Array.isArray(runCases) ||
      runCases.some(
        (item) =>
          !item ||
          !Number.isSafeInteger(item.caseId) ||
          item.caseId < 1 ||
          !['new', 'deleted', 'changed', 'notChanged'].includes(item.editState) ||
          (item.editState !== 'new' &&
            !(item.editState === 'deleted' && item.id === -1) &&
            (!Number.isSafeInteger(item.id) || item.id < 1)) ||
          (item.editState !== 'deleted' && (!Number.isInteger(item.status) || item.status < 0 || item.status > 4))
      )
    )
      return res.status(400).json({ error: '运行用例或状态格式无效' });

    try {
      const results = await sequelize.transaction(async (transaction) => {
        const run = await Run.findByPk(runId, { transaction });
        const ids = [...new Set(runCases.map((item) => item.caseId))];
        const count = await Case.count({
          where: { id: ids },
          include: [{ model: Folder, where: { projectId: run.projectId }, required: true }],
          transaction,
        });
        if (count !== ids.length) throw Object.assign(new Error('用例不属于当前项目'), { status: 400 });
        const results = [];
        for (const item of runCases) {
          // A case selected and then deselected before saving has never been persisted.
          if (item.editState === 'deleted' && item.id === -1) continue;
          if (item.editState === 'new') {
            results.push(
              await RunCase.create(
                { runId, caseId: item.caseId, status: item.status, executionSource: 'manual', agentTaskId: null },
                { transaction }
              )
            );
            continue;
          }
          const saved = await RunCase.findOne({
            where: { id: item.id, runId, caseId: item.caseId },
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          if (!saved) throw Object.assign(new Error('运行用例已变化或不属于当前运行，请重新加载'), { status: 409 });
          if (item.editState === 'deleted') await saved.destroy({ transaction });
          else {
            if (item.editState === 'changed')
              await saved.update(
                { status: item.status, executionSource: 'manual', agentTaskId: null },
                { transaction }
              );
            results.push(saved);
          }
        }
        return results;
      });
      res.json(results);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error('Failed to update run cases');
      res.status(500).send('Internal Server Error');
    }
  });

  return router;
}
