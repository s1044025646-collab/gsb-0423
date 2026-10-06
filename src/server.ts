import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { openDatabase, type DB } from "./db.js";
import { FactorService } from "./service.js";
import { AppError, ErrorCode, type ErrorCodeType } from "./errors.js";

const DEFAULT_DB = resolve(process.cwd(), "data", "rho.sqlite");

/** 在指定端口创建服务；port=0 时由操作系统分配空闲端口。 */
export async function listen(server: Server, port: number, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolvePort(addr.port);
      } else {
        reject(new Error("无法获取监听端口"));
      }
    });
  });
}

/** 探测一个空闲端口（用于默认配置）。 */
export function findFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => res(port));
      } else {
        srv.close(() => rej(new Error("无法获取空闲端口")));
      }
    });
  });
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveJson, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_048_576) {
        reject(new AppError(ErrorCode.BAD_REQUEST, "请求体超过 1 MiB 上限"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolveJson({});
      try {
        resolveJson(JSON.parse(raw));
      } catch {
        reject(new AppError(ErrorCode.BAD_REQUEST, "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

function errorBody(code: ErrorCodeType, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export function createApp(dbPathOrDb: string | DB = DEFAULT_DB): Server {
  const db = typeof dbPathOrDb === "string" ? openDatabase(dbPathOrDb) : dbPathOrDb;
  const service = new FactorService(db);

  const server = createServer(async (req, res) => {
    const url = new URL((req.url ?? "/") || "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "");
    const routePath = path === "" ? "/" : path;
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && routePath === "/health") {
        return send(res, 200, { ok: true, service: "pollard-rho", time: new Date().toISOString() });
      }

      // POST /searches
      if (method === "POST" && routePath === "/searches") {
        const body = (await readJson(req)) as { n?: string; firstX0?: string; firstC?: string };
        const row = service.createSearch({ n: body.n, firstX0: body.firstX0, firstC: body.firstC });
        return send(res, 201, row);
      }

      const solveMatch = /^\/searches\/(\d+)\/solve$/.exec(routePath);
      if (method === "POST" && solveMatch) {
        const body = (await readJson(req)) as {
          budgetIterations?: number;
          maxAttempts?: number;
          explainStepLimit?: number;
        };
        const result = service.solve({
          searchId: Number(solveMatch[1]),
          budgetIterations: body.budgetIterations,
          maxAttempts: body.maxAttempts,
          explainStepLimit: body.explainStepLimit,
        });
        return send(res, 201, result.report);
      }

      // 增加预算 = 以新预算从头计算并建立新报告（语义同 solve，提供直观别名）
      const addBudgetMatch = /^\/searches\/(\d+)\/add-budget$/.exec(routePath);
      if (method === "POST" && addBudgetMatch) {
        const body = (await readJson(req)) as {
          budgetIterations?: number;
          maxAttempts?: number;
          explainStepLimit?: number;
        };
        const result = service.solve({
          searchId: Number(addBudgetMatch[1]),
          budgetIterations: body.budgetIterations,
          maxAttempts: body.maxAttempts,
          explainStepLimit: body.explainStepLimit,
        });
        return send(res, 201, result.report);
      }

      const searchMatch = /^\/searches\/(\d+)$/.exec(routePath);
      if (method === "GET" && searchMatch) {
        return send(res, 200, service.getSearch(Number(searchMatch[1])));
      }

      const reportsMatch = /^\/searches\/(\d+)\/reports$/.exec(routePath);
      if (method === "GET" && reportsMatch) {
        return send(res, 200, service.listReports(Number(reportsMatch[1])));
      }

      const verifyMatch = /^\/searches\/(\d+)\/verify$/.exec(routePath);
      if (method === "POST" && verifyMatch) {
        const body = (await readJson(req)) as { factor?: string };
        if (typeof body.factor !== "string") {
          throw new AppError(ErrorCode.BAD_REQUEST, "请求体需要字符串字段 factor");
        }
        return send(res, 200, service.verifyExternal(Number(verifyMatch[1]), body.factor));
      }

      const stepsMatch = /^\/reports\/(\d+)\/attempts\/(\d+)\/steps$/.exec(routePath);
      if (method === "GET" && stepsMatch) {
        return send(
          res,
          200,
          service.getSteps(Number(stepsMatch[1]), Number(stepsMatch[2])),
        );
      }

      const attemptsMatch = /^\/reports\/(\d+)\/attempts$/.exec(routePath);
      if (method === "GET" && attemptsMatch) {
        return send(res, 200, service.listAttempts(Number(attemptsMatch[1])));
      }

      const exportMatch = /^\/reports\/(\d+)\/export$/.exec(routePath);
      if (method === "GET" && exportMatch) {
        return send(res, 200, service.exportReport(Number(exportMatch[1])));
      }

      const reportMatch = /^\/reports\/(\d+)$/.exec(routePath);
      if (method === "GET" && reportMatch) {
        return send(res, 200, service.getReport(Number(reportMatch[1])));
      }

      return send(res, 404, errorBody(ErrorCode.NOT_FOUND, `无此路由：${method} ${routePath}`));
    } catch (err) {
      if (err instanceof AppError) {
        const status =
          err.code === ErrorCode.NOT_FOUND
            ? 404
            : err.code === ErrorCode.INVALID_DECIMAL ||
                err.code === ErrorCode.N_TOO_SMALL ||
                err.code === ErrorCode.N_ABOVE_LIMIT ||
                err.code === ErrorCode.INVALID_PARAM ||
                err.code === ErrorCode.INVALID_BUDGET ||
                err.code === ErrorCode.INVALID_FACTOR
              ? 422
              : 400;
        return send(res, status, errorBody(err.code, err.message));
      }
      const message = err instanceof Error ? err.message : String(err);
      return send(res, 500, errorBody("INTERNAL_ERROR" as ErrorCodeType, message));
    }
  });

  return server;
}

async function main(): Promise<void> {
  const portArg = process.env.PORT ? Number(process.env.PORT) : undefined;
  const port = portArg !== undefined && Number.isInteger(portArg) && portArg >= 0 ? portArg : await findFreePort();
  const dbPath = process.env.RHO_DB ? resolve(process.env.RHO_DB) : DEFAULT_DB;
  const server = createApp(dbPath);
  const actual = await listen(server, port);
  console.log(JSON.stringify({
    message: "Pollard rho 因子搜索后端已启动",
    baseUrl: `http://127.0.0.1:${actual}`,
    db: dbPath,
  }, null, 2));
}

// 仅在作为入口脚本直接运行时启动 HTTP 服务，被测试或其他模块导入时不产生副作用。
if (import.meta.url === new URL(`file://${process.argv[1]!.replace(/\\/g, "/")}`).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
