# 开发与验收记录

目标是完整的“已有用例 → Agent 准备 → 人工确认 → 真实接口执行 → 原任务状态回填 → 查看与导出报告”，不是仅完成 AI 生成草稿。

## 已完成并有证据的部分（2026-10-07）

- 毕设仓库 `auto-test` 原提交 `5106096` 仍保留，工作分支 `codex/test-agent`。平台源码复制自 Test-platfrom，来源、GPL 许可和版权保留。
- 没有复制源项目 `.git`、依赖、构建产物、真实 `.env`；目标依赖重新安装，本地 `.env` 独立生成且由 Git 忽略。
- 独立数据库容器 `auto-test-postgres-1`，端口 5433；26 条迁移已应用。新增用例执行信息、任务环境、Agent 任务及结果来源字段。
- HTTP 执行器：方法/路径/头/查询/JSON 请求体；状态码、JSON 字段存在和严格相等断言；JSON Pointer、变量提取与引用；超时/断连、响应体上限、禁止自动重定向、证据脱敏。
- 13 项执行器测试使用真实本地 HTTP 服务。27 项已有草稿功能测试通过。4 项配置权限测试覆盖未登录、跨项目、角色限制、原文字信息保留和认证值不能明文提交。
- 执行配置后端接口已注册：`PUT /agent/cases/:caseId/execution`；测试环境 `GET/PUT /agent/runs/:runId/environment`。允许保存不完整配置，并返回明确缺失项，尚未接入新前端配置界面。
- 共享模型客户端支持官方地址和后端配置的兼容代理。用户提供的本地代理已实测返回 `record_check` 工具调用；实际模型为 `gpt-6.1-sol`，这不代表 DeepSeek 官方 Agent 联调完成。真实凭据仅在被忽略的本地 `.env`，不写在文档里。

## 仍需完成（不得提前宣称目标达成）

1. 计划整理与编辑：读取已选运行用例和接口说明，校验依赖/变量/业务缺口，保存快照，人工确认后才能执行。
2. Agent 工具循环：受控 `read_cases`、`execute_case`、`get_results`、报告工具，模型参数校验、调用次数/总时间上限、明确状态与工具记录、失败保留证据、服务重启恢复。
3. 执行结果逐条持久化并回填 `runCases`，前置失败时明确跳过；重复任务保留历史；人工更新须设置人工来源并保持项目范围检查。
4. 运行页面选择用例、环境与用例执行配置、计划确认、状态轮询、报告与历史 UI。沿用平台组件和现有权限。
5. Excel 报告扩展：环境、范围、时间、程序统计、每条断言与请求响应证据、AI 推测标签；支持选择此前执行的报告。
6. 演示用例和初始化脚本：覆盖正常、已知缺陷、未填配置、超时、断连及前置失败。示例 HTTP 服务已在 `demo/server.mjs`。
7. 集成/权限/历史/导出测试，浏览器完整演示；完成前后端构建及所需检查。复制的平台存在几个前端旧测试类型错误，需要为构建消除，不能忽略后宣称全项目类型检查通过。
8. 最终 README 改为完整启动、管理员初始化、模型配置、演示与报告步骤；逐项审计用户的 10 条验收标准。

## 当前实现约定

- 执行信息：`method`, `path`, `headers`, `query`, `body`, `assertions`, `extract`, `dependsOn`, `requiredVariables`, `preconditions`。
- 断言：`{type:"status",expected:200}`、`{type:"jsonExists",path:"/token"}`、`{type:"jsonEquals",path:"/id",expected:7}`。
- 提取：`{name:"TOKEN",path:"/token",secret:true}`；ID 等非敏感提取应显式 `secret:false`。
- 环境：`baseUrl`, `headers`, `variables`, `secretVariables`, `timeoutMs`。认证变量由后端 `TEST_AGENT_SECRET_<名称>` 解析（任务调度阶段接入）。
- 现阶段请求上限 30 秒，响应上限 1 MiB。任务整体时间/模型调用限制尚待接入。
- 权限：开发者及以上配置用例，项目管理者配置环境，报告者及以上读取本项目环境；后续任务执行沿用报告者权限。
- 默认官方模型为 `deepseek-flash`，接入依据：[官方工具调用说明](https://api-docs.deepseek.com/guides/tool_calls/)。
