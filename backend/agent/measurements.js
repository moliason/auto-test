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

export function executionMeasurements(task) {
  const requests = task.results.filter((result) => result.request !== null && result.request !== undefined);
  const timedRequests = requests.filter((result) => Number.isFinite(result.durationMs) && result.durationMs >= 0);
  const saves = task.events.filter(
    (event) => event.type === 'evidence_saved' && Number.isFinite(event.durationMs) && event.durationMs >= 0
  );
  const report = task.events.find(
    (event) =>
      event.type === 'tool_finished' &&
      event.name === 'submit_report' &&
      event.ok &&
      Number.isFinite(event.reportDurationMs) &&
      event.reportDurationMs >= 0
  );
  return {
    requests: {
      durationMs: timedRequests.length ? timedRequests.reduce((sum, result) => sum + result.durationMs, 0) : null,
      recorded: timedRequests.length,
      total: requests.length,
    },
    persistence: {
      durationMs: saves.length ? saves.reduce((sum, event) => sum + event.durationMs, 0) : null,
      recorded: saves.length,
      total: task.results.length,
    },
    reportDurationMs: report?.reportDurationMs ?? null,
  };
}
