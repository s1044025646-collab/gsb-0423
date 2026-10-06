#!/usr/bin/env node
import { resolve } from "node:path";
import { openDatabase } from "./db.js";
import { FactorService } from "./service.js";
import { AppError, ErrorCode } from "./errors.js";
import { trialDivisionFactor } from "./rho.js";

const DEFAULT_DB = resolve(process.cwd(), "data", "rho.sqlite");

function getDbPath(): string {
  return process.env.RHO_DB ? resolve(process.env.RHO_DB) : DEFAULT_DB;
}

function usage(): string {
  return [
 "用法：rho <命令> [参数]",
    "",
    "命令：",
    "  create <N> [x0] [c]                创建搜索题（N 为十进制字符串，x0/c 可选）",
    "  solve <searchId> [预算] [尝试上限]  按预算求解并建立报告",
    "  attempts <reportId>                查询某报告的尝试记录",
    "  steps <reportId> <attemptIndex>    查询某次尝试的有限步状态表（碰撞解释）",
    "  verify <searchId> <factor>         独立验证外部因子的乘积见证",
    "  add-budget <searchId> <新预算>      以新预算从头计算，建立新报告",
    "  export <reportId>                  导出报告（输入/参数/结果/解释，JSON）",
    "  demo                               运行内置演示",
    "  help                               显示本帮助",
  ].join("\n");
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function run(): void {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(usage());
    return;
  }

  const service = new FactorService(openDatabase(getDbPath()));

  switch (cmd) {
    case "create": {
      const [n, x0, c] = args;
      if (!n) throw new AppError(ErrorCode.BAD_REQUEST, "用法：create <N> [x0] [c]");
      print(service.createSearch({ n, firstX0: x0, firstC: c }));
      return;
    }
    case "solve":
    case "add-budget": {
      const [idStr, budgetStr, attemptsStr] = args;
      if (!idStr || !budgetStr) throw new AppError(ErrorCode.BAD_REQUEST, `用法：${cmd} <searchId> <预算> [尝试上限]`);
      const result = service.solve({
        searchId: Number(idStr),
        budgetIterations: Number(budgetStr),
        maxAttempts: attemptsStr ? Number(attemptsStr) : undefined,
      });
      print(result.report);
      return;
    }
    case "attempts": {
      if (!args[0]) throw new AppError(ErrorCode.BAD_REQUEST, "用法：attempts <reportId>");
      print(service.listAttempts(Number(args[0])));
      return;
    }
    case "steps": {
      if (!args[0] || args[1] === undefined) {
        throw new AppError(ErrorCode.BAD_REQUEST, "用法：steps <reportId> <attemptIndex>");
      }
      print(service.getSteps(Number(args[0]), Number(args[1])));
      return;
    }
    case "verify": {
      if (!args[0] || !args[1]) throw new AppError(ErrorCode.BAD_REQUEST, "用法：verify <searchId> <factor>");
      print(service.verifyExternal(Number(args[0]), args[1]));
      return;
    }
    case "export": {
      if (!args[0]) throw new AppError(ErrorCode.BAD_REQUEST, "用法：export <reportId>");
      print(service.exportReport(Number(args[0])));
      return;
    }
    case "demo":
      runDemo(service);
      return;
    default:
      throw new AppError(ErrorCode.BAD_REQUEST, `未知命令：${cmd}\n\n${usage()}`);
  }
}

function banner(title: string): void {
  console.log("\n==================== " + title + " ====================");
}

function runDemo(service: FactorService): void {
  banner("演示 1：N = 8051，应找到 83 或 97");
  const s1 = service.createSearch({ n: "8051" });
  const r1 = service.solve({ searchId: s1.id, budgetIterations: 1000, maxAttempts: 10, explainStepLimit: 12 });
  console.log(`报告 #${r1.report.id}，found=${r1.report.found === 1}，factor=${r1.report.factor}，usedIterations=${r1.report.used_iterations}`);
  console.log("前若干步（attempt 0）：");
  print(service.getSteps(r1.report.id, 0));
  if (r1.report.factor !== null) {
    print(service.verifyExternal(s1.id, r1.report.factor));
  }

  banner("演示 2：平方合数 N = 49 = 7 × 7");
  const s2 = service.createSearch({ n: "49" });
  const r2 = service.solve({ searchId: s2.id, budgetIterations: 1000, maxAttempts: 10 });
  console.log(`factor=${r2.report.factor}，stop=${r2.report.overall_stop_reason}，used=${r2.report.used_iterations}`);
  print(service.verifyExternal(s2.id, r2.report.factor ?? "7"));

  banner("演示 3：偶合数 N = 123456，走简单预检直接给因子 2");
  const s3 = service.createSearch({ n: "123456" });
  const r3 = service.solve({ searchId: s3.id, budgetIterations: 1000 });
  console.log(`factor=${r3.report.factor}，precheck=${r3.report.precheck}，rho 迭代数=${r3.report.used_iterations}`);

  banner("演示 4：N = 101（素数），小预算（3 步）——只报告未找到，不宣布素数");
  const s4 = service.createSearch({ n: "101" });
  const r4 = service.solve({ searchId: s4.id, budgetIterations: 3, maxAttempts: 10 });
  console.log(`found=${r4.report.found === 1}，stop=${r4.report.overall_stop_reason}，真实已用=${r4.report.used_iterations}`);
  console.log("独立试除核对 101：", trialDivisionFactor(101n) === null ? "试除范围内无因子（这是独立证据；rho 未找到本身不能证明素数）" : "意外");

  banner("演示 5：增加预算建立新报告（101，预算 50）");
  const r5 = service.solve({ searchId: s4.id, budgetIterations: 50, maxAttempts: 10 });
  console.log(`新报告 #${r5.report.id}：found=${r5.report.found === 1}，used=${r5.report.used_iterations}（从头计算，非断点续搜）`);
}

try {
  run();
} catch (err) {
  if (err instanceof AppError) {
    console.error(JSON.stringify({ error: { code: err.code, message: err.message } }, null, 2));
  } else {
    console.error(err);
  }
  process.exitCode = 1;
}
