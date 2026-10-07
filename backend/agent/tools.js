export const readCasesTool = {
  type: 'function',
  function: {
    name: 'read_cases',
    description:
      'Read the selected test cases, their execution configuration and environment. No HTTP requests are sent.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
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
