/**
 * 统一错误码：所有面向 API / CLI 的校验失败都使用这里定义的码。
 */
export const ErrorCode = {
  INVALID_DECIMAL: "INVALID_DECIMAL",
  N_TOO_SMALL: "N_TOO_SMALL",
  N_ABOVE_LIMIT: "N_ABOVE_LIMIT",
  INVALID_PARAM: "INVALID_PARAM",
  INVALID_BUDGET: "INVALID_BUDGET",
  NOT_FOUND: "NOT_FOUND",
  INVALID_FACTOR: "INVALID_FACTOR",
  BAD_REQUEST: "BAD_REQUEST",
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  readonly code: ErrorCodeType;
  constructor(code: ErrorCodeType, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

/** 有符号 64 位整数上限 2^63 - 1。 */
export const SIGNED_64_MAX = (1n << 63n) - 1n;

/**
 * 严格解析十进制非负整数字符串：
 * - 必须是非空字符串；
 * - 只允许 ASCII 数字 0-9，不允许符号、空白、下划线、小数点、科学计数法；
 * - 除单个 "0" 外不允许前导零；
 * - 不限制 Number 安全整数范围（结果为 BigInt）。
 */
export function parseDecimalString(value: unknown, field = "N"): bigint {
  if (typeof value !== "string") {
    throw new AppError(
      ErrorCode.INVALID_DECIMAL,
      `${field} 必须是十进制字符串，实际类型为 ${typeof value}`,
    );
  }
  if (value.length === 0) {
    throw new AppError(ErrorCode.INVALID_DECIMAL, `${field} 不能为空字符串`);
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new AppError(
      ErrorCode.INVALID_DECIMAL,
      `${field} 只能包含十进制数字 0-9，不能带符号、空白或小数点：${JSON.stringify(value)}`,
    );
  }
  if (value.length > 1 && value.startsWith("0")) {
    throw new AppError(
      ErrorCode.INVALID_DECIMAL,
      `${field} 不允许前导零：${JSON.stringify(value)}`,
    );
  }
  let result = 0n;
  for (const ch of value) {
    result = result * 10n + BigInt(ch.charCodeAt(0) - 48);
  }
  return result;
}

/**
 * 校验并返回搜索目标 N：
 * - 合法十进制字符串；
 * - N >= 4（题目要求严格介于 1 与 N 之间的因子）；
 * - N <= 2^63 - 1（有符号 64 位上限）。
 */
export function validateN(value: unknown): bigint {
  const n = parseDecimalString(value, "N");
  if (n < 4n) {
    throw new AppError(ErrorCode.N_TOO_SMALL, `N 必须 >= 4（需要存在严格介于 1 与 N 之间的因子），收到 ${n.toString()}`);
  }
  if (n > SIGNED_64_MAX) {
    throw new AppError(
      ErrorCode.N_ABOVE_LIMIT,
      `N 超过有符号 64 位上限 ${SIGNED_64_MAX.toString()}，收到 ${n.toString()}`,
    );
  }
  return n;
}

/** 校验可选的 c / x0 十进制字符串参数（允许 0，不能为负数）。 */
export function validateParam(value: unknown, field: string, limit: bigint): bigint {
  const parsed = parseDecimalString(value, field);
  if (parsed >= limit) {
    throw new AppError(
      ErrorCode.INVALID_PARAM,
      `${field} 必须满足 0 <= ${field} < N（当前上限 ${limit.toString()}），收到 ${parsed.toString()}`,
    );
  }
  return parsed;
}

/** 校验正整数预算（迭代数 / 尝试次数）。 */
export function validatePositiveInt(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new AppError(ErrorCode.INVALID_BUDGET, `${field} 必须是正整数，收到 ${JSON.stringify(value)}`);
  }
  if (value > max) {
    throw new AppError(ErrorCode.INVALID_BUDGET, `${field} 不能超过 ${max}，收到 ${value}`);
  }
  return value;
}
