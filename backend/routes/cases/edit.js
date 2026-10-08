import express from 'express';
import { DataTypes } from 'sequelize';
import defineCase from '../../models/cases.js';
import authMiddleware from '../../middleware/auth.js';
import editableMiddleware from '../../middleware/verifyEditable.js';

export default function (sequelize) {
  const router = express.Router();
  const { verifySignedIn } = authMiddleware(sequelize);
  const { verifyProjectDeveloperFromCaseId } = editableMiddleware(sequelize);
  const Case = defineCase(sequelize, DataTypes);

  router.put('/:caseId', verifySignedIn, verifyProjectDeveloperFromCaseId, async (req, res) => {
    const caseId = req.params.caseId;
    const updateCase = req.body;
    try {
      const testcase = await Case.findByPk(caseId);
      if (!testcase) {
        return res.status(404).send('Case not found');
      }
      if (
        ['folderId', 'id', 'caseNo'].some((key) => Object.hasOwn(updateCase, key) && updateCase[key] !== testcase[key])
      )
        return res.status(400).json({ error: '用例归属和编号不能通过普通编辑修改，请使用移动接口' });

      if (updateCase.Steps) {
        delete updateCase.Steps;
      }

      await testcase.update(updateCase);
      res.json(testcase);
    } catch (error) {
      console.error(error);
      res.status(500).send('Internal Server Error');
    }
  });

  return router;
}
