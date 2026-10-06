# Pollard Rho 有界整数因子搜索后端

这是一个只包含 API 与 CLI 的 Windows 本地教学后端，使用 TypeScript、Node.js 和内置 SQLite（`node:sqlite`）。它搜索正整数 `N` 的**一个**严格非平凡因子，并给出可独立验算的乘法见证。

## 能力边界

- 使用 BigInt 完成乘法、余数、差值和最大公因数，不把中间模运算状态转成 `Number`。
- `N` 和所有状态以十进制字符串传输；上限为有符号 64 位整数 `9223372036854775807`。
- 奇数使用 Floyd 双速迭代：`x=f(x)`，`y=f(f(y))`，再计算 `gcd(|x-y|, N)`，其中 `f(x)=(x*x+c) mod N`。
- `gcd=1` 继续；`1<gcd<N` 找到因子；`gcd=N` 表示该轨道退化，会换下一组确定参数。
- 偶数先做简单预检，直接返回因子 `2`。
- 搜索失败只表示“当前预算内未找到”，**不证明 N 是素数**，也不表示不存在因子。
- 成功后独立检查 `1<factor<N`、`N mod factor=0`、`factor*cofactor=N`；这只证明分解正确，不宣称两个因子为素数。
- 不提供完整素因数分解、素数证明，也不应作为真实密钥攻击工具。

## 环境要求

- Windows 本地 Node.js 25 或支持 `node:sqlite` 的版本。
- 不需要 Docker、WSL、付费服务或在线 API。
- 默认数据库在项目内 `data/pollard.sqlite`。

## 构建、测试、启动、演示

```powershell
npm install
npm run build
npm test
npm start
npm run demo
```

`npm start` 默认让操作系统分配 `127.0.0.1` 的空闲端口，并在控制台打印地址。也可以指定：

```powershell
$env:PORT="3000"; npm start
node --experimental-sqlite dist/cli.js serve --port 3000
```

## CLI

```powershell
node --experimental-sqlite dist/cli.js create --n 8051
node --experimental-sqlite dist/cli.js solve --id <搜索ID> --max-iterations 100 --max-attempts 20
node --experimental-sqlite dist/cli.js reports --id <搜索ID>
node --experimental-sqlite dist/cli.js states --id <搜索ID> --report-id <报告ID> --attempt 1 --limit 10
node --experimental-sqlite dist/cli.js verify --id <搜索ID> --factor 83
node --experimental-sqlite dist/cli.js export --id <搜索ID>
```

指定第一组参数：

```powershell
node --experimental-sqlite dist/cli.js create --n 25 --first-c 5 --first-x0 0
```

## HTTP API

所有 JSON 数字字段按要求使用十进制字符串；预算是小型安全整数。

- `POST /searches`：创建搜索。
  ```json
  { "n": "8051", "firstC": "1", "firstX0": "2" }
  ```
- `POST /searches/:id/solve`：按预算从头计算并生成一份新报告。
  ```json
  { "budget": { "maxIterations": 100, "maxAttempts": 20 } }
  ```
- `GET /searches/:id`：查询输入和算法版本。
- `GET /searches/:id/reports`：列出所有报告。
- `GET /searches/:id/reports/:reportId`：查询一次报告和尝试摘要。
- `GET /searches/:id/reports/:reportId/states?attempt=1&limit=20&offset=0`：分页查询碰撞解释状态。
- `POST /searches/:id/verify`：验证外部因子，请求 `{ "factor": "83" }`。
- `GET /searches/:id/export`：导出搜索、报告和尝试。

## 预算与解释

全局硬上限为 `100000` 次迭代、`100` 次尝试。计算预算与解释分页上限相互独立：

- 即使只查询前几步，也会先按预算完成本次计算并保存所有已计算状态。
- 一次报告内切换参数不会重置全局已用迭代数。
- 增加预算会从头重算并生成新报告，不做断点续搜。
- 尝试预算或迭代预算耗尽都会返回真实的 `usedIterations` 和 `usedAttempts`。

## 确定性参数

默认参数不使用随机等待。若指定 `firstC`、`firstX0`，该组参数排第一；之后使用固定的起点表 `[2,3,5,7,11,13]` 和常数表 `[1,2,3,5,7,11,13,17]`，再按确定规则补充。相同输入、参数和预算产生相同轨道。

## 错误码

- `INVALID_JSON`：请求体不是合法 JSON。
- `INVALID_NUMBER`：不是规范十进制字符串。
- `NUMBER_TOO_LARGE`：超过有符号 64 位上限。
- `INVALID_N`：`N < 4`。
- `INVALID_PARAMETER`：起点或 `c` 不在 `[0,N)`。
- `INVALID_BUDGET`：预算不是正安全整数或超过硬上限。
- `INVALID_FACTOR`：候选因子不满足严格范围。
- `NOT_FOUND`：搜索或报告不存在。
- `METHOD_NOT_ALLOWED`：HTTP 方法不支持。
- `INTERNAL_ERROR`：服务内部错误。

## 数据持久化

SQLite 表保存：

- 输入、首组参数和算法版本；
- 每份报告的预算、停止原因、结果、乘积见证和真实用量；
- 每次尝试的起点、`c`、迭代次数、停止原因；
- 每一步的 `x`、`y`、差值和 `gcd`。

重启后可以继续查询旧数据；执行新预算会生成新的报告编号。
