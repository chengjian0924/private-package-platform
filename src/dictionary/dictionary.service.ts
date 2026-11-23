import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ApiError } from '../common/errors';
import { nowIso } from '../common/http.util';
import { DatabaseService } from '../db/database.service';
import { getConfig, getEnvConfig } from '../config/config';
import { registerDictionaryLoader, setDictionaryOverrides, type DictionaryOverrides } from '../config/overrides';

/** 字典条目类型：boolean 渲染为开关，int 渲染为数字输入框（带 min/max 校验） */
type DictType = 'boolean' | 'int';

export interface DictionaryDef {
  key: keyof DictionaryOverrides;
  group: 'rateLimit' | 'security' | 'retention' | 'backup' | 'missing' | 'limits';
  /** 前端展示名 */
  label: string;
  type: DictType;
  /** int 型的取值范围（含边界），与 value 同单位（字节） */
  min?: number;
  max?: number;
  /**
   * 显示单位：仅影响前端展示与输入，存储与业务计算始终用原始单位（字节）。
   * 目前只有上传大小上限用 'MB'，前端据此做 value/min/max/defaultValue 的换算。
   */
  unit?: 'MB';
  /** 字段说明，展示在表单控件下方 */
  hint: string;
}

/**
 * 字典条目清单：新增可运行时调整的配置必须在此登记，
 * 未登记的 key 保存时直接拒绝，避免控制台写入业务模块根本不读取的“僵尸配置”。
 */
export const DICTIONARY_DEFS: DictionaryDef[] = [
  {
    key: 'rateLimit.enabled',
    group: 'rateLimit',
    label: '启用接口限流',
    type: 'boolean',
    hint: '关闭后所有请求不再按来源 IP + 类别计数限流',
  },
  {
    key: 'rateLimit.windowMs',
    group: 'rateLimit',
    label: '限流窗口（毫秒）',
    type: 'int',
    min: 1000,
    max: 3_600_000,
    hint: '固定窗口长度，范围内按次数上限放行',
  },
  {
    key: 'rateLimit.authMax',
    group: 'rateLimit',
    label: '认证类上限（次/窗口）',
    type: 'int',
    min: 1,
    max: 100_000,
    hint: '登录等认证接口在单窗口内允许的最大次数',
  },
  {
    key: 'rateLimit.writeMax',
    group: 'rateLimit',
    label: '写入类上限（次/窗口）',
    type: 'int',
    min: 1,
    max: 100_000,
    hint: '发布、导入等写操作在单窗口内允许的最大次数',
  },
  {
    key: 'rateLimit.readMax',
    group: 'rateLimit',
    label: '读取类上限（次/窗口）',
    type: 'int',
    min: 1,
    max: 1_000_000,
    hint: '控制台 API 查询等读操作的上限；registry 协议请求不计入此配额',
  },
  {
    key: 'rateLimit.registryMax',
    group: 'rateLimit',
    label: 'Registry 读上限（次/窗口）',
    type: 'int',
    min: 1,
    max: 1_000_000,
    hint: 'npm/pypi 协议 GET/HEAD 独立配额（search、packument、simple 索引、tarball 下载）。dshmarket 每次开页约 400 次请求，批量安装也按依赖逐个拉取，需保持较高值；修改后三角色进程自动同步，无需重启',
  },
  {
    key: 'security.scanEnabled',
    group: 'security',
    label: '漏洞扫描与校验',
    type: 'boolean',
    hint: '总开关：关闭后上传 / 导入 / 复检全部跳过六维扫描直接入库；三角色共享同一数据库，保存后自动同步到全部服务进程，无需重启',
  },
  {
    key: 'security.requireSignature',
    group: 'security',
    label: '强制签名校验',
    type: 'boolean',
    hint: '开启后未签名或验签失败的包按高危处理',
  },
  {
    key: 'security.requireAdvisoryDb',
    group: 'security',
    label: '漏洞库未初始化时拦截',
    type: 'boolean',
    hint: '开启后本地漏洞库为空时按高危处理，避免拿到虚假的 ALLOW',
  },
  {
    key: 'retention.deletedPackageDays',
    group: 'retention',
    label: '软删除包保留天数',
    type: 'int',
    min: 0,
    max: 3650,
    hint: '删除的版本在该天数内可恢复，超期未恢复将被硬删除（含包文件与扫描记录）；0 表示永不自动清理',
  },
  {
    key: 'retention.logDays',
    group: 'retention',
    label: '日志文件保留天数',
    type: 'int',
    min: 0,
    max: 3650,
    hint: '服务按天落盘的日志文件超过该天数自动删除，默认半年；0 表示永不自动清理',
  },
  {
    key: 'backup.enabled',
    group: 'backup',
    label: '启用包文件备份',
    type: 'boolean',
    hint: '开启后按下面的间隔把已入库的包文件增量复制到备份目录；关闭只停止后续备份，已生成的备份不会被删除',
  },
  {
    key: 'backup.intervalMinutes',
    group: 'backup',
    label: '备份间隔（分钟）',
    type: 'int',
    min: 1,
    max: 10_080,
    hint: '每轮只补齐备份目录里缺失的包文件，不改动已存在的备份；保存后下一轮按新间隔执行，无需重启',
  },
  {
    key: 'missing.autoReport',
    group: 'missing',
    label: '缺包自动上报',
    type: 'boolean',
    hint: '开启后，下游把本平台设为 npm / pypi 源、拉取包失败时自动登记缺失依赖（含来源 IP）；关闭只停新增，已有记录保留。下游显式上报接口不受影响',
  },
  {
    key: 'limits.maxNpmUploadBytes',
    group: 'limits',
    label: 'npm 上传包大小上限（MB）',
    type: 'int',
    min: 1024 * 1024,
    max: 256 * 1024 * 1024,
    unit: 'MB',
    hint: 'npm publish 解码后包文件的大小上限，保存后即时生效。硬天花板由环境变量 MAX_NPM_PUBLISH_BYTES 控制（默认 288MB，需重启），本项不可超过它；默认 200MB 可容纳大型离线插件包',
  },
  {
    key: 'limits.maxPypiUploadBytes',
    group: 'limits',
    label: 'PyPI 上传包大小上限（MB）',
    type: 'int',
    min: 1024 * 1024,
    max: 256 * 1024 * 1024,
    unit: 'MB',
    hint: 'twine 上传的单文件大小上限，保存后即时生效。硬天花板由环境变量 MAX_PYPI_PUBLISH_BYTES 控制（默认 288MB，需重启），本项不可超过它；wheel 走磁盘落盘，不占请求体内存',
  },
];

