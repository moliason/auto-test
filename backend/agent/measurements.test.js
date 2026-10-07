import { describe, expect, it } from 'vitest';
import { modelMeasurements } from './measurements.js';

describe('model measurement summaries', () => {
  it('keeps missing historical measurements unknown and does not count tools as models', () => {
    const [prepare, execute] = modelMeasurements([
      { type: 'model', phase: 'prepare' },
      { type: 'tool_finished', phase: 'execute', durationMs: 999 },
    ]);
    expect(prepare).toMatchObject({
      calls: 1,
      durationMs: null,
      timedCalls: 0,
      tokens: { total_tokens: { value: null, recordedCalls: 0 } },
    });
    expect(execute.calls).toBe(0);
    expect(execute.tokens.total_tokens.value).toBeNull();
  });

  it('separates phases and preserves measurement coverage including failed billable responses', () => {
    const [prepare, execute] = modelMeasurements([
      {
        type: 'model',
        phase: 'prepare',
        outcome: 'completed',
        durationMs: 20,
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
      { type: 'model', phase: 'prepare', outcome: 'failed', durationMs: 30, usage: { total_tokens: 4 } },
      { type: 'model', phase: 'prepare', outcome: 'failed', durationMs: 10, usage: null },
      {
        type: 'model',
        phase: 'execute',
        outcome: 'completed',
        durationMs: 0,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
    ]);
    expect(prepare).toMatchObject({ calls: 3, completedCalls: 1, failedCalls: 2, durationMs: 60, timedCalls: 3 });
    expect(prepare.tokens).toEqual({
      prompt_tokens: { value: 10, recordedCalls: 1 },
      completion_tokens: { value: 2, recordedCalls: 1 },
      total_tokens: { value: 16, recordedCalls: 2 },
    });
    expect(execute).toMatchObject({
      calls: 1,
      durationMs: 0,
      tokens: { total_tokens: { value: 0, recordedCalls: 1 } },
    });
  });
});
