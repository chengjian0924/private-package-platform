import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config/config';
import { ApiError } from '../common/errors';
import { addSeconds, nowIso, randomToken, sha256Hex } from '../common/http.util';
import { likeContains } from '../common/sql.util';
import { DatabaseService } from '../db/database.service';
import { hashPassword, validatePasswordStrength, verifyPassword } from './password';

export type Role = 'admin' | 'developer' | 'reader';
/** 角色代码的唯一来源：接口校验、批量模板、文档与前端下拉都以此为准 */
export const ROLE_CODES = ['admin', 'developer', 'reader'] as const;
/** 中文展示名，仅用于提示文案与文档，不参与鉴权 */
export const ROLE_LABELS: Record<Role, string> = {
  admin: '管理员',
  developer: '开发者',
  reader: '只读',
};
/**
 * 历史命名兼容：早期文档与外部脚本用 viewer 表示「只读」，
 * 代码与库表统一为 reader。这里把别名收敛掉，避免 viewer 被原样写进 users.role
 * 之后，读出来被 toRole() 静默降级成 reader，形成「库里是 A、界面显示 B」的漂移。
 */
const ROLE_ALIASES: Record<string, Role> = {
  viewer: 'reader',
  read: 'reader',
  read_only: 'reader',
  readonly: 'reader',
};

/** 把外部输入归一成合法角色；非法返回 null（由调用方给出明确报错，不静默降级） */
export function normalizeRole(raw: string | null | undefined): Role | null {
  const value = (raw || '').trim().toLowerCase();
  if (!value) return null;
  if ((ROLE_CODES as readonly string[]).includes(value)) return value as Role;
  return ROLE_ALIASES[value] ?? null;
}

/** human: 人员账号；service: 机器账号（CI/流水线），口令随机且不可知，只能用 API 令牌 */
export type AccountType = 'human' | 'service';

export interface AuthUser {
  id: string;
  subject: string;
  username: string;
  email: string | null;
  displayName: string | null;
  role: Role;
  accountType: AccountType;
  /** 首登/重置后为 true：只允许改密、查看自身信息与登出，其余接口由守卫拦下 */
  mustChangePassword: boolean;
  /** 认证所用 API Token 的哈希（sha256 hex）；仅 Token 认证时填充，用于审计按 Token 归属下游项目 */
  tokenId?: string | null;
}

export interface UserSummary {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  role: Role;
  accountType: AccountType;
  status: 'active' | 'disabled';
  mustChangePassword: boolean;
  lockedUntil: string | null;
  passwordUpdatedAt: string | null;
  createdAt: string;
  /**
   * 未吊销令牌数量。与「账号禁用」组合阅读：
   * 禁用账号的有效令牌仍是未吊销状态（凭据保留、暂时不可用），
   * 需要永久作废必须显式吊销。
   */
  activeTokenCount?: number;
}

/** 批量建号的单行输入：字段均可缺省，由服务端逐行校验并给出失败原因 */
export interface BatchUserInput {
  username?: string;
  displayName?: string;
  email?: string;
  role?: string;
}

export interface BatchCreateResult {
  total: number;
  createdCount: number;
  failedCount: number;
  created: { row: number; username: string; role: Role; initialPassword: string }[];
  failed: { row: number; username: string; reason: string }[];
}
export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  admin: [
    'package:read',
    'package:publish',
    'import:run',
    'missing:supplement',
    'audit:read',
    'user:manage',
    'token:manage',
    // 安全校验：仅管理员可查看报告与执行复检/隔离放行
    'security:read',
    'security:read:own',
    'security:manage',
    // 字典管理：运行时调整限流与漏洞扫描配置，仅管理员可维护
    'config:manage',
  ],
  developer: [
    'package:read',
    'package:publish',
    'import:run',
    'missing:supplement',
    'token:manage',
    // 上传者只能看自己包的安全结论，便于自助整改
    'security:read:own',
  ],
  reader: ['package:read', 'token:manage'],
};

interface UserRow {
  id: string;
  subject: string;
  username: string;
  email: string | null;
  display_name: string | null;
  role: string;
  account_type: string;
  status: string;
  password_hash: string | null;
  password_updated_at: string | null;
  must_change_password: number;
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
  /** 仅 listUsers 的子查询会带出；其他查询路径为 undefined */
  active_token_count?: number;
}

interface SessionRow {
  sid: string;
  user_id: string;
  issued_at: string;
  expires_at: string;
  idle_expires_at: string;
  revoked_at: string | null;
}

