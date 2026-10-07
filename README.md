# Auto-test：接口测试 Agent 毕设

基于现有 Test-platfrom 平台，复用项目、目录、测试运行、权限和报告，增加接口测试 Agent。来源及许可见 [SOURCE.md](SOURCE.md) 和 [LICENSE](LICENSE)。下方保留原平台介绍。

**当前仍在开发，尚未完成完整 Agent 验收。** 已完成平台迁入、用例草稿生成、HTTP 执行器、执行配置、计划确认、Agent 后端调度和 Excel 报告接口；运行界面还在接入。具体状态见 [开发与验收记录](docs/agent-status.md)。

本地数据库使用独立的 Docker 卷，端口 **5433**，不占用原平台的 5432：

```sh
docker compose up -d --wait postgres
cd backend
# 首次运行：复制 .env.example 为 .env，设置自己的 SECRET_KEY
npm ci
npm run migrate
npm run build
npm start
```

DeepSeek 配置保存在后端环境或 `backend/.env`：`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL=deepseek-flash`、`DEEPSEEK_BASE_URL=https://api.deepseek.com`。不要提交真实密钥。本地兼容代理可通过这三个配置项指定，使用代理实际支持的模型名称；代理联调不能代表官方 DeepSeek 联调。

本地被测服务（独立终端，仓库根目录）：

```sh
node demo/server.mjs
```

服务地址为 `http://127.0.0.1:4010`，包含登录、认证查询、故意返回错误总额、慢请求和断连接口。测试目标须列入后端 `TEST_AGENT_ALLOWED_ORIGINS`。认证值通过后端 `TEST_AGENT_SECRET_变量名` 设置，执行配置用 `{{变量名}}` 引用。

核心验证（仓库根目录）：

```sh
npm ci
npx vitest run backend/agent/execution.test.js backend/routes/agent/index.test.js backend/routes/cases/ai.test.js
```

执行器测试启动真实本地 HTTP 服务，模型测试使用模拟响应。这些检查不能替代完整 Agent 流程验收。

---

<p align="center">
  <img src="./frontend/public/favicon/test-platfrom.svg" width="96" height="96" alt="Test-platfrom" />
</p>

<h1 align="center">Test-platfrom</h1>

<p align="center">Test Case Management and Test Execution Platform</p>

Test-platfrom builds on UnitTCMS with extensive user experience improvements, including tree-based case navigation, streamlined test-run workflows, and asynchronous updates that reduce full-page reloads.

Designed for self-hosted teams, it brings project-based test case management, test execution, result tracking, and report generation into one platform.

## Key Features

- Organize test cases by project and folder, with a tree view for navigating case details.
- Import Excel test cases, update cases with matching titles, and align steps with expected results by number.
- Create test runs from selected cases or add them to existing runs.
- Assign owners, record statuses and comments, and track testing progress.
- Export Excel test reports with a separate worksheet for each folder.
- Manage accounts, project members, role-based permissions, and project-specific test case types.
- Use a multilingual interface, PostgreSQL storage, and optional OIDC single sign-on.

## Screenshots

### Test Case Details

Browse cases by folder on the left and view preconditions, test steps, expected results, and attachments on the right.

![Test case tree and step details](./docs/images/test-case-details.png)

### Bulk Case Selection

Select multiple test cases to create a new run or add them to an existing run.

![Selecting multiple test cases to create or join a run](./docs/images/test-case-selection.png)

### Test Runs

Track execution progress, manage run status, and browse the cases included in a run by folder.

![Test run progress and included test cases](./docs/images/test-run.png)

## Getting Started

```bash
git clone https://github.com/moliason/Test-platfrom.git
cd Test-platfrom
docker compose up --build
```

Once the application is running, open the [local sign-in page](http://localhost:8000/zh-CN/account/signin).

Configure the initial administrator using `ADMIN_USERNAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` in the Compose environment. Before exposing the application, change the default administrator password, database password, and `SECRET_KEY`. Never commit real credentials to the repository.

- [Running from Source](./docs/docs/getstarted/from-source.md)
- [Environment Configuration](./docs/docs/getstarted/environment.md)
- [OIDC Configuration](./docs/docs/getstarted/oidc.md)
- [Report an Issue](https://github.com/moliason/Test-platfrom/issues)
- [Contributing](./CONTRIBUTING.md)

## License and Attribution

This project is based on [UnitTCMS](https://github.com/kimatata/unittcms) and retains its upstream copyright notice: Copyright © 2024-present UnitTCMS.

The code is licensed under [GPL-3.0](./LICENSE). Test-platfrom is this project's display name; it does not change the license or attribution of the upstream code.
