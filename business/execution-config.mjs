// Keep the frozen HTTP inputs unchanged, but store even invalid test passwords through backend references.
export function executionConfig(fixture, caseIds) {
  const execution = structuredClone(fixture.executionInfo);
  if (execution.body?.password && !execution.body.password.startsWith('{{'))
    execution.body.password = '{{BIZ_WRONG_PASSWORD}}';
  return { ...execution, dependsOn: (execution.dependsOn || []).map((id) => caseIds[id - 1]) };
}
