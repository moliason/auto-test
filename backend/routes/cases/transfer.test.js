import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createAgentDatabase } from '../../agent/database.fixture.js';
import moveRoute from './move.js';
import cloneRoute from './clone.js';
import editRoute from './edit.js';
import folderCloneRoute from '../folders/clone.js';
import { buildPlan } from '../../agent/plan.js';

let db, app;
const auth = (userId = 1) => `Bearer ${jwt.sign({ userId }, 'transfer-test')}`;
beforeEach(async () => {
  vi.stubEnv('SECRET_KEY', 'transfer-test');
  db = await createAgentDatabase();
  await db.models.Folder.create({ id: 3, name: 'Own target', projectId: 1 });
  await db.models.Case.bulkCreate(
    [1, 2].map((id) => ({
      id,
      folderId: id,
      caseNo: 1,
      title: `Private ${id}`,
      state: 0,
      priority: 1,
      type: 0,
      automationStatus: 0,
      template: 0,
    }))
  );
  app = express();
  app.use(express.json());
  app.use('/cases', moveRoute(db), cloneRoute(db), editRoute(db));
  app.use('/folders', folderCloneRoute(db));
});
afterEach(async () => {
  await db.close();
  vi.unstubAllEnvs();
});

describe('project-scoped case transfers', () => {
  it.each(['cases', 'folders'])(
    'remaps copied dependencies across a %s copy without changing originals',
    async (mode) => {
      await db.models.Case.update(
        {
          executionInfo: {
            method: 'POST',
            path: '/login',
            assertions: [{ type: 'status', expected: 200 }],
            extract: [{ name: 'TOKEN', path: '/token' }],
          },
        },
        { where: { id: 1 } }
      );
      await db.models.Case.create({
        id: 3,
        folderId: 1,
        caseNo: 2,
        title: 'Query',
        state: 0,
        priority: 1,
        type: 0,
        automationStatus: 0,
        template: 0,
        executionInfo: {
          method: 'GET',
          path: '/profile',
          headers: { Authorization: 'Bearer {{TOKEN}}' },
          dependsOn: [1],
          assertions: [{ type: 'status', expected: 200 }],
        },
      });
      const response =
        mode === 'cases'
          ? await request(app)
              .post('/cases/clone?projectId=1')
              .set('Authorization', auth())
              .send({ caseIds: [3, 1], targetFolderId: 3 })
          : await request(app).post('/folders/1/clone').set('Authorization', auth()).send({ targetFolderId: 3 });
      expect(response.status).toBe(mode === 'cases' ? 200 : 201);
      const copied = (await db.models.Case.findAll()).filter((item) => item.id > 3);
      expect(copied).toHaveLength(2);
      const login = copied.find((item) => item.title === 'Private 1');
      const query = copied.find((item) => item.title === 'Query');
      expect(query.executionInfo.dependsOn).toEqual([login.id]);
      expect((await db.models.Case.findByPk(3)).executionInfo.dependsOn).toEqual([1]);
      vi.stubEnv('TEST_AGENT_ALLOWED_ORIGINS', 'http://127.0.0.1:4010');
      expect(
        buildPlan(
          copied.map((item) => ({ ...item.toJSON(), caseId: item.id })),
          { baseUrl: 'http://127.0.0.1:4010' }
        ).issues
      ).toEqual([]);
    }
  );
  for (const [method, action] of [
    ['put', 'move'],
    ['post', 'clone'],
  ]) {
    it(`${action} rejects foreign sources and targets without changing any case`, async () => {
      for (const body of [
        { caseIds: [2], targetFolderId: 3 },
        { caseIds: [1], targetFolderId: 2 },
        { caseIds: [1, 2], targetFolderId: 3 },
      ]) {
        const response = await request(app)
          [method](`/cases/${action}?projectId=1`)
          .set('Authorization', auth())
          .send(body);
        expect(response.status).toBe(403);
        expect(await db.models.Case.count()).toBe(2);
        expect((await db.models.Case.findByPk(2)).folderId).toBe(2);
        expect((await db.models.Case.findByPk(1)).folderId).toBe(1);
      }
    });
    it(`${action} allows a project developer and rejects a reporter`, async () => {
      const path = `/cases/${action}?projectId=1`;
      expect(
        (
          await request(app)
            [method](path)
            .set('Authorization', auth(3))
            .send({ caseIds: [1], targetFolderId: 3 })
        ).status
      ).toBe(403);
      expect(
        (
          await request(app)
            [method](path)
            .set('Authorization', auth(4))
            .send({ caseIds: [1], targetFolderId: 3 })
        ).status
      ).toBe(200);
      expect(await db.models.Case.count({ where: { folderId: 3 } })).toBe(1);
    });
  }
  it('ordinary case edits cannot bypass the transfer permission check', async () => {
    const response = await request(app).put('/cases/1').set('Authorization', auth()).send({ folderId: 2 });
    expect(response.status).toBe(400);
    expect((await db.models.Case.findByPk(1)).folderId).toBe(1);
    expect(
      (
        await request(app).put('/cases/1').set('Authorization', auth()).send({
          id: 1,
          folderId: 1,
          caseNo: 1,
          title: 'Edited',
        })
      ).status
    ).toBe(200);
  });
  it('folder cloning cannot write cases into a foreign project', async () => {
    expect(
      (await request(app).post('/folders/1/clone').set('Authorization', auth()).send({ targetFolderId: 2 })).status
    ).toBe(403);
    expect(await db.models.Case.count()).toBe(2);
  });
});
