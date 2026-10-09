import { describe, expect, it } from 'vitest';
import { caseFingerprint, documentAcceptance, documentBudget, documentPlanIssues } from './documentPlan.js';

const plan = {
  workflow: {
    document: { format: 'markdown', sourceText: 'GET /items/{id}\n查询成功返回 200，包含 id 字段。', requirements: '' },
    limits: documentBudget,
    operations: [{ id: 'get', method: 'GET', path: '/items/{id}', evidence: 'GET /items/{id}' }],
    allowedOperationIds: ['get'],
    rules: [
      {
        id: 'ok',
        operationId: 'get',
        description: '成功',
        evidence: '查询成功返回 200',
        assertion: { type: 'status', expected: 200 },
      },
    ],
    questions: [],
  },
  issues: [],
  cases: [
    {
      caseId: 1,
      ruleIds: ['ok'],
      executionInfo: { method: 'GET', path: '/items/1', assertions: [{ type: 'status', expected: 200 }] },
    },
  ],
};

describe('document execution contract', () => {
  it('accepts sourced assertions and restricts operation, path, expectation and budget', () => {
    expect(documentPlanIssues(plan)).toEqual([]);
    for (const change of [
      { method: 'DELETE' },
      { path: '/admin/1' },
      { path: '/items/%2e%2e' },
      { path: '/items/a%2Fb' },
      { path: '/items/%252e%252e' },
      { assertions: [{ type: 'status', expected: 201 }] },
      { headers: { Authorization: 'Bearer literal' } },
    ]) {
      const changed = structuredClone(plan);
      Object.assign(changed.cases[0].executionInfo, change);
      expect(documentPlanIssues(changed).length).toBeGreaterThan(0);
    }
    const changed = structuredClone(plan);
    changed.workflow.limits.maxCases = 0;
    changed.workflow.allowedOperationIds = 'invalid';
    expect(documentPlanIssues(changed).join('；')).toContain('maxCases');
  });
  it('requires original source evidence and leaves unknown rules pending', () => {
    const changed = structuredClone(plan);
    changed.workflow.rules[0].evidence = '编造 200';
    changed.workflow.questions = ['不存在的 id 应返回什么？'];
    expect(documentPlanIssues(changed).join('；')).toContain('原文');
    expect(documentPlanIssues(changed).join('；')).toContain('待确认');
    changed.workflow.document = null;
    expect(documentPlanIssues(changed)).toEqual(['缺少接口文档来源']);
  });
  it('deduplicates equivalent objects, header names and assertion ordering', () => {
    const spec = {
      ...plan.cases[0].executionInfo,
      query: { a: '1', b: '2' },
      headers: { Accept: 'application/json' },
      assertions: [
        { type: 'status', expected: 200 },
        { type: 'jsonExists', path: '/id' },
      ],
    };
    expect(caseFingerprint(spec)).toBe(
      caseFingerprint({
        ...spec,
        query: { b: '2', a: '1' },
        headers: { accept: 'application/json' },
        assertions: [...spec.assertions].reverse(),
      })
    );
    expect(caseFingerprint(spec)).not.toBe(caseFingerprint({ ...spec, path: '/items/2' }));
  });
  it('keeps failures and budget stops visible instead of reporting acceptance from all-green counts', () => {
    const task = {
      state: 'completed',
      plan: structuredClone(plan),
      results: [{ caseId: 1, request: {}, status: 'passed' }],
    };
    task.plan.workflow.stopReason = 'no_new_cases';
    expect(documentAcceptance(task).verdict).toBe('passed');
    task.plan.workflow.stopReason = 'max_rounds';
    expect(documentAcceptance(task).verdict).toBe('inconclusive');
    task.results[0].status = 'failed';
    expect(documentAcceptance(task)).toMatchObject({ verdict: 'failed', failedCaseIds: [1] });
    task.results = [];
    expect(documentAcceptance(task).uncoveredRules).toHaveLength(1);
  });
});