export interface DictionaryItemView {
  key: string;
  group: string;
  label: string;
  type: DictType;
  min?: number;
  max?: number;
  /** 显示单位，前端按此换算展示值；存储与业务值保持原单位 */
  unit?: 'MB';
  hint: string;
  /** 当前生效值（env 基线 + 字典覆盖） */
  value: boolean | number;
  /** 环境变量基线值，供前端展示默认与回退 */
  defaultValue: boolean | number;
  /** 是否已被字典覆盖（false 表示仍用 env 基线） */
  overridden: boolean;
  updatedAt: string | null;
}

export interface DictionaryGroupView {
  key: string;
  label: string;
  items: DictionaryItemView[];
}

interface DictRow {
  key: string;
  value: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

const GROUP_LABELS: Record<string, string> = {
  rateLimit: '限流参数',
  security: '漏洞扫描与校验',
  retention: '保留与清理',
  backup: '包文件备份',
  missing: '缺包自动上报',
  limits: '上传包大小上限',
};

/** 字典中保存的覆盖值按 key 校验并原样返回，损坏行（历史脏数据）直接忽略 */
function parseRowValue(def: DictionaryDef, raw: string): boolean | number | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (def.type === 'boolean' && typeof parsed === 'boolean') return parsed;
    if (def.type === 'int' && typeof parsed === 'number' && Number.isInteger(parsed)) return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

@Injectable()
export class DictionaryService implements OnModuleInit {
  private readonly logger = new Logger('Dictionary');

  constructor(private readonly db: DatabaseService) {}

  /**
   * 注入 DB 读取器并装载初始值。三个角色进程都会走这里（CoreModule 是 @Global 共享模块）：
   * 启动装载只保证「本进程有值」，之后其他进程的字典变更由覆盖层惰性回读共享库自动同步。
   * 拆分部署时 npm / pypi 进程同样注册，避免只有控制台进程生效。
   */
  onModuleInit(): void {
    registerDictionaryLoader(() => this.readFromDb(), {
      onError: (err) => this.logger.warn(`字典覆盖同步失败，沿用上次值: ${(err as Error).message}`),
    });
    this.applyFromDb();
  }

  /** 纯读：从共享 DB 读取并校验字典项，不修改进程内覆盖层（供覆盖层跨进程回读） */
  private readFromDb(): DictionaryOverrides {
    const overrides: DictionaryOverrides = {};
    const byKey = new Map(DICTIONARY_DEFS.map((def) => [def.key as string, def]));
    for (const row of this.db.all<DictRow>('SELECT * FROM sys_dictionary')) {
      const def = byKey.get(row.key);
      if (!def) continue;
      const value = parseRowValue(def, row.value);
      if (value === undefined) {
        this.logger.warn(`字典项 ${row.key} 的值不合法，已忽略: ${row.value}`);
        continue;
      }
      (overrides as Record<string, unknown>)[row.key] = value;
    }
    return overrides;
  }

