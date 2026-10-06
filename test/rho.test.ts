import { test } from "node:test";
import assert from "node:assert/strict";
import { gcdBig, paramForAttempt, runPollardRho, trialDivisionFactor, verifyWitness } from "../src/rho.js";

test("gcd 与见证校验", () => {
  assert.equal(gcdBig(0n, 7n), 7n);
  assert.equal(gcdBig(-12n, 8n), 4n);
  assert.equal(verifyWitness(8051n, 83n).ok, true);
  assert.equal(verifyWitness(8051n, 83n).cofactor, 97n);
  assert.equal(verifyWitness(10n, 4n).ok, false);
  assert.equal(verifyWitness(10n, 10n).ok, false);
  assert.equal(verifyWitness(10n, 1n).ok, false);
});

test("8051 找到 83 或 97，且乘积核对", () => {
  const r = runPollardRho({
    n: 8051n,
    firstX0: 2n,
    firstC: 1n,
    globalIterationBudget: 1000,
    maxAttempts: 10,
    explainStepLimit: 40,
  });
  assert.equal(r.found, true);
  assert.ok(r.factor === "83" || r.factor === "97", `因子应为 83/97，实际 ${r.factor}`);
  const d = BigInt(r.factor!);
  assert.equal(8051n % d, 0n);
  assert.equal(d * (8051n / d), 8051n);
});

test("逐步手算 8051 第一段轨道与实现一致", () => {
  // f(x) = x^2+1 mod 8051，x0=y0=2
  // step1: x = 5;            y = f(f(2)) = f(5) = 26;       gcd(|5-26|,8051) = gcd(21,8051)
  const n = 8051n;
  const f = (x: bigint) => (x * x + 1n) % n;
  let x = 2n;
  let y = 2n;
  x = f(x);
  y = f(f(y));
  assert.equal(x, 5n);
  assert.equal(y, 26n);
  assert.equal(gcdBig(x > y ? x - y : y - x, n), gcdBig(21n, 8051n));

  const r = runPollardRho({ n, firstX0: 2n, firstC: 1n, globalIterationBudget: 1000, maxAttempts: 10, explainStepLimit: 40 });
  const first = r.attempts[0]!.steps[0]!;
  assert.equal(first.x, "5");
  assert.equal(first.y, "26");
  assert.equal(first.gcd, gcdBig(21n, 8051n).toString());
});

test("49 找到因子 7", () => {
  const r = runPollardRho({ n: 49n, firstX0: 2n, firstC: 1n, globalIterationBudget: 1000, maxAttempts: 10, explainStepLimit: 40 });
  assert.equal(r.found, true);
  assert.equal(r.factor, "7");
});

test("固定轨道退化后换确定参数，并累计全局预算", () => {
  // 构造退化：选 c 使得轨道快速 gcd=N 不现实；改为直接验证 paramForAttempt 确定可重现，
  // 并用小素数 N=101 验证多尝试 + 预算耗尽时 usedIterations 等于真实步数。
  assert.deepEqual(paramForAttempt(0, 2n, 1n, 101n), { x0: 2n, c: 1n });
  const p1a = paramForAttempt(1, 2n, 1n, 101n);
  const p1b = paramForAttempt(1, 2n, 1n, 101n);
  assert.deepEqual(p1a, p1b);
  assert.ok(p1a.c !== 1n || p1a.x0 !== 2n, "换组参数必须与第一组不同");

  // 制造真正的退化轨道：N=25, x0=0, c=0 时 f(x)=x^2，x 与 y 立即相等 => gcd(0,25)=25=N
  const deg = runPollardRho({ n: 25n, firstX0: 0n, firstC: 0n, globalIterationBudget: 100, maxAttempts: 3, explainStepLimit: 10 });
  assert.equal(deg.attempts[0]!.stopReason, "degenerate_gcd_n");
  assert.equal(deg.attempts[0]!.factor, null);
  // 退化后必须换参数继续，而不是把 gcd=N 当成功
  assert.ok(deg.attempts.length >= 1);
  assert.equal(deg.found, true, "后续确定参数组应在 25 上找到 5");
  assert.equal(deg.factor, "5");
});

test("总预算耗尽：真实已用步数等于预算，且不宣布素数", () => {
  const r = runPollardRho({ n: 101n, firstX0: 2n, firstC: 1n, globalIterationBudget: 3, maxAttempts: 10, explainStepLimit: 40 });
  assert.equal(r.found, false);
  assert.equal(r.factor, null);
  assert.equal(r.usedIterations, 3);
  assert.equal(r.overallStopReason, "iteration_budget_exhausted");
  // 预算耗尽只是未找到，独立试除可另行确认 101 为素数
  assert.equal(trialDivisionFactor(101n), null);
});

test("解释上限与计算预算独立：只保留前几步，不停算", () => {
  // 101 在 (2,1) 轨道上于第 9 步 gcd=N 退化；取预算 8（此前全部 gcd=1）以隔离本断言。
  const r = runPollardRho({ n: 101n, firstX0: 2n, firstC: 1n, globalIterationBudget: 8, maxAttempts: 10, explainStepLimit: 2 });
  assert.equal(r.usedIterations, 8, "解释只保留 2 步但必须算满 8 步");
  assert.equal(r.attempts[0]!.iterations, 8);
  assert.equal(r.attempts[0]!.steps.length, 2);
});

test("超安全整数 BigInt 输入可处理（超过 Number.MAX_SAFE_INTEGER 且小于 2^63）", () => {
  const p = 1000000007n;
  const q = 1000000009n;
  const n = p * q;
  assert.ok(n > 2n ** 53n, "必须超过 Number.MAX_SAFE_INTEGER");
  assert.ok(n < 2n ** 63n);
  const r = runPollardRho({ n, firstX0: 2n, firstC: 1n, globalIterationBudget: 200000, maxAttempts: 32, explainStepLimit: 5 });
  assert.equal(r.found, true);
  const d = BigInt(r.factor!);
  const v = verifyWitness(n, d);
  assert.equal(v.ok, true);
  assert.ok(v.cofactor === p || v.cofactor === q);
});

test("小整数因子用独立试除核对返回因子有效", () => {
  for (const nStr of ["8051", "49", "12345", "77", "143", "1001"]) {
    const n = BigInt(nStr);
    const r = runPollardRho({ n, firstX0: 2n, firstC: 1n, globalIterationBudget: 5000, maxAttempts: 16, explainStepLimit: 0 });
    assert.equal(r.found, true, `${nStr} 应找到因子`);
    const d = BigInt(r.factor!);
    assert.equal(verifyWitness(n, d).ok, true);
    const td = trialDivisionFactor(n);
    assert.ok(td !== null && n % td === 0n, `试除核对 ${nStr}`);
    assert.equal(n % d, 0n);
  }
});

test("篡改因子被拒绝", () => {
  assert.equal(verifyWitness(8051n, 84n).ok, false);
  assert.equal(verifyWitness(8051n, 8051n).ok, false);
  assert.equal(verifyWitness(49n, 6n).ok, false);
});
