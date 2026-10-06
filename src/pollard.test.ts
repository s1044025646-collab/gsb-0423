import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { before, beforeEach, test } from 'node:test';
import { resolve } from 'node:path';
import { Store } from './db.js';
import { AppError } from './errors.js';
import { gcd, validateExternalFactor } from './numbers.js';
import { parameterPlan, runPollardRho } from './pollard.js';

const dataDir = resolve('data/test');
let dbCounter = 0;

before(() => mkdirSync(dataDir, { recursive: true }));
beforeEach(() => {
  dbCounter += 1;
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(resolve(dataDir, `test-${dbCounter}.sqlite${suffix}`), { force: true });
  }
});

function newStore() {
  return new Store(resolve(dataDir, `test-${dbCounter}.sqlite`));
}

test('8051 返回 83 或 97，并且乘积见证可独立核对', () => {
  const result = runPollardRho({ n: 8051n }, { maxIterations: 100, maxAttempts: 20 });
  assert.equal(result.found, true);
  assert.ok(result.factor === 83n || result.factor === 97n);
  assert.equal(result.factor! * result.cofactor!, 8051n);
  assert.equal(8051n % result.factor!, 0n);
});

test('平方合数 49 找到非平凡因子 7', () => {
  const result = runPollardRho({ n: 49n }, { maxIterations: 100, maxAttempts: 20 });
  assert.equal(result.found, true);
  assert.equal(result.factor, 7n);
  assert.equal(result.cofactor, 7n);
  assert.equal(result.stopReason, 'found');
});

test('偶数走简单预检直接返回 2', () => {
  const result = runPollardRho({ n: 50n }, { maxIterations: 100, maxAttempts: 20 });
  assert.equal(result.found, true);
  assert.equal(result.factor, 2n);
  assert.equal(result.stopReason, 'even_precheck');
  assert.equal(result.usedIterations, 0);
});

test('101 小预算只报告未找到，不宣称素数', () => {
  const result = runPollardRho({ n: 101n }, { maxIterations: 3, maxAttempts: 2 });
  assert.equal(result.found, false);
  assert.equal(result.factor, null);
  assert.equal(result.stopReason, 'global_iteration_budget');
  assert.equal(result.usedIterations, 3);
  assert.ok(result.usedAttempts <= 2);
});

test('固定轨道退化后换确定参数，且全局迭代预算不重置', () => {
  const result = runPollardRho({ n: 25n, firstC: 5n, firstX0: 0n }, { maxIterations: 4, maxAttempts: 3 });
  assert.equal(result.attempts[0].stopReason, 'degenerate');
  assert.ok(result.attempts.length >= 2);
  assert.notDeepEqual(
    { c: result.attempts[1].c, start: result.attempts[1].start },
    { c: result.attempts[0].c, start: result.attempts[0].start }
  );
  const totalIterations = result.attempts.reduce((sum, attempt) => sum + attempt.iterations, 0);
  assert.equal(totalIterations, result.usedIterations);
  assert.ok(result.usedIterations <= 4);
});

test('尝试次数预算耗尽时停止', () => {
  const result = runPollardRho({ n: 101n }, { maxIterations: 100_000, maxAttempts: 1 });
  assert.equal(result.found, false);
  assert.equal(result.stopReason, 'attempt_budget');
  assert.equal(result.usedAttempts, 1);
});

test('退化恰好在全局预算最后一步时不追加零迭代尝试', () => {
  const result = runPollardRho({ n: 25n, firstC: 5n, firstX0: 0n }, { maxIterations: 1, maxAttempts: 3 });
  assert.equal(result.usedIterations, 1);
  assert.equal(result.usedAttempts, 1);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.stopReason, 'global_iteration_budget');
});

test('非法字符串和过小 N 被拒绝', () => {
  assert.throws(() => runPollardRho({ n: 3n }, { maxIterations: 1, maxAttempts: 1 }), {
    message: /n 必须大于等于 4/
  });
  const store = newStore();
  assert.throws(() => store.createSearch({ n: '008051' }), AppError);
  assert.throws(() => store.createSearch({ n: '8,051' }), AppError);
  assert.throws(() => store.createSearch({ n: 8051 }), AppError);
  store.close();
});

