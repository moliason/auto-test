import express from 'express';
import { DataTypes } from 'sequelize';
import defineFolder from '../../models/folders.js';
import defineCase from '../../models/cases.js';
import defineStep from '../../models/steps.js';
import defineCaseStep from '../../models/caseSteps.js';
import authMiddleware from '../../middleware/auth.js';
import editableMiddleware from '../../middleware/verifyEditable.js';
import { getNextProjectCaseNo } from '../../utils/caseNumber.js';

export default function (sequelize) {
  const router = express.Router();
  const { verifySignedIn } = authMiddleware(sequelize);
  const { verifyProjectDeveloperFromFolderId } = editableMiddleware(sequelize);

  const Folder = defineFolder(sequelize, DataTypes);
  const Case = defineCase(sequelize, DataTypes);
  const Step = defineStep(sequelize, DataTypes);
  const CaseStep = defineCaseStep(sequelize, DataTypes);
  Case.belongsTo(Folder);
  Case.belongsToMany(Step, { through: 'caseSteps', foreignKey: 'caseId', otherKey: 'stepId' });
  Step.belongsToMany(Case, { through: 'caseSteps', foreignKey: 'stepId', otherKey: 'caseId' });

  async function _cloneFolderRecursive(sourceFolder, targetParent, transaction, copied) {
    const folderToCreate = {
      name: sourceFolder.name,
      detail: sourceFolder.detail,
      parentFolderId: targetParent.id,
      projectId: targetParent.projectId,
    };

    const clonedFolder = await Folder.create(folderToCreate, { transaction });

    await _cloneCasesAndSteps(sourceFolder.id, clonedFolder.id, transaction, copied);

    const childFolders = await Folder.findAll({
      where: { parentFolderId: sourceFolder.id },
    });

    for (const child of childFolders) {
      await _cloneFolderRecursive(child, clonedFolder, transaction, copied);
    }

    return clonedFolder;
  }

  async function _cloneCasesAndSteps(folderId, targetFolderId, transaction, copied) {
    const folderCases = await Case.findAll({
      where: { folderId },
      include: [{ model: Step, through: { attributes: ['stepNo'] } }],
    });

    if (folderCases.length === 0) return;

    const cases = folderCases.map((c) => c.get({ plain: true }));

    const clonedCases = cases.map((c) => {
      // eslint-disable-next-line no-unused-vars
      const { id: _id, caseNo: _caseNo, createdAt: _createdAt, updatedAt: _updatedAt, ...clonedCase } = c;
      return { ...clonedCase, folderId: targetFolderId };
    });

    let nextCaseNo = await getNextProjectCaseNo(sequelize, Folder, targetFolderId, transaction);
    for (const [index, c] of clonedCases.entries()) {
      const newCase = await Case.create({ ...c, caseNo: nextCaseNo }, { transaction });
      copied.set(cases[index].id, newCase);
      nextCaseNo += 1;

      if (c.Steps && c.Steps.length > 0) {
        const clonedSteps = c.Steps.map((s) => {
          // eslint-disable-next-line no-unused-vars
          const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...clonedStep } = s;
          return clonedStep;
        });

        const newSteps = await Step.bulkCreate(clonedSteps, { transaction });
        const caseSteps = newSteps.map((step, index) => ({
          caseId: newCase.id,
          stepId: step.id,
          stepNo: clonedSteps[index].caseSteps.stepNo,
        }));

        await CaseStep.bulkCreate(caseSteps, { transaction });
      }
    }
  }

  router.post('/:folderId/clone', verifySignedIn, verifyProjectDeveloperFromFolderId, async (req, res) => {
    const folderId = req.params.folderId;
    const { targetFolderId } = req.body;

    try {
      const sourceFolder = await Folder.findByPk(folderId);
      const targetFolder = await Folder.findByPk(targetFolderId);

      if (!sourceFolder || !targetFolder) {
        return res.status(404).send('Folder or target folder not found');
      }
      if (sourceFolder.projectId !== targetFolder.projectId)
        return res.status(403).json({ error: 'Target folder must belong to the authorized project' });

      await sequelize.transaction(async (t) => {
        const copied = new Map();
        await _cloneFolderRecursive(sourceFolder, targetFolder, t, copied);
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

      res.status(201).send({ message: 'Folder cloned successfully' });
    } catch (err) {
      console.error(err);
      res.status(500).send('Internal Server Error');
    }
  });

  return router;
}
