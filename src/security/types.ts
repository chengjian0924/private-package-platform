import type { Ecosystem } from '../packages/packages.service';

/** 风险等级：none 表示无风险，其余为四级风险 */
export type Severity = 'none' | 'low' | 'medium' | 'high' | 'critical';

export const SEVERITY_RANK: Record<Severity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** 六大校验维度，报告、控制台与 CSV 均按此顺序展示 */
export type Dimension = 'integrity' | 'malware' | 'vulnerability' | 'permission' | 'secret' | 'behavior';

export const DIMENSIONS: Dimension[] = ['integrity', 'malware', 'vulnerability', 'permission', 'secret', 'behavior'];

export const DIMENSION_LABELS: Record<Dimension, string> = {
  integrity: '格式与完整性',
  malware: '恶意代码',
  vulnerability: '已知漏洞',
  permission: '权限风险',
  secret: '敏感信息',
  behavior: '行为风险',
};

/** 处置动作：ALLOW 入库、WARN 入库并告警、QUARANTINE 隔离复核、BLOCK 拒绝入库 */
export type Disposition = 'ALLOW' | 'WARN' | 'QUARANTINE' | 'BLOCK';

export type SignatureStatus = 'verified' | 'unsigned' | 'invalid';

export interface SecurityFinding {
  dimension: Dimension;
  ruleId: string;
  severity: Exclude<Severity, 'none'>;
  title: string;
  detail: string;
  location?: string;
  /** 证据必须脱敏，禁止把原始密钥写入报告或日志 */
  evidence?: string;
  remediation: string;
}

export interface DimensionOutcome {
  /** unknown 表示该维度缺少判定依据（如漏洞库未初始化），不能视为通过 */
  status: 'pass' | 'warn' | 'fail' | 'skipped' | 'unknown';
  findingCount: number;
  summary: string;
}

export interface ScanInput {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
  source: string;
  uploaderId?: string | null;
  traceId?: string | null;
  /** base64 编码的分离签名，覆盖整个包文件 */
  signature?: string;
  trigger: 'upload' | 'rescan';
  buffer: Buffer;
}

export interface ScanOutcome {
  verdict: Severity;
  disposition: Disposition;
  score: number;
  signature: SignatureStatus;
  findings: SecurityFinding[];
  dimensions: Record<Dimension, DimensionOutcome>;
  metadata: Record<string, unknown>;
  /** 包内依赖清单（含 lockfile 传递依赖），用于生成 SBOM */
  dependencies: DependencyRef[];
  durationMs: number;
}

export interface ScanRow {
  id: string;
  package_version_id: string | null;
  ecosystem: Ecosystem;
  package_name: string;
  package_version: string;
  filename: string;
  sha256: string;
  size_bytes: number;
  trigger: string;
  verdict: Severity;
  disposition: Disposition;
  risk_score: number;
  signature_status: SignatureStatus;
  rule_version: string | null;
  advisory_snapshot_id: string | null;
  dimensions: string | null;
  report_key: string | null;
  quarantine_kind: string | null;
  quarantine_path: string | null;
  duration_ms: number;
  trace_id: string | null;
  actor_id: string | null;
  source: string | null;
  released_at: string | null;
  released_by: string | null;
  created_at: string;
}

export interface FindingRow {
  id: number;
  scan_id: string;
  dimension: Dimension;
  rule_id: string;
  severity: Exclude<Severity, 'none'>;
  title: string;
  detail: string | null;
  location: string | null;
  evidence: string | null;
  remediation: string | null;
  created_at: string;
}

/** 漏洞库导入条目：支持 CVE / CNVD / OSV 三种来源的同构结构 */
export interface AdvisoryInput {
  source?: 'CVE' | 'CNVD' | 'OSV' | string;
  advisoryId?: string;
  id?: string;
  ecosystem?: string;
  packageName?: string;
  package?: string;
  affectedRange?: string;
  affected?: string | string[];
  severity?: string;
  cvss?: number;
  title?: string;
  summary?: string;
  description?: string;
  fixedVersion?: string;
  fixed?: string;
  references?: string[];
  publishedAt?: string;
}

export interface AdvisoryRow {
  id: string;
  source: string;
  advisory_id: string;
  ecosystem: string;
  package_name: string;
  affected_range: string;
  severity: string;
  cvss: number | null;
  title: string | null;
  description: string | null;
  fixed_version: string | null;
  refs: string | null;
  published_at: string | null;
  imported_at: string;
}

/** 依赖声明，用于把包内组件与漏洞库比对 */
export interface DependencyRef {
  name: string;
  range: string;
  kind: 'runtime' | 'optional' | 'peer' | 'python';
  /** 由包内 lockfile 解析出的实际版本；缺失时只能按声明范围做提示 */
  resolvedVersion?: string;
  /** 传递依赖：来自 lockfile 但未在 manifest 中直接声明 */
  transitive?: boolean;
}
