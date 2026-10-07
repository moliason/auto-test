import { Sequelize, DataTypes } from 'sequelize';
import defineUser from '../models/users.js';
import defineProject from '../models/projects.js';
import defineFolder from '../models/folders.js';
import defineCase from '../models/cases.js';
import defineStep from '../models/steps.js';
import defineCaseStep from '../models/caseSteps.js';
import defineMember from '../models/members.js';
import defineRun from '../models/runs.js';
import defineRunCase from '../models/runCases.js';
import defineAgentTask from '../models/agentTasks.js';

export async function createAgentDatabase() {
  const db = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const User = defineUser(db, DataTypes),
    Project = defineProject(db, DataTypes),
    Folder = defineFolder(db, DataTypes);
  const Case = defineCase(db, DataTypes),
    Run = defineRun(db, DataTypes),
    Member = defineMember(db, DataTypes);
  defineStep(db, DataTypes);
  defineCaseStep(db, DataTypes);
  defineRunCase(db, DataTypes);
  defineAgentTask(db, DataTypes);
  Project.rawAttributes.userId.references.model = 'users';
  Folder.rawAttributes.projectId.references.model = 'projects';
  Folder.rawAttributes.parentFolderId.references.model = 'folders';
  Case.rawAttributes.folderId.references.model = 'folders';
  Run.rawAttributes.projectId.references.model = 'projects';
  await db.sync();
  await db.getQueryInterface().addIndex('agentTasks', ['runId'], { unique: true, where: { state: 'running' } });
  await User.bulkCreate(
    [1, 2, 3, 4].map((id) => ({ id, email: `${id}@example.test`, password: 'unused', username: `User ${id}`, role: 1 }))
  );
  await Project.bulkCreate([
    { id: 1, name: 'Own project', userId: 1, isPublic: false },
    { id: 2, name: 'Other project', userId: 2, isPublic: false },
  ]);
  await Folder.bulkCreate([
    { id: 1, name: 'Own folder', projectId: 1 },
    { id: 2, name: 'Other folder', projectId: 2 },
  ]);
  await Run.bulkCreate([1, 2].map((id) => ({ id, projectId: id, name: `Test run ${id}`, state: 0 })));
  await Member.bulkCreate([
    { userId: 3, projectId: 1, role: 2 },
    { userId: 4, projectId: 1, role: 1 },
  ]);
  return db;
}
