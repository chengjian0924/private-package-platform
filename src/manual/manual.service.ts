import { Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../common/errors';
import { nowIso } from '../common/http.util';
import { DatabaseService } from '../db/database.service';
import { sanitizeManualHtml } from './manual-sanitize';

/** 可编辑章节白名单：与 public/index.html 的 .manual-sec id 一一对应 */
export const MANUAL_SECTION_IDS = [
  'manual-login',
  'manual-access',
  'manual-package',
  'manual-import',
  'manual-missing',
  'manual-security',
  'manual-audit',
  'manual-users',
  'manual-token',
  'manual-config',
  'manual-faq',
] as const;

type ManualSectionId = (typeof MANUAL_SECTION_IDS)[number];
const SECTION_ID_SET = new Set<string>(MANUAL_SECTION_IDS);
const MAX_SECTION_HTML = 200_000;

interface ManualRow {
  section_id: string;
  html: string;
  updated_by: string | null;
  updated_at: string;
}

export interface ManualSectionOverride {
  html: string;
  updatedBy: string | null;
  updatedAt: string;
}

export interface ManualContent {
  sections: Record<string, ManualSectionOverride>;
  serverUpdatedAt: string | null;
}

export interface ManualSaveResult extends ManualContent {
  changed: string[];
}

@Injectable()
export class ManualService {
  private readonly logger = new Logger('Manual');

  constructor(private readonly db: DatabaseService) {}

  /** 只返回被管理员改过的章节；没改过的章节由前端继续用内置静态内容 */
  list(): ManualContent {
    const rows = this.db.all<ManualRow>(
      'SELECT section_id, html, updated_by, updated_at FROM user_manual',
    );
    const sections: Record<string, ManualSectionOverride> = {};
    let serverUpdatedAt: string | null = null;
    for (const row of rows) {
      if (!SECTION_ID_SET.has(row.section_id)) continue;
      sections[row.section_id] = {
        html: row.html,
        updatedBy: row.updated_by,
        updatedAt: row.updated_at,
      };
      if (!serverUpdatedAt || row.updated_at > serverUpdatedAt) {
        serverUpdatedAt = row.updated_at;
      }
    }
    return { sections, serverUpdatedAt };
  }

  /**
   * 保存章节覆盖。空字符串表示恢复内置默认内容（直接删除覆盖行）。
   * 整体校验后再写库，任何一项不合法都不落库。
   */
  save(payload: unknown, actorId: string | null): ManualSaveResult {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ApiError('SYS_VALIDATION', { reason: '请求体必须是对象' });
    }
    const sections = (payload as { sections?: unknown }).sections;
    if (!sections || typeof sections !== 'object' || Array.isArray(sections)) {
      throw new ApiError('SYS_VALIDATION', { reason: '缺少 sections 对象' });
    }

    const changes: Array<{ id: ManualSectionId; html: string | null }> = [];
    for (const [id, raw] of Object.entries(sections)) {
      if (!SECTION_ID_SET.has(id)) {
        throw new ApiError('SYS_VALIDATION', { key: id, reason: `未登记的手册章节: ${id}` });
      }
      if (raw === null || raw === '') {
        changes.push({ id: id as ManualSectionId, html: null });
        continue;
      }
      if (typeof raw !== 'string') {
        throw new ApiError('SYS_VALIDATION', { key: id, reason: '章节内容必须是字符串' });
      }
      if (raw.length > MAX_SECTION_HTML) {
        throw new ApiError('SYS_VALIDATION', {
          key: id,
          reason: `章节内容不能超过 ${MAX_SECTION_HTML} 字符`,
        });
      }
      changes.push({ id: id as ManualSectionId, html: sanitizeManualHtml(raw) });
    }
    if (!changes.length) {
      throw new ApiError('SYS_VALIDATION', { reason: '没有需要保存的章节' });
    }

    const now = nowIso();
    this.db.tx(() => {
      for (const change of changes) {
        if (change.html === null) {
          this.db.run('DELETE FROM user_manual WHERE section_id = ?', change.id);
          continue;
        }
        this.db.run(
          `INSERT INTO user_manual (section_id, html, updated_by, created_at, updated_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(section_id) DO UPDATE SET
             html = excluded.html,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
          change.id,
          change.html,
          actorId,
          now,
          now,
        );
      }
    });

    this.logger.log(`用户手册已更新：${changes.map((item) => item.id).join(', ')}`);
    const current = this.list();
    return { ...current, changed: changes.map((item) => item.id) };
  }
}
