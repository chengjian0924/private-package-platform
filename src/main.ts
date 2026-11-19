import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { resolveAppModule } from './app.module';
import { configureApp } from './app.setup';
import { AuthService } from './auth/auth.service';
import { JsonLogger } from './common/logger';
import { assertProductionReady, ConfigError, getConfig } from './config/config';

const logger = new JsonLogger();

async function bootstrap(): Promise<void> {
  // 生产配置不达标时直接拒绝启动，避免带着弱口令或明文基址上线
  try {
    assertProductionReady();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    logger.error('生产环境配置校验未通过，已拒绝启动', undefined, 'Config');
    for (const problem of err.problems) logger.error(problem, undefined, 'Config');
    process.exit(1);
  }

  const cfg = getConfig();
  const app = await NestFactory.create<NestExpressApplication>(resolveAppModule(cfg.role), {
    bodyParser: false,
    // 早期启动日志也走结构化输出
    logger,
  });
  configureApp(app);
  // A4：BIND_HOST 收敛监听地址，走 Nginx 网关的生产环境设 127.0.0.1
  await app.listen(cfg.port, cfg.bindHost);

  // 建号只由控制台进程负责：registry 进程并发建号会撞唯一约束，且 npm/pypi 本就不提供登录入口
  if (cfg.role === 'all' || cfg.role === 'console') {
    await app.get(AuthService).ensureBootstrapAdmin();
  }

  logger.log(`角色=${cfg.role} 环境=${cfg.envName} 端口=${cfg.port} 数据目录=${cfg.dataDir}`, 'Bootstrap');
  logger.log(`Web 控制台: ${cfg.publicBaseUrl}/`, 'Bootstrap');
  logger.log(`npm registry: ${cfg.npmBaseUrl}/npm/`, 'Bootstrap');
  logger.log(`PyPI index: ${cfg.pypiBaseUrl}/pypi/simple/`, 'Bootstrap');
  // 拆分部署时若漏配专属基址，packument 里的 tarball 会指回控制台端口，安装会 404
  if (cfg.role === 'npm' && !process.env.NPM_BASE_URL) {
    logger.warn('PROCESS_ROLE=npm 但未设置 NPM_BASE_URL，tarball 下载地址将回落 PUBLIC_BASE_URL', 'Bootstrap');
  }
  if (cfg.role === 'pypi' && !process.env.PYPI_BASE_URL) {
    logger.warn('PROCESS_ROLE=pypi 但未设置 PYPI_BASE_URL，索引展示地址将回落 PUBLIC_BASE_URL', 'Bootstrap');
  }
  logger.log('登录方式：本地账号密码（首次部署使用 BOOTSTRAP_ADMIN_USERNAME/PASSWORD 建号后必须改密）', 'Bootstrap');
  if (cfg.envName === 'production' && cfg.allowInsecureBaseUrl) {
    logger.warn(
      '已启用 ALLOW_INSECURE_BASE_URL：对外地址为明文 HTTP，登录态与令牌在内网可被嗅探，请确保已做网络隔离并纳入风险清单',
      'Bootstrap',
    );
  }

  // A-07：Nest 的 shutdown hook 负责排空，这里只做硬超时兜底，避免 keep-alive 长连接拖住进程
  const armShutdownWatchdog = (signal: string): void => {
    logger.warn(`收到 ${signal}，开始优雅停机（硬超时 ${cfg.shutdown.hardTimeoutMs}ms）`, 'Bootstrap');
    const watchdog = setTimeout(() => {
      logger.error(`优雅停机超过 ${cfg.shutdown.hardTimeoutMs}ms，仍有请求/连接未释放，强制退出`, undefined, 'Bootstrap');
      process.exit(1);
    }, cfg.shutdown.hardTimeoutMs);
    // 正常排空完成后进程应立即退出，不能被动等待看门狗
    watchdog.unref();
  };
  process.once('SIGTERM', () => armShutdownWatchdog('SIGTERM'));
  process.once('SIGINT', () => armShutdownWatchdog('SIGINT'));
}

bootstrap().catch((err) => {
  // 启动失败必须显式退出并打印原因，避免进程挂在半启动状态
  logger.error('启动失败', err instanceof Error ? err.stack : undefined, 'Bootstrap');
  process.exit(1);
});

// 兜底异常：记录结构化日志后退出，由 systemd Restart=always 自动拉起（A4；直连部署仍需人工介入）
process.on('uncaughtException', (err) => {
  logger.error(`未捕获异常: ${err.message}`, err.stack, 'Process');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error(`未处理的 Promise 拒绝: ${err.message}`, err.stack, 'Process');
  process.exit(1);
});
