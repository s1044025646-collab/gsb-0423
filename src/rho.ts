/**
 * Pollard rho（Floyd 双速迭代）核心实现。
 *
 * 轨道函数：f(x) = (x*x + c) mod N
 * 每一步：
 *   x <- f(x)        （前进一步）
 *   y <- f(f(y))     （前进两步）
 *   d <- gcd(|x - y|, N)
 * 判定：
 *   d = 1            继续；
 *   1 < d < N        找到非平凡因子（成功）；
 *   d = N            本次轨道退化，必须换一组确定参数重新尝试。
 *
 * 所有整数运算均使用 BigInt，绝不经过 Number 转换。
 */

/** 每一步的有限步状态：可独立验算。 */
export interface StepState {
  /** 第几步，从 1 开始（该步做完两次迭代与一次 gcd）。 */
  step: number;
  x: string;
  y: string;
  diff: string;
  gcd: string;
}

/** 单次轨道尝试的停止原因。 */
export type StopReason =
  | "factor_found"
  | "degenerate_gcd_n"
  | "iteration_budget_exhausted"
  | "attempt_limit_exhausted";

/** 一次轨道尝试的记录。 */
export interface AttemptRecord {
  attemptIndex: number;
  x0: string;
  c: string;
  /** 本次尝试实际执行的步数（每步含一次 x 迭代与两次 y 迭代）。 */
  iterations: number;
  stopReason: StopReason;
  factor: string | null;
  steps: StepState[];
}

export interface RunInput {
  n: bigint;
  /** 第一组参数（用户可指定）；后续参数由确定序列生成。 */
  firstX0: bigint;
  firstC: bigint;
  /** 全局迭代（步）预算：跨所有尝试累计，换参数不重置。 */
  globalIterationBudget: number;
  /** 尝试次数上限。 */
  maxAttempts: number;
  /**
   * 解释保留上限：每个尝试最多保留多少步状态。
   * 与计算预算相互独立——只保留前若干步状态，绝不为了展示而提前停算。
   */
  explainStepLimit: number;
}

export interface RunResult {
  found: boolean;
  factor: string | null;
  attempts: AttemptRecord[];
  /** 真实已消耗的全局步数。 */
  usedIterations: number;
  overallStopReason: StopReason;
}

export function gcdBig(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

function f(x: bigint, c: bigint, n: bigint): bigint {
  return (x * x + c) % n;
}

/**
 * 公开的有限参数序列（教学用，确定且公开）：
 * 第 0 组使用用户指定或默认的 (x0=2, c=1)；
 * 之后 c 依次取 1,2,3,...，起点 x0 依次为 2,3,4,...（均对 N 取模，且要求 c % N !== 0 避免 f(x)=x^2）。
 */
export function paramForAttempt(index: number, firstX0: bigint, firstC: bigint, n: bigint): { x0: bigint; c: bigint } {
  if (index === 0) {
    return { x0: firstX0 % n, c: firstC % n };
  }
  const c = (firstC + BigInt(index)) % n;
  const x0 = (firstX0 + BigInt(index)) % n;
  // 若退化到 c=0，顺移一个确定偏移，保证可重现且不依赖随机数。
  const safeC = c === 0n ? ((firstC + BigInt(index) * 7n + 1n) % n) : c;
  return { x0, c: safeC };
}

/**
 * 在预算内执行搜索。全局迭代预算跨尝试累计；
 * 不做任何随机性、不依赖外部服务、不会死循环（每轮循环预算至少减 1 或停止）。
 */
export function runPollardRho(input: RunInput): RunResult {
  const { n, firstX0, firstC, globalIterationBudget, maxAttempts, explainStepLimit } = input;
  const attempts: AttemptRecord[] = [];
  let used = 0;

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
    const { x0, c } = paramForAttempt(attemptIndex, firstX0, firstC, n);
    let x = x0;
    let y = x0;
    let iterations = 0;
    const steps: StepState[] = [];
    let stopReason: StopReason = "iteration_budget_exhausted";
    let factor: string | null = null;

    while (used < globalIterationBudget) {
      x = f(x, c, n);
      y = f(f(y, c, n), c, n);
      const diff = x - y;
      const absDiff = diff < 0n ? -diff : diff;
      const g = gcdBig(absDiff, n);
      iterations++;
      used++;

      if (iterations <= explainStepLimit) {
        steps.push({
          step: iterations,
          x: x.toString(),
          y: y.toString(),
          diff: absDiff.toString(),
          gcd: g.toString(),
        });
      }

      if (g === 1n) {
        continue;
      }
      if (g < n) {
        // 严格 1 < g < N（g>1 且 g<N）：非平凡因子。
        stopReason = "factor_found";
        factor = g.toString();
      } else {
        // g === N：本轨道退化，绝不能当成功因子。
        stopReason = "degenerate_gcd_n";
      }
      break;
    }

    attempts.push({ attemptIndex, x0: x0.toString(), c: c.toString(), iterations, stopReason, factor, steps });

    if (factor !== null) {
      return { found: true, factor, attempts, usedIterations: used, overallStopReason: "factor_found" };
    }
    if (used >= globalIterationBudget) {
      return { found: false, factor: null, attempts, usedIterations: used, overallStopReason: "iteration_budget_exhausted" };
    }
    // 本轨道退化或自然耗尽（该分支理论上 used 已满才会到），继续换参数。
  }

  return { found: false, factor: null, attempts, usedIterations: used, overallStopReason: "attempt_limit_exhausted" };
}

/**
 * 独立因子见证校验：
 * 1 < d < N、N mod d === 0、d * (N/d) === N。
 * 只证明分解正确，不断言两个因子为素数。
 */
export function verifyWitness(n: bigint, d: bigint): { ok: boolean; cofactor: bigint | null; reason: string } {
  if (d <= 1n) return { ok: false, cofactor: null, reason: "因子必须严格大于 1" };
  if (d >= n) return { ok: false, cofactor: null, reason: "因子必须严格小于 N" };
  if (n % d !== 0n) return { ok: false, cofactor: null, reason: "N 不能被该因子整除" };
  const cofactor = n / d;
  if (d * cofactor !== n) {
    return { ok: false, cofactor: null, reason: "因子与余因子乘积不等于 N" };
  }
  return { ok: true, cofactor, reason: "乘积见证成立：1 < d < N，N mod d = 0，d * (N/d) = N（不代表两因子为素数）" };
}

/** 小整数独立试除核对：从 2 起逐个试除，返回最小真因子；素数返回 null。 */
export function trialDivisionFactor(n: bigint): bigint | null {
  if (n % 2n === 0n) return 2n;
  let i = 3n;
  while (i * i <= n) {
    if (n % i === 0n) return i;
    i += 2n;
  }
  return null;
}
