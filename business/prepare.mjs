import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { executionConfig } from './execution-config.mjs';

const envPath = new URL('../backend/.env', import.meta.url);
const env = parseEnv(readFileSync(envPath, 'utf8'));
const baseUrl = `http://localhost:${env.PORT || 8001}`;
const statePath = new URL('.env.study.json', import.meta.url);
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : {
      studyId: `business-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      email: `business-${Date.now()}@local`,
      password: randomBytes(24).toString('base64url'),
      caseIds: [],
      agentRunIds: [],
      baselineRunIds: [],
    };
writeFileSync(statePath, JSON.stringify(state, null, 2));
let accessToken;
async function api(path, method = 'GET', body) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      `${method} ${path}: HTTP ${response.status}` +
        (method === 'PUT' && path.endsWith('/environment')
          ? '；若刚更新项目密钥授权，请重启后端后重跑准备脚本，已创建的运行会继续配置'
          : '')
    );
  return response.json();
}
accessToken = (
  await api('/users/signin', 'POST', {
    email: env.ADMIN_EMAIL || 'admin666@local',
    password: env.ADMIN_PASSWORD || '666666',
  })
).access_token;
if (!state.userId) {
  const created = await api('/users', 'POST', {
    email: state.email,
    username: state.studyId,
    password: state.password,
    role: 1,
  });
  state.userId = created.user.id;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}
accessToken = (await api('/users/signin', 'POST', { email: state.email, password: state.password })).access_token;
if (!state.projectId) {
  state.projectId = (
    await api('/projects', 'POST', {
      name: `${state.studyId} 对照研究`,
      detail: '独立测试数据；业务用例与报告管理项目',
      isPublic: false,
    })
  ).id;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}
if (!state.folderId) {
  state.folderId = (
    await api(`/folders?projectId=${state.projectId}`, 'POST', { name: '实际业务接口验收', parentFolderId: null })
  ).id;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}
const fixtures = JSON.parse(readFileSync(new URL('cases.json', import.meta.url), 'utf8'));
for (const fixture of fixtures) {
  if (state.caseIds[fixture.id - 1]) continue;
  const item = await api(`/cases?folderId=${state.folderId}`, 'POST', {
    title: fixture.title,
    description: '规则来源：business/README.md 与 cases.json；独立业务数据',
    expectedResults: fixture.expectedResults,
    preConditions: '独立账号可用，按 dependsOn 执行前置；故障注入用例用于控制实验。',
    state: 0,
    priority: 1,
    type: 0,
    automationStatus: 0,
    template: 0,
  });
  state.caseIds[fixture.id - 1] = item.id;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}
if (!state.configured) {
  for (const fixture of fixtures) {
    const executionInfo = executionConfig(fixture, state.caseIds);
    await api(`/agent/cases/${state.caseIds[fixture.id - 1]}/execution`, 'PUT', {
      executionInfo: fixture.id === 5 ? null : executionInfo,
    });
  }
  state.configured = true;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}
let envText = readFileSync(envPath, 'utf8');
const grants = JSON.parse(env.TEST_AGENT_SECRET_GRANTS || '{}');
if (!grants || typeof grants !== 'object' || Array.isArray(grants)) throw new Error('项目密钥授权配置必须是 JSON 对象');
grants[state.projectId] = [...new Set([...(grants[state.projectId] || []), 'BIZ_PASSWORD', 'BIZ_WRONG_PASSWORD'])];
const allowed = [...new Set([...(env.TEST_AGENT_ALLOWED_ORIGINS || '').split(',').filter(Boolean), baseUrl])];
for (const [name, value] of Object.entries({
  TEST_AGENT_ALLOWED_ORIGINS: allowed.join(','),
  TEST_AGENT_SECRET_BIZ_PASSWORD: state.password,
  TEST_AGENT_SECRET_BIZ_WRONG_PASSWORD:
    fixtures.find((item) => item.id === 6)?.executionInfo.body.password || 'deliberately-wrong-password',
  TEST_AGENT_SECRET_GRANTS: JSON.stringify(grants),
})) {
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  envText = pattern.test(envText)
    ? envText.replace(pattern, () => `${name}=${value}`)
    : `${envText.trimEnd()}\n${name}=${value}\n`;
}
writeFileSync(envPath, envText);
for (const mode of ['agent', 'baseline']) {
  for (let round = 1; round <= (mode === 'agent' && process.argv.includes('--reuse-check') ? 4 : 3); round++) {
    const ids = state[`${mode}RunIds`];
    if (!ids[round - 1]) {
      const run = await api(`/runs?projectId=${state.projectId}`, 'POST', {
        name: `${mode === 'agent' ? 'Agent' : '脚本模拟逐条流程'} 第${round}轮`,
        state: 0,
        caseIds: state.caseIds,
        configurations: '本地真实平台业务接口',
        description: '首次与回归分组，非真实人员效率数据',
      });
      ids[round - 1] = run.id;
      writeFileSync(statePath, JSON.stringify(state, null, 2));
    }
    state.configuredRunIds ||= [];
    if (mode === 'agent' && !state.configuredRunIds.includes(ids[round - 1])) {
      const current = await api(`/agent/runs/${ids[round - 1]}/environment`);
      if (!Object.keys(current.environment || {}).length)
        await api(`/agent/runs/${ids[round - 1]}/environment`, 'PUT', {
          environment: {
            baseUrl,
            timeoutMs: 5000,
            variables: { BIZ_EMAIL: state.email, BIZ_PROJECT_NAME: `${state.studyId}-${mode}-${round}` },
            secretVariables: ['BIZ_PASSWORD', 'BIZ_WRONG_PASSWORD'],
          },
        });
      state.configuredRunIds.push(ids[round - 1]);
      writeFileSync(statePath, JSON.stringify(state, null, 2));
    }
  }
}
console.log(
  JSON.stringify(
    {
      studyId: state.studyId,
      projectId: state.projectId,
      caseIds: state.caseIds,
      agentRunIds: state.agentRunIds,
      baselineRunIds: state.baselineRunIds,
      credentials: '仅保存在忽略文件 business/.env.study.json 与后端环境；请重启后端加载环境',
    },
    null,
    2
  )
);
