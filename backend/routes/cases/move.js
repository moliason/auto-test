import express from 'express';
import { DataTypes } from 'sequelize';
import defineCase from '../../models/cases.js';
import defineFolder from '../../models/folders.js';
import authMiddleware from '../../middleware/auth.js';
import editableMiddleware from '../../middleware/verifyEditable.js';

export default function (sequelize) {
  const router = express.Router();
  const { verifySignedIn } = authMiddleware(sequelize);
  const { verifyProjectDeveloperFromProjectId } = editableMiddleware(sequelize);
  const Case = defineCase(sequelize, DataTypes);
  const Folder = defineFolder(sequelize, DataTypes);

  router.put('/move', verifySignedIn, verifyProjectDeveloperFromProjectId, async (req, res) => {
    const { caseIds, targetFolderId } = req.body;

    if (!Array.isArray(caseIds) || caseIds.length === 0 || !targetFolderId) {
      return res.status(400).json({ error: 'caseIds(array) and targetFolderId are required' });
    }

    try {
      const cases = await Case.findAll({ where: { id: caseIds } });
      if (cases.length !== caseIds.length) {
        return res.status(404).json({ error: 'Some cases not found' });
      }

      const folders = await Folder.findAll({ where: { id: [...cases.map((item) => item.folderId), targetFolderId] } });
      const target = folders.find((item) => item.id === Number(targetFolderId));
      if (!target) return res.status(404).json({ error: 'Target folder not found' });
      if (
        folders.some((item) => item.projectId !== Number(req.query.projectId)) ||
        cases.some((item) => !folders.some((folder) => folder.id === item.folderId))
      )
        return res.status(403).json({ error: 'Source cases and target folder must belong to the authorized project' });

      await Case.update(
        { folderId: targetFolderId },
        { where: { id: caseIds, folderId: cases.map((item) => item.folderId) } }
      );

      res.status(200).json({ message: 'Cases moved successfully', movedCaseIds: caseIds, targetFolderId });
    } catch (error) {
      console.error('Error moving cases:', error);
      res.status(500).send('Internal Server Error');
    }
  });

  return router;
}
