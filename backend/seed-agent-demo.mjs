import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { Sequelize, DataTypes } from 'sequelize';
import bcrypt from 'bcrypt';
import { getSequelizeConfig } from './config/config.js';
import defineUser from './models/users.js';
import defineProject from './models/projects.js';
import defineFolder from './models/folders.js';
import defineCase from './models/cases.js';
import defineStep from './models/steps.js';
import defineCaseStep from './models/caseSteps.js';
import defineRun from './models/runs.js';
import defineRunCase from './models/runCases.js';

const config = getSequelizeConfig();
const db = config.use_env_variable
  ? new Sequelize(process.env[config.use_env_variable], { ...config, logging: false })
  : new Sequelize({ ...config, logging: false });
const User = defineUser(db, DataTypes),
  Project = defineProject(db, DataTypes),
  Folder = defineFolder(db, DataTypes);
const Case = defineCase(db, DataTypes),
  Step = defineStep(db, DataTypes),
  CaseStep = defineCaseStep(db, DataTypes);
const Run = defineRun(db, DataTypes),
  RunCase = defineRunCase(db, DataTypes);
const fixtures = JSON.parse(readFileSync(new URL('../demo/cases.json', import.meta.url), 'utf8'));
try {
  const envPath = new URL('.env', import.meta.url);
  let envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const grants = JSON.parse(parseEnv(envText).TEST_AGENT_SECRET_GRANTS || process.env.TEST_AGENT_SECRET_GRANTS || '{}');
  if (!grants || typeof grants !== 'object' || Array.isArray(grants))
    throw new Error('项目密钥授权配置必须是 JSON 对象');
  const email = process.env.ADMIN_EMAIL || 'admin666@local';
  const username = process.env.ADMIN_USERNAME || 'admin666';
  const [user, created] = await User.findOrCreate({
    where: { email },
    defaults: {
      username,
      email,
      password: await bcrypt.hash(process.env.ADMIN_PASSWORD || '666666', 10),
      role: 0,
      locale: 'zh-CN',
    },
  });
  const output = await db.transaction(async (transaction) => {
    // A fresh project makes every demonstration repeatable without modifying existing work or evidence.
    const project = await Project.create(
      { name: `Agent 接口演示 ${new Date().toISOString()}`, userId: user.id, isPublic: false },
      { transaction }
    );
    const folder = await Folder.create({ name: '接口回归演示', projectId: project.id }, { transaction });
    const cases = [];
    for (const fixture of fixtures) {
      const executionInfo = structuredClone(fixture.executionInfo);
      if (executionInfo?.body?.password)
        executionInfo.body.password = fixture.id === 1 ? '{{DEMO_PASSWORD}}' : '{{DEMO_WRONG_PASSWORD}}';
      const item = await Case.create(
        {
          folderId: folder.id,
          caseNo: fixture.id,
          title: fixture.title,
          description: '本地 HTTP 接口测试演示用例',
          preConditions: fixture.preConditions,
          expectedResults: fixture.expectedResults,
          state: 0,
          priority: 2,
          type: 0,
          automationStatus: 1,
          template: 1,
          executionInfo,
        },
        { transaction }
      );
      const step = await Step.create(
        {
          step: fixture.executionInfo
            ? `${fixture.executionInfo.method} ${fixture.executionInfo.path}`
            : '调用健康检查接口，地址需人工补充',
          result: fixture.expectedResults,
        },
        { transaction }
      );
      await CaseStep.create({ caseId: item.id, stepId: step.id, stepNo: 1 }, { transaction });
      cases.push(item);
    }
    for (let index = 0; index < fixtures.length; index++) {
      const executionInfo = cases[index].executionInfo;
      if (executionInfo?.dependsOn)
        await cases[index].update(
          {
            executionInfo: {
              ...executionInfo,
              dependsOn: executionInfo.dependsOn.map((id) => cases[fixtures.findIndex((item) => item.id === id)].id),
            },
          },
          { transaction }
        );
    }
    const run = await Run.create(
      {
        name: 'Agent 接口回归验收',
        description: '8 条示例：通过、断言失败、超时、断连、依赖跳过及缺失信息',
        projectId: project.id,
        state: 0,
        agentEnvironment: {
          baseUrl: 'http://127.0.0.1:4010',
          timeoutMs: 500,
          secretVariables: ['DEMO_PASSWORD', 'DEMO_WRONG_PASSWORD'],
        },
      },
      { transaction }
    );
    await RunCase.bulkCreate(
      cases.map((item) => ({ runId: run.id, caseId: item.id, status: 0 })),
      { transaction }
    );
    return { projectId: project.id, runId: run.id, caseIds: cases.map((item) => item.id), missingCaseId: cases[7].id };
  });
  grants[output.projectId] = ['DEMO_PASSWORD', 'DEMO_WRONG_PASSWORD'];
  for (const [name, value] of Object.entries({
    TEST_AGENT_SECRET_GRANTS: JSON.stringify(grants),
    TEST_AGENT_SECRET_DEMO_PASSWORD: fixtures.find((item) => item.id === 1).executionInfo.body.password,
    TEST_AGENT_SECRET_DEMO_WRONG_PASSWORD: fixtures.find((item) => item.id === 6).executionInfo.body.password,
  })) {
    const pattern = new RegExp(`^${name}=.*$`, 'm');
    envText = pattern.test(envText)
      ? envText.replace(pattern, () => `${name}=${value}`)
      : `${envText.trimEnd()}\n${name}=${value}\n`;
  }
  writeFileSync(envPath, envText);
  writeFileSync(new URL('.env.agent-demo.json', import.meta.url), JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ ...output, username: user.username, userCreated: created }, null, 2));
  console.log('请重启后端加载本项目演示密钥授权；真实值保存在忽略的后端环境文件中。');
  console.log('演示数据已创建。已有用户密码不会被修改。第 8 条用例需补充 GET /plain，断言 HTTP 200。');
} catch (error) {
  console.error('创建演示数据失败，请检查数据库配置及迁移。', error.name);
  process.exitCode = 1;
} finally {
  await db.close();
}
