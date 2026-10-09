import express from 'express';
import { DataTypes } from 'sequelize';
import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import { create } from 'xmlbuilder2';
import defineRun from '../../models/runs.js';
import defineRunCase from '../../models/runCases.js';
import defineCase from '../../models/cases.js';
import defineFolder from '../../models/folders.js';
import defineTag from '../../models/tags.js';
import authMiddleware from '../../middleware/auth.js';
import visibilityMiddleware from '../../middleware/verifyVisible.js';
import { contentDisposition, toSafeFileName } from '../../config/contentDisposition.js';
import { testRunCaseStatus, testRunStatus, priorities, automationStatus } from '../../config/enums.js';
import { getCaseTypeNames } from '../../utils/caseTypes.js';
import editableMiddleware from '../../middleware/verifyEditable.js';
import defineAgentTask from '../../models/agentTasks.js';
import { reportSummary } from '../../agent/plan.js';
import { redact } from '../../agent/execution.js';
import { modelMeasurements, executionMeasurements } from '../../agent/measurements.js';
import { documentAcceptance } from '../../agent/documentPlan.js';
import { protectConfiguration } from '../../agent/credentials.js';

export default function (sequelize) {
  const router = express.Router();
  const { verifySignedIn } = authMiddleware(sequelize);
  const { verifyProjectVisibleFromRunId } = visibilityMiddleware(sequelize);
  const { verifyProjectReporterFromRunId } = editableMiddleware(sequelize);
  const AgentTask = defineAgentTask(sequelize, DataTypes);

  const Run = defineRun(sequelize, DataTypes);
  const RunCase = defineRunCase(sequelize, DataTypes);
  const Case = defineCase(sequelize, DataTypes);
  const Folder = defineFolder(sequelize, DataTypes);
  const Tags = defineTag(sequelize, DataTypes);

  RunCase.belongsTo(Case, { foreignKey: 'caseId' });
  Case.belongsToMany(Tags, { through: 'caseTags', foreignKey: 'caseId', otherKey: 'tagId' });
  Tags.belongsToMany(Case, { through: 'caseTags', foreignKey: 'tagId', otherKey: 'caseId' });

  router.get(
    '/download/:runId',
    verifySignedIn,
    verifyProjectVisibleFromRunId,
    (req, res, next) =>
      req.query.agentTaskId !== undefined ? verifyProjectReporterFromRunId(req, res, next).catch(next) : next(),
    async (req, res) => {
      const { runId } = req.params;
      const { type } = req.query;

      if (!runId) {
        return res.status(400).json({ error: 'runId is required' });
      }

      try {
        const run = await Run.findByPk(runId);
        if (!run) {
          return res.status(404).send('Run not found');
        }

        if (req.query.agentTaskId !== undefined) {
          if (type !== 'xlsx' || typeof req.query.agentTaskId !== 'string' || !/^[1-9]\d*$/.test(req.query.agentTaskId))
            return res.status(400).json({ error: 'Agent 报告需要有效的 agentTaskId 和 type=xlsx' });
          const task = await AgentTask.findOne({ where: { id: req.query.agentTaskId, runId } });
          if (!task) return res.status(404).json({ error: '执行记录不属于此测试运行或已删除' });
          const workbook = new ExcelJS.Workbook();
          workbook.creator = 'Auto-test';
          workbook.title = `Agent 测试报告 #${task.id}`;
          const summary = reportSummary(task);
          const timings = executionMeasurements(task);
          const overview = workbook.addWorksheet('执行概览');
          overview.addRows([
            ['项目', '记录'],
            ['测试运行', run.name],
            ['运行编号', run.id],
            ['Agent 任务编号', task.id],
            ['任务状态', task.state],
            ['执行来源', 'Agent'],
            ['模型', task.plan.model || '未记录'],
            ['模型接口', task.plan.provider || '未记录'],
            ['创建时间', task.createdAt.toISOString()],
            ['开始时间', task.startedAt?.toISOString() || '尚未开始'],
            ['结束时间', task.finishedAt?.toISOString() || '尚未结束'],
            ['测试范围（用例编号）', task.plan.cases.map((item) => item.caseId).join(', ')],
            ['计划说明与业务规则补充', task.plan.notes || ''],
            ['测试环境（敏感值已隐藏）', JSON.stringify(redact(task.plan.environment), null, 2)],
            ['用例总数', summary.total],
            ['通过', summary.passed],
            ['失败（含请求异常）', summary.failed],
            ['未执行（含跳过）', summary.unexecuted],
            ['请求异常', summary.requestErrors],
            ['任务错误', task.error || ''],
            ['统计依据', '仅使用本次持久化执行记录，不使用当前人工状态或模型提供的数字'],
            ['HTTP 与断言累计耗时(ms)', timings.requests.durationMs ?? '未记录'],
            ['HTTP 计时覆盖（已记录/请求数）', `${timings.requests.recorded}/${timings.requests.total}`],
            ['保存与回填累计耗时(ms)', timings.persistence.durationMs ?? '未记录'],
            ['回填计时覆盖（已记录/结果数）', `${timings.persistence.recorded}/${timings.persistence.total}`],
            ['报告整理耗时(ms)', timings.reportDurationMs ?? '未记录'],
            [
              '耗时口径',
              'HTTP 包含响应读取和断言；保存与回填包含证据事务提交，不含计量日志写入；报告从首次读取完整结果至报告保存，包含期间模型等待。各项与模型耗时可能重叠，不能相加视为人工劳动时间。缺失计时不按零处理。',
            ],
          ]);
          overview.columns = [{ width: 32 }, { width: 110 }];
          const cases = workbook.addWorksheet('用例结果');
          cases.addRow([
            '用例编号',
            '执行时标题',
            '结果',
            '耗时(ms)',
            '失败或未执行原因',
            '原预期（摘要）',
            '断言结果（摘要）',
            '回填原运行',
          ]);
          cases.columns = [
            { width: 12 },
            { width: 38 },
            { width: 16 },
            { width: 14 },
            { width: 60 },
            { width: 60 },
            { width: 70 },
            { width: 16 },
          ];
          const evidence = workbook.addWorksheet('完整执行证据');
          evidence.addRow(['用例编号', '内容', '分段', 'JSON 内容（按分段顺序拼接）']);
          evidence.columns = [{ width: 12 }, { width: 22 }, { width: 12 }, { width: 110 }];
          const labels = { passed: '通过', failed: '失败', error: '请求异常', skipped: '未执行' };
          for (const item of task.plan.cases) {
            const result = task.results.find((entry) => entry.caseId === item.caseId);
            cases.addRow([
              item.caseId,
              result?.title || item.title,
              labels[result?.status] || '未执行',
              result?.durationMs ?? '',
              (result?.reason || (result ? '' : '尚无执行记录')).slice(0, 2000),
              String(result?.snapshot?.expectedResults || item.expectedResults || '').slice(0, 2000),
              JSON.stringify(result?.assertions || []).slice(0, 2000),
              result ? (result.mappedToRun ? '是' : '否') : '',
            ]);
            for (const [name, value] of Object.entries({
              用例与预期快照: result?.snapshot || item,
              请求: result?.request ?? null,
              实际响应: result?.response ?? null,
              断言与差异: result?.assertions || [],
              执行信息: {
                status: result?.status || 'unexecuted',
                reason: result?.reason ?? '尚无执行记录',
                startedAt: result?.startedAt,
                finishedAt: result?.finishedAt,
                durationMs: result?.durationMs,
              },
            })) {
              const text = JSON.stringify(redact(value), null, 2);
              // Excel limits cells to 32767 characters. Keep complete evidence in ordered chunks.
              for (let offset = 0; offset < text.length; offset += 30000)
                evidence.addRow([item.caseId, name, offset / 30000 + 1, text.slice(offset, offset + 30000)]);
            }
          }
          const analysis = workbook.addWorksheet('AI 分析');
          analysis.addRows([
            ['说明', '内容'],
            ['性质', 'AI 分析属于待核实推测；已确认的事实以用例结果和完整执行证据为准。'],
            ['模型总结与原因推测', task.analysis || '尚未生成分析，已有执行记录仍可查看。'],
          ]);
          analysis.columns = [{ width: 30 }, { width: 110 }];
          const usage = workbook.addWorksheet('模型用量');
          usage.addRow([
            '说明',
            '次数包含失败或中断的调用；耗时为客户端等待模型的时长。仅汇总接口已返回的 Token，缺失不按 0 计算；旧任务未采集的数值不补估。',
          ]);
          usage.addRow([
            '阶段',
            '调用次数',
            '成功响应',
            '失败响应',
            '已记录耗时(ms)',
            '已计时调用数',
            '输入 Token',
            '输入已记录次数',
            '输出 Token',
            '输出已记录次数',
            '总 Token',
            '总 Token 已记录次数',
          ]);
          for (const measurement of modelMeasurements(task.events)) {
            usage.addRow([
              measurement.phase === 'prepare' ? '准备' : '执行',
              measurement.calls,
              measurement.completedCalls,
              measurement.failedCalls,
              measurement.durationMs ?? '未记录',
              measurement.timedCalls,
              ...['prompt_tokens', 'completion_tokens', 'total_tokens'].flatMap((field) => [
                measurement.tokens[field].value ?? '未记录',
                measurement.tokens[field].recordedCalls,
              ]),
            ]);
          }
          usage.addRow([]);
          usage.addRow([
            '阶段',
            '序号',
            '开始时间',
            '结束时间',
            '结果',
            '耗时(ms)',
            '输入 Token',
            '输出 Token',
            '总 Token',
          ]);
          for (const event of task.events.filter((entry) => entry.type === 'model')) {
            usage.addRow([
              event.phase,
              event.call,
              event.at,
              event.finishedAt || '未记录',
              event.outcome || '未记录',
              event.durationMs ?? '未记录',
              event.usage?.prompt_tokens ?? '未记录',
              event.usage?.completion_tokens ?? '未记录',
              event.usage?.total_tokens ?? '未记录',
            ]);
          }
          usage.columns = Array.from({ length: 12 }, (_, index) => ({ width: index === 0 ? 18 : 24 }));
          if (task.plan.workflow) {
            const acceptance = documentAcceptance(task);
            const workflow = task.plan.workflow;
            const document = workbook.addWorksheet('文档验收');
            document.columns = [{ width: 26 }, { width: 12 }, { width: 115 }];
            document.addRows([
              ['内容', '分段', '记录（同一内容按分段顺序拼接）'],
              ['验收判定', 1, acceptance.verdict],
              ['停止原因', 1, acceptance.stopReason || '尚未停止'],
              ['规则覆盖', 1, `${acceptance.coveredRules.length}/${acceptance.ruleCount}（实际断言，含失败）`],
              [
                '判定口径',
                1,
                '仅对已确认规则判定；预算耗尽、中断和待确认不能视为完整验收。原始失败不因补测通过而消除。',
              ],
            ]);
            for (const [name, value] of Object.entries({
              文档来源: workflow.document,
              用户确认记录: workflow.confirmed || null,
              规则与依据: workflow.rules,
              执行范围及预算: { allowedOperationIds: workflow.allowedOperationIds, limits: workflow.limits },
              各轮生成与补测原因: workflow.rounds,
              用例来源与轮次: task.plan.cases.map((item) => ({
                caseId: item.caseId,
                title: item.title,
                key: item.key,
                purpose: item.purpose,
                scenario: item.scenario,
                ruleIds: item.ruleIds,
                round: item.round,
                reason: item.reason,
                evidenceCaseIds: item.evidenceCaseIds,
              })),
              排除的用例: workflow.excludedCases || [],
              待确认内容: workflow.pending || { questions: workflow.questions },
              验收与未完成内容: acceptance,
            })) {
              const text = JSON.stringify(protectConfiguration(redact(value)), null, 2);
              for (let offset = 0; offset < text.length; offset += 30000)
                document.addRow([name, offset / 30000 + 1, text.slice(offset, offset + 30000)]);
            }
          }
          for (const sheet of workbook.worksheets) {
            sheet.views = [{ state: 'frozen', ySplit: 1 }];
            sheet.getRow(1).font = { bold: true };
            sheet.eachRow((row) =>
              row.eachCell((cell) => {
                cell.alignment = { vertical: 'top', wrapText: true };
              })
            );
          }
          res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
          res.setHeader('Content-Disposition', contentDisposition(`Agent测试报告-${task.id}.xlsx`));
          res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          return res.send(Buffer.from(await workbook.xlsx.writeBuffer()));
        }

        const runName = toSafeFileName(run.name);
        const filename = type === 'xlsx' ? '系统测试报告.xlsx' : `${runName}.${type}`;
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
        res.setHeader('Content-Disposition', contentDisposition(filename));

        if (type === 'xlsx') {
          const [folders, detailedRunCases] = await Promise.all([
            Folder.findAll({ where: { projectId: run.projectId }, order: [['id', 'ASC']] }),
            RunCase.findAll({
              where: { runId },
              include: [{ model: Case, attributes: ['id', 'caseNo', 'folderId', 'title'] }],
            }),
          ]);

          const workbook = new ExcelJS.Workbook();
          workbook.creator = 'Test-platfrom';
          workbook.title = '系统测试报告';
          workbook.subject = '测试运行报告';
          workbook.created = new Date();
          const reportFolders = folders.length > 0 ? folders : [{ id: null, name: '测试报告' }];
          const caseStatusLabels = ['未测试', '通过', '失败', '重测', '跳过'];

          for (const folder of reportFolders) {
            let sheetName = String(folder.name || '未命名文件夹')
              .replace(/[:\\/?*\[\]]/g, '_')
              .replace(/^'+|'+$/g, '')
              .trim();
            sheetName = (sheetName || '未命名文件夹').slice(0, 31);
            const baseSheetName = sheetName;
            let duplicateIndex = 2;
            while (workbook.worksheets.some((worksheet) => worksheet.name === sheetName)) {
              const suffix = ` (${duplicateIndex})`;
              sheetName = `${baseSheetName.slice(0, 31 - suffix.length)}${suffix}`;
              duplicateIndex += 1;
            }

            const folderRunCases =
              folder.id == null
                ? []
                : detailedRunCases
                    .filter((runCase) => Number(runCase.Case.folderId) === Number(folder.id))
                    .sort(
                      (left, right) =>
                        Number(left.Case.caseNo ?? left.Case.id) - Number(right.Case.caseNo ?? right.Case.id)
                    );

            const worksheet = workbook.addWorksheet(sheetName, {
              views: [{ state: 'frozen', ySplit: 1 }],
              pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
            });

            const headerRow = worksheet.addRow(['测试标题', '测试类型', '结果']);
            headerRow.height = 24;
            headerRow.eachCell((cell) => {
              cell.font = { name: 'SimSun', bold: true, color: { argb: 'FF000000' } };
              cell.alignment = { horizontal: 'center', vertical: 'middle' };
              cell.border = {
                top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
                left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
                bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
                right: { style: 'thin', color: { argb: 'FFD9D9D9' } },
              };
            });

            for (const runCase of folderRunCases) {
              const result = caseStatusLabels[runCase.status] || testRunCaseStatus[runCase.status] || runCase.status;
              const row = worksheet.addRow([runCase.Case.title, sheetName, result]);
              row.height = 24;
              row.eachCell((cell) => {
                cell.font = { name: 'SimSun', size: 10, color: { argb: 'FF000000' } };
                cell.alignment = { vertical: 'middle', wrapText: true };
                cell.border = {
                  top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
                  left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
                  bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
                  right: { style: 'thin', color: { argb: 'FFD9D9D9' } },
                };
              });
              row.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };
              row.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };
              row.getCell(3).font = { name: 'SimSun', size: 10, bold: true, color: { argb: 'FF000000' } };
            }

            worksheet.columns = [{ width: 62 }, { width: 24 }, { width: 16 }];
            worksheet.autoFilter = { from: 'A1', to: `C${Math.max(worksheet.rowCount, 1)}` };
          }

          const output = await workbook.xlsx.writeBuffer();
          res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          return res.send(Buffer.from(output));
        }

        const runCases = await RunCase.findAll({
          where: { runId },
          include: [
            {
              model: Case,
              include: [
                {
                  model: Tags,
                  attributes: ['id', 'name'],
                  through: { attributes: [] },
                },
              ],
            },
          ],
        });

        if (type === 'xml') {
          // JUnit xml valid status
          const validStatuses = [1, 2, 4]; // 0: untested, 1: passed, 2 failed, 3: retest, 4: skipped
          const filteredRunCases = runCases.filter((rc) => validStatuses.includes(rc.status));

          // group cases by folder
          const folderMap = new Map();
          for (const rc of filteredRunCases) {
            const folderId = rc.Case.folderId;
            if (!folderMap.has(folderId)) {
              folderMap.set(folderId, []);
            }
            folderMap.get(folderId).push(rc);
          }

          // Construct JUnit xml
          const xml = create({ version: '1.0' });
          const root = xml.ele('testsuites');

          for (const [folderId, cases] of folderMap.entries()) {
            let folderName = '';
            const folder = await Folder.findByPk(folderId);
            if (folder) {
              folderName = folder.name;
            }

            const suite = root.ele('testsuite', {
              name: folderName,
              tests: cases.length,
              failures: cases.filter((c) => c.status === 2).length,
              skipped: cases.filter((c) => c.status === 4).length,
            });

            for (const rc of cases) {
              const testCase = suite.ele('testcase', {
                name: rc.Case.title,
                classname: folderName,
                time: '0',
              });

              if (rc.status === 2) {
                testCase.ele('failure', { message: 'Test failed' }).txt('Test case failed.');
              } else if (rc.status === 4) {
                testCase.ele('skipped', { message: 'skipped' });
              }
            }
          }

          const xmlString = xml.end({ prettyPrint: true });

          res.setHeader('Content-Type', 'application/xml');
          return res.send(xmlString);
        } else if (type === 'json') {
          return res.json(runCases);
        } else if (type === 'csv') {
          const caseTypeNames = await getCaseTypeNames(sequelize, run.projectId);
          const records = runCases.map((rc) => ({
            id: rc.Case.id,
            title: rc.Case.title,
            state: testRunStatus[rc.Case.state] || rc.Case.state,
            priority: priorities[rc.Case.priority] || rc.Case.priority,
            type: caseTypeNames[rc.Case.type] || rc.Case.type,
            automationStatus: automationStatus[rc.Case.automationStatus] || rc.Case.automationStatus,
            tags: rc.Case.Tags && rc.Case.Tags.length > 0 ? rc.Case.Tags.map((tag) => tag.name).join(', ') : '',
            status: testRunCaseStatus[rc.status] || rc.status,
          }));

          const csv = Papa.unparse(records, {
            quotes: true,
            skipEmptyLines: true,
          });

          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          return res.send(csv);
        }

        return res.status(400).json({ error: 'Unsupported type. Use ?type=xml, ?type=json, ?type=csv, or ?type=xlsx' });
      } catch (error) {
        console.error(error);
        res.status(500).send('Internal Server Error');
      }
    }
  );

  return router;
}
