import { Module } from '@nestjs/common';

/**
 * A4 证书签发能力裁剪说明
 *
 * 本版本已移除证书签发相关的业务逻辑、后台流程、页面入口与菜单项，
 * 仅保留 certificates 数据表（见 DatabaseService 中的建表语句）与埋点事件常量
 * （TelemetryService 中的 CERT_TELEMETRY_EVENTS），用于后续迭代直接复用。
 *
 * 后续恢复该能力时：
 * 1. 在本模块内新增 CertificatesController / CertificatesService；
 * 2. 复用 certificates 表结构与 cert.* 埋点事件；
 * 3. 在 public/ 控制台新增独立入口，避免与现有包管理页面耦合。
 */
@Module({})
export class CertificatesModule {}
