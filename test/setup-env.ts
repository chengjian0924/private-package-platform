/**
 * jest 启动前注入测试环境变量。
 * 与 .env.test 保持同一组参数，避免测试绕过环境隔离直连开发数据。
 */
process.env.NODE_ENV = 'test';
process.env.PORT = '3100';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3100';
process.env.DATA_DIR = './data/test';

process.env.SESSION_TTL_SEC = '7200';
process.env.SESSION_IDLE_TTL_SEC = '900';
process.env.AUTH_CACHE_TTL_MS = '5000';

// 本地账号认证：账号由 app-factory 通过内置管理员流程创建（详见 app-factory.ts）
// 口令强度、失败锁定阈值用 config 默认值（8 位 / 5 次 / 15 分钟），与生产基线一致

process.env.MAX_MANIFEST_BYTES = String(10 * 1024 * 1024);
process.env.MAX_ITEMS = '5000';
process.env.MAX_UPLOAD_BYTES = String(200 * 1024 * 1024);
process.env.BATCH_DEFAULT_MODE = 'partial';
process.env.DEFAULT_NODE_TARGET = '20.11.0';
process.env.DEFAULT_PYTHON_TARGET = '3.11.9';

// 安全校验：测试环境关闭定时复检，复检用例通过 API 手动触发
process.env.SECURITY_BLOCK_SEVERITY = 'critical';
process.env.SECURITY_QUARANTINE_SEVERITY = 'high';
process.env.SECURITY_RESCAN_INTERVAL_SEC = '0';
process.env.SECURITY_REQUIRE_SIGNATURE = 'false';
process.env.SECURITY_TRUSTED_KEYS = '[]';
process.env.SECURITY_MAX_SCAN_FILE_BYTES = String(200 * 1024 * 1024);
process.env.SECURITY_MAX_SCAN_ENTRIES = '5000';
process.env.SECURITY_MAX_SCAN_TOTAL_BYTES = String(32 * 1024 * 1024);
