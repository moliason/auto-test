# Auto-test：接口测试 Agent

基于 [Test-platfrom](https://github.com/moliason/Test-platfrom) 的毕业设计。复用项目、用例目录、测试运行、成员权限、进度统计与报告，在原运行页面加入单个接口测试 Agent，减少用例准备、重复请求、结果回填与报告整理的工作。

使用流程：**选中运行内用例 → Agent 整理计划 → 补充缺失信息并确认 → 执行真实 HTTP 请求 → 回填原运行 → 查看历史与导出 Excel**。

## 功能

- 根据文字需求生成用例草稿，人工编辑和审核后保存到原用例目录。
- 为文字用例补充 HTTP 方法、路径、请求头、查询参数、JSON 请求体、前置条件和断言，保留原文字步骤与预期。
- 配置运行环境；Agent 可依据已有配置和用户提供的接口说明起草执行计划。规则不明时显示待确认问题。
- 支持状态码、JSON 字段存在、JSON 字段严格相等断言，使用 JSON Pointer 指定字段。
- 提取 Token、ID 等变量供后续用例使用；前置失败时跳过依赖用例并记录原因。
- 程序负责真实请求、断言、耗时和统计，模型负责计划与分析。每次执行独立保存快照和证据。
- 在原运行列表显示人工 / Agent 来源；支持历史报告、完整请求响应证据及 Excel 导出，AI 原因推测单独标注。

## 本地启动

需要 Node.js **22.9 或更新版本**、npm 和可用的 Docker。数据库运行在容器中，前后端运行在本机。

```powershell
git clone https://github.com/moliason/auto-test.git
cd auto-test
git switch codex/test-agent
npm ci
npm ci --prefix backend
npm ci --prefix frontend
docker compose up -d --wait postgres
```

PostgreSQL 使用 `127.0.0.1:5433`，默认数据库、用户名和开发密码均为 `unittcms`，数据保存在独立 Docker 卷。以下配置文件仅首次复制；已有 `.env` 时保留自己的配置：

```powershell
Copy-Item backend/.env.example backend/.env
Copy-Item frontend/.env.example frontend/.env
```

编辑 `backend/.env`，将 `SECRET_KEY` 改为自己的随机长字符串，并填写模型配置。真实密钥仅保存在后端 `.env`，该文件由 Git 忽略。

```dotenv
FRONTEND_ORIGIN=http://localhost:8000
PORT=8001
DATABASE_URL=postgres://unittcms:unittcms@127.0.0.1:5433/unittcms
SECRET_KEY=replace-with-your-own-random-secret
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
TEST_AGENT_ALLOWED_ORIGINS=http://127.0.0.1:4010,http://localhost:4010
```

后端默认使用 DeepSeek 官方兼容接口及工具调用，参考[官方文档](https://api-docs.deepseek.com/guides/tool_calls/)。可以配置兼容代理地址及其实际支持的模型名称；使用代理不等于完成 DeepSeek 官方模型联调。

```powershell
npm run migrate --prefix backend
npm run demo:seed --prefix backend
npm run build --prefix backend
npm start --prefix backend
```

在另一个终端启动前端：

```powershell
npm run dev --prefix frontend
```

再开一个终端启动被测示例服务：

```powershell
node demo/server.mjs
```

打开 [本地登录页](http://localhost:8000/zh-CN/account/signin)。演示初始化默认创建管理员 `admin666@local` / `666666`；也可在初始化前设置 `ADMIN_EMAIL`、`ADMIN_USERNAME`、`ADMIN_PASSWORD`。如果账号已存在，初始化会复用账号，不修改密码或角色。每次初始化都会创建独立演示项目和运行，保留之前的数据。

若端口被其他项目占用，可将后端 `.env` 的 `PORT` 改为 `8011`、`FRONTEND_ORIGIN` 改为 `http://localhost:8010`，前端 `.env` 改为 `NEXT_PUBLIC_BACKEND_ORIGIN=http://localhost:8011`，并在 `frontend` 目录运行 `npx next dev -p 8010`。当前浏览器验收使用这组端口。

## 演示步骤

1. 打开初始化创建的项目及“Agent 接口回归验收”测试运行，勾选全部 8 条用例。
2. 打开“接口测试 Agent”，检查测试环境为 `http://127.0.0.1:4010`，请求超时为 500 毫秒。
3. 点击“整理选中用例的测试计划”。第 8 条故意缺少执行配置，准备完成后会显示待补充信息。
4. 为第 8 条选择 `GET`，填写 `/plain`，在“请求与断言配置”中填入下面的 JSON。根据示例规则核实并清除已解决的问题，必要时补充计划说明。
5. 点击“保存并检查计划”。可勾选同时保存配置到原用例，供后续回归复用。
6. 核对计划与环境，确认测试数据、认证及前置条件准备妥当，勾选两项确认后点击“确认并开始执行”。
7. 查看各条断言、请求响应和 AI 分析，导出本次 Excel；关闭面板后检查原运行状态与来源，再通过“历史执行记录”打开报告。
8. 再次创建任务会生成新的历史记录，之前的请求响应和报告不会被覆盖。

```json
{ "assertions": [{ "type": "status", "expected": 200 }] }
```

完整执行预期为 **3 条通过、4 条失败（含 2 条请求异常）、1 条未执行**，其中包括故意设置的总额缺陷、超时、断连和前置失败。任务“已完成”表示执行与报告整理结束。各用例说明见 [demo/README.md](demo/README.md)。

## 执行配置与权限

在面板中选择方法与相对路径，其他字段在 JSON 编辑区填写。例如依赖登录用例后查询用户：

```json
{
  "headers": { "Authorization": "Bearer {{TOKEN}}" },
  "dependsOn": [1],
  "assertions": [
    { "type": "status", "expected": 200 },
    { "type": "jsonExists", "path": "/id" },
    { "type": "jsonEquals", "path": "/id", "expected": 7 }
  ]
}
```

`dependsOn` 使用实际用例编号；前置登录用例通过 `extract: [{"name":"TOKEN","path":"/token","secret":true}]` 提取变量。所有前置用例都应加入本次选择。ID 等非敏感值可显式设置 `secret:false`。

环境支持 `baseUrl`、`timeoutMs`、`headers`、`variables`、`secretVariables`。固定认证值在后端设置，例如 `TEST_AGENT_SECRET_API_TOKEN`；环境配置 `secretVariables: ["API_TOKEN"]`，请求头写 `Bearer {{API_TOKEN}}`。`TEST_AGENT_ALLOWED_ORIGINS` 是允许的测试目标来源列表，以逗号分隔；添加新测试环境时同时更新后端配置并重启。

权限沿用原平台：报告者及以上准备和执行本项目测试；开发者及以上保存原用例执行配置；项目管理者修改测试环境。服务端验证项目、运行与用例归属，不能通过替换编号访问其他项目的证据。

第一版每次最多 20 条用例，准备最多 6 次模型调用、执行最多 16 次模型调用，单阶段总时限 5 分钟、最多 64 次工具调用。单请求最长 30 秒，响应正文最大 1 MiB，禁止自动跟随重定向。后端以单进程运行；重启后任务标记为中断，已保存的证据保留，不自动重发请求。

## 验证与构建

```powershell
npm test -- --run
npm run build --prefix backend
npm run build --prefix frontend
```

前端生产构建完成后可使用 `npm start --prefix frontend`。首次构建需要下载原平台使用的 Google 字体。

浏览器验收前先启动数据库、前后端及示例服务，并配置可用模型：

```powershell
npm run e2e:agent
```

脚本默认使用前端 8010、后端 8011 和 Microsoft Edge，可配置 `E2E_BASE_URL`、`E2E_API_URL`、`PLAYWRIGHT_CHANNEL`，详见[演示说明](demo/README.md)。Agent 流程创建独立演示数据，使用配置的真实模型、执行真实 HTTP 请求并保存截图与 Excel；草稿编辑流程使用模拟 API 验证编辑和保存重试。自动化单元测试可以模拟模型响应；真实模型联调与最终验收状态见[验证记录](docs/agent-status.md)。

## 来源与许可

平台源码来自 Test-platfrom，基于 UnitTCMS。保留 Copyright © 2024-present UnitTCMS 和 [GPL-3.0 许可](LICENSE)，具体基线及来源见 [SOURCE.md](SOURCE.md)。本仓库保留最初的 Git 历史，原参考项目未被覆盖。

开发使用 `codex/test-agent` 分支，按功能逐笔提交，提交说明采用中文 Conventional Commits，例如 `feat: 增加计划确认`、`fix: 修正结果回填`、`test: 补充权限验证`。
