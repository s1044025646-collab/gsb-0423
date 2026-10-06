import { AppError } from './errors.js';
import { ERROR_CODES, MAX_SIGNED_64 } from './constants.js';

export function parseCanonicalDecimal(value: unknown, fieldName: string): bigint {
  if (typeof value !== 'string') {
    throw new AppError(ERROR_CODES.INVALID_NUMBER, `${fieldName} 必须是十进制字符串`);
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new AppError(
      ERROR_CODES.INVALID_NUMBER,
      `${fieldName} 必须是规范十进制字符串：仅含数字，且除 0 外不能有前导零`
    );
  }
  const parsed = BigInt(value);
  if (parsed > MAX_SIGNED_64) {
    throw new AppError(ERROR_CODES.NUMBER_TOO_LARGE, `${fieldName} 超过有符号 64 位上限`);
  }
  return parsed;
}

export function parsePositiveInt(value: unknown, fieldName: string, hardMax: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new AppError(ERROR_CODES.INVALID_BUDGET, `${fieldName} 必须是正安全整数`);
  }
  if (value > hardMax) {
    throw new AppError(ERROR_CODES.INVALID_BUDGET, `${fieldName} 不能超过 ${hardMax}`);
  }
  return value;
}

export function parseNonNegativeInt(value: unknown, fieldName: string, hardMax: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AppError(ERROR_CODES.INVALID_BUDGET, `${fieldName} 必须是非负安全整数`);
  }
  if (value > hardMax) {
    throw new AppError(ERROR_CODES.INVALID_BUDGET, `${fieldName} 不能超过 ${hardMax}`);
  }
  return value;
}

export function gcd(a: bigint, b: bigint): bigint {
  let left = a < 0n ? -a : a;
  let right = b < 0n ? -b : b;
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left;
}

export function absDifference(a: bigint, b: bigint): bigint {
  return a >= b ? a - b : b - a;
}

export function validateN(value: unknown): bigint {
  const n = parseCanonicalDecimal(value, 'n');
  if (n < 4n) {
    throw new AppError(ERROR_CODES.INVALID_N, 'n 必须大于等于 4');
  }
  return n;
}

export function validateParameter(value: unknown, fieldName: string, n: bigint): bigint {
  const parsed = parseCanonicalDecimal(value, fieldName);
  if (parsed >= n) {
    throw new AppError(ERROR_CODES.INVALID_PARAMETER, `${fieldName} 必须满足 0 <= ${fieldName} < n`);
  }
  return parsed;
}

export function validateExternalFactor(n: bigint, factorInput: unknown) {
  const factor = parseCanonicalDecimal(factorInput, 'factor');
  if (factor <= 1n || factor >= n) {
    throw new AppError(ERROR_CODES.INVALID_FACTOR, '因子必须严格满足 1 < factor < n');
  }
  const divides = n % factor === 0n;
  const cofactor = divides ? n / factor : null;
  const productChecks = cofactor === null ? false : factor * cofactor === n;
  return {
    n: n.toString(),
    factor: factor.toString(),
    valid: divides && productChecks,
    divides,
    cofactor: cofactor === null ? null : cofactor.toString(),
    productWitness:
      cofactor === null
        ? null
        : `${factor.toString()} * ${cofactor.toString()} = ${(factor * cofactor).toString()}`
  };
}
