import { isDeepStrictEqual } from 'node:util';
import { sensitiveName } from './credentials.js';

const variablePattern = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function executionIssues(spec) {
  const issues = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['缺少接口执行信息'];
  if (JSON.stringify(spec).includes('"[REDACTED]"')) issues.push('执行配置包含旧的脱敏凭据，请重新配置变量引用');
  if (!methods.includes(spec.method)) issues.push('请选择 HTTP 方法');
  if (typeof spec.path !== 'string' || !/^\/(?!\/)/.test(spec.path) || /[\\\s#]/.test(spec.path)) {
    issues.push('接口路径须以单个 / 开头，不能包含域名、空格、反斜杠或片段');
  }
  for (const field of ['headers', 'query']) {
    if (
      spec[field] !== undefined &&
      (!spec[field] ||
        typeof spec[field] !== 'object' ||
        Array.isArray(spec[field]) ||
        Object.values(spec[field]).some((value) => typeof value !== 'string'))
    )
      issues.push(`${field} 必须是字符串键值对象`);
  }
  if (
    Object.keys(spec.headers || {}).some((key) => /^(host|connection|content-length|transfer-encoding)$/i.test(key))
  ) {
    issues.push('不能覆盖连接管理请求头');
  }
  if (['GET', 'HEAD'].includes(spec.method) && spec.body != null) issues.push('GET/HEAD 不能包含请求体');
  if (!Array.isArray(spec.assertions) || !spec.assertions.length || spec.assertions.length > 30) {
    issues.push('请填写 1 至 30 条明确的预期断言');
  } else {
    for (const assertion of spec.assertions) {
      if (!['status', 'jsonExists', 'jsonEquals'].includes(assertion?.type)) {
        issues.push('断言仅支持 status、jsonExists、jsonEquals');
      } else if (assertion.type === 'status') {
        if (!Number.isInteger(assertion.expected) || assertion.expected < 100 || assertion.expected > 599) {
          issues.push('状态码断言需要 100 至 599 的整数');
        }
      } else {
        if (typeof assertion.path !== 'string' || !/^(\/([^~]|~[01])*)*$/.test(assertion.path)) {
          issues.push('JSON 字段路径使用 JSON Pointer，例如 /data/id');
        }
        if (assertion.type === 'jsonEquals' && !Object.hasOwn(assertion, 'expected'))
          issues.push('字段相等断言缺少预期值');
      }
    }
  }
  for (const field of ['dependsOn', 'requiredVariables', 'preconditions']) {
    if (
      spec[field] !== undefined &&
      (!Array.isArray(spec[field]) ||
        spec[field].length > 30 ||
        spec[field].some((value) =>
          field === 'dependsOn' ? !Number.isSafeInteger(value) || value < 1 : typeof value !== 'string' || !value.trim()
        ))
    )
      issues.push(`${field} 格式不正确`);
  }
  if (
    spec.extract !== undefined &&
    (!Array.isArray(spec.extract) ||
      spec.extract.length > 20 ||
      spec.extract.some(
        (entry) =>
          !entry ||
          typeof entry.name !== 'string' ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) ||
          typeof entry.path !== 'string' ||
          !/^(\/([^~]|~[01])*)*$/.test(entry.path) ||
          (entry.secret !== undefined && typeof entry.secret !== 'boolean')
      ))
  )
    issues.push('变量提取需要合法的名称、JSON Pointer 路径及可选 secret 标记');
  if (JSON.stringify(spec).length > 64000) issues.push('单条用例的执行信息不能超过 64000 字符');
  return [...new Set(issues)];
}

