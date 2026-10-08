# 权限、凭据与测试判定修复

2026-10-08，在 `codex/test-agent` 分支逐项修复本轮评审问题，并按功能提交中文 Conventional Commits。

## 修复与回归覆盖

| 问题 | 修复后的行为 | 回归测试 |
| --- | --- | --- |
| 移动其他项目的私有用例 | 来源用例和目标目录均须属于已授权项目；混合批次整体拒绝。普通编辑不能修改归属，复制入口使用相同边界 | `backend/routes/cases/transfer.test.js` |
| 跨项目借用认证密钥 | 管理员在后端配置项目与密钥名称的授权；默认拒绝。执行时根据数据库中运行的真实项目重新校验，客户端项目编号无效 | `backend/agent/plan.test.js`、`runner.test.js`、`backend/routes/agent/index.test.js` |
| Token 经断言 actual 泄露 | 先用原值判断断言，再统一脱敏请求、响应和断言。覆盖没有提取 Token、显式 secret:false 两种情况；检查数据库和模型消息 | `backend/agent/runner.test.js` |
| 普通报告暴露认证配置 | 配置保存拒绝敏感字段中的明文，保留变量引用；模型提出的明文配置脱敏并要求补充。旧配置通过模型 getter 统一保护读取，覆盖公开项目普通 JSON 报告 | `backend/routes/agent/index.test.js`、`tasks.test.js`、`backend/routes/runs/agent-report.test.js`、`backend/agent/runner.test.js` |
| 复制后依赖旧用例 | 同一事务创建全部用例后，映射组内 dependsOn；目录复制覆盖整个子树。未复制的外部依赖保留原编号 | `backend/routes/cases/transfer.test.js` |
| 认证头大小写冲突 | 不区分大小写合并请求头，用例值覆盖环境值；实际 HTTP 验证只发送一份认证值 | `backend/agent/execution.test.js` |
| 数组内部属性假通过 | 数组 JSON Pointer 仅接受合法、存在的非负整数索引，拒绝 length、前导零、负数等；对象字段与转义仍正常 | `backend/agent/execution.test.js` |
| 基线计时混入写盘 | HTTP 与断言分别计时后再写检查点；注入两次各 1 秒写盘，验证 25 ms 请求不会记成 2025 ms | `business/baseline-study.test.js` |
| 准备失败不能恢复 | 分别保存运行编号与环境配置完成状态；环境保存失败后重跑继续配置同一运行 | `business/prepare.test.js` |

移动和复制沿用界面现有的同项目操作范围，不增加跨项目转移功能。运行的普通编辑接口也不能修改项目归属或绕过管理者权限修改 Agent 环境。

## 旧配置迁移

固定凭据改为后端变量，并显式授权给需要使用的项目。例如以下值是配置示意，不是真实密钥：

```dotenv
TEST_AGENT_SECRET_API_TOKEN=replace-with-local-secret
TEST_AGENT_SECRET_GRANTS={"10":["API_TOKEN"]}
```

运行环境填写 `secretVariables: ["API_TOKEN"]`，用例认证头使用 `Bearer {{API_TOKEN}}`。修改后重启后端加载授权。缺少授权的旧任务也会被阻止执行。

旧配置读取时显示 `[REDACTED]`，需要改成变量引用再保存；不能将这个占位值用于执行。本轮没有批量改写历史数据库、备份或已经导出的文件，也不声称历史明文已被清除。脱敏依据认证字段名称及执行中已知的敏感值，不是任意文本的秘密识别器。

演示初始化已适配：先运行 `npm run demo:seed --prefix backend`，再启动或重启后端。浏览器测试读取这次初始化的编号。业务准备会先写入项目授权；首次环境配置若失败，重启后端后重跑 `node business/prepare.mjs`，继续使用已创建的运行。

## 验证结果

- 全仓库 **293 项测试、64 个测试文件通过**，其中原有 265 项、新增 28 项。
- 后端生产构建和前端 TypeScript 检查通过。
- 完整浏览器流程使用真实模型、HTTP 和 PostgreSQL，覆盖补充信息、双重确认、结果回填、历史查看、Excel 下载和四种窗口宽度。
- 浏览器演示的预设结果为 **3 通过、4 失败、1 未执行**，其中 2 条为故意制造的请求异常；这不是回归测试失败。

最终实测为项目 **#19**、运行 **#18**、任务 **#45**。直接读取 PostgreSQL 的原始任务字段，确认没有保存演示密码或 Token 明文；摘要与计量见 [review-fixes-check.json](verification/review-fixes-check.json)。

验证命令：

```powershell
npx vitest run
npm run build --prefix backend
# 在 frontend 目录
npx tsc --noEmit
# 返回仓库根目录
cd ..
# 初始化演示并重启后端，启动前端和 demo/server.mjs 后
$env:PLAYWRIGHT_CHANNEL='chromium'
npx playwright test --config playwright.agent.config.ts e2e/agent.spec.ts
```

## 实验计时修正

[修正后的对比表](../business/evidence/business-2026-10-08T03-35-27-848Z/comparison-timing-v2.md)从原始 `script_http`、`script_assertions` 步骤日志重新汇总。三轮基线 HTTP/断言耗时为 **287、349、333 ms**，原记录为 287、365、347 ms。各步骤取整至毫秒，第一轮修正前后相同不能说明写盘无成本。

原始 JSON、Excel 和旧对比表均保留；本次是计时口径修正，没有重新执行三轮业务实验。脚本操作时间仍不能换算为真实测试人员效率提升比例。

## 本地服务恢复记录

恢复工作时 Docker Desktop 再次报 `dockerInference` 无法访问，`fsutil` 对该 socket 返回错误 1920。停止 Docker 进程后，将只含运行时 socket 的目录改名保留：`%LOCALAPPDATA%/Docker/run.stale-20261008-200013`、`%LOCALAPPDATA%/docker-secrets-engine.stale-20261008-200013`，再启动 Docker 和现有 PostgreSQL 容器。没有执行恢复出厂设置或删除数据库卷。

最终容器健康，前端 8010、后端 8011、演示服务 4010、数据库 5433 均已启动。该处理恢复了本次运行，不代表彻底解决 Docker 的 socket 生命周期问题；相似错误见 [Docker 反馈记录 #625](https://github.com/docker/desktop-feedback/issues/625)。
