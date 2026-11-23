import type { Request } from 'express';
import { clientIp } from '../../src/common/http.util';
import { resetConfigCache } from '../../src/config/config';

/** 构造只带来源信息的最小请求对象，聚焦 clientIp 取值逻辑 */
function reqWith(headers: Record<string, string>, remoteAddress?: string, ip?: string): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    socket: remoteAddress ? { remoteAddress } : undefined,
    ip,
  } as unknown as Request;
}

describe('可信来源 IP clientIp（单元）', () => {
  const savedMode = process.env.DEPLOY_MODE;

  afterEach(() => {
    if (savedMode === undefined) delete process.env.DEPLOY_MODE;
    else process.env.DEPLOY_MODE = savedMode;
    resetConfigCache();
  });

  describe('direct 形态（默认，不启动网关）', () => {
    beforeEach(() => {
      delete process.env.DEPLOY_MODE;
      resetConfigCache();
    });

    it('忽略伪造的 X-Forwarded-For，始终取 TCP 对端', () => {
      const req = reqWith({ 'x-forwarded-for': '203.0.113.9' }, '192.0.2.10');
      expect(clientIp(req)).toBe('192.0.2.10');
    });

    it('多段 XFF（含伪造前缀）同样整段忽略', () => {
      const req = reqWith({ 'x-forwarded-for': '203.0.113.9, 198.51.100.7' }, '192.0.2.10');
      expect(clientIp(req)).toBe('192.0.2.10');
    });

    it('无 XFF 时取 TCP 对端；socket 缺失回退 req.ip', () => {
      expect(clientIp(reqWith({}, '192.0.2.10'))).toBe('192.0.2.10');
      expect(clientIp(reqWith({}, undefined, '192.0.2.11'))).toBe('192.0.2.11');
    });
  });

  describe('gateway 形态（前置 Nginx）', () => {
    beforeEach(() => {
      process.env.DEPLOY_MODE = 'gateway';
      resetConfigCache();
    });

    it('取 XFF 最后一跳（网关追加的真实对端），忽略客户端伪造前缀', () => {
      // 客户端自报 203.0.113.9，网关把真实对端 192.0.2.10 追加到末尾
      const req = reqWith({ 'x-forwarded-for': '203.0.113.9, 192.0.2.10' }, '127.0.0.1');
      expect(clientIp(req)).toBe('192.0.2.10');
    });

    it('单段 XFF 与带空格的多段 XFF 正确归一化', () => {
      expect(clientIp(reqWith({ 'x-forwarded-for': '192.0.2.10' }, '127.0.0.1'))).toBe('192.0.2.10');
      expect(clientIp(reqWith({ 'x-forwarded-for': '203.0.113.9,  192.0.2.10  ' }, '127.0.0.1'))).toBe('192.0.2.10');
    });

    it('网关未注入 XFF 时回退 TCP 对端', () => {
      expect(clientIp(reqWith({}, '127.0.0.1'))).toBe('127.0.0.1');
    });
  });
});
