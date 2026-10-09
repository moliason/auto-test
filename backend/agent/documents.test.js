import { describe, expect, it } from 'vitest';
import { parseInterfaceDocument, resolveApiReferences } from './documents.js';

const source = {
  openapi: '3.1.0',
  info: { title: 'Example', version: '1' },
  security: [{ bearer: [] }],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    schemas: { Order: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } },
  },
  paths: {
    '/orders/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      get: {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
        responses: {
          200: {
            description: 'Order found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
        },
      },
    },
  },
};

describe('interface document import', () => {
  it('retains Markdown content, requirements and an immutable source digest', () => {
    const input = { name: '登录.md', content: '# Login\r\nPOST /login\r\n密码错误返回 401。' };
    const result = parseInterfaceDocument(input, '验证错误密码');
    expect(result).toMatchObject({
      format: 'markdown',
      requirements: '验证错误密码',
      sourceText: '# Login\nPOST /login\n密码错误返回 401。',
    });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parseInterfaceDocument({ ...input, content: input.content + '\n' }).sha256).not.toBe(result.sha256);
  });
  it('resolves OpenAPI parameters, response constraints and inherited authentication', () => {
    const result = parseInterfaceDocument({ name: 'api.json', content: JSON.stringify(source) });
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      id: 'GET /orders/{id}',
      method: 'GET',
      path: '/orders/{id}',
      security: [{ bearer: [] }],
    });
    expect(result.operations[0].parameters).toHaveLength(1);
    expect(result.operations[0].parameters[0].schema.minimum).toBe(1);
    expect(result.operations[0].responses['200'].content['application/json'].schema).toEqual(
      source.components.schemas.Order
    );
    expect(result.authentication.bearer.scheme).toBe('bearer');
  });
  it('parses YAML and preserves operation security overrides', () => {
    const result = parseInterfaceDocument({
      name: 'api.yaml',
      content:
        'openapi: 3.0.3\nsecurity:\n  - bearer: []\npaths:\n  /plain:\n    get:\n      security: []\n      responses:\n        "200":\n          description: Healthy\n',
    });
    expect(result.operations[0]).toMatchObject({
      method: 'GET',
      path: '/plain',
      security: [],
      responses: { 200: { description: 'Healthy' } },
    });
  });
  it.each([
    { name: '../api.md', content: '# API' },
    { name: 'api.pdf', content: '# API' },
    { name: 'api.md', content: '' },
    { name: 'api.md', content: '中'.repeat(22000) },
    { name: 'api.md', content: 'invalid\uFFFD' },
    { name: 'api.json', content: '{broken' },
    { name: 'api.json', content: '{}' },
    { name: 'api.yaml', content: 'openapi: 3.0.0\nopenapi: 3.1.0\npaths: {}' },
    { name: 'api.yaml', content: 'openapi: 3.0.0\npaths: &a { self: *a }' },
    { name: 'api.json', content: JSON.stringify({ ...source, paths: { '/secret': { $ref: 'file:///secret.json' } } }) },
  ])('rejects invalid or unsafe imports without fetching external references: $name', (input) => {
    expect(() => parseInterfaceDocument(input)).toThrow();
  });
  it('supports recursive local schema references and rejects missing and remote references', () => {
    const root = { node: { type: 'object', properties: { next: { $ref: '#/node' } } } };
    expect(resolveApiReferences({ $ref: '#/node' }, root).properties.next).toEqual({ $ref: '#/node' });
    expect(() => resolveApiReferences({ $ref: '#/missing' }, root)).toThrow('不存在');
    expect(() => resolveApiReferences({ $ref: 'https://example.com/schema' }, root)).toThrow('文档内');
  });
  it('bounds repeated reference expansion before allocating an oversized document', () => {
    const root = { a: { value: 'leaf' } };
    for (let i = 0; i < 16; i++)
      root[`n${i}`] = {
        left: { $ref: i ? `#/n${i - 1}` : '#/a' },
        right: { $ref: i ? `#/n${i - 1}` : '#/a' },
      };
    expect(() => resolveApiReferences({ $ref: '#/n15' }, root)).toThrow(/上限|嵌套/);
    expect(() => resolveApiReferences({ $ref: '#/value' }, { value: 1 })).toThrow('对象');
  });
});
