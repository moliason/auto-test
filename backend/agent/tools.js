export const readCasesTool = {
  type: 'function',
  function: {
    name: 'read_cases',
    description:
      'Read the selected test cases, their execution configuration and environment. No HTTP requests are sent.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

export const documentCasesTool = {
  type: 'function',
  function: {
    name: 'submit_document_cases',
    description:
      'Generate initial document cases for human review, or propose NEW cases after reading execution evidence. Never change frozen rules. Empty cases means no new validation points. For missing business rules supply questions and stop. Cite rule IDs and actual evidence IDs; use stable keys for dependencies.',
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description:
            'Initial preparation only. Each item: id, method, path, evidence (exact source quote including method/path for Markdown).',
          items: { type: 'object' },
        },
        rules: {
          type: 'array',
          description:
            'Initial preparation only. Each item: id, operationId, description (include applicability/input conditions), evidence (exact source quote), assertion (one status/jsonEquals/jsonExists assertion). Every expected value MUST appear in evidence. No invented rules.',
          items: { type: 'object' },
        },
        reason: {
          type: 'string',
          description:
            'Why these scenarios are needed, based on source rules or actual execution evidence. In Chinese.',
        },
        questions: { type: 'array', items: { type: 'string' } },
        cases: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              title: { type: 'string' },
              purpose: { type: 'string' },
              scenario: { type: 'string', enum: ['normal', 'abnormal', 'boundary'] },
              ruleIds: { type: 'array', items: { type: 'string' } },
              evidenceCaseIds: { type: 'array', items: { type: 'integer' } },
              dependsOnKeys: { type: 'array', items: { type: 'string' } },
              executionInfo: { anyOf: [{ type: 'object' }, { type: 'null' }] },
              questions: { type: 'array', items: { type: 'string' } },
            },
            required: [
              'key',
              'title',
              'purpose',
              'scenario',
              'ruleIds',
              'evidenceCaseIds',
              'dependsOnKeys',
              'executionInfo',
              'questions',
            ],
            additionalProperties: false,
          },
        },
      },
      required: ['cases', 'reason', 'questions'],
      additionalProperties: false,
    },
  },
};

export const prepareTools = [
  readCasesTool,
  {
    type: 'function',
    function: {
      name: 'submit_plan',
      description:
        'Submit a draft for human review. Include every selected case. Preserve known rules, use null/missing fields and specific questions for unknown information. This NEVER executes tests.',
      parameters: {
        type: 'object',
        properties: {
          cases: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                caseId: { type: 'integer' },
                executionInfo: { anyOf: [{ type: 'object' }, { type: 'null' }] },
                questions: { type: 'array', items: { type: 'string' } },
              },
              required: ['caseId', 'executionInfo', 'questions'],
              additionalProperties: false,
            },
          },
          notes: { type: 'string' },
        },
        required: ['cases', 'notes'],
        additionalProperties: false,
      },
    },
  },
];

export const executionTools = [
  readCasesTool,
  {
    type: 'function',
    function: {
      name: 'execute_case',
      description:
        'Execute one human-confirmed case by ID. Execute prerequisites first. Already executed cases are never sent twice. You cannot change the request or assertions.',
      parameters: {
        type: 'object',
        properties: { caseId: { type: 'integer' } },
        required: ['caseId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_results',
      description:
        'Read actual execution evidence and program-computed statistics. Call after all execution attempts before submitting the analysis.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_report',
      description:
        'Finish the task with an analysis based only on get_results. Mark suspected causes as hypotheses, cite case IDs, and acknowledge missing evidence. Never invent statistics or outcomes.',
      parameters: {
        type: 'object',
        properties: { analysis: { type: 'string' } },
        required: ['analysis'],
        additionalProperties: false,
      },
    },
  },
];
