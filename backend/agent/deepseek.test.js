import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatCompletion } from './deepseek.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('model usage evidence', () => {
  it.each([
    [
      { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_cache_hit_tokens: 0 },
      { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_cache_hit_tokens: 0 },
    ],
    [undefined, null],
    [{ total_tokens: -1, prompt_tokens: '20', completion_tokens: 2.5 }, null],
    [
      { prompt_tokens: 0, total_tokens: 20, extra: 'must-not-be-saved' },
      { prompt_tokens: 0, total_tokens: 20 },
    ],
  ])('retains reported counters without estimating missing fields %#', async (usage, expected) => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-only-key');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage }),
      })
    );
    const result = await chatCompletion([{ role: 'user', content: 'check' }]);
    expect(result.usage).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain('test-only-key');
  });

  it('retains reported usage even if the model output is truncated', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-only-key');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{}' }, finish_reason: 'length' }],
          usage: { total_tokens: 512 },
        }),
      })
    );
    await expect(chatCompletion([])).rejects.toMatchObject({ code: 'invalidResponse', usage: { total_tokens: 512 } });
  });
});
