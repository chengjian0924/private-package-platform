/**
 * 统一错误码表：所有对外错误必须携带 code + message + traceId，
 * 前端据此展示可读提示，避免出现无反馈的空白状态。
 */
interface ErrorDef {
  status: number;
  message: string;
}

export const ERROR_DEFS: Record<string, ErrorDef> = {
  // 通用
  SYS_INTERNAL: { status: 500, message: '服务内部错误，请稍后重试' },
  SYS_NOT_FOUND: { status: 404, message: '请求的资源不存在' },
  SYS_VALIDATION: { status: 400, message: '请求参数不合法' },
  SYS_CONFLICT: { status: 409, message: '资源已存在或状态冲突' },
  SYS_RATE_LIMITED: { status: 429, message: '请求过于频繁，请稍后重试' },

  // 认证 / 鉴权
  AUTH_UNAUTHENTICATED: { status: 401, message: '未登录或登录已失效，请重新登录' },
  AUTH_FORBIDDEN: { status: 403, message: '当前账号无权执行该操作' },
  AUTH_SESSION_EXPIRED: { status: 401, message: '登录态已过期，请重新登录' },
  AUTH_TOKEN_INVALID: { status: 401, message: '访问令牌无效或已吊销' },
  AUTH_USER_DISABLED: { status: 403, message: '账号已被禁用，请联系管理员' },
  AUTH_ROLE_REQUIRED: { status: 403, message: '角色权限不足' },
  // 本地账号认证：凭证错误与锁定分开，前端才能提示剩余锁定时间
  AUTH_INVALID_CREDENTIALS: { status: 401, message: '用户名或密码错误' },
  AUTH_ACCOUNT_LOCKED: { status: 423, message: '失败次数过多，账号已临时锁定' },
  AUTH_PASSWORD_CHANGE_REQUIRED: { status: 403, message: '首次登录需先修改密码' },
  AUTH_SERVICE_ACCOUNT: { status: 403, message: '机器账号不支持口令登录，请使用访问令牌' },

  // 清单解析
  MANIFEST_FORMAT_INVALID: { status: 400, message: '清单文件格式不正确' },
  MANIFEST_ENCODING_INVALID: { status: 400, message: '清单文件编码必须为 UTF-8' },
  MANIFEST_FIELD_MISSING: { status: 400, message: '清单必填字段缺失' },
  MANIFEST_DUPLICATE_ITEM: { status: 400, message: '清单中存在重复条目' },
  MANIFEST_REQUIREMENT_UNSUPPORTED: { status: 400, message: '清单中存在暂不支持的依赖写法' },
  MANIFEST_TOO_LARGE: { status: 413, message: '清单文件超过大小上限' },
  MANIFEST_ITEM_LIMIT_EXCEEDED: { status: 413, message: '清单条目数超过上限' },
  MANIFEST_EMPTY: { status: 400, message: '清单中没有可导入的条目' },
  TARGET_UNDECLARED: { status: 400, message: '清单缺少运行时目标（targets）声明' },

  // 包与版本
  PKG_NOT_FOUND: { status: 404, message: '依赖包不存在' },
  PKG_NAME_INVALID: { status: 400, message: '包名不合法' },
  PKG_VERSION_INVALID: { status: 400, message: '版本号不合法' },
  PKG_VERSION_DUPLICATE: { status: 409, message: '该版本已存在' },
  PKG_FILE_MISSING: { status: 400, message: '包文件缺失' },
  PKG_FILE_UNMATCHED: { status: 400, message: '清单条目未匹配到上传文件' },
  PKG_INTEGRITY_MISMATCH: { status: 400, message: '文件摘要与声明不一致' },
  PKG_TARBALL_INVALID: { status: 400, message: 'npm 包文件无法解析' },
  PKG_METADATA_MISMATCH: { status: 400, message: '包内元数据与清单不一致' },
  PKG_RUNTIME_INCOMPATIBLE: { status: 400, message: '包与目标运行时版本不兼容' },
  PKG_DEP_UNRESOLVED: { status: 400, message: '依赖项在私有源中无法解析' },
  PKG_DEP_INCOMPATIBLE: { status: 400, message: '依赖版本范围无法满足' },
  PKG_YANKED: { status: 409, message: '该版本已撤回' },
  PKG_VERSION_DELETED: { status: 409, message: '该版本已被删除，可在包管理中勾选「包含已删除」后恢复' },
  PKG_VERSION_NOT_DELETED: { status: 409, message: '该版本未被删除，无需恢复' },
  PKG_VERSION_STATE_INVALID: { status: 409, message: '该版本当前状态不允许该操作' },

  // 批次
  BATCH_NOT_FOUND: { status: 404, message: '导入批次不存在' },
  BATCH_EMPTY: { status: 400, message: '批次中没有可入库的条目' },
  BATCH_STATE_INVALID: { status: 409, message: '当前批次状态不允许该操作' },
  BATCH_HAS_BLOCKING_ITEMS: { status: 409, message: '存在校验失败条目，strict 模式已中止' },
  BATCH_NO_FILES: { status: 400, message: '请先上传包文件' },

  // 缺失依赖
  MISSING_NOT_FOUND: { status: 404, message: '缺失依赖记录不存在' },
  MISSING_STATE_INVALID: { status: 409, message: '该缺失记录当前状态不允许补包' },
  MISSING_SUPPLEMENT_MISMATCH: { status: 400, message: '补包文件与缺失依赖不匹配' },

  // 上传
  UPLOAD_EMPTY: { status: 400, message: '上传内容为空' },
  UPLOAD_FILE_TOO_LARGE: { status: 413, message: '上传文件超过大小上限' },
  UPLOAD_UNSUPPORTED_TYPE: { status: 415, message: '不支持的文件类型' },

  // 存储 / 磁盘水位（A-05）
  STORAGE_READ_ONLY: { status: 507, message: '磁盘可用空间不足，平台已进入只读模式，请联系管理员清理后重试' },

  // 停机排空（A-07）
  SYS_SHUTTING_DOWN: { status: 503, message: '服务正在停机，请稍后重试' },

  // 出站收敛（B5）
  OUTBOUND_TARGET_BLOCKED: { status: 403, message: '目标地址不在出站白名单内，已拒绝访问' },
  OUTBOUND_TLS_FAILED: { status: 502, message: '出站 TLS 证书校验失败，请检查内部 CA 配置' },

  // 安全校验
  SEC_BLOCKED: { status: 403, message: '包未通过安全校验：检出严重风险，已拦截，请整改后重新上传' },
  SEC_QUARANTINED: { status: 409, message: '包存在高危风险，已进入隔离区，等待管理员复核' },
  SEC_SCAN_FAILED: { status: 500, message: '安全校验执行失败，包已阻断入库，请稍后重试' },
  SEC_NOT_FOUND: { status: 404, message: '安全校验记录不存在' },
  SEC_REPORT_NOT_FOUND: { status: 404, message: '安全校验报告不存在' },
  SEC_QUARANTINE_NOT_FOUND: { status: 404, message: '隔离区中不存在该文件' },
  SEC_ADVISORY_INVALID: { status: 400, message: '漏洞库数据格式不正确' },
  SEC_SCAN_BUSY: { status: 503, message: '安全校验队列已满，请稍后重试' },
  SEC_SCAN_TIMEOUT: { status: 504, message: '安全校验超时，包已阻断入库，请稍后重试' },
  // RV-18：隔离样本正在被其他管理员处置（占位中），防止并发放行/废弃造成状态错乱
  SEC_QUARANTINE_BUSY: { status: 409, message: '该隔离样本正在处置中，请刷新后重试' },
  // RV-19：复检全量串行耗时较长，manual/schedule 必须互斥，避免重复扫描与统计错乱
  SEC_RESCAN_BUSY: { status: 409, message: '复检正在进行中，请等待本轮完成后再试' },
  // 字典管理：漏洞扫描总开关关闭时，复检等安全操作直接拒绝并给出开启入口
  SEC_SCAN_DISABLED: { status: 409, message: '漏洞扫描与校验已关闭，请先在「字典管理」中开启' },

  // A4 预留
  CERT_FEATURE_DISABLED: { status: 410, message: '证书签发能力已在本版本裁剪' },
};

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, details?: unknown, message?: string, status?: number) {
    const def = ERROR_DEFS[code] ?? { status: 400, message: code };
    super(message ?? def.message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status ?? def.status;
    this.details = details;
  }
}

export function fail(code: string, details?: unknown, message?: string): never {
  throw new ApiError(code, details, message);
}

export function httpStatusOf(statusCode: number): ErrorDef {
  return { status: statusCode, message: '请求处理失败' };
}
