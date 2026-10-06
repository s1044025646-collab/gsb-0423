import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../src/db.js";
import { FactorService, ALGORITHM_VERSION } from "../src/service.js";
import { AppError, ErrorCode } from "../src/errors.js";

const dbPath = join(tmpdir(), `rho-test-${process.pid}-${Date.now()}.sqlite`);
let db: DB;
let service: FactorService;

before(() => {
  db = openDatabase(dbPath);
  service = new FactorService(db);
});

after(() => {
  db.close();
  rmSync(dbPath, { force: true });
  rmSync(dbPath + "-wal", { force: true });
  rmSync(dbPath + "-shm", { force: true });
});

test("非法十进制字符串被拒绝并带错误码", () => {
  for (const bad of ["abc", "-5", " 100", "12.0", "1e3", "007", "", "0x10"]) {
    assert.throws(
      () => service.createSearch({ n: bad }),
      (err: unknown) => err instanceof AppError && err.code === ErrorCode.INVALID_DECIMAL,
      `应拒绝 ${JSON.stringify(bad)}`,
    );
  }
  assert.throws(() => service.createSearch({ n: "3" }), (e: unknown) => (e as AppError).code === ErrorCode.N_TOO_SMALL);
  assert.throws(
    () => service.createSearch({ n: "9223372036854775808" }),
    (e: unknown) => (e as AppError).code === ErrorCode.N_ABOVE_LIMIT,
  );
});

test("创建 -> 求解 8051 -> 尝试与碰撞可查询", () => {
  const s = service.createSearch({ n: "8051" });
  assert.equal(s.algorithm_version, ALGORITHM_VERSION);
  const { report } = service.solve({ searchId: s.id, budgetIterations: 1000, maxAttempts: 10, explainStepLimit: 10 });
  assert.equal(report.found, 1);
  assert.ok(report.factor === "83" || report.factor === "97");
  assert.equal(report.cofactor, String(8051n / BigInt(report.factor!)));
  const attempts = service.listAttempts(report.id);
  assert.ok(attempts.length >= 1);
  const steps = service.getSteps(report.id, 0);
  assert.ok(steps.length <= 10);
  assert.ok(steps.length >= 1);
  for (const st of steps) {
    assert.ok(typeof st.x === "string" && typeof st.y === "string");
  }
});

test("偶数走预检：rho 迭代 0，因子 2", () => {
  const s = service.createSearch({ n: "123456" });
  const { report } = service.solve({ searchId: s.id, budgetIterations: 1000 });
  assert.equal(report.factor, "2");
  assert.equal(report.used_iterations, 0);
  assert.equal(report.precheck, "even_number_factor_2");
});

test("101 小预算未找到：不宣布素数，返回真实已用次数", () => {
  const s = service.createSearch({ n: "101" });
  const { report } = service.solve({ searchId: s.id, budgetIterations: 3, maxAttempts: 10 });
  assert.equal(report.found, 0);
  assert.equal(report.factor, null);
  assert.equal(report.used_iterations, 3);
  assert.equal(report.overall_stop_reason, "iteration_budget_exhausted");
});

test("增加预算建立新报告（从头计算，历史报告保留）", () => {
  const s = service.createSearch({ n: "8051" });
  const a = service.solve({ searchId: s.id, budgetIterations: 1, maxAttempts: 10 });
  assert.equal(a.report.found, 0);
  const b = service.solve({ searchId: s.id, budgetIterations: 1000, maxAttempts: 10 });
  assert.equal(b.report.found, 1);
  assert.notEqual(a.report.id, b.report.id);
  const all = service.listReports(s.id);
  assert.equal(all.length, 2);
});

test("外部因子验证：正确通过，篡改拒绝", () => {
  const s = service.createSearch({ n: "8051" });
  const ok = service.verifyExternal(s.id, "97");
  assert.equal(ok.ok, true);
  assert.equal(ok.cofactor, "83");
  const bad = service.verifyExternal(s.id, "84");
  assert.equal(bad.ok, false);
  assert.throws(
    () => service.verifyExternal(s.id, "abc"),
    (e: unknown) => (e as AppError).code === ErrorCode.INVALID_FACTOR,
  );
});

test("超安全整数偶数与奇合数（BigInt 十进制字符串）", () => {
  const even = "9007199254741006"; // > 2^53
  const sEven = service.createSearch({ n: even });
  const rEven = service.solve({ searchId: sEven.id, budgetIterations: 10 });
  assert.equal(rEven.report.factor, "2");

  const n = 1000000007n * 1000000009n;
  const s = service.createSearch({ n: n.toString() });
  const { report } = service.solve({ searchId: s.id, budgetIterations: 200000, maxAttempts: 32 });
  assert.equal(report.found, 1);
  assert.equal(n % BigInt(report.factor!), 0n);
});

test("导出包含算法版本、输入、参数、结果与逐步解释", () => {
  const s = service.createSearch({ n: "49", firstX0: "2", firstC: "1" });
  const { report } = service.solve({ searchId: s.id, budgetIterations: 1000, explainStepLimit: 5 });
  const exported = service.exportReport(report.id) as any;
  assert.equal(exported.algorithmVersion, ALGORITHM_VERSION);
  assert.equal(exported.search.n, "49");
  assert.equal(exported.report.factor, "7");
  assert.ok(Array.isArray(exported.attempts));
});

test("重启读取一致：关闭后重开同一数据库文件", () => {
  const s = service.createSearch({ n: "8051", firstX0: "2", firstC: "1" });
  const { report } = service.solve({ searchId: s.id, budgetIterations: 1000, maxAttempts: 10, explainStepLimit: 8 });
  const stepsBefore = service.getSteps(report.id, 0);

  db.close();
  const db2 = openDatabase(dbPath);
  const service2 = new FactorService(db2);
  const searchAgain = service2.getSearch(s.id);
  assert.equal(searchAgain.n, "8051");
  const reportAgain = service2.getReport(report.id);
  assert.equal(reportAgain.factor, report.factor);
  assert.equal(reportAgain.used_iterations, report.used_iterations);
  const stepsAfter = service2.getSteps(report.id, 0);
  assert.deepEqual(stepsAfter, stepsBefore);

  // 同参数重算一致
  const rerun = service2.solve({ searchId: s.id, budgetIterations: 1000, maxAttempts: 10, explainStepLimit: 8 });
  assert.equal(rerun.report.factor, report.factor);
  assert.equal(rerun.report.used_iterations, report.used_iterations);
  db2.close();
  db = openDatabase(dbPath);
  service = new FactorService(db);
});
