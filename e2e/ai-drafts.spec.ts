import { test, expect } from '@playwright/test';

test('review, edit, retry saving and discard AI drafts across screen sizes', async ({ page }) => {
  const draft = {
    title: '错误密码登录',
    description: '检查错误密码被拒绝',
    priority: 1,
    preConditions: '存在测试账号',
    expectedResults: '提示登录失败',
    steps: [{ step: '输入错误密码并提交', result: '提示登录失败' }],
  };
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let saveRequests = 0;
  let generated = 0;
  let savedCases: Record<string, unknown>[] = [];
  await page.addInitScript(() =>
    localStorage.setItem(
      'unittcms-auth-token',
      JSON.stringify({
        access_token: 'ui-test-token',
        expires_at: Date.now() + 3600000,
        user: { id: 1, username: 'Tester', email: 'tester@example.test', role: 0, avatarPath: null, locale: 'zh-CN' },
      })
    )
  );
  await page.route(
    (url) =>
      url.origin === new URL(process.env.E2E_API_URL || 'http://localhost:8011').origin ||
      url.pathname.startsWith('/api/'),
    async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/api/, '');
      let data: unknown = [];
      if (path === '/projects/1') data = { id: 1, name: 'AI 测试项目', userId: 1, isPublic: false };
      if (path === '/folders') data = [{ id: 1, name: '登录模块', projectId: 1, parentFolderId: null }];
      if (path === '/members/check') data = [{ projectId: 1, isOwner: true, role: 0 }];
      if (path === '/cases') data = savedCases;
      if (path === '/cases/ai/generate') {
        generated++;
        expect(route.request().postDataJSON()).toEqual({ requirements: '密码错误时拒绝登录' });
        data = { cases: [draft, { ...draft, title: '待移除草稿' }] };
      }
      if (path === '/cases/ai/save') {
        saveRequests++;
        if (saveRequests === 1) {
          await route.fulfill({ status: 500, json: { code: 'saveFailed' } });
          return;
        }
        const body = route.request().postDataJSON();
        expect(body.reviewed).toBe(true);
        expect(body.cases).toHaveLength(1);
        expect(body.cases[0]).toMatchObject({
          title: '已编辑登录用例',
          priority: 2,
          steps: [{ step: '提交错误密码', result: '提示登录失败' }],
        });
        savedCases = body.cases.map((item: Record<string, unknown>) => ({
          ...item,
          id: 1,
          caseNo: 1,
          folderId: 1,
          state: 0,
          template: 1,
          type: 0,
          automationStatus: 1,
        }));
        data = { cases: savedCases };
      }
      if (path === '/cases/1') data = { ...savedCases[0], Steps: [], Tags: [], Attachments: [] };
      await route.fulfill({ json: data });
    }
  );
  await page.goto('/zh-CN/projects/1/folders/1/cases');
  await page.getByRole('button', { name: 'AI 生成用例', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '生成草稿', exact: true })).toBeDisabled();
  await dialog.getByLabel('需求／业务描述').fill('密码错误时拒绝登录');
  await dialog.getByRole('button', { name: '生成草稿', exact: true }).click();
  await expect(dialog.getByLabel('用例名称').first()).toHaveValue('错误密码登录');
  expect(saveRequests).toBe(0);
  await dialog.getByRole('button', { name: '移除此用例' }).nth(1).click();
  const save = dialog.getByRole('button', { name: '保存到当前目录' });
  const review = dialog.getByRole('checkbox');
  await expect(save).toBeDisabled();
  await review.check();
  await dialog.getByLabel('用例名称').fill('已编辑登录用例');
  await expect(review).not.toBeChecked();
  await dialog.getByLabel('1. 测试步骤').fill('提交错误密码');
  await dialog.getByRole('combobox', { name: /优先级/ }).selectOption('2');
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: `playwright-screenshots/ai-drafts-${width}.png` });
  }
  await review.check();
  await save.click();
  await expect(dialog.getByRole('alert')).toContainText('保存失败');
  await expect(dialog.getByLabel('用例名称')).toHaveValue('已编辑登录用例');
  await save.click();
  await expect(dialog).not.toBeVisible();
  expect(savedCases).toHaveLength(1);
  expect(saveRequests).toBe(2);
  expect(generated).toBe(1);
  await page.getByRole('button', { name: 'AI 生成用例', exact: true }).click();
  await expect(dialog.getByLabel('需求／业务描述')).toHaveValue('');
  await dialog.getByRole('button', { name: '关闭（草稿不保存）' }).click();
  await expect(dialog).not.toBeVisible();
  expect(errors).toEqual([]);
});
