import type { DB } from "./db.js";
import { AppError, ErrorCode, parseDecimalString, validateN, validateParam } from "./errors.js";
import {
  runPollardRho,
  verifyWitness,
  type AttemptRecord,
  type RunResult,
} from "./rho.js";

export const ALGORITHM_VERSION = "pollard-rho-floyd-1.0.0";

/** 固定上限（可在创建时收紧，不能放宽）。 */
export const MAX_ITERATIONS_HARD = 2_000_000;
export const MAX_ATTEMPTS_HARD = 256;
export const EXPLAIN_STEP_LIMIT = 40;

export interface CreateSearchInput {
  n: unknown;
  firstX0?: string;
  firstC?: string;
}

export interface SolveInput {
  searchId: number;
  budgetIterations?: number;
  maxAttempts?: number;
  explainStepLimit?: number;
}

interface SearchRow {
  id: number;
  n: string;
  first_x0: string;
  first_c: string;
  algorithm_version: string;
  created_at: string;
}

interface ReportRow {
  id: number;
  search_id: number;
  budget_iterations: number;
  max_attempts: number;
  explain_step_limit: number;
  found: number;
  factor: string | null;
  cofactor: string | null;
  used_iterations: number;
  overall_stop_reason: string;
  precheck: string | null;
  created_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class FactorService {
  constructor(private readonly db: DB) {}

  createSearch(input: CreateSearchInput): SearchRow {
    const n = validateN(input.n);
    const firstX0 =
      input.firstX0 === undefined ? 2n : validateParam(input.firstX0, "firstX0", n);
    const firstC =
      input.firstC === undefined ? 1n : validateParam(input.firstC, "firstC", n);

    const stmt = this.db.prepare(
      `INSERT INTO searches (n, first_x0, first_c, algorithm_version, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const info = stmt.run(n.toString(), firstX0.toString(), firstC.toString(), ALGORITHM_VERSION, nowIso());
    return this.getSearch(Number(info.lastInsertRowid));
  }

  getSearch(id: number): SearchRow {
    const row = this.db.prepare(`SELECT * FROM searches WHERE id = ?`).get(id) as SearchRow | undefined;
    if (!row) {
      throw new AppError(ErrorCode.NOT_FOUND, `搜索题 id=${id} 不存在`);
    }
    return row;
  }

  /**
   * 按预算求解：新预算从头计算（不做断点续搜）。
   * 全局迭代预算在本次报告内跨尝试累计，换参数不重置。
   */
  solve(input: SolveInput): { search: SearchRow; report: ReportRow } {
    const search = this.getSearch(input.searchId);
    const n = BigInt(search.n);
    const budget = clampPositive(input.budgetIterations ?? 100_000, "budgetIterations", MAX_ITERATIONS_HARD);
    const maxAttempts = clampPositive(input.maxAttempts ?? MAX_ATTEMPTS_HARD, "maxAttempts", MAX_ATTEMPTS_HARD);
    const explain = clampNonNegative(
      input.explainStepLimit ?? EXPLAIN_STEP_LIMIT,
      "explainStepLimit",
      1000,
    );

    // 简单预检：偶数直接给因子 2，不走 rho。
    const precheck = n % 2n === 0n ? "even_number_factor_2" : null;

    let result: RunResult;
    if (precheck) {
      result = {
        found: true,
        factor: "2",
        attempts: [],
        usedIterations: 0,
        overallStopReason: "factor_found",
      };
    } else {
      result = runPollardRho({
        n,
        firstX0: BigInt(search.first_x0),
        firstC: BigInt(search.first_c),
        globalIterationBudget: budget,
        maxAttempts,
        explainStepLimit: explain,
      });
    }

    const cofactor = result.found && result.factor !== null ? (n / BigInt(result.factor)).toString() : null;
    const reportStmt = this.db.prepare(
      `INSERT INTO reports
        (search_id, budget_iterations, max_attempts, explain_step_limit, found, factor, cofactor, used_iterations, overall_stop_reason, precheck, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const info = reportStmt.run(
      search.id,
      budget,
      maxAttempts,
      explain,
      result.found ? 1 : 0,
      result.factor,
      cofactor,
      result.usedIterations,
      result.overallStopReason,
      precheck,
      nowIso(),
    );
    const reportId = Number(info.lastInsertRowid);
    this.persistAttempts(reportId, result.attempts);
    return { search, report: this.getReport(reportId) };
  }

  private persistAttempts(reportId: number, attempts: AttemptRecord[]): void {
    const attemptStmt = this.db.prepare(
      `INSERT INTO attempts (report_id, attempt_index, x0, c, iterations, stop_reason, factor)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const stepStmt = this.db.prepare(
      `INSERT INTO steps (attempt_pk, step, x, y, diff, gcd) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const a of attempts) {
      const info = attemptStmt.run(reportId, a.attemptIndex, a.x0, a.c, a.iterations, a.stopReason, a.factor);
      const attemptPk = Number(info.lastInsertRowid);
      for (const s of a.steps) {
        stepStmt.run(attemptPk, s.step, s.x, s.y, s.diff, s.gcd);
      }
    }
  }

  getReport(id: number): ReportRow {
    const row = this.db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id) as ReportRow | undefined;
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, `报告 id=${id} 不存在`);
    return row;
  }

  listReports(searchId: number): ReportRow[] {
    this.getSearch(searchId);
    return this.db
      .prepare(`SELECT * FROM reports WHERE search_id = ? ORDER BY id`)
      .all(searchId) as unknown as ReportRow[];
  }

  listAttempts(reportId: number): Array<Record<string, unknown>> {
    this.getReport(reportId);
    return this.db
      .prepare(`SELECT * FROM attempts WHERE report_id = ? ORDER BY attempt_index`)
      .all(reportId) as Array<Record<string, unknown>>;
  }

  /** 查询某次尝试的碰撞 / 有限步状态表。 */
  getSteps(reportId: number, attemptIndex: number): Array<Record<string, unknown>> {
    this.getReport(reportId);
    return this.db
      .prepare(
        `SELECT s.step, s.x, s.y, s.diff, s.gcd
         FROM steps s
         JOIN attempts a ON a.id = s.attempt_pk
         WHERE a.report_id = ? AND a.attempt_index = ?
         ORDER BY s.step`,
      )
      .all(reportId, attemptIndex) as Array<Record<string, unknown>>;
  }

  /** 验证外部提交的因子对（十进制字符串），并返回乘积见证。 */
  verifyExternal(searchId: number, factorStr: string): Record<string, unknown> {
    const search = this.getSearch(searchId);
    const n = BigInt(search.n);
    const d = parseExternalDecimal(factorStr, "factor");
    const result = verifyWitness(n, d);
    return {
      n: search.n,
      factor: d.toString(),
      ok: result.ok,
      cofactor: result.cofactor === null ? null : result.cofactor.toString(),
      productCheck: result.ok ? `${d.toString()} * ${result.cofactor!.toString()} = ${search.n}` : null,
      reason: result.reason,
    };
  }

  exportReport(reportId: number): Record<string, unknown> {
    const report = this.getReport(reportId);
    const search = this.getSearch(report.search_id);
    const attempts = this.db
      .prepare(`SELECT * FROM attempts WHERE report_id = ? ORDER BY attempt_index`)
      .all(reportId) as Array<{ id: number; attempt_index: number }>;
    const stepsByAttempt: Record<number, Array<Record<string, unknown>>> = {};
    for (const a of attempts) {
      stepsByAttempt[a.attempt_index] = this.db
        .prepare(`SELECT step, x, y, diff, gcd FROM steps WHERE attempt_pk = ? ORDER BY step`)
        .all(a.id) as Array<Record<string, unknown>>;
    }
    return {
      algorithmVersion: search.algorithm_version,
      search: {
        id: search.id,
        n: search.n,
        firstX0: search.first_x0,
        firstC: search.first_c,
        createdAt: search.created_at,
      },
      report: {
        id: report.id,
        budgetIterations: report.budget_iterations,
        maxAttempts: report.max_attempts,
        explainStepLimit: report.explain_step_limit,
        found: report.found === 1,
        factor: report.factor,
        cofactor: report.cofactor,
        usedIterations: report.used_iterations,
        overallStopReason: report.overall_stop_reason,
        precheck: report.precheck,
        createdAt: report.created_at,
      },
      attempts: (this.listAttempts(reportId) as Array<Record<string, unknown>>).map((a) => ({
        attemptIndex: a.attempt_index,
        x0: a.x0,
        c: a.c,
        iterations: a.iterations,
        stopReason: a.stop_reason,
        factor: a.factor,
        steps: stepsByAttempt[Number(a.attempt_index)] ?? [],
      })),
    };
  }
}

function parseExternalDecimal(value: unknown, field: string): bigint {
  try {
    return parseDecimalString(value, field);
  } catch (err) {
    if (err instanceof AppError) {
      throw new AppError(ErrorCode.INVALID_FACTOR, err.message);
    }
    throw err;
  }
}

function clampPositive(value: number, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new AppError(ErrorCode.INVALID_BUDGET, `${field} 必须是正整数，收到 ${JSON.stringify(value)}`);
  }
  if (value > max) {
    throw new AppError(ErrorCode.INVALID_BUDGET, `${field} 不能超过硬上限 ${max}`);
  }
  return value;
}

function clampNonNegative(value: number, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new AppError(ErrorCode.INVALID_BUDGET, `${field} 必须是非负整数，收到 ${JSON.stringify(value)}`);
  }
  if (value > max) {
    throw new AppError(ErrorCode.INVALID_BUDGET, `${field} 不能超过 ${max}`);
  }
  return value;
}
