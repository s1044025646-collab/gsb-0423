# Pollard rho 整数因子搜索与循环碰撞解释后端

一个只包含 **API 与 CLI** 的本地后端，用 Pollard rho（Floyd 双速迭代）在固定预算内搜索整数 **N** 的一个非平凡因子，并输出可独立验算的乘积见证。

- 技术栈：TypeScript + Node.js（内置 `node:sqlite`，无需原生编译）
- 运行环境：Windows 本地直接运行，不依赖 Docker / WSL / 付费服务 / 外部在线 API
- 范围：教学规模有界大整数，`4 <= N <= 2^63 - 1`（有符号 64 位上限）
- 传输：JSON 中 `N` 与全部模运算状态（`x`、`y`、差值、gcd、因子）一律用**十进制字符串**，内部全部使用 `BigInt`，绝不经过 `Number` 转换

> 本项目只搜索一个非平凡因子，不做完整素因数分解、不做素数证明、不针对真实密钥，不是攻击工具。

## 算法说明

轨道函数：

```
f(x) = (x*x + c) mod N
```

每次迭代（Floyd 双速）：

```
x <- f(x)          // 前进一步
y <- f(f(y))       // 前进两步
d <- gcd(|x - y|, N)
```

判定规则：

- `d = 1`：未碰撞，继续；
- `1 < d < N`：找到非平凡因子，成功；
- `d = N`：本次轨道**退化**，记录停止原因后，以另一组**确定**参数重新尝试，绝不把 `gcd=N` 当作成功因子。

参数序列固定、公开、可重现：第 0 组为 `(x0, c)`（默认 `(2, 1)`，可在创建搜索题时指定）；之后 `c` 依次 `+1`、`x0` 依次 `+1`（均对 N 取模，`c=0` 时按确定顺移规则避开）。

预算规则：

- **全局迭代（步）预算**跨所有尝试累计，换参数不重置；任何停止都返回真实已用步数；
- **尝试次数上限**独立设置；
- **解释保留上限**与计算预算分开：每步状态（`x`、`y`、`diff`、`gcd`）最多保留前 K 步到数据库，但计算绝不为展示而提前停止；
- 偶合数走简单预检：直接返回因子 `2`，报告中以 `precheck: "even_number_factor_2"` 注明，rho 迭代数为 0。

### “未找到因子”不等于“已证明素数”

预算耗尽或轨道退化换参数后仍无结果时，系统只报告 `iteration_budget_exhausted` / `attempt_limit_exhausted`，含义是**在本次预算内没有找到因子**。这不是素性证明：增大预算仍可能找到因子。若需要证明 N 为素数，应使用独立的素性判定（本项目 CLI 演示中用独立试除对小整数另行核对，仅作教学佐证，与 rho 结论分开）。

### 乘积见证

成功后独立检查三件事，全部通过才接受因子 `d`：

1. `1 < d < N`；
2. `N mod d = 0`；
3. `d * (N / d) = N`。

这只证明分解正确，**不宣称 `d` 与 `N/d` 已是素数**。外部提交的因子也走同一套校验（篡改因子会被拒绝）。

## 环境要求

- Node.js >= 22.5（开发与验证使用 Node v25；`node:sqlite` 为内置模块，无需 npm 原生依赖）
- 运行时可能出现一条 `ExperimentalWarning: SQLite is an experimental feature`，属正常提示，不影响功能。

## 安装、构建、测试、启动

```powershell
npm install        # 仅安装 typescript 与 @types/node 开发依赖
npm run build      # 编译到 dist/
npm test           # 编译测试并运行 node:test（21 个测试）
npm start          # 启动 HTTP 服务
npm run demo       # 构建并运行 CLI 内置演示
```

### 端口与数据目录

- 默认启动时自动选择一个**空闲端口**，启动后在 stdout 打印 `baseUrl`（JSON）；
- 可用环境变量固定端口：`$env:PORT=8791; npm start`；
- SQLite 数据文件默认在项目内 `data/rho.sqlite`，可用 `$env:RHO_DB="E:\path\to\db.sqlite"` 修改；
- 重启后历史搜索题、报告、尝试与逐步状态均可查询。增加预算时**从头计算并建立新报告**（不做断点续搜），旧报告保留。

## HTTP API

所有请求/响应均为 JSON；大整数为十进制字符串。错误响应形如 `{"error":{"code":"...","message":"..."}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/searches` | 创建搜索题：`{"n":"8051","firstX0":"2","firstC":"1"}`（后两个可选） |
| GET | `/searches/:id` | 查询搜索题（含算法版本） |
| POST | `/searches/:id/solve` | 按预算求解：`{"budgetIterations":100000,"maxAttempts":256,"explainStepLimit":40}` |
| POST | `/searches/:id/add-budget` | 以新预算从头计算并建立新报告（请求体同 solve） |
| GET | `/searches/:id/reports` | 列出该题全部报告 |
| GET | `/reports/:id` | 查询单个报告 |
| GET | `/reports/:id/attempts` | 查询尝试记录（起点、c、迭代次数、停止原因、因子） |
| GET | `/reports/:id/attempts/:index/steps` | 某次尝试的有限步状态表（碰撞解释） |
| POST | `/searches/:id/verify` | 验证外部因子：`{"factor":"97"}`，返回乘积见证 |
| GET | `/reports/:id/export` | 导出整份报告（输入/参数序列/算法版本/结果/逐步解释） |