export function environmentIssues(environment) {
  const issues = [];
  if (JSON.stringify(environment)?.includes('"[REDACTED]"'))
    issues.push('测试环境包含旧的脱敏凭据，请重新配置变量引用');
  try {
    const url = new URL(environment?.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error();
    const allowed = (process.env.TEST_AGENT_ALLOWED_ORIGINS || 'http://127.0.0.1:4010,http://localhost:4010')
      .split(',')
      .map((value) => value.trim());
    if (!allowed.includes(url.origin)) issues.push('测试地址未列入后端 TEST_AGENT_ALLOWED_ORIGINS 配置');
  } catch {
    issues.push('请填写有效的 HTTP/HTTPS 测试基地址，不要在地址中填写认证信息');
  }
  for (const field of ['headers', 'variables']) {
    if (
      environment?.[field] !== undefined &&
      (!environment[field] ||
        typeof environment[field] !== 'object' ||
        Array.isArray(environment[field]) ||
        Object.values(environment[field]).some((value) => !['string', 'number', 'boolean'].includes(typeof value)))
    ) {
      issues.push(`${field} 必须是键值对象，值只能是字符串、数字或布尔值`);
    }
  }
  if (
    environment?.secretVariables !== undefined &&
    (!Array.isArray(environment.secretVariables) ||
      environment.secretVariables.some((name) => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
  )
    issues.push('认证变量名称格式不正确');
  if (
    environment?.timeoutMs !== undefined &&
    (!Number.isInteger(environment.timeoutMs) || environment.timeoutMs < 100 || environment.timeoutMs > 30000)
  ) {
    issues.push('请求超时应为 100 至 30000 毫秒');
  }
  return issues;
}

export function readJsonPointer(value, pointer) {
  if (pointer === '') return { exists: true, value };
  for (const part of pointer.slice(1).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return { exists: false };
    value = value[key];
  }
  return { exists: true, value };
}

export function renderVariables(value, variables, encode = false) {
  if (Array.isArray(value)) return value.map((entry) => renderVariables(entry, variables, encode));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, renderVariables(entry, variables, encode)])
    );
  if (typeof value !== 'string') return value;
  const wholeVariable = !encode && value.match(/^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}$/);
  if (
    wholeVariable &&
    Object.hasOwn(variables, wholeVariable[1]) &&
    ['string', 'number', 'boolean'].includes(typeof variables[wholeVariable[1]])
  ) {
    return variables[wholeVariable[1]];
  }
  return value.replace(variablePattern, (_, name) => {
    if (!Object.hasOwn(variables, name)) throw new Error(`缺少变量：${name}`);
    if (!['string', 'number', 'boolean'].includes(typeof variables[name]))
      throw new Error(`变量 ${name} 必须是字符串、数字或布尔值`);
    return encode ? encodeURIComponent(String(variables[name])) : String(variables[name]);
  });
}

export function collectSensitiveValues(value, sensitive = false) {
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([key, entry]) =>
      collectSensitiveValues(entry, sensitive || sensitiveName.test(key))
    );
  return sensitive && typeof value === 'string' && value.length ? [value] : [];
}

export function redact(value, secrets = collectSensitiveValues(value)) {
  if (Array.isArray(value)) return value.map((entry) => redact(entry, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sensitiveName.test(key) ? '[REDACTED]' : redact(entry, secrets),
      ])
    );
  if (typeof value !== 'string') return value;
  for (const secret of secrets) {
    if (secret !== undefined && secret !== null && String(secret).length) {
      value = value.split(String(secret)).join('[REDACTED]');
      value = value.split(encodeURIComponent(String(secret))).join('[REDACTED]');
    }
  }
  return value;
}

