import { isDeepStrictEqual } from 'node:util';

export const sensitiveName = /authorization|cookie|password|passwd|secret|token|api[-_]?key/i;
const reference = /^(?:Bearer |Basic )?\{\{[A-Za-z_][A-Za-z0-9_]*\}\}$/i;

// Preserve variable references in editable configuration; never return legacy literal credentials.
export function protectConfiguration(value, field = '') {
  if (typeof value === 'string') {
    if (sensitiveName.test(field) && value && !reference.test(value)) return '[REDACTED]';
    if (field === 'body') {
      try {
        const parsed = JSON.parse(value);
        const safe = protectConfiguration(parsed);
        if (!isDeepStrictEqual(parsed, safe)) return JSON.stringify(safe);
      } catch {
        for (const [key, entry] of new URLSearchParams(value))
          if (sensitiveName.test(key) && entry && !reference.test(entry)) return '[REDACTED]';
      }
    }
    if (field === 'path' || field === 'baseUrl') {
      try {
        const url = new URL(value, 'http://configuration.invalid');
        if (url.username || url.password) return '[REDACTED]';
        for (const [key, entry] of url.searchParams)
          if (sensitiveName.test(key) && entry && !reference.test(entry)) return '[REDACTED]';
      } catch {
        /* Structural URL validation is handled separately. */
      }
    }
    return value;
  }
  if (Array.isArray(value))
    return value.map((entry) => protectConfiguration(entry, field === 'secretVariables' ? '' : field));
  if (value && typeof value === 'object') {
    const sensitiveAssertion =
      typeof value.path === 'string' &&
      value.type?.startsWith?.('json') &&
      value.path.split('/').some((part) => sensitiveName.test(part.replace(/~1/g, '/').replace(/~0/g, '~')));
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sensitiveAssertion && ['actual', 'expected'].includes(key) && entry != null
          ? '[REDACTED]'
          : protectConfiguration(entry, sensitiveName.test(field) ? field : key),
      ])
    );
  }
  return value;
}

export function configurationIssues(value) {
  return !isDeepStrictEqual(value, protectConfiguration(value)) || JSON.stringify(value)?.includes('"[REDACTED]"')
    ? ['认证信息请使用 {{变量名}} 引用；旧的脱敏值须重新配置，不能保存明文凭据']
    : [];
}
