---
sidebar_position: 3
---

# Running Test-platfrom from Source

This chapter explains how to run Test-platfrom directly from source. The frontend and backend run separately and require a PostgreSQL database.

:::info[Prerequisite]

Prerequisite: v22 or higher node must be installed.

:::

To use Test-platfrom, you need to run both frontend server and backend(API) server.

First, clone the repository.

```bash
git clone https://github.com/moliason/Test-platfrom.git
```

## Start a local database

Run the PostgreSQL service from the repository root:

```bash
docker compose up -d --wait postgres
```

The database is available at `127.0.0.1:5433`. Its default database name, username, and password are all `unittcms`. Data is stored in the `postgres-data` Docker volume.

## Run backend server

Copy `backend/.env.example` to `backend/.env`. With the default Docker database settings, use:

```.env title="backend/.env"
FRONTEND_ORIGIN=http://localhost:8000
PORT=8001
DATABASE_URL=postgres://unittcms:unittcms@127.0.0.1:5433/unittcms
SECRET_KEY=change-this-key-for-local-development
```

Move to backend directory, then install dependencies.

```bash
cd backend
npm install
```

Build backend code.

```bash
npm run build
```

Initialize the database with the following command.

```bash
npm run migrate
```

Start backend server.

```bash
npm run start
```

### AI case drafts (DeepSeek)

Set `DEEPSEEK_API_KEY` in the backend environment or `backend/.env`, then restart the backend.
`DEEPSEEK_MODEL` defaults to `deepseek-flash`. Never put the key in frontend configuration.

In a project's case folder, choose **AI case drafts** (中文：**AI 生成用例**). Enter text requirements to generate up to six drafts.
Review and edit titles, priorities, preconditions, steps and expected results, remove unwanted cases, then check the review box and save.
Missing business rules are marked for confirmation. The generated cases use the existing step template; they are not automatically executed.
Only project members with case editing permission can generate or save drafts. Saving inserts all cases and steps in one database transaction.

The backend exposes `POST /cases/ai/generate?folderId=...` with `{ "requirements": "..." }`,
and `POST /cases/ai/save?folderId=...` with `{ "cases": [...], "reviewed": true }`. Both require the existing bearer token.
Generation has a 60-second timeout and does not write to the database. Unsaved drafts are discarded when the dialog is closed.

## Run frontend server

Move to frontend directory, then install dependencies.

Place the .env file at `frontend/.env`.

```.env title="frontend/.env"
NEXT_PUBLIC_BACKEND_ORIGIN=http://localhost:8001
```

```bash
cd frontend
npm install
```

Build frontend code

```bash
npm run build
```

Start frontend server

```bash
npm run start
```
