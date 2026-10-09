# 接口测试演示文档

本文档用于本地演示服务 http://127.0.0.1:4010，无需认证，所有请求均使用独立演示数据。

## GET /echo

可选 query 参数 probe 为字符串，不影响 HTTP 状态码。所有请求返回 200，响应 JSON 包含 query 对象。
传入 probe 时，响应的 /query/probe 必须原样返回该字符串。

本次业务验收要求分别覆盖以下七个场景，每个场景使用独立请求：

1. probe 为空字符串时，返回 200，/query/probe 等于 ""。
2. probe 为 "alpha" 时，返回 200，/query/probe 等于 "alpha"。
3. probe 为 "中文" 时，返回 200，/query/probe 等于 "中文"。
4. probe 为 "0" 时，返回 200，/query/probe 等于 "0"。
5. probe 为 "a b" 时，返回 200，/query/probe 等于 "a b"。
6. probe 为 "a/b" 时，返回 200，/query/probe 等于 "a/b"。
7. probe 为 "%" 时，返回 200，/query/probe 等于 "%"。

这是正常输入与字符边界测试；文档没有定义其他输入的错误响应，不应猜测错误码。

## GET /broken-total

无需请求参数。返回 200，响应 JSON 的 /total 应等于数字 100。
这是独立业务规则，必须保留该预期并记录真实响应差异。

## 测试范围

仅验证上面两个 GET 接口。总计八个必测场景，初始批次最多六条，剩余场景在分析初始结果后补测。
没有文档依据的新业务预期需要另行确认。
