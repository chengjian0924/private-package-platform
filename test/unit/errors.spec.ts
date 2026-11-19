import * as fs from 'node:fs';
import * as path from 'node:path';
import { ApiError, ERROR_DEFS, fail, httpStatusOf } from '../../src/common/errors';

/** 统一错误码：已知 code 映射到正确 status/message，未知 code 兜底，不裸抛 Error */
describe('统一错误码（单元）', () => {
  it('已知 code 使用错误码表的 status 与 message', () => {
    const e = new ApiError('PKG_NOT_FOUND');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ApiError');
    expect(e.code).toBe('PKG_NOT_FOUND');
    expect(e.status).toBe(404);
    expect(e.message).toBe('依赖包不存在');
  });

  it('业务关键错误码的 status 正确（锁定 423 / 只读 507 / 限流 429）', () => {
    expect(new ApiError('AUTH_ACCOUNT_LOCKED').status).toBe(423);
    expect(new ApiError('STORAGE_READ_ONLY').status).toBe(507);
    expect(new ApiError('SYS_RATE_LIMITED').status).toBe(429);
    expect(new ApiError('SEC_SCAN_TIMEOUT').status).toBe(504);
  });

  it('未知 code 兜底为 400 且 message 使用 code 本身', () => {
    const e = new ApiError('SOME_NEW_CODE');
    expect(e.status).toBe(400);
    expect(e.message).toBe('SOME_NEW_CODE');
  });

  it('F-02 回归：BATCH_EMPTY 已登记，返回中文提示而非英文裸 code', () => {
    const e = new ApiError('BATCH_EMPTY');
    expect(e.code).toBe('BATCH_EMPTY');
    expect(e.status).toBe(400);
    expect(e.message).toBe('批次中没有可入库的条目');
    expect(e.message).not.toBe('BATCH_EMPTY');
  });

  it('空值 / 极端 code 入参不抛 TypeError', () => {
    expect(new ApiError('').status).toBe(400);
    expect(new ApiError('a'.repeat(1000)).code).toBe('a'.repeat(1000));
    expect(new ApiError(undefined as unknown as string).status).toBe(400);
  });

  it('details 原样保存；可显式覆盖 message 与 status', () => {
    const details = { field: 'username' };
    const e = new ApiError('SYS_VALIDATION', details, '自定义提示', 422);
    expect(e.details).toBe(details);
    expect(e.message).toBe('自定义提示');
    expect(e.status).toBe(422);
  });

  it('fail 抛出 ApiError 而非返回', () => {
    expect(() => fail('AUTH_FORBIDDEN')).toThrow(ApiError);
    try {
      fail('AUTH_FORBIDDEN', { reason: 'role' });
    } catch (err) {
      expect(err).toMatchObject({ code: 'AUTH_FORBIDDEN', status: 403 });
      expect((err as ApiError).details).toEqual({ reason: 'role' });
    }
  });

  it('httpStatusOf 用传入状态码生成通用错误定义', () => {
    expect(httpStatusOf(418)).toEqual({ status: 418, message: '请求处理失败' });
  });

  it('错误码表无重复定义且每个条目都有 status 与 message', () => {
    const codes = Object.keys(ERROR_DEFS);
    expect(codes.length).toBeGreaterThan(50);
    for (const code of codes) {
      expect(ERROR_DEFS[code].status).toBeGreaterThanOrEqual(400);
      expect(ERROR_DEFS[code].message.length).toBeGreaterThan(0);
    }
  });

  it('F-02 回归：业务代码抛出的错误码必须全部在错误码表登记（否则前端只看到英文裸 code）', () => {
    const srcDir = path.resolve(__dirname, '../../src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (full.endsWith('.ts')) files.push(full);
      }
    };
    walk(srcDir);
    const used = new Set<string>();
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?:fail|new ApiError)\(\s*'([A-Z][A-Z0-9_]*)'/g)) used.add(m[1]);
    }
    const unregistered = [...used].filter((code) => !(code in ERROR_DEFS));
    expect(unregistered).toEqual([]);
  });
});
