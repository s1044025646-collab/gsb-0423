#!/usr/bin/env node
import { resolve } from 'node:path';
import { Store } from './db.js';
import { startServer } from './server.js';
import { defaultBudgets, runPollardRho } from './pollard.js';
import { parsePositiveInt, validateExternalFactor, validateN, validateParameter } from './numbers.js';
import { HARD_MAX_ATTEMPTS, HARD_MAX_ITERATIONS } from './constants.js';

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        index += 1;
      } else {
        args[key] = 'true';
      }
    }
  }
  return args;
}

function budgetsFromArgs(args: Record<string, string>) {
  return {
    maxIterations: parsePositiveInt(
      args['max-iterations'] ? Number(args['max-iterations']) : defaultBudgets().maxIterations,
      'max-iterations',
      HARD_MAX_ITERATIONS
    ),
    maxAttempts: parsePositiveInt(
      args['max-attempts'] ? Number(args['max-attempts']) : defaultBudgets().maxAttempts,
      'max-attempts',
      HARD_MAX_ATTEMPTS
    )
  };
}

function print(value: unknown) {
  const json = JSON.stringify(
    value,
    (_key, item) => (typeof item === 'bigint' ? item.toString() : item),
    2
  );
  process.stdout.write(`${json}\n`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const dbPath = resolve(args.db ?? 'data/pollard.sqlite');
  const store = new Store(dbPath);

  try {
    switch (command) {
      case 'serve': {
        const requestedPort = args.port ? Number(args.port) : undefined;
        const result = await startServer(dbPath, requestedPort);
        process.stdout.write(`API 已启动：http://127.0.0.1:${result.port}\n`);
        break;
      }
      case 'create': {
        const n = validateN(args.n);
        const firstC = args['first-c'] === undefined ? undefined : validateParameter(args['first-c'], 'first-c', n);
        const firstX0 = args['first-x0'] === undefined ? undefined : validateParameter(args['first-x0'], 'first-x0', n);
        print(store.createSearch({ n: args.n, firstC: args['first-c'], firstX0: args['first-x0'] }));
        break;
      }
      case 'solve': {
        if (!args.id) throw new Error('--id 必填');
        print(store.solve(args.id, budgetsFromArgs(args)));
        break;
      }
      case 'get':
        print(store.getSearch(args.id ?? ''));
        break;
      case 'report':
        print(store.getReport(args.id ?? '', args['report-id'] ?? ''));
        break;
      case 'reports':
        print({ reports: store.listReports(args.id ?? '') });
        break;
      case 'states':
        print(
          store.getStates(args.id ?? '', args['report-id'] ?? '', {
            attempt: args.attempt ? Number(args.attempt) : undefined,
            limit: args.limit ? Number(args.limit) : undefined,
            offset: args.offset ? Number(args.offset) : undefined
          })
        );
        break;
      case 'verify': {
        if (!args.id || args.factor === undefined) throw new Error('--id 与 --factor 必填');
        const search = store.getSearch(args.id);
        print(validateExternalFactor(BigInt(search.n), args.factor));
        break;
      }
      case 'export':
        print(store.exportSearch(args.id ?? ''));
        break;
      case 'direct': {
        const n = validateN(args.n);
        const firstC = args['first-c'] === undefined ? undefined : validateParameter(args['first-c'], 'first-c', n);
        const firstX0 = args['first-x0'] === undefined ? undefined : validateParameter(args['first-x0'], 'first-x0', n);
        print(runPollardRho({ n, firstC, firstX0 }, budgetsFromArgs(args)));
        break;
      }
      case 'demo':
        await import('./demo.js');
        break;
      default:
        process.stderr.write(
          '用法: pollard <serve|create|solve|get|report|reports|states|verify|export|direct|demo> [参数]\n'
        );
        process.exitCode = 1;
    }
  } finally {
    if (command !== 'serve') store.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
