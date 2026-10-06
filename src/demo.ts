import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './db.js';

const dbPath = resolve('data/demo.sqlite');
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });

const store = new Store(dbPath);
function caseTitle(title: string) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

try {
  for (const [n, maxIterations, maxAttempts] of [
    ['8051', 100, 20],
    ['49', 100, 20],
    ['50', 100, 20],
    ['101', 3, 2]
  ] as Array<[string, number, number]>) {
    caseTitle(`N=${n}`);
    const search = store.createSearch({ n });
    const report = store.solve(search.id, { maxIterations, maxAttempts });
    process.stdout.write(JSON.stringify({ searchId: search.id, reportId: report.id, ...report }, null, 2));
    process.stdout.write('\n');
    if (report.found) {
      process.stdout.write(`独立验算：${report.productWitness}\n`);
    } else {
      process.stdout.write('预算内未找到因子；这不证明 N 是素数。\n');
    }
    process.stdout.write('\n前 3 个 Floyd 双速迭代状态：\n');
    process.stdout.write(JSON.stringify(store.getStates(search.id, report.id, { limit: 3 }), null, 2));
    process.stdout.write('\n');
  }
} finally {
  store.close();
}