### 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 422 | `INVALID_DECIMAL` | 不是规范十进制字符串（空串、符号、空白、小数点、科学计数法、前导零等） |
| 422 | `N_TOO_SMALL` | N < 4 |
| 422 | `N_ABOVE_LIMIT` | N > 2^63 - 1 |
| 422 | `INVALID_PARAM` | `firstX0` / `firstC` 不满足 `0 <= p < N` |
| 422 | `INVALID_BUDGET` | 预算 / 尝试上限 / 解释上限不是合法整数或超出硬上限 |
| 422 | `INVALID_FACTOR` | 外部验证因子不是规范十进制字符串 |
| 404 | `NOT_FOUND` | 搜索题 / 报告不存在，或路由不存在 |
| 400 | `BAD_REQUEST` | 非法 JSON、缺少字段等 |

硬上限：`budgetIterations <= 2,000,000`，`maxAttempts <= 256`，`explainStepLimit <= 1000`。

### curl 示例（PowerShell）

```powershell
curl.exe -X POST http://127.0.0.1:<port>/searches -H "content-type: application/json" -d '{\"n\":\"8051\"}'
curl.exe -X POST http://127.0.0.1:<port>/searches/1/solve -H "content-type: application/json" -d '{\"budgetIterations\":1000}'
curl.exe http://127.0.0.1:<port>/reports/1/attempts/0/steps
curl.exe -X POST http://127.0.0.1:<port>/searches/1/verify -H "content-type: application/json" -d '{\"factor\":\"97\"}'
```

## CLI

```powershell
node dist/cli.js create 8051                 # 创建（可再跟 x0 c）
node dist/cli.js solve 1 1000 10             # 按预算求解（预算、尝试上限）
node dist/cli.js attempts 1                  # 查询尝试
node dist/cli.js steps 1 0                   # 查询第 0 次尝试的逐步状态
node dist/cli.js verify 1 97                 # 独立验证外部因子
node dist/cli.js add-budget 1 5000           # 新预算从头计算，建立新报告
node dist/cli.js export 1                    # 导出 JSON
node dist/cli.js demo                        # 内置演示
```

## 内置演示内容（`npm run demo`）

1. **8051**：3 步在第 0 条轨道上碰撞出 `gcd=97`，乘积见证 `97 * 83 = 8051`；
2. **49 = 7 × 7**：平方合数，1 步找到 `7`；
3. **123456**（偶合数）：走简单预检直接给因子 `2`，rho 迭代 0；
4. **101**（素数）：预算仅 3 步，报告 `iteration_budget_exhausted`、真实已用 3，不宣布素数；另用独立试除佐证；
5. 对 101 增加预算到 50 步，从头计算建立新报告（仍未找到，但语义明确）。

8051 第一段轨道逐步手算（`x0=y0=2, c=1`）：

| 步 | x | y | \|x-y\| | gcd |
| --- | --- | --- | --- | --- |
| 1 | 5 | 26 | 21 | 1 |
| 2 | 26 | 7474 | 7448 | 1 |
| 3 | 677 | 871 | 194 | 97 |

## 测试覆盖

- 8051 找到 83 或 97 并乘法核对；第一段轨道逐步手算与实现一致；
- 平方合数 49、偶合数预检、101 小预算未找到且返回真实已用次数；
- 人为退化轨道（`x0=0,c=0` 时 `gcd(0,25)=25=N`）后换确定参数继续并最终找到 5，验证不把 `gcd=N` 当成功；
- 全局预算耗尽、解释上限与计算预算独立；
- 非法字符串（`abc`、`-5`、`12.0`、`007`、空串、十六进制等）、N<4、超 2^63 上限；
- 超过 `Number.MAX_SAFE_INTEGER` 的偶数与奇合数（`1000000007 × 1000000009`）全程 BigInt；
- 篡改因子拒绝；小整数因子用独立试除核对；同参数重算一致；关闭后重开同一 SQLite 文件读取一致；完整 HTTP 流程与 422 错误码。

## 限制与边界

- 仅搜索单个非平凡因子，不保证找到的因子是素因子；
- rho 是概率型思想的确定性参数化实现：固定参数序列在固定预算下结果可重现，但轨道不利或 N 实际为素数时会报告未找到，这不是素性结论；
- 不做 Brent 变种、批量 gcd 等性能优化，硬上限面向教学规模（64 位以内）；
- 新预算只保证从头重算与独立新报告，不实现断点续搜。
