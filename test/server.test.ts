import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApp, listen } from "../src/server.js";
import { openDatabase } from "../src/db.js";

const dbPath = join(tmpdir(), `rho-http-${process.pid}-${Date.now()}.sqlite`);
let server: Server;
let base: string;
let db: ReturnType<typeof openDatabase>;

before(async () => {
  db = openDatabase(dbPath);
  server = createApp(db);
  const port = await listen(server, 0);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  db.close();
  rmSync(dbPath, { force: true });
  rmSync(dbPath + "-wal", { force: true });
  rmSync(dbPath + "-shm", { force: true });
});

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: init?.body,
  });
  return { status: res.status, body: await res.json() };
}

test("完整 HTTP 流程", async () => {
  const health = await api("/health");
  assert.equal(health.status, 200);

  const created = await api("/searches", { method: "POST", body: JSON.stringify({ n: "8051" }) });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const solved = await api(`/searches/${id}/solve`, {
    method: "POST",
    body: JSON.stringify({ budgetIterations: 1000, maxAttempts: 10, explainStepLimit: 5 }),
  });
  assert.equal(solved.status, 201);
  assert.equal(solved.body.found, 1);
  const reportId = solved.body.id;

  const steps = await api(`/reports/${reportId}/attempts/0/steps`);
  assert.equal(steps.status, 200);
  assert.ok(Array.isArray(steps.body));

  const verify = await api(`/searches/${id}/verify`, { method: "POST", body: JSON.stringify({ factor: "97" }) });
  assert.equal(verify.body.ok, true);

  const exported = await api(`/reports/${reportId}/export`);
  assert.equal(exported.body.search.n, "8051");

  const tampered = await api(`/searches/${id}/verify`, { method: "POST", body: JSON.stringify({ factor: "100" }) });
  assert.equal(tampered.body.ok, false);
});

test("非法输入返回 422 与明确错误码", async () => {
  const r = await api("/searches", { method: "POST", body: JSON.stringify({ n: "abc" }) });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, "INVALID_DECIMAL");

  const r2 = await api("/searches", { method: "POST", body: JSON.stringify({ n: "9223372036854775808" }) });
  assert.equal(r2.status, 422);
  assert.equal(r2.body.error.code, "N_ABOVE_LIMIT");
});