  /** 把 DB 值套用到本进程：启动装载与保存后即时生效共用同一入口 */
  private applyFromDb(): DictionaryOverrides {
    const overrides = this.readFromDb();
    setDictionaryOverrides(overrides);
    return overrides;
  }

  /** 字典全量视图：分组 + 当前生效值 + env 默认值 + 覆盖标记 */
  describe(): DictionaryGroupView[] {
    const effective = getConfig();
    const baseline = getEnvConfig();
    const rows = new Map(
      this.db.all<DictRow>('SELECT * FROM sys_dictionary').map((row) => [row.key, row]),
    );

    const groups = new Map<string, DictionaryItemView[]>();
    for (const def of DICTIONARY_DEFS) {
      const field = def.key.split('.')[1] as string;
      const value = (effective[def.group] as Record<string, boolean | number>)[field];
      const defaultValue = (baseline[def.group] as Record<string, boolean | number>)[field];
      const row = rows.get(def.key as string);
      const item: DictionaryItemView = {
        key: def.key as string,
        group: def.group,
        label: def.label,
        type: def.type,
        ...(def.type === 'int' ? { min: def.min, max: def.max } : {}),
        ...(def.unit ? { unit: def.unit } : {}),
        hint: def.hint,
        value,
        defaultValue,
        overridden: Boolean(row) && parseRowValue(def, row!.value) !== undefined,
        updatedAt: row?.updated_at ?? null,
      };
      const list = groups.get(def.group) ?? [];
      list.push(item);
      groups.set(def.group, list);
    }
    return [...groups.entries()].map(([key, items]) => ({
      key,
      label: GROUP_LABELS[key] ?? key,
      items,
    }));
  }

  /**
   * 保存字典：整体校验 → 事务 upsert → 重新装载覆盖层 → 立即生效。
   * 校验失败抛 SYS_VALIDATION（携带字段级原因），不会写入任何行。
   */
  save(values: unknown, actorId: string | null): DictionaryGroupView[] {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new ApiError('SYS_VALIDATION', { reason: 'values 必须是 key → value 对象' });
    }
    const input = values as Record<string, unknown>;
    const byKey = new Map(DICTIONARY_DEFS.map((def) => [def.key as string, def]));
    const baseline = getEnvConfig();

    // 先整体校验再写库：任何一项不合法全部拒绝，避免半份数据生效
    for (const [key, value] of Object.entries(input)) {
      const def = byKey.get(key);
      if (!def) {
        throw new ApiError('SYS_VALIDATION', { key, reason: `未登记的字典项: ${key}` });
      }
      if (def.type === 'boolean') {
        if (typeof value !== 'boolean') {
          throw new ApiError('SYS_VALIDATION', { key, reason: `${def.label} 必须为布尔值` });
        }
      } else if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new ApiError('SYS_VALIDATION', { key, reason: `${def.label} 必须为整数` });
      } else if (def.min !== undefined && value < def.min) {
        throw new ApiError('SYS_VALIDATION', { key, reason: `${def.label} 不能小于 ${def.min}` });
      } else {
        // 上传上限：硬天花板（env，启动固定）优先于静态 max 命中，错误原因才准确
        const hardCapField =
          key === 'limits.maxNpmUploadBytes'
            ? 'maxNpmPublishBytes'
            : key === 'limits.maxPypiUploadBytes'
              ? 'maxPypiPublishBytes'
              : null;
        if (hardCapField && value > baseline.limits[hardCapField]) {
          throw new ApiError('SYS_VALIDATION', {
            key,
            reason: `${def.label} 不能超过 HTTP 硬天花板 ${baseline.limits[hardCapField]}（需调整环境变量后重启）`,
          });
        }
        if (def.max !== undefined && value > def.max) {
          throw new ApiError('SYS_VALIDATION', { key, reason: `${def.label} 不能大于 ${def.max}` });
        }
      }
    }

    const now = nowIso();
    this.db.tx(() => {
      for (const [key, value] of Object.entries(input)) {
        this.db.run(
          `INSERT INTO sys_dictionary (key, value, updated_by, created_at, updated_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          key,
          JSON.stringify(value),
          actorId,
          now,
          now,
        );
      }
    });

    this.applyFromDb();
    this.logger.log(
      `字典已更新（${Object.keys(input).length} 项）：本进程即时生效，其他角色进程将在同步间隔内自动读取共享库`,
    );
    return this.describe();
  }
}
