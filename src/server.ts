import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { AppError } from './errors.js';
import { ERROR_CODES, HARD_MAX_ATTEMPTS, HARD_MAX_ITERATIONS } from './constants.js';
import { parseNonNegativeInt, parsePositiveInt } from './numbers.js';
import { Store } from './db.js';

export function findFreePort(preferredPort = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on('error', reject);
    server.listen(preferredPort, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('无法取得空闲端口')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function readJson(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) {
      throw new AppError(ERROR_CODES.INVALID_JSON, '请求体超过 1 MB');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError(ERROR_CODES.INVALID_JSON, '请求体不是合法 JSON');
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body, null, 2));
}

function getBudgets(body: any) {
  const budget = body.budget ?? {};
  if (typeof budget !== 'object' || budget === null || Array.isArray(budget)) {
    throw new AppError(ERROR_CODES.INVALID_BUDGET, 'budget 必须是对象');
  }
  return {
    maxIterations: parsePositiveInt(
      budget.maxIterations ?? 10_000,
      'budget.maxIterations',
      HARD_MAX_ITERATIONS
    ),
    maxAttempts: parsePositiveInt(budget.maxAttempts ?? 20, 'budget.maxAttempts', HARD_MAX_ATTEMPTS)
  };
}

export function createApp(store: Store): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = request.method ?? 'GET';

      if (parts[0] === 'health' && method === 'GET') {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (parts[0] === 'searches' && parts.length === 1 && method === 'POST') {
        const body = await readJson(request);
        sendJson(response, 201, store.createSearch(body));
        return;
      }

      if (parts[0] === 'searches' && parts.length === 2 && method === 'GET') {
        sendJson(response, 200, store.getSearch(parts[1]));
        return;
      }

      if (parts[0] === 'searches' && parts.length === 2 && parts[2] === undefined && method === 'POST') {
        throw new AppError(ERROR_CODES.METHOD_NOT_ALLOWED, '该路径不支持此方法', 405);
      }

      if (parts[0] === 'searches' && parts.length === 3 && parts[2] === 'solve' && method === 'POST') {
        const body = await readJson(request);
        sendJson(response, 201, store.solve(parts[1], getBudgets(body)));
        return;
      }

      if (parts[0] === 'searches' && parts.length === 3 && parts[2] === 'reports' && method === 'GET') {
        sendJson(response, 200, { reports: store.listReports(parts[1]) });
        return;
      }

      if (parts[0] === 'searches' && parts.length === 3 && parts[2] === 'export' && method === 'GET') {
        sendJson(response, 200, store.exportSearch(parts[1]));
        return;
      }

      if (parts[0] === 'searches' && parts.length === 3 && parts[2] === 'verify' && method === 'POST') {
        const body = await readJson(request);
        sendJson(response, 200, store.verifyFactor(parts[1], body.factor));
        return;
      }

      if (parts[0] === 'searches' && parts.length === 5 && parts[2] === 'reports' && parts[4] === 'states' && method === 'GET') {
        const attemptText = url.searchParams.get('attempt');
        const attempt = attemptText === null ? undefined : parsePositiveInt(Number(attemptText), 'attempt', Number.MAX_SAFE_INTEGER);
        const limitText = url.searchParams.get('limit');
        const offsetText = url.searchParams.get('offset');
        const limit = limitText === null ? undefined : parsePositiveInt(Number(limitText), 'limit', 1_000);
        const offset =
          offsetText === null
            ? undefined
            : parseNonNegativeInt(Number(offsetText), 'offset', Number.MAX_SAFE_INTEGER);
        sendJson(response, 200, store.getStates(parts[1], parts[3], { attempt, limit, offset }));
        return;
      }

      if (parts[0] === 'searches' && parts.length === 4 && parts[2] === 'reports' && method === 'GET') {
        sendJson(response, 200, store.getReport(parts[1], parts[3]));
        return;
      }

      sendJson(response, 404, { error: { code: ERROR_CODES.NOT_FOUND, message: '路由不存在' } });
    } catch (error) {
      if (error instanceof AppError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } });
      } else {
        const message = error instanceof Error ? error.message : '未知错误';
        sendJson(response, 500, { error: { code: ERROR_CODES.INTERNAL_ERROR, message } });
      }
    }
  });
}

export async function startServer(dbPath: string, requestedPort?: number): Promise<{ server: Server; port: number }> {
  const port = await findFreePort(requestedPort ?? Number(process.env.PORT ?? 0));
  const store = new Store(dbPath);
  const server = createApp(store);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, port };
}