test('超过有符号 64 位上限被拒绝，但边界值接受', () => {
  const store = newStore();
  assert.throws(() => store.createSearch({ n: '9223372036854775808' }), /超过有符号 64 位上限/);
  const search = store.createSearch({ n: '9223372036854775807' });
  assert.equal(search.n, '9223372036854775807');
  store.close();
});

test('篡改或不整除的外部因子被拒绝为无效见证', () => {
  assert.equal(validateExternalFactor(8051n, '83').valid, true);
  assert.equal(validateExternalFactor(8051n, '97').valid, true);
  assert.equal(validateExternalFactor(8051n, '84').valid, false);
  assert.throws(() => validateExternalFactor(8051n, '1'), /严格/);
  assert.throws(() => validateExternalFactor(8051n, '8051'), /严格/);
});

test('小整数用试除独立验证返回因子', () => {
  for (const n of [49n, 77n, 143n, 8051n]) {
    const result = runPollardRho({ n }, { maxIterations: 100, maxAttempts: 20 });
    assert.equal(result.found, true);
    assert.ok(result.factor! > 1n && result.factor! < n);
    assert.equal(n % result.factor!, 0n);
    let trialFactor: bigint | null = null;
    for (let candidate = 2n; candidate * candidate <= n; candidate += 1n) {
      if (n % candidate === 0n) {
        trialFactor = candidate;
        break;
      }
    }
    assert.equal(n % result.factor!, 0n);
    assert.ok(trialFactor === null || result.factor! === trialFactor || result.factor! === n / trialFactor);
  }
});

test('逐步状态与 Floyd 手算一致', () => {
  const n = 49n;
  const c = 1n;
  const result = runPollardRho({ n, firstC: c, firstX0: 2n }, { maxIterations: 10, maxAttempts: 2 });
  const step = result.steps[0];
  const x = (2n * 2n + c) % n;
  const yIntermediate = x;
  const y = (yIntermediate * yIntermediate + c) % n;
  const difference = x > y ? x - y : y - x;
  assert.deepEqual(
    {
      xBefore: step.xBefore,
      yBefore: step.yBefore,
      xAfter: step.xAfter,
      yAfter: step.yAfter,
      difference: step.difference,
      gcd: step.gcdValue
    },
    { xBefore: 2n, yBefore: 2n, xAfter: x, yAfter: y, difference, gcd: gcd(difference, n) }
  );
});

test('参数序列确定，同参数重算一致', () => {
  const first = runPollardRho({ n: 8051n, firstC: 1n, firstX0: 2n }, { maxIterations: 20, maxAttempts: 5 });
  const second = runPollardRho({ n: 8051n, firstC: 1n, firstX0: 2n }, { maxIterations: 20, maxAttempts: 5 });
  assert.deepEqual(first, second);
  assert.deepEqual(parameterPlan(8051n, 1n, 2n, 5), parameterPlan(8051n, 1n, 2n, 5));
});

test('SQLite 持久化后重启读取一致，新预算生成新报告', () => {
  const path = resolve(dataDir, `persist-${dbCounter}.sqlite`);
  const firstStore = new Store(path);
  const search = firstStore.createSearch({ n: '101', firstC: '1', firstX0: '2' });
  const report = firstStore.solve(search.id, { maxIterations: 2, maxAttempts: 2 });
  firstStore.close();

  const reopened = new Store(path);
  const reloadedSearch = reopened.getSearch(search.id);
  assert.equal(reloadedSearch.n, '101');
  const reloadedReport = reopened.getReport(search.id, report.id);
  assert.equal(reloadedReport.usedIterations, 2);
  assert.equal(reloadedReport.found, false);

  const secondReport = reopened.solve(search.id, { maxIterations: 100, maxAttempts: 5 });
  assert.equal(secondReport.reportNumber, 2);
  assert.notEqual(secondReport.id, report.id);
  const states = reopened.getStates(search.id, report.id, { limit: 10 });
  assert.equal(states.totalComputedStates, 2);
  assert.equal(states.states.length, 2);
  reopened.close();
});

test('解释展示上限不会改变实际计算量', () => {
  const store = newStore();
  const search = store.createSearch({ n: '101' });
  const report = store.solve(search.id, { maxIterations: 7, maxAttempts: 3 });
  const states = store.getStates(search.id, report.id, { limit: 2 });
  assert.equal(states.explanationLimit, 2);
  assert.equal(states.states.length, 2);
  assert.equal(states.totalComputedStates, report.usedIterations);
  store.close();
});
