// Counts come only from persisted client observations and provider-reported usage.
export function modelMeasurements(events = []) {
  return ['prepare', 'execute'].map((phase) => {
    const calls = events.filter((event) => event.type === 'model' && event.phase === phase);
    const timed = calls.filter((event) => Number.isFinite(event.durationMs) && event.durationMs >= 0);
    const tokens = {};
    for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
      const reported = calls.filter((event) => Number.isSafeInteger(event.usage?.[field]) && event.usage[field] >= 0);
      tokens[field] = {
        value: reported.length ? reported.reduce((sum, event) => sum + event.usage[field], 0) : null,
        recordedCalls: reported.length,
      };
    }
    return {
      phase,
      calls: calls.length,
      completedCalls: calls.filter((event) => event.outcome === 'completed').length,
      failedCalls: calls.filter((event) => event.outcome === 'failed').length,
      durationMs: timed.length ? timed.reduce((sum, event) => sum + event.durationMs, 0) : null,
      timedCalls: timed.length,
      tokens,
    };
  });
}
