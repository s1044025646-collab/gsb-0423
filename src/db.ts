import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * SQLite 持久层。使用 Node 内置 node:sqlite（Node >= 22.5，实验标志在 23.4+ 取消）。
 * 数据文件位于项目内 data 目录，重启后可查。
 */
export function openDatabase(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      n TEXT NOT NULL,
      first_x0 TEXT NOT NULL,
      first_c TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id INTEGER NOT NULL REFERENCES searches(id),
      budget_iterations INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      explain_step_limit INTEGER NOT NULL,
      found INTEGER NOT NULL,
      factor TEXT,
      cofactor TEXT,
      used_iterations INTEGER NOT NULL,
      overall_stop_reason TEXT NOT NULL,
      precheck TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL REFERENCES reports(id),
      attempt_index INTEGER NOT NULL,
      x0 TEXT NOT NULL,
      c TEXT NOT NULL,
      iterations INTEGER NOT NULL,
      stop_reason TEXT NOT NULL,
      factor TEXT
    );
    CREATE TABLE IF NOT EXISTS steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_pk INTEGER NOT NULL REFERENCES attempts(id),
      step INTEGER NOT NULL,
      x TEXT NOT NULL,
      y TEXT NOT NULL,
      diff TEXT NOT NULL,
      gcd TEXT NOT NULL
    );
  `);
  return db;
}

export type DB = ReturnType<typeof openDatabase>;
