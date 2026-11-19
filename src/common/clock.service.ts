import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as crypto from 'node:crypto';
import * as dgram from 'node:dgram';
import { isIP } from 'node:net';
import { getConfig } from '../config/config';

export interface ClockSnapshot {
  server: string;
  offsetMs: number | null;
  sampledAt: string;
  healthy: boolean | null;
}

const NTP_PORT = 123;
const PACKET_BYTES = 48;

/** SNTP 客户端报文：LI=0、VN=3、Mode=3；transmit timestamp 填随机 nonce 防重放 */
export function buildSntpRequest(nonce: Buffer): Buffer {
  const packet = Buffer.alloc(PACKET_BYTES);
  packet[0] = 0x1b;
  nonce.copy(packet, 40, 0, 8);
  return packet;
}

/**
 * 只取服务器 transmit timestamp 估算偏移：
 * offset ≈ t3 - (t1 + t4) / 2，忽略 t2 与 t3 的微小差异；
 * 内网 RTT 通常在毫秒级，用于 1s 阈值告警足够。
 */
export function parseSntpOffset(sentAtMs: number, receivedAtMs: number, packet: Buffer): number | null {
  if (packet.length < PACKET_BYTES) return null;
  const seconds = packet.readUInt32BE(40);
  const fraction = packet.readUInt32BE(44);
  if (seconds === 0 && fraction === 0) return null;
  const serverMs = seconds * 1000 + (fraction / 2 ** 32) * 1000;
  return Math.round(serverMs - (sentAtMs + receivedAtMs) / 2);
}

/**
 * B5：SNTP 时钟采样。主机时钟漂移会直接影响会话过期判断与审计时间可信度，
 * 也会让审计时间不可信；本服务只做观测与告警，不自动调整系统时钟。
 */
@Injectable()
export class ClockService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Clock');
  private state: ClockSnapshot = { server: '', offsetMs: null, sampledAt: '', healthy: null };
  private timer?: NodeJS.Timeout;
  private sampling = false;

  onModuleInit(): void {
    const cfg = getConfig();
    this.state.server = cfg.clock.ntpServer;
    if (!cfg.clock.ntpServer) {
      if (cfg.envName === 'production') this.logger.warn('未配置 NTP_SERVER，跳过时钟偏移采样');
      return;
    }
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, cfg.clock.ntpIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    const cfg = getConfig();
    if (!cfg.clock.ntpServer || this.sampling) return;
    this.sampling = true;
    try {
      const offsetMs = await this.query(cfg.clock.ntpServer, 3000);
      const healthy = Math.abs(offsetMs) <= cfg.clock.ntpMaxOffsetMs;
      this.state = {
        server: cfg.clock.ntpServer,
        offsetMs,
        sampledAt: new Date().toISOString(),
        healthy,
      };
      if (healthy) {
        this.logger.log(`时钟偏移 ${offsetMs}ms，在阈值 ${cfg.clock.ntpMaxOffsetMs}ms 内`);
      } else {
        this.logger.warn(
          `主机时钟偏移 ${offsetMs}ms 超过阈值 ${cfg.clock.ntpMaxOffsetMs}ms，请检查 NTP 校时`,
        );
      }
    } catch (err) {
      // 采样失败不改写上次结果，但健康状态置为未知，避免误报为正常
      this.logger.warn(`NTP 采样失败（${cfg.clock.ntpServer}）：${(err as Error).message}`);
      this.state = { ...this.state, healthy: null };
    } finally {
      this.sampling = false;
    }
  }

  snapshot(): ClockSnapshot {
    return { ...this.state };
  }

  private query(server: string, timeoutMs: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const socket = dgram.createSocket(isIP(server) === 6 ? 'udp6' : 'udp4');
      const sentAt = Date.now();
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('timeout'));
      }, timeoutMs);
      timer.unref();

      socket.once('error', (err) => {
        clearTimeout(timer);
        socket.close();
        reject(err);
      });
      socket.once('message', (message) => {
        clearTimeout(timer);
        socket.close();
        const offset = parseSntpOffset(sentAt, Date.now(), message);
        if (offset === null) reject(new Error('invalid_response'));
        else resolve(offset);
      });
      socket.send(buildSntpRequest(crypto.randomBytes(8)), NTP_PORT, server, (err) => {
        if (!err) return;
        clearTimeout(timer);
        socket.close();
        reject(err);
      });
    });
  }
}
