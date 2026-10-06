import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { ALGORITHM_VERSION, MAX_STATE_ROWS_PER_QUERY } from './constants.js';
import { AppError } from './errors.js';
import { ERROR_CODES } from './constants.js';
import { validateExternalFactor, validateN, validateParameter } from './numbers.js';
import { runPollardRho, type SearchBudgets } from './pollard.js';

interface SearchRow {
  id: string;
  n: string;
  first_c: string | null;
  first_x0: string | null;
  algorithm_version: string;
  created_at: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close() {
    this.db.close();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS searches (
        id TEXT PRIMARY KEY,
        n TEXT NOT NULL,
        first_c TEXT,
        first_x0 TEXT,
        algorithm_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        search_id TEXT NOT NULL REFERENCES searches(id),
        report_number INTEGER NOT NULL,
        max_iterations INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        found INTEGER NOT NULL,
        stop_reason TEXT NOT NULL,
        factor TEXT,
        cofactor TEXT,
        product_witness TEXT,
        used_iterations INTEGER NOT NULL,
        used_attempts INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(search_id, report_number)
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL REFERENCES reports(id),
        attempt_number INTEGER NOT NULL,
        start TEXT NOT NULL,
        c TEXT NOT NULL,
        iterations INTEGER NOT NULL,
        stop_reason TEXT NOT NULL,
        factor TEXT
      );
      CREATE TABLE IF NOT EXISTS steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id TEXT NOT NULL REFERENCES reports(id),
        attempt_number INTEGER NOT NULL,
        iteration INTEGER NOT NULL,
        x_before TEXT NOT NULL,
        y_before TEXT NOT NULL,
        x_after TEXT NOT NULL,
        y_after TEXT NOT NULL,
        difference TEXT NOT NULL,
        gcd_value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reports_search ON reports(search_id);
      CREATE INDEX IF NOT EXISTS idx_attempts_report ON attempts(report_id);
      CREATE INDEX IF NOT EXISTS idx_steps_report ON steps(report_id, attempt_number, iteration);
    `);
  }

  createSearch(body: { n?: unknown; firstC?: unknown; firstX0?: unknown }) {
    const n = validateN(body.n);
    const firstC = body.firstC === undefined ? undefined : validateParameter(body.firstC, 'firstC', n);
    const firstX0 = body.firstX0 === undefined ? undefined : validateParameter(body.firstX0, 'firstX0', n);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO searches (id, n, first_c, first_x0, algorithm_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, n.toString(), firstC?.toString() ?? null, firstX0?.toString() ?? null, ALGORITHM_VERSION, createdAt);
    return this.getSearch(id);
  }

  getSearch(id: string) {
    const row = this.db.prepare('SELECT * FROM searches WHERE id = ?').get(id) as SearchRow | undefined;
    if (!row) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `搜索 ${id} 不存在`, 404);
    }
    return this.serializeSearch(row);
  }

  solve(id: string, budgets: SearchBudgets) {
    const search = this.getSearch(id);
    const n = BigInt(search.n);
    const result = runPollardRho(
      {
        n,
        firstC: search.firstC === null ? undefined : BigInt(search.firstC),
        firstX0: search.firstX0 === null ? undefined : BigInt(search.firstX0)
      },
      budgets
    );

    if (result.found && result.factor !== null) {
      const factor = result.factor;
      const cofactor = result.cofactor;
      if (factor <= 1n || factor >= n || n % factor !== 0n || cofactor === null || factor * cofactor !== n) {
        throw new AppError(ERROR_CODES.INTERNAL_ERROR, '内部因子见证校验失败', 500);
      }
    }

    const nextReportRow = this.db
      .prepare('SELECT COALESCE(MAX(report_number), 0) + 1 AS next_number FROM reports WHERE search_id = ?')
      .get(id) as { next_number: number };
    const reportId = randomUUID();
    const createdAt = new Date().toISOString();

    const insertReport = this.db.prepare(`
      INSERT INTO reports (
        id, search_id, report_number, max_iterations, max_attempts, found,
        stop_reason, factor, cofactor, product_witness, used_iterations, used_attempts, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAttempt = this.db.prepare(`
      INSERT INTO attempts (id, report_id, attempt_number, start, c, iterations, stop_reason, factor)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertStep = this.db.prepare(`
      INSERT INTO steps (
        report_id, attempt_number, iteration, x_before, y_before,
        x_after, y_after, difference, gcd_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      insertReport.run(
        reportId,
        id,
        nextReportRow.next_number,
        budgets.maxIterations,
        budgets.maxAttempts,
        result.found ? 1 : 0,
        result.stopReason,
        result.factor?.toString() ?? null,
        result.cofactor?.toString() ?? null,
        result.productWitness,
        result.usedIterations,
        result.usedAttempts,
        createdAt
      );
      for (const attempt of result.attempts) {
        insertAttempt.run(
          randomUUID(),
          reportId,
          attempt.attemptNumber,
          attempt.start.toString(),
          attempt.c.toString(),
          attempt.iterations,
          attempt.stopReason,
          attempt.factor?.toString() ?? null
        );
      }
      for (const step of result.steps) {
        insertStep.run(
          reportId,
          step.attemptNumber,
          step.iteration,
          step.xBefore.toString(),
          step.yBefore.toString(),
          step.xAfter.toString(),
          step.yAfter.toString(),
          step.difference.toString(),
          step.gcdValue.toString()
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return this.getReport(id, reportId);
  }

  listReports(searchId: string) {
    this.getSearch(searchId);
    const rows = this.db
      .prepare('SELECT id FROM reports WHERE search_id = ? ORDER BY report_number')
      .all(searchId) as Array<{ id: string }>;
    return rows.map((row) => this.getReport(searchId, row.id));
  }

  getReport(searchId: string, reportId: string) {
    const search = this.getSearch(searchId);
    const report = this.db
      .prepare('SELECT * FROM reports WHERE id = ? AND search_id = ?')
      .get(reportId, searchId) as Record<string, unknown> | undefined;
    if (!report) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `报告 ${reportId} 不存在`, 404);
    }
    const attempts = this.db
      .prepare('SELECT attempt_number, start, c, iterations, stop_reason, factor FROM attempts WHERE report_id = ? ORDER BY attempt_number')
      .all(reportId) as Array<Record<string, unknown>>;
    return {
      ...this.serializeReport(report),
      search,
      attempts: attempts.map((row) => ({
        attemptNumber: Number(row.attempt_number),
        start: String(row.start),
        c: String(row.c),
        iterations: Number(row.iterations),
        stopReason: String(row.stop_reason),
        factor: row.factor === null ? null : String(row.factor)
      }))
    };
  }

  getStates(searchId: string, reportId: string, options: { attempt?: number; limit?: number; offset?: number }) {
    this.getReport(searchId, reportId);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_STATE_ROWS_PER_QUERY);
    const offset = Math.max(options.offset ?? 0, 0);
    const where = ['report_id = ?'];
    const params: Array<string | number> = [reportId];
    if (options.attempt !== undefined) {
      where.push('attempt_number = ?');
      params.push(options.attempt);
    }
    const rows = this.db
      .prepare(
        `SELECT attempt_number, iteration, x_before, y_before, x_after, y_after, difference, gcd_value
         FROM steps WHERE ${where.join(' AND ')}
         ORDER BY attempt_number, iteration LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM steps WHERE ${where.join(' AND ')}`)
      .get(...params) as { count: number };
    return {
      explanationLimit: limit,
      explanationOffset: offset,
      totalComputedStates: Number(totalRow.count),
      states: rows.map((row) => ({
        attemptNumber: Number(row.attempt_number),
        iteration: Number(row.iteration),
        xBefore: String(row.x_before),
        yBefore: String(row.y_before),
        xAfter: String(row.x_after),
        yAfter: String(row.y_after),
        difference: String(row.difference),
        gcd: String(row.gcd_value)
      }))
    };
  }

  verifyFactor(searchId: string, factor: unknown) {
    const search = this.getSearch(searchId);
    return validateExternalFactor(BigInt(search.n), factor);
  }

  exportSearch(searchId: string) {
    const reports = this.listReports(searchId).map((report) => ({
      ...report,
      states: this.allStates(report.id)
    }));
    return {
      search: this.getSearch(searchId),
      reports
    };
  }

  private allStates(reportId: string) {
    const rows = this.db
      .prepare(
        `SELECT attempt_number, iteration, x_before, y_before, x_after, y_after, difference, gcd_value
         FROM steps WHERE report_id = ? ORDER BY attempt_number, iteration`
      )
      .all(reportId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      attemptNumber: Number(row.attempt_number),
      iteration: Number(row.iteration),
      xBefore: String(row.x_before),
      yBefore: String(row.y_before),
      xAfter: String(row.x_after),
      yAfter: String(row.y_after),
      difference: String(row.difference),
      gcd: String(row.gcd_value)
    }));
  }

  private serializeSearch(row: SearchRow) {
    return {
      id: row.id,
      n: row.n,
      firstC: row.first_c,
      firstX0: row.first_x0,
      algorithmVersion: row.algorithm_version,
      createdAt: row.created_at
    };
  }

  private serializeReport(row: Record<string, unknown>) {
    return {
      id: String(row.id),
      reportNumber: Number(row.report_number),
      budget: {
        maxIterations: Number(row.max_iterations),
        maxAttempts: Number(row.max_attempts)
      },
      found: Boolean(row.found),
      stopReason: String(row.stop_reason),
      factor: row.factor === null ? null : String(row.factor),
      cofactor: row.cofactor === null ? null : String(row.cofactor),
      productWitness: row.product_witness === null ? null : String(row.product_witness),
      usedIterations: Number(row.used_iterations),
      usedAttempts: Number(row.used_attempts),
      createdAt: String(row.created_at)
    };
  }
}
