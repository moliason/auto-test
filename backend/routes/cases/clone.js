import express from 'express';
import { DataTypes } from 'sequelize';
import defineCase from '../../models/cases.js';
import defineFolder from '../../models/folders.js';
import defineStep from '../../models/steps.js';
import defineCaseStep from '../../models/caseSteps.js';
import authMiddleware from '../../middleware/auth.js';
import editableMiddleware from '../../middleware/verifyEditable.js';
import { getNextProjectCaseNo } from '../../utils/caseNumber.js';

export default function (sequelize) {
  const router = express.Router();
  const { verifySignedIn } = authMiddleware(sequelize);
  const { verifyProjectDeveloperFromProjectId } = editableMiddleware(sequelize);
  const Case = defineCase(sequelize, DataTypes);
  const Folder = defineFolder(sequelize, DataTypes);
  const Step = defineStep(sequelize, DataTypes);
  const CaseStep = defineCaseStep(sequelize, DataTypes);
  Case.belongsToMany(Step, { through: 'caseSteps', foreignKey: 'caseId', otherKey: 'stepId' });
  Step.belongsToMany(Case, { through: 'caseSteps', foreignKey: 'stepId', otherKey: 'caseId' });

  router.post('/clone', verifySignedIn, verifyProjectDeveloperFromProjectId, async (req, res) => {
    const { caseIds, targetFolderId } = req.body;

    if (!Array.isArray(caseIds) || caseIds.length === 0 || !targetFolderId) {
      return res.status(400).json({ error: 'caseIds(array) and targetFolderId are required' });
    }

    try {
      const caseRecords = await Case.findAll({
        where: { id: caseIds },
        include: [{ model: Step, through: { attributes: ['stepNo'] } }],
      });

      if (caseRecords.length !== caseIds.length) {
        return res.status(404).json({ error: 'Some cases not found' });
      }

      const folders = await Folder.findAll({
        where: { id: [...caseRecords.map((item) => item.folderId), targetFolderId] },
      });
      if (!folders.some((item) => item.id === Number(targetFolderId)))
        return res.status(404).json({ error: 'Target folder not found' });
      if (
        folders.some((item) => item.projectId !== Number(req.query.projectId)) ||
        caseRecords.some((item) => !folders.some((folder) => folder.id === item.folderId))
      )
        return res.status(403).json({ error: 'Source cases and target folder must belong to the authorized project' });

      const cases = caseRecords.map((c) => c.get({ plain: true }));

      const clonedCases = cases.map((c) => {
        // eslint-disable-next-line no-unused-vars
        const { id: _id, caseNo: _caseNo, createdAt: _createdAt, updatedAt: _updatedAt, ...clonedCase } = c;
        return { ...clonedCase, folderId: targetFolderId };
      });

      await sequelize.transaction(async (t) => {
        const copied = new Map();
        let nextCaseNo = await getNextProjectCaseNo(sequelize, Folder, targetFolderId, t);
        for (const [index, c] of clonedCases.entries()) {
          const newCase = await Case.create({ ...c, caseNo: nextCaseNo }, { transaction: t });
          copied.set(cases[index].id, newCase);
          nextCaseNo += 1;

          if (c.Steps) {
            const clonedSteps = c.Steps.map((s) => {
              // eslint-disable-next-line no-unused-vars
              const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...clonedStep } = s;
              return clonedStep;
            });

            const newStep = await Step.bulkCreate(clonedSteps, { transaction: t });
            const newCaseSteps = newStep.map((step, index) => ({
              caseId: newCase.id,
              stepId: step.id,
              stepNo: clonedSteps[index].caseSteps.stepNo,
            }));

            await CaseStep.bulkCreate(newCaseSteps, { transaction: t });
          }
        }
        for (const item of copied.values()) {
          if (Array.isArray(item.executionInfo?.dependsOn))
            await item.update(
              {
                executionInfo: {
                  ...item.executionInfo,
                  dependsOn: item.executionInfo.dependsOn.map((id) => copied.get(id)?.id ?? id),
                },
              },
              { transaction: t }
            );
        }
      });

      res.status(200).json({ message: 'Cases cloned successfully' });
    } catch (error) {
      console.error('Error cloning cases:', error);
      res.status(500).send('Internal Server Error');
    }
  });

  return router;
}