export async function executeHttpCase({ execution, environment, variables = {}, secrets = [], signal }) {
  const started = Date.now();
  const evidence = {
    status: 'skipped',
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    assertions: [],
    request: null,
    response: null,
    reason: '',
  };
  const extractedVariables = {};
  const issues = [...executionIssues(execution), ...environmentIssues(environment)];
  const sensitiveValues = [...secrets];
  let reader;
  try {
    if (issues.length) throw new Error(issues.join('；'));
    for (const [name, value] of Object.entries(variables)) if (sensitiveName.test(name)) sensitiveValues.push(value);
    for (const name of execution.requiredVariables || [])
      if (!Object.hasOwn(variables, name)) throw new Error(`缺少变量：${name}`);
    const url = new URL(environment.baseUrl.replace(/\/$/, '') + renderVariables(execution.path, variables, true));
    if (url.origin !== new URL(environment.baseUrl).origin) throw new Error('请求地址超出了已确认的测试环境');
    for (const [name, value] of Object.entries(renderVariables(execution.query || {}, variables)))
      url.searchParams.set(name, value);
    const headers = {
      ...renderVariables(environment.headers || {}, variables),
      ...renderVariables(execution.headers || {}, variables),
    };
    if (Object.keys(headers).some((key) => /^(host|connection|content-length|transfer-encoding)$/i.test(key)))
      throw new Error('不能覆盖连接管理请求头');
    for (const [name, value] of Object.entries(headers))
      if (sensitiveName.test(name)) sensitiveValues.push(value, String(value).replace(/^Bearer\s+/i, ''));
    const body = renderVariables(execution.body, variables);
    if (
      body != null &&
      typeof body !== 'string' &&
      !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')
    )
      headers['Content-Type'] = 'application/json';
    const evidenceUrl = new URL(url);
    for (const name of evidenceUrl.searchParams.keys())
      if (sensitiveName.test(name)) evidenceUrl.searchParams.set(name, '[REDACTED]');
    evidence.request = { method: execution.method, url: evidenceUrl.href, headers, body: body ?? null };
    sensitiveValues.push(...collectSensitiveValues(evidence.request));
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(environment.timeoutMs || 5000),
      ...(signal ? [signal] : []),
    ]);
    evidence.status = 'error';
    const response = await fetch(url, {
      method: execution.method,
      headers,
      body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      redirect: 'manual',
      signal: requestSignal,
    });
    evidence.response = {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: null,
      incomplete: true,
    };
    const chunks = [];
    let bytes = 0;
    reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 1024 * 1024) throw new Error('响应超过 1 MiB 上限，未执行断言');
        chunks.push(Buffer.from(part.value));
      }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let json;
    let isJson = false;
    try {
      json = JSON.parse(text);
      isJson = true;
    } catch {
      /* Non-JSON responses still support status assertions. */
    }
    evidence.response = {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: isJson ? json : text.slice(0, 32768),
      truncated: !isJson && text.length > 32768,
      bytes,
    };
    // Assertion evaluation uses original values; every evidence copy is redacted with the same discovered secrets.
    sensitiveValues.push(...collectSensitiveValues(evidence.response));
    for (const assertion of execution.assertions) {
      const actual =
        assertion.type === 'status'
          ? { exists: true, value: response.status }
          : isJson
            ? readJsonPointer(json, assertion.path)
            : { exists: false };
      const passed =
        assertion.type === 'jsonExists'
          ? actual.exists
          : actual.exists && isDeepStrictEqual(actual.value, assertion.expected);
      evidence.assertions.push({
        ...assertion,
        passed,
        actual: actual.exists ? actual.value : null,
        exists: actual.exists,
      });
    }
    evidence.status = evidence.assertions.every((assertion) => assertion.passed) ? 'passed' : 'failed';
    for (const extraction of execution.extract || []) {
      const actual = isJson ? readJsonPointer(json, extraction.path) : { exists: false };
      if (!actual.exists || !['string', 'number', 'boolean'].includes(typeof actual.value)) {
        evidence.status = 'failed';
        evidence.reason = `无法提取变量 ${extraction.name}：字段不存在或不是标量`;
      } else {
        extractedVariables[extraction.name] = actual.value;
        if (extraction.secret !== false) sensitiveValues.push(actual.value);
      }
    }
    if (evidence.status !== 'passed')
      for (const name of Object.keys(extractedVariables)) delete extractedVariables[name];
  } catch (error) {
    evidence.reason =
      evidence.status === 'skipped'
        ? error.message
        : ['TimeoutError', 'AbortError'].includes(error.name)
          ? '请求超时或任务已结束'
          : error.message === '响应超过 1 MiB 上限，未执行断言'
            ? error.message
            : '接口请求失败，请检查测试服务、网络和请求配置';
  } finally {
    if (reader) await reader.cancel().catch(() => {});
    evidence.durationMs = Date.now() - started;
    evidence.finishedAt = new Date().toISOString();
  }
  return { evidence: redact(evidence, sensitiveValues), extractedVariables, secrets: sensitiveValues };
}
