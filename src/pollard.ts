import { DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_ITERATIONS, ERROR_CODES, TWO } from './constants.js';
import { AppError } from './errors.js';
import { absDifference, gcd } from './numbers.js';

export interface SearchInput {
  n: bigint;
  firstC?: bigint;
  firstX0?: bigint;
}

export interface SearchBudgets {
  maxIterations: number;
  maxAttempts: number;
}

export interface StepState {
  attemptNumber: number;
  iteration: number;
  xBefore: bigint;
  yBefore: bigint;
  xAfter: bigint;
  yAfter: bigint;
  difference: bigint;
  gcdValue: bigint;
}

export interface AttemptRecord {
  attemptNumber: number;
  start: bigint;
  c: bigint;
  iterations: number;
  stopReason: 'found' | 'degenerate' | 'global_iteration_budget';
  factor: bigint | null;
}

export interface SearchResult {
  found: boolean;
  factor: bigint | null;
  cofactor: bigint | null;
  productWitness: string | null;
  stopReason: 'even_precheck' | 'found' | 'global_iteration_budget' | 'attempt_budget';
  usedIterations: number;
  usedAttempts: number;
  attempts: AttemptRecord[];
  steps: StepState[];
}

export function defaultBudgets(): SearchBudgets {
  return { maxIterations: DEFAULT_MAX_ITERATIONS, maxAttempts: DEFAULT_MAX_ATTEMPTS };
}

export function parameterPlan(
  n: bigint,
  firstC?: bigint,
  firstX0?: bigint,
  maxAttempts = DEFAULT_MAX_ATTEMPTS
): Array<{ c: bigint; start: bigint }> {
  const plan: Array<{ c: bigint; start: bigint }> = [];
  const seen = new Set<string>();
  const add = (c: bigint, start: bigint) => {
    const normalizedC = ((c % n) + n) % n;
    const normalizedStart = ((start % n) + n) % n;
    const key = `${normalizedC.toString()}:${normalizedStart.toString()}`;
    if (!seen.has(key)) {
      seen.add(key);
      plan.push({ c: normalizedC, start: normalizedStart });
    }
  };

  if (firstC !== undefined || firstX0 !== undefined) {
    add(firstC ?? 1n, firstX0 ?? 2n);
  }

  const starts = [2n, 3n, 5n, 7n, 11n, 13n];
  const constants = [1n, 2n, 3n, 5n, 7n, 11n, 13n, 17n];
  for (const start of starts) {
    for (const c of constants) {
      add(c, start);
      if (plan.length >= maxAttempts) return plan;
    }
  }

  let candidate = 19n;
  while (plan.length < maxAttempts && candidate < n) {
    add(candidate, 2n);
    candidate += 2n;
  }
  return plan;
}

function f(x: bigint, c: bigint, n: bigint): bigint {
  return (x * x + c) % n;
}

export function runPollardRho(input: SearchInput, budgets: SearchBudgets): SearchResult {
  const { n } = input;
  if (n < 4n) {
    throw new AppError(ERROR_CODES.INVALID_N, 'n 必须大于等于 4');
  }
  const attempts: AttemptRecord[] = [];
  const steps: StepState[] = [];

  if (n % TWO === 0n) {
    const factor = TWO;
    const cofactor = n / factor;
    return {
      found: true,
      factor,
      cofactor,
      productWitness: `${factor.toString()} * ${cofactor.toString()} = ${n.toString()}`,
      stopReason: 'even_precheck',
      usedIterations: 0,
      usedAttempts: 1,
      attempts: [{ attemptNumber: 1, start: 0n, c: 0n, iterations: 0, stopReason: 'found', factor }],
      steps
    };
  }

  const plan = parameterPlan(n, input.firstC, input.firstX0, budgets.maxAttempts);
  let usedIterations = 0;

  for (const parameters of plan) {
    const attemptNumber = attempts.length + 1;
    if (usedIterations >= budgets.maxIterations) {
      break;
    }
    let x = parameters.start;
    let y = parameters.start;
    let iteration = 0;
    let stopReason: AttemptRecord['stopReason'] = 'global_iteration_budget';
    let factor: bigint | null = null;

    while (usedIterations < budgets.maxIterations) {
      const xBefore = x;
      const yBefore = y;
      x = f(x, parameters.c, n);
      y = f(f(y, parameters.c, n), parameters.c, n);
      iteration += 1;
      usedIterations += 1;
      const difference = absDifference(x, y);
      const gcdValue = gcd(difference, n);
      steps.push({ attemptNumber, iteration, xBefore, yBefore, xAfter: x, yAfter: y, difference, gcdValue });

      if (gcdValue > 1n && gcdValue < n) {
        stopReason = 'found';
        factor = gcdValue;
        break;
      }
      if (gcdValue === n) {
        stopReason = 'degenerate';
        break;
      }
    }

    attempts.push({ attemptNumber, start: parameters.start, c: parameters.c, iterations: iteration, stopReason, factor });

    if (factor !== null) {
      const cofactor = n / factor;
      return {
        found: true,
        factor,
        cofactor,
        productWitness: `${factor.toString()} * ${cofactor.toString()} = ${n.toString()}`,
        stopReason: 'found',
        usedIterations,
        usedAttempts: attemptNumber,
        attempts,
        steps
      };
    }

    if (usedIterations >= budgets.maxIterations) {
      return {
        found: false,
        factor: null,
        cofactor: null,
        productWitness: null,
        stopReason: 'global_iteration_budget',
        usedIterations,
        usedAttempts: attemptNumber,
        attempts,
        steps
      };
    }
  }

  return {
    found: false,
    factor: null,
    cofactor: null,
    productWitness: null,
    stopReason: 'attempt_budget',
    usedIterations,
    usedAttempts: attempts.length,
    attempts,
    steps
  };
}
