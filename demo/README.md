# 本地接口测试演示

先按根目录 README 启动 PostgreSQL 并执行迁移，然后在仓库根目录运行：

```sh
npm run demo:seed --prefix backend
node demo/server.mjs
```

初始化脚本每次创建独立的演示项目、目录和测试运行，输出真实编号，并将前置依赖映射到本次用例编号。它不会覆盖已有项目或历史执行记录。

默认创建本地管理员 `admin666@local`，密码 `666666`。可以先在 `backend/.env` 设置 `ADMIN_EMAIL`、`ADMIN_USERNAME`、`ADMIN_PASSWORD`；已经存在的账号会复用，密码和角色不会被修改。

演示服务地址为 `http://127.0.0.1:4010`，运行环境已设置 500 毫秒请求超时。后端的 `TEST_AGENT_ALLOWED_ORIGINS` 必须包含该地址。模型接口通过后端 `DEEPSEEK_*` 配置，凭据不能写入前端。

选中初始化输出的全部 8 条用例创建 Agent 任务。第 8 条故意缺少执行信息，准备阶段应提示补充，不能直接执行。依据示例服务，为它填写：

```json
{
  "method": "GET",
  "path": "/plain",
  "assertions": [{ "type": "status", "expected": 200 }]
}
```

核对所有用例、环境及前置条件，保存计划后确认执行。完整运行的预期统计为 **3 条通过、4 条失败（其中 2 条请求异常）、1 条未执行**：

| 用例序号 | 演示内容 | 预期执行结果 |
| --- | --- | --- |
| 1 | 正常登录并提取 Token | 通过；敏感值在证据中隐藏 |
| 2 | 使用前置登录的 Token 查询用户 | 通过 |
| 3 | 总额预期 100，接口实际返回 90 | 断言失败 |
| 4 | 响应超过 500 毫秒 | 请求超时 |
| 5 | 服务主动断开连接 | 请求异常 |
| 6 | 错误密码导致登录前置失败 | 断言失败 |
| 7 | 依赖第 6 条登录成功 | 未执行，说明前置失败 |
| 8 | 补充健康检查信息 | 通过 |

任务完成状态表示执行与整理已结束，不表示全部测试通过。可通过 `/runs/download/<runId>?type=xlsx&agentTaskId=<taskId>` 导出指定历史报告（需要原平台登录凭据及项目权限）。重复创建 Agent 任务会保留此前快照、证据和报告。

开发测试 `backend/agent/runner.test.js` 模拟模型工具选择，HTTP 请求实际发往本地示例服务。完整界面演示和真实模型联调状态以根目录 `docs/agent-status.md` 为准。

## 浏览器完整验证

`npm run e2e:agent` 会创建新的演示数据，通过真实页面完成缺失信息补充、确认、执行、历史查看和 Excel 下载，并检查四种窗口宽度。测试会调用已启动后端配置的真实模型，需要可用模型接口。默认前端为 `http://localhost:8010`、后端为 `http://localhost:8011`，可通过 `E2E_BASE_URL` 和 `E2E_API_URL` 修改；两者须与前端接口配置及后端 CORS 配置一致。

本机使用已安装的 Microsoft Edge；其他环境可设置 `PLAYWRIGHT_CHANNEL=chromium` 并先运行 `npx playwright install chromium`。执行前启动数据库、后端、前端和 `node demo/server.mjs`。截图与导出文件保存在被 Git 忽略的 `test-results` 目录。
