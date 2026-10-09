import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { readJsonPointer } from './execution.js';

const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

// Local references share the uploaded document's trust boundary. Never fetch a URL or local file.
export function resolveApiReferences(value, root, trail = [], depth = 0, budget = { remaining: 10000 }) {
  if (--budget.remaining < 0) throw new Error('接口引用展开超过上限，请拆分文档');
  if (depth > 30) throw new Error('接口结构嵌套超过 30 层，请拆分文档');
  if (Array.isArray(value)) return value.map((item) => resolveApiReferences(item, root, trail, depth + 1, budget));
  if (!value || typeof value !== 'object') return value;
  if (Object.hasOwn(value, '$ref')) {
    const ref = value.$ref;
    if (typeof ref !== 'string' || !ref.startsWith('#/')) throw new Error('仅支持文档内的 $ref，请先合并外部引用');
    if (trail.includes(ref)) return { $ref: ref };
    const target = readJsonPointer(root, ref.slice(1));
    if (!target.exists) throw new Error('文档包含不存在的 $ref');
    if (!target.value || typeof target.value !== 'object' || Array.isArray(target.value))
      throw new Error('$ref 必须指向文档内的对象');
    const { $ref, ...siblings } = value;
    return {
      ...resolveApiReferences(target.value, root, [...trail, ref], depth + 1, budget),
      ...resolveApiReferences(siblings, root, trail, depth + 1, budget),
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, resolveApiReferences(entry, root, trail, depth + 1, budget)])
  );
}

export function parseInterfaceDocument(input, requirements = '') {
  if (
    !input ||
    typeof input.name !== 'string' ||
    !/\.(md|json|ya?ml)$/i.test(input.name) ||
    input.name.length > 120 ||
    /[\\/\0]/.test(input.name)
  )
    throw new Error('请选择 Markdown (.md) 或 OpenAPI (.json/.yaml/.yml) 文件');
  if (
    typeof input.content !== 'string' ||
    !input.content.trim() ||
    Buffer.byteLength(input.content, 'utf8') > 65536 ||
    /[\0\uFFFD]/.test(input.content)
  )
    throw new Error('接口文档须为有效 UTF-8 文本，大小为 1 至 64 KiB');
  if (typeof requirements !== 'string' || requirements.length > 6000) throw new Error('补充业务要求最多 6000 字符');
  const content = input.content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const document = {
    name: input.name,
    content,
    requirements: requirements.trim(),
    sha256: createHash('sha256').update(input.content).digest('hex'),
    format: 'markdown',
    operations: [],
    authentication: {},
    sourceText: content,
  };
  if (/\.md$/i.test(input.name)) return document;
  let source;
  try {
    if (/\.json$/i.test(input.name)) source = JSON.parse(content);
    else {
      const yaml = parseDocument(content, { uniqueKeys: true, strict: true, stringKeys: true, prettyErrors: false });
      if (yaml.errors.length || yaml.warnings.length) throw new Error();
      source = yaml.toJS({ maxAliasCount: 20 });
    }
    // Reject cyclic YAML aliases before walking schemas; recursive JSON Schema $refs remain supported.
    if (JSON.stringify(source).length > 200000) throw new Error();
  } catch {
    throw new Error('接口文档解析失败，请检查 JSON/YAML 格式、重复字段及别名');
  }
  if (
    !source ||
    !/^3\.(0|1)\./.test(source.openapi || '') ||
    !source.paths ||
    typeof source.paths !== 'object' ||
    Array.isArray(source.paths)
  )
    throw new Error('当前支持包含 paths 的 OpenAPI 3.0/3.1 文档');
  document.format = 'openapi';
  document.authentication = resolveApiReferences(source.components?.securitySchemes || {}, source);
  for (const [path, rawPathItem] of Object.entries(source.paths)) {
    if (!/^\/(?!\/)/.test(path) || /[\\\s?#]/.test(path)) throw new Error('OpenAPI 路径必须是相对接口路径');
    const pathItem = resolveApiReferences(rawPathItem, source);
    for (const method of methods) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      if (!operation.responses || typeof operation.responses !== 'object') throw new Error('接口缺少 responses 定义');
      const parameters = new Map();
      for (const parameter of [...(pathItem.parameters || []), ...(operation.parameters || [])]) {
        if (!parameter?.name || !['path', 'query', 'header', 'cookie'].includes(parameter.in))
          throw new Error('接口参数定义无效');
        parameters.set(`${parameter.in}:${parameter.name}`, parameter);
      }
      document.operations.push({
        id: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        summary: operation.summary || '',
        description: operation.description || '',
        parameters: [...parameters.values()],
        requestBody: resolveApiReferences(operation.requestBody || null, source),
        security: operation.security ?? source.security ?? [],
        responses: resolveApiReferences(operation.responses, source),
      });
    }
  }
  if (!document.operations.length || document.operations.length > 30)
    throw new Error('每份文档支持 1 至 30 个接口，请按模块拆分');
  document.sourceText = JSON.stringify(
    { operations: document.operations, authentication: document.authentication },
    null,
    2
  );
  if (document.sourceText.length > 100000) throw new Error('展开后的接口文档过大，请按模块拆分');
  return document;
}