// 用户不存在时也付一次等价开销的 scrypt，避免用响应时间枚举账号是否存在
const FAKE_HASH = [
  'scrypt',
  16384,
  8,
  1,
  Buffer.alloc(16).toString('base64'),
  Buffer.alloc(64).toString('base64'),
].join('$');

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;

function toRole(raw: string): Role {
  // 库里的脏值（历史版本或手工改库）只做兜底收敛，不抛错：读路径抛错会让账号直接无法登录
  return normalizeRole(raw) ?? 'reader';
}

function toAccountType(raw: string | null | undefined): AccountType {
  return raw === 'service' ? 'service' : 'human';
}

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    subject: row.subject,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    role: toRole(row.role),
    accountType: toAccountType(row.account_type),
    mustChangePassword: row.must_change_password === 1,
  };
}

function toUserSummary(row: UserRow, activeTokenCount?: number): UserSummary {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    role: toRole(row.role),
    accountType: toAccountType(row.account_type),
    status: row.status === 'disabled' ? 'disabled' : 'active',
    mustChangePassword: row.must_change_password === 1,
    lockedUntil: row.locked_until,
    passwordUpdatedAt: row.password_updated_at,
    createdAt: row.created_at,
    ...(activeTokenCount === undefined ? {} : { activeTokenCount }),
  };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');
  private readonly permCache = new Map<string, { allowed: boolean; expiresAt: number }>();

  constructor(private readonly db: DatabaseService) {}

  // ---------- 本地账号与口令 ----------

  /**
   * 校验用户名口令并维护失败计数/锁定。
   * 所有失败路径都不区分“用户不存在”和“口令错误”，只有达到阈值才升级为锁定错误。
   */
  private async authenticate(username: string, password: string): Promise<UserRow> {
    const cfg = getConfig();
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE username = ?', username);
    if (!row) {
      await verifyPassword(password, FAKE_HASH);
      throw new ApiError('AUTH_INVALID_CREDENTIALS');
    }
    // 禁用/服务账号同样走一次假的哈希校验：否则响应时间明显短于「口令错误」，
    // 攻击者可据此枚举哪些用户名存在且被禁用（时序侧信道）。
    if (row.status !== 'active') {
      await verifyPassword(password, FAKE_HASH);
      throw new ApiError('AUTH_USER_DISABLED');
    }
    // 机器账号不发已知口令，只接受 API 令牌；口令登录一律拒绝，避免初始口令被拿去接管 CI 身份
    if (toAccountType(row.account_type) === 'service') {
      await verifyPassword(password, FAKE_HASH);
      throw new ApiError('AUTH_SERVICE_ACCOUNT');
    }

    const now = Date.now();
    if (row.locked_until && new Date(row.locked_until).getTime() > now) {
      throw new ApiError('AUTH_ACCOUNT_LOCKED', {
        retryAfterSec: Math.ceil((new Date(row.locked_until).getTime() - now) / 1000),
      });
    }

    if (!(await verifyPassword(password, row.password_hash))) {
      // 原子自增后再回读：先 SELECT 再写回在并发爆破时会丢失计数（多个请求读到同一旧值），
      // 让锁定阈值被推迟。SQLite 单语句 UPDATE 是原子的，回读拿到的就是真实累计值。
      const nowStr = nowIso();
      this.db.run(
        'UPDATE users SET failed_attempts = failed_attempts + 1, updated_at = ? WHERE id = ?',
        nowStr,
        row.id,
      );
      const attempts =
        this.db.get<{ failed_attempts: number }>('SELECT failed_attempts FROM users WHERE id = ?', row.id)
          ?.failed_attempts ?? 1;
      if (attempts >= cfg.auth.loginMaxFailures) {
        const until = new Date(now + cfg.auth.loginLockMinutes * 60_000).toISOString();
        this.db.run(
          'UPDATE users SET failed_attempts = 0, locked_until = ?, updated_at = ? WHERE id = ?',
          until,
          nowStr,
          row.id,
        );
        this.logger.warn(`账号临时锁定 ${cfg.auth.loginLockMinutes} 分钟: ${row.username}`);
        throw new ApiError('AUTH_ACCOUNT_LOCKED', { retryAfterSec: cfg.auth.loginLockMinutes * 60 });
      }
      throw new ApiError('AUTH_INVALID_CREDENTIALS', { remainingAttempts: cfg.auth.loginMaxFailures - attempts });
    }

    if (row.failed_attempts || row.locked_until) {
      this.db.run(
        'UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?',
        nowIso(),
        row.id,
      );
    }
    return { ...row, failed_attempts: 0, locked_until: null };
  }

  /** 网页登录：校验通过后建立会话；登录前遗留的旧会话由调用方按需清理 */
  async login(
    username: string,
    password: string,
    ctx: { ip?: string; userAgent?: string },
  ): Promise<{ user: AuthUser; sid: string; maxAge: number }> {
    const row = await this.authenticate(username, password);
    const user = toAuthUser(row);
    const session = this.createSession(user.id, ctx);
    return { user, ...session };
  }

  /**
   * registry（npm/twine）Basic 认证：只返回能否通过，错误语义交给各协议的响应体。
   * 需要区分「凭据错误 / 账号禁用 / 已锁定」时用 verifyBasicCredentialsDetailed。
   */
  async verifyBasicCredentials(username: string, password: string): Promise<AuthUser | null> {
    return (await this.verifyBasicCredentialsDetailed(username, password)).user;
  }

  /**
   * 带错误语义的 Basic 认证。registry 客户端（npm login）需要告诉用户「账号被锁定/禁用」，
   * 而不是一律回「令牌无效」——否则只能靠人工猜，也无法按 Retry-After 重试。
   */
  async verifyBasicCredentialsDetailed(
    username: string,
    password: string,
  ): Promise<{ user: AuthUser | null; error: ApiError | null }> {
    try {
      return { user: toAuthUser(await this.authenticate(username, password)), error: null };
    } catch (err) {
      return {
        user: null,
        error: err instanceof ApiError ? err : new ApiError('AUTH_INVALID_CREDENTIALS'),
      };
    }
  }

  /**
   * 改密。两种场景：
   * - 主动改密（must_change_password=0）：必须验证原密码，避免会话被盗后直接改掉口令。
   * - 强制首登改密（must_change_password=1）：不要求原密码。此时账号仍在用初始口令，
   *   改密本身就是"证明你能登录"之后的动作，再问一遍等于让用户抄同一串字符。
   */
  async changePassword(input: {
    userId: string;
    newPassword: string;
    oldPassword?: string;
    confirmPassword?: string;
    currentSid?: string;
  }): Promise<void> {
    const cfg = getConfig();
    const { userId, newPassword, oldPassword, confirmPassword, currentSid } = input;
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
    if (!row) throw new ApiError('AUTH_UNAUTHENTICATED');
    const forced = row.must_change_password === 1;

    if (!forced) {
      if (!oldPassword) {
        throw new ApiError('SYS_VALIDATION', { field: 'oldPassword', reason: '请输入原密码' });
      }
      if (!(await verifyPassword(oldPassword, row.password_hash))) {
        throw new ApiError('SYS_VALIDATION', { field: 'oldPassword', reason: '原密码错误' });
      }
    }
    // 两次输入一致性在后端再校验一次：前端校验可被直接调接口绕过
    if (confirmPassword !== undefined && confirmPassword !== newPassword) {
      throw new ApiError('SYS_VALIDATION', { field: 'confirmPassword', reason: '两次输入的新密码不一致' });
    }
    // 强制改密拿不到原密码，改用"新口令能否通过当前哈希"判断是否原地打转，
    // 比字符串比对更可靠：前端漏传、大小写改写都拦得住
    if (await verifyPassword(newPassword, row.password_hash)) {
      throw new ApiError('SYS_VALIDATION', { field: 'newPassword', reason: '新密码不能与原密码相同' });
    }
    const weak = validatePasswordStrength(newPassword, row.username, cfg.auth.passwordMinLength);
    if (weak) throw new ApiError('SYS_VALIDATION', { field: 'newPassword', reason: weak });

    const now = nowIso();
    this.db.run(
      `UPDATE users SET password_hash = ?, password_updated_at = ?, must_change_password = 0,
         failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
      await hashPassword(newPassword),
      now,
      now,
      userId,
    );
    // 改密后吊销其它端会话，但保留当前这次，避免“改完密码把自己踢下线”
    this.db.run(
      `UPDATE sessions SET revoked_at = ?, revoke_reason = 'password_changed'
        WHERE user_id = ? AND revoked_at IS NULL AND sid <> ?`,
      now,
      userId,
      currentSid ?? '',
    );
    this.logger.log(`口令已更新: ${row.username}`);
  }

  listUsers(): UserSummary[] {
    // 子查询一次带出未吊销令牌数，避免逐行再查（用于提示「账号已禁用但仍挂着 Token」）
    const rows = this.db.all<UserRow>(
      `SELECT u.*, (SELECT COUNT(*) FROM api_tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL)
         AS active_token_count
       FROM users u ORDER BY u.created_at ASC`,
    );
    return rows.map((row) => toUserSummary(row, row.active_token_count ?? 0));
  }

  /** 按角色返回固定初始密码：管理员 admin123，其余 123123123（可用环境变量覆盖） */
  initialPasswordFor(role: Role): string {
    const cfg = getConfig();
    return role === 'admin' ? cfg.auth.initialPasswordAdmin : cfg.auth.initialPasswordUser;
  }

  async createUser(input: {
    username: string;
    displayName?: string;
    email?: string;
    role?: Role;
    accountType?: AccountType;
  }): Promise<{ user: UserSummary; initialPassword: string | null }> {
    const username = (input.username || '').trim();
    if (!USERNAME_PATTERN.test(username)) {
      throw new ApiError('SYS_VALIDATION', {
        field: 'username',
        reason: '仅允许字母、数字、点、下划线与短横线，长度 3-32',
      });
    }
    if (this.db.get<{ id: string }>('SELECT id FROM users WHERE username = ?', username)) {
      throw new ApiError('SYS_CONFLICT', { field: 'username', reason: '用户名已存在' });
    }

    // 角色非法时明确报错：静默回落成 reader 会让「本想开开发者、结果只能读」的问题
    // 一直拖到用户发布失败才被发现
    const requestedRole = input.role === undefined ? undefined : normalizeRole(input.role);
    if (input.role !== undefined && !requestedRole) {
      throw new ApiError('SYS_VALIDATION', {
        field: 'role',
        reason: `角色非法：${input.role}，可选 developer / reader（只读角色的旧名 viewer 已统一为 reader）`,
      });
    }
    const role: Role = requestedRole ?? 'reader';
    // 管理员账号由系统初始化时创建且唯一：接口层不允许再建第二个管理员
    if (role === 'admin') {
      throw new ApiError('SYS_VALIDATION', { field: 'role', reason: '管理员账号唯一，不能新建管理员' });
    }
    const accountType: AccountType = input.accountType === 'service' ? 'service' : 'human';
    // 机器账号：口令取 32 字节随机串且从不返回，等于封死口令登录通道；同时不要求改密，令牌开箱可用
    const initialPassword = accountType === 'service' ? null : this.initialPasswordFor(role);
    const passwordHash = await hashPassword(initialPassword ?? randomToken(32));
    const now = nowIso();
    const id = randomUUID();
    // subject 在本地模式下与 username 同值，保持既有唯一约束与关联查询不变
    this.db.run(
      `INSERT INTO users (id, subject, username, email, display_name, role, account_type, status,
         password_hash, password_updated_at, must_change_password, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,'active',?,?,?,?,?)`,
      id,
      username,
      username,
      input.email ?? null,
      input.displayName ?? username,
      role,
      accountType,
      passwordHash,
      now,
      accountType === 'service' ? 0 : 1,
      now,
      now,
    );
    this.logger.log(`已创建账号: ${username} (${role}${accountType === 'service' ? ' / 机器账号' : ''})`);
    return {
      user: toUserSummary(this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id)!),
      initialPassword,
    };
  }

  /**
   * 批量建号：逐行校验后独立落库，单行失败不影响其它行。
   * 返回成功/失败明细，前端可直接展示失败原因；所有新账号 must_change_password=1。
   */
  async createUsersBatch(inputs: BatchUserInput[]): Promise<BatchCreateResult> {
    const result: BatchCreateResult = {
      total: inputs.length,
      createdCount: 0,
      failedCount: 0,
      created: [],
      failed: [],
    };
    const seen = new Set<string>();
    // 同一批次同角色共用一个口令哈希：所有账号初始口令相同，重复 scrypt 只会阻塞事件循环
    const hashCache = new Map<Role, string>();

    for (let index = 0; index < inputs.length; index += 1) {
      const rowNo = index + 1;
      const raw = inputs[index] || {};
      const username = (raw.username || '').trim();
      const roleRaw = (raw.role || 'reader').trim();
      const roleNormalized = normalizeRole(roleRaw);

      const reject = (reason: string): void => {
        result.failedCount += 1;
        result.failed.push({ row: rowNo, username: username || '-', reason });
      };

      if (!USERNAME_PATTERN.test(username)) {
        reject('用户名格式不合法：仅允许字母、数字、点、下划线与短横线，长度 3-32');
        continue;
      }
      if (!roleNormalized) {
        reject(`角色非法：${roleRaw || '(空)'}，可选 developer / reader（只读角色的旧名 viewer 已统一为 reader）`);
        continue;
      }
      if (roleNormalized === 'admin') {
        reject('管理员账号唯一，不能批量创建管理员');
        continue;
      }
      if (seen.has(username)) {
        reject('批次内用户名重复');
        continue;
      }
      if (this.db.get<{ id: string }>('SELECT id FROM users WHERE username = ?', username)) {
        reject('用户名已存在');
        continue;
      }
      seen.add(username);

      const role = roleNormalized;
      let passwordHash = hashCache.get(role);
      if (!passwordHash) {
        passwordHash = await hashPassword(this.initialPasswordFor(role));
        hashCache.set(role, passwordHash);
      }
      const now = nowIso();
      this.db.run(
        `INSERT INTO users (id, subject, username, email, display_name, role, status,
           password_hash, password_updated_at, must_change_password, created_at, updated_at)
         VALUES (?,?,?,?,?,?,'active',?,?,1,?,?)`,
        randomUUID(),
        username,
        username,
        raw.email?.trim() || null,
        raw.displayName?.trim() || username,
        role,
        passwordHash,
        now,
        now,
        now,
      );
      result.createdCount += 1;
      result.created.push({ row: rowNo, username, role, initialPassword: this.initialPasswordFor(role) });
    }

    this.logger.warn(`批量建号完成：成功 ${result.createdCount} 个，失败 ${result.failedCount} 个`);
    return result;
  }

  /** 管理员重置口令：恢复为该角色的固定初始密码并踢掉该用户所有会话 */
  async resetPassword(userId: string): Promise<{ user: UserSummary; initialPassword: string }> {
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
    if (!row) throw new ApiError('SYS_NOT_FOUND', { resource: 'user' });
    // 机器账号没有口令可重置：重置只会造出一个已知口令的登录入口，正确动作是签发新令牌
    if (toAccountType(row.account_type) === 'service') {
      throw new ApiError('SYS_VALIDATION', {
        field: 'accountType',
        reason: '机器账号不支持口令登录，请为其签发访问令牌',
      });
    }

    const initialPassword = this.initialPasswordFor(toRole(row.role));
    const now = nowIso();
    this.db.run(
      `UPDATE users SET password_hash = ?, password_updated_at = ?, must_change_password = 1,
         failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
      await hashPassword(initialPassword),
      now,
      now,
      userId,
    );
    this.revokeUserSessions(userId, 'password_reset');
    this.logger.warn(`口令已重置: ${row.username}`);
    return { user: toUserSummary({ ...row, must_change_password: 1 }), initialPassword };
  }

  updateUser(
    userId: string,
    patch: { role?: Role; status?: 'active' | 'disabled'; displayName?: string; email?: string },
  ): UserSummary {
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
    if (!row) throw new ApiError('SYS_NOT_FOUND', { resource: 'user' });

    // 入参角色先归一：否则 viewer / developr 这类脏值会被原样写进 users.role，
    // 读出来又被 toRole() 兜底成 reader，形成「库里一个值、界面另一个值」的静默漂移
    const currentRole = toRole(row.role);
    const nextRole = patch.role === undefined ? currentRole : normalizeRole(patch.role);
    if (!nextRole) {
      throw new ApiError('SYS_VALIDATION', {
        field: 'role',
        reason: `角色非法：${patch.role}，可选 developer / reader（只读角色的旧名 viewer 已统一为 reader）`,
      });
    }

    // 管理员账号唯一：既不接受把普通账号提升为管理员，也不允许降级或禁用内置管理员
    if (nextRole === 'admin' && currentRole !== 'admin') {
      throw new ApiError('SYS_VALIDATION', { field: 'role', reason: '管理员账号唯一，不能将其他账号提升为管理员' });
    }
    if (nextRole !== 'admin' && currentRole === 'admin') {
      throw new ApiError('SYS_VALIDATION', { field: 'role', reason: '管理员账号唯一，管理员角色不可变更' });
    }
    if (patch.status === 'disabled' && currentRole === 'admin') {
      throw new ApiError('SYS_VALIDATION', { field: 'status', reason: '管理员账号唯一，内置管理员不可禁用' });
    }

    const now = nowIso();
    this.db.run(
      `UPDATE users SET role = ?, status = ?, display_name = ?, email = ?, updated_at = ? WHERE id = ?`,
      nextRole,
      patch.status ?? row.status,
      patch.displayName ?? row.display_name,
      patch.email ?? row.email,
      now,
      userId,
    );
    if (patch.status === 'disabled') this.revokeUserSessions(userId, 'disabled');
    this.invalidatePermissionCache(userId);
    return toUserSummary(this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', userId)!);
  }

  /** 首次部署无任何账号时，用固定初始密码创建内置管理员；已有账号时不覆盖 */
  async ensureBootstrapAdmin(): Promise<void> {
    const cfg = getConfig();
    const count = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
    if (count > 0) return;

    const initialPassword = cfg.auth.initialPasswordAdmin;
    if (!initialPassword) {
      this.logger.warn('用户表为空且 INITIAL_PASSWORD_ADMIN 为空：当前无任何账号可登录，请配置后重启');
      return;
    }
    // 固定弱口令靠 must_change_password 强制首登改密兜底，这里不做强度校验
    const now = nowIso();
    this.db.run(
      `INSERT INTO users (id, subject, username, email, display_name, role, status,
         password_hash, password_updated_at, must_change_password, created_at, updated_at)
       VALUES (?,?,?,NULL,?,'admin','active',?,?,1,?,?)`,
      randomUUID(),
      cfg.auth.bootstrapUsername,
      cfg.auth.bootstrapUsername,
      '系统管理员',
      await hashPassword(initialPassword),
      now,
      now,
      now,
    );
    this.logger.warn(`已创建内置管理员 ${cfg.auth.bootstrapUsername}，初始密码为固定值，首次登录必须修改`);
  }

  findUserById(id: string): AuthUser | null {
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (!row || row.status !== 'active') return null;
    return toAuthUser(row);
  }

  /**
   * 含已禁用账号的查询。
   * 供运维动作（吊销令牌）使用：禁用账号恰恰是最需要清理凭据的对象，
   * 而 findUserById 会把它当不存在，不能用于此处。
   */
  findUserByIdAnyStatus(id: string): UserSummary | null {
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    return row ? toUserSummary(row) : null;
  }

  // ---------- 登录态 ----------

  createSession(userId: string, ctx: { ip?: string; userAgent?: string }): { sid: string; maxAge: number } {
    const cfg = getConfig();
    const now = nowIso();
    const sid = randomToken(32);
    this.db.run(
      `INSERT INTO sessions (sid, user_id, issued_at, expires_at, idle_expires_at, last_seen_at, client_ip, user_agent)
       VALUES (?,?,?,?,?,?,?,?)`,
      sid,
      userId,
      now,
      addSeconds(now, cfg.sessionTtlSec),
      addSeconds(now, cfg.sessionIdleTtlSec),
      now,
      ctx.ip ?? null,
      (ctx.userAgent ?? '').slice(0, 300) || null,
    );
    // 单账号会话数封顶：客户端每次重试登录都插一行、从不登出的话，sessions 会无界增长。
    // 超出上限时吊销最早签发的那些（保留最新这次），用户感知是「旧设备被踢下线」。
    this.revokeOverflowSessions(userId, cfg.sessionMaxPerUser);
    return { sid, maxAge: cfg.sessionTtlSec };
  }

  /** 吊销该用户超出上限的最早会话；返回被吊销的数量 */
  private revokeOverflowSessions(userId: string, maxPerUser: number): number {
    const res = this.db.run(
      `UPDATE sessions SET revoked_at = ?, revoke_reason = 'replaced'
        WHERE revoked_at IS NULL AND sid IN (
          SELECT sid FROM sessions
           WHERE user_id = ? AND revoked_at IS NULL
           ORDER BY issued_at DESC, rowid DESC
           LIMIT -1 OFFSET ?
        )`,
      nowIso(),
      userId,
      maxPerUser,
    );
    return res.changes;
  }

  /** 校验会话并滑动空闲有效期；返回 null 表示无效 */
  resolveSession(sid: string): AuthUser | null {
    const cfg = getConfig();
    const row = this.db.get<SessionRow>('SELECT * FROM sessions WHERE sid = ?', sid);
    if (!row || row.revoked_at) return null;
    const now = new Date();
    if (new Date(row.expires_at) <= now || new Date(row.idle_expires_at) <= now) {
      this.db.run('UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE sid = ?', nowIso(), 'expired', sid);
      return null;
    }
    const user = this.findUserById(row.user_id);
    if (!user) return null;

    // 活跃时间按间隔回写：每个 registry 请求都写一次 last_seen_at，会让三角色共享的
    // SQLite 长期占着写锁（WAL 只允许单写者），而空闲有效期并不需要秒级精度。
    // 回写间隔最多取空闲有效期的一半，避免配置成「回写间隔 > 空闲期」后会话永不续期。
    const touchSec = Math.min(cfg.sessionTouchIntervalSec, Math.floor(cfg.sessionIdleTtlSec / 2));
    const remainingMs = new Date(row.idle_expires_at).getTime() - now.getTime();
    if (remainingMs <= (cfg.sessionIdleTtlSec - touchSec) * 1000) {
      const nowStr = nowIso();
      this.db.run(
        'UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE sid = ?',
        nowStr,
        addSeconds(nowStr, cfg.sessionIdleTtlSec),
        sid,
      );
    }
    return user;
  }

  /**
   * 清掉已失效且超过保留期的会话行（过期或已吊销）。
   * 只在控制台进程的保留期任务里调用：会话行是排障线索，登录即删会丢掉「谁在什么时候登录过」，
   * 但也不能永久累积——sessions 只增不减，一年就是全库最大的表。
   * 返回删除行数；retentionDays<=0 表示不清理。
   */
  purgeExpiredSessions(retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const res = this.db.run(
      `DELETE FROM sessions
        WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
           OR (revoked_at IS NULL AND expires_at < ?)`,
      cutoff,
      cutoff,
    );
    return res.changes;
  }

  revokeSession(sid: string, reason: string): void {
    this.db.run(
      'UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE sid = ? AND revoked_at IS NULL',
      nowIso(),
      reason,
      sid,
    );
  }

  /** 全局登出：同一用户在所有服务/浏览器上的会话统一吊销 */
  revokeUserSessions(userId: string, reason: string): number {
    const res = this.db.run(
      'UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
      nowIso(),
      reason,
      userId,
    );
    return res.changes;
  }

  /**
   * 会话是否应带 Secure 属性。
   * auto（默认）按「这一次请求实际走的是什么协议」判断，而不是看基址配置：
   * - 网关形态信任 X-Forwarded-Proto（TLS 在 Nginx 终结，应用看到的是 http）；
   * - 直连形态取 TCP/TLS 实际协议，基址写 https 但用户直连 http 端口时不下发 Secure，
   *   否则浏览器会直接丢弃这条 Cookie，表现为「登录成功却仍是未登录」。
   * 需要强制时可设 SESSION_COOKIE_SECURE=always/never，不必改 ALLOW_INSECURE_BASE_URL。
   */
  cookieSecureFor(req: { protocol?: string; headers: Record<string, unknown> }): boolean {
    const cfg = getConfig();
    if (cfg.sessionCookieSecure === 'always') return true;
    if (cfg.sessionCookieSecure === 'never') return false;

    const forwarded = String(req.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    if (cfg.deployMode === 'gateway') {
      // 网关形态下应用只监听回环，XFP 由网关写入；缺失时按 https 处理（网关就该是 TLS）
      return forwarded ? forwarded === 'https' : true;
    }
    if (forwarded === 'https' && cfg.insecureBaseTargets.length === 0) return true;
    if ((req.protocol || '').toLowerCase() === 'https') return true;
    // 直连形态没有反代，按基址兜底：基址是 https 说明 TLS 在前置，仍应下发 Secure
    return cfg.publicBaseUrl.startsWith('https://');
  }

  sessionCookie(sid: string, maxAgeSec: number, secure = false): string {
    return `yj_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
  }

  /**
   * 清除 Cookie 必须与下发时属性一致：登录时带了 Secure，清除时却不带，
   * 浏览器会认为是另一条 Cookie（同名不同属性），旧值继续跟着请求走，
   * 表现为「点了退出但仍是登录态」。Expires 供不支持 Max-Age 的老客户端兜底。
   */
  clearSessionCookie(secure = false): string {
    return `yj_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`;
  }

  // ---------- API 令牌 ----------

  /**
   * 签发 API 令牌。
   *
   * 有效期优先用调用方显式传入的 `expiresInDays`（0 表示不过期），未传则取配置默认值
   * `auth.apiTokenTtlDays`。令牌是长期凭据，没有到期时间就等于永久凭据，泄露后只能靠
   * 人工发现再吊销；因此默认给一个有限有效期，靠轮换把风险窗口压到可控范围。
   */
  createApiToken(
    userId: string,
    name: string,
    expiresInDays?: number,
  ): { token: string; name: string; createdAt: string; expiresAt: string | null } {
    const token = `yj_${randomToken(24)}`;
    const createdAt = nowIso();
    const days = expiresInDays ?? getConfig().auth.apiTokenTtlDays;
    const expiresAt = days > 0 ? addSeconds(createdAt, Math.round(days) * 86400) : null;
    this.db.run(
      'INSERT INTO api_tokens (token_hash, user_id, name, created_at, expires_at) VALUES (?,?,?,?,?)',
      sha256Hex(token),
      userId,
      name.slice(0, 80),
      createdAt,
      expiresAt,
    );
    return { token, name, createdAt, expiresAt };
  }

  resolveApiToken(token: string): AuthUser | null {
    if (!token.startsWith('yj_')) return null;
    const hash = sha256Hex(token);
    const row = this.db.get<{ user_id: string; revoked_at: string | null; expires_at: string | null }>(
      'SELECT user_id, revoked_at, expires_at FROM api_tokens WHERE token_hash = ?',
      hash,
    );
    if (!row || row.revoked_at) return null;
    // expires_at 为空表示不过期（加列前的存量令牌）；到期后顺带标记吊销，
    // 让管理端清单能直接看出失效原因，而不是一直显示「有效但用不了」。
    if (row.expires_at && new Date(row.expires_at) <= new Date()) {
      this.db.run(
        "UPDATE api_tokens SET revoked_at = ?, revoke_reason = 'expired' WHERE token_hash = ? AND revoked_at IS NULL",
        nowIso(),
        hash,
      );
      return null;
    }
    const user = this.findUserById(row.user_id);
    if (!user) return null;
    this.db.run('UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?', nowIso(), hash);
    // Token 归属法：把 token_hash 带进 AuthUser，审计写入时落到 actor_token_hash
    return { ...user, tokenId: hash };
  }

  listApiTokens(userId: string): Record<string, unknown>[] {
    return this.db.all(
      `SELECT token_hash, name, created_at, expires_at, last_used_at, revoked_at, revoke_reason
         FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`,
      userId,
    );
  }

  /**
   * 管理员视角的全量令牌清单：带出归属账号，用于集中排查离职账号、泄露凭据。
   * 普通用户走 listApiTokens（只返回自己的），两个入口不共用一个方法，
   * 避免后续给这里加参数时误把越权查询能力开放出去。
   */
  listAllApiTokens(filter: { keyword?: string } = {}): Record<string, unknown>[] {
    const keyword = (filter.keyword || '').trim();
    const where: string[] = [];
    const params: string[] = [];
    if (keyword) {
      where.push("(t.name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')");
      const like = likeContains(keyword);
      params.push(like, like, like);
    }
    const sql = `SELECT t.token_hash, t.name, t.created_at, t.expires_at, t.last_used_at, t.revoked_at, t.revoke_reason,
                        t.user_id, u.username, u.display_name, u.role, u.account_type,
                        u.status AS user_status
                   FROM api_tokens t JOIN users u ON u.id = t.user_id
                   ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                  ORDER BY t.created_at DESC LIMIT 2000`;
    return this.db.all(sql, ...params);
  }

  /**
   * 管理员代吊销：不限定归属人，命中未吊销令牌时返回其归属账号，供审计落 target。
   * 与 revokeApiToken 分开，是为了让「只能吊销自己的」这条约束在代码里显式可见。
   */
  revokeApiTokenByHash(tokenHash: string, reason = 'admin_revoke'): { userId: string; username: string } | null {
    const row = this.db.get<{ user_id: string; username: string }>(
      `SELECT t.user_id, u.username FROM api_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
      tokenHash,
    );
    if (!row) return null;
    this.revokeApiToken(row.user_id, tokenHash, reason);
    return { userId: row.user_id, username: row.username };
  }

  revokeApiToken(userId: string, tokenHash: string, reason = 'manual'): boolean {
    const res = this.db.run(
      'UPDATE api_tokens SET revoked_at = ?, revoke_reason = ? WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL',
      nowIso(),
      reason,
      tokenHash,
      userId,
    );
    return res.changes > 0;
  }

  /**
   * 批量吊销某账号名下所有未吊销令牌，返回实际吊销数量。
   * 与「禁用账号」语义不同：禁用是可逆的（令牌保留、暂时不可用），
   * 本操作不可逆，用于离职、凭据泄露、项目下线等需要彻底断开的场景。
   */
  revokeAllApiTokens(userId: string, reason = 'bulk_revoke'): number {
    const res = this.db.run(
      'UPDATE api_tokens SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
      nowIso(),
      reason,
      userId,
    );
    return res.changes;
  }

  // ---------- 权限决策（带短 TTL 缓存） ----------

  permissionsOf(user: AuthUser): string[] {
    return ROLE_PERMISSIONS[user.role] || ROLE_PERMISSIONS.reader;
  }

  hasPermission(user: AuthUser, permission: string): boolean {
    // 缓存键带上角色：会话/令牌每次请求都会从库里取到最新 role，角色一旦变更键就变了，
    // 拆分部署下另一进程改的角色在本进程立即生效，不会出现 TTL 内的旧权限窗口。
    const key = `${user.id}:${user.role}:${permission}`;
    const cached = this.permCache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.allowed;

    const allowed = this.permissionsOf(user).includes(permission);
    this.permCache.set(key, { allowed, expiresAt: now + getConfig().authCacheTtlMs });
    return allowed;
  }

  private invalidatePermissionCache(userId: string): void {
    const prefix = `${userId}:`;
    for (const key of this.permCache.keys()) {
      if (key.startsWith(prefix)) this.permCache.delete(key);
    }
  }
}
