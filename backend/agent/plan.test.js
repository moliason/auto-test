import { afterEach, describe, expect, it, vi } from 'vitest';
import { environmentVariables } from './plan.js';

afterEach(() => vi.unstubAllEnvs());
describe('project secret grants', () => {
  it.each(['{}', 'null', '{invalid', '{"2":["API_TOKEN"]}', '{"1":"API_TOKEN"}'])(
    'fails closed for missing or invalid grants: %s',
    (grants) => {
      vi.stubEnv('TEST_AGENT_SECRET_GRANTS', grants);
      vi.stubEnv('TEST_AGENT_SECRET_API_TOKEN', 'private-project-value');
      const result = environmentVariables({ secretVariables: ['API_TOKEN'], variables: { API_TOKEN: 'override' } }, 1);
      expect(result.issues.join(' ')).toContain('未授权');
      expect(result.variables).not.toHaveProperty('API_TOKEN');
      expect(result.secrets).toEqual([]);
    }
  );
  it('does not treat an unspecified project as authorized', () => {
    vi.stubEnv('TEST_AGENT_SECRET_GRANTS', '{"1":["API_TOKEN"]}');
    expect(environmentVariables({ secretVariables: ['API_TOKEN'] }).issues.join(' ')).toContain('未授权');
  });
});
