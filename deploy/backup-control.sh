#!/usr/bin/env bash
# 源鉴平台 · 备份功能一键启停与运维控制（在宿主服务器执行，无需 Node / Python）
#
# 它管理的是「整机归档备份」= 镜像内 /app/scripts/backup.sh（SQLite 一致性快照 + 目录打包）。
# 应用内还有一套「包对象增量备份」由 console 进程自动运行，两者由字典项 backup.enabled 统一控制。
#
# 用法：
#   ./backup-control.sh enable   一键启用（幂等）：建目录、装 cron、立即验证一次
#   ./backup-control.sh disable  一键停用（幂等）：移除 cron，不动任何备份数据
#   ./backup-control.sh status   查看启用状态、最近运行结果、字典总闸、归档清单
#   ./backup-control.sh run      执行一次备份（供 cron 调用；含互斥锁与字典总闸检查）
#
# 全部路径均可用环境变量覆盖，便于非默认部署或演练测试。
set -u

# ---------- 可配置项 ----------
YJ_IMAGE="${YJ_IMAGE:-yuanjian:local}"
YJ_DATA_VOLUME="${YJ_DATA_VOLUME:-yuanjian_data}"        # compose name=yuanjian → 卷全名 yuanjian_data
YJ_DATA_DIR="${YJ_DATA_DIR:-/var/lib/yuanjian/data}"      # 容器内数据目录（挂载点）
YJ_BACKUP_ROOT="${YJ_BACKUP_ROOT:-/srv/yuanjian-backups}" # 宿主备份目录 → 容器 /backups
YJ_CONTROL_DIR="${YJ_CONTROL_DIR:-${YJ_BACKUP_ROOT}/.control}"
YJ_LOG="${YJ_LOG:-/var/log/yuanjian-backup.log}"
YJ_CRON_EXPR="${YJ_CRON_EXPR:-10 2 * * *}"                # 默认每天 02:10
YJ_RETAIN_DAYS="${YJ_RETAIN_DAYS:-14}"
YJ_LOCK_TTL="${YJ_LOCK_TTL:-7200}"                        # 陈旧锁判定（秒），防异常残留锁永久阻塞
YJ_DICT_KEY="${YJ_DICT_KEY:-backup.enabled}"             # 字典总闸键
# 仅测试用：设置后 cron 内容写入该文件而不是 crontab -
YJ_CRON_OUTPUT="${YJ_CRON_OUTPUT:-}"

STATE_FILE="${YJ_CONTROL_DIR}/state"
HISTORY_FILE="${YJ_CONTROL_DIR}/history.log"
ERROR_FILE="${YJ_CONTROL_DIR}/last_error"
LOCK_DIR="${YJ_CONTROL_DIR}/.lock"
CRON_MARK="# yuanjian-backup-control (managed, do not edit)"
SCRIPT_PATH="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/$(basename "$0")"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

# ---------- 状态读写（key=value，纯 shell，无 jq/Python 依赖） ----------
set_state() {
  local key="$1" val="${2-}"
  val="$(printf '%s' "$val" | tr '\n' ' ')"
  local tmp="${STATE_FILE}.tmp.$$"
  { grep -v "^${key}=" "$STATE_FILE" 2>/dev/null || true; printf '%s=%s\n' "$key" "$val"; } > "$tmp"
  mv "$tmp" "$STATE_FILE"
}
get_state() { grep "^$1=" "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }
append_history() {
  printf '%s | %s | %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$1" "${2-}" >> "$HISTORY_FILE" 2>/dev/null || true
}

# ---------- 互斥锁：mkdir 原子创建，无外部依赖；带陈旧锁自愈 ----------
acquire_lock() {
  mkdir -p "$YJ_CONTROL_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    date +%s > "${LOCK_DIR}/ts"
    return 0
  fi
  local ts now
  ts="$(cat "${LOCK_DIR}/ts" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  if [ "$((now - ts))" -gt "$YJ_LOCK_TTL" ]; then
    rm -rf "$LOCK_DIR"
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      date +%s > "${LOCK_DIR}/ts"
      return 0
    fi
  fi
  return 1
}
release_lock() { rm -rf "$LOCK_DIR" 2>/dev/null || true; }

# ---------- 字典总闸：读 sys_dictionary 的 backup.enabled ----------
# 返回 0=允许备份；1=字典明确 false。读不到/出错一律放行（备份是安全网，fail-open）。
dict_allows_backup() {
  local v
  v="$(docker run --rm \
      -v "${YJ_DATA_VOLUME}:${YJ_DATA_DIR}" \
      --entrypoint sh "$YJ_IMAGE" -c \
      "sqlite3 '${YJ_DATA_DIR}/platform.db' \"SELECT value FROM sys_dictionary WHERE key='${YJ_DICT_KEY}';\" 2>/dev/null" \
      2>/dev/null || true)"
  [ "$v" = "false" ] && return 1
  return 0
}

# ---------- cron 幂等安装 / 卸载 ----------
read_cron() {
  if [ -n "$YJ_CRON_OUTPUT" ]; then
    [ -f "$YJ_CRON_OUTPUT" ] && cat "$YJ_CRON_OUTPUT" || true
  else
    crontab -l 2>/dev/null || true
  fi
}
write_cron() {
  if [ -n "$YJ_CRON_OUTPUT" ]; then
    cat > "$YJ_CRON_OUTPUT"
  else
    crontab -
  fi
}
install_cron() {
  local line="${YJ_CRON_EXPR} ${SCRIPT_PATH} run >> ${YJ_LOG} 2>&1 ${CRON_MARK}"
  { read_cron | grep -vF "$CRON_MARK" | grep -vF "${SCRIPT_PATH} run" || true; printf '%s\n' "$line"; } \
    | sed '/^[[:space:]]*$/d' | write_cron
}
uninstall_cron() {
  { read_cron | grep -vF "$CRON_MARK" | grep -vF "${SCRIPT_PATH} run" || true; } \
    | sed '/^[[:space:]]*$/d' | write_cron
}

# ---------- 子命令 ----------
cmd_run() {
  mkdir -p "$YJ_CONTROL_DIR"
  if ! acquire_lock; then
    log "SKIP 已有备份任务在运行或锁未过期（${LOCK_DIR}）"
    set_state LAST_STATUS skipped_locked
    append_history skipped_locked "上一轮仍在执行"
    return 0
  fi
  trap release_lock EXIT

  if ! dict_allows_backup; then
    log "SKIP 字典 ${YJ_DICT_KEY}=false，总闸关闭，本轮不备份"
    set_state LAST_STATUS skipped_by_dictionary
    set_state LAST_RUN_AT "$(date '+%Y-%m-%dT%H:%M:%S%z')"
    : > "$ERROR_FILE"
    append_history skipped_by_dictionary "字典总闸关闭"
    return 0
  fi

  log "RUN 开始整机备份（archive via backup.sh --prune）"
  local out rc
  out="$(docker run --rm \
      -v "${YJ_DATA_VOLUME}:${YJ_DATA_DIR}" \
      -v "${YJ_BACKUP_ROOT}:/backups" \
      -e DATA_DIR="${YJ_DATA_DIR}" \
      -e BACKUP_ROOT=/backups \
      -e RETAIN_DAYS="${YJ_RETAIN_DAYS}" \
      -u 10001:10001 \
      "$YJ_IMAGE" /app/scripts/backup.sh --prune 2>&1)"
  rc=$?
  printf '%s\n' "$out"
  set_state LAST_RUN_AT "$(date '+%Y-%m-%dT%H:%M:%S%z')"

  if [ "$rc" -eq 0 ]; then
    local archive
    archive="$(printf '%s\n' "$out" | grep -oE 'yuanjian-[0-9T]+\.tar\.gz' | head -1 || true)"
    set_state LAST_STATUS success
    set_state LAST_ARCHIVE "$archive"
    set_state CONSECUTIVE_FAILURES 0
    : > "$ERROR_FILE"
    append_history success "归档=${archive:-unknown}"
    log "OK 备份完成 归档=${archive:-unknown}"
  else
    local fails
    fails="$(get_state CONSECUTIVE_FAILURES)"; [ -n "$fails" ] || fails=0
    set_state LAST_STATUS failed
    set_state CONSECUTIVE_FAILURES "$((fails + 1))"
    printf '%s\n' "$out" > "$ERROR_FILE"
    append_history failed "退出码=${rc} 连续失败=$((fails + 1))"
    log "FAIL 备份失败 退出码=${rc} 连续失败=$((fails + 1)) 详情见 ${ERROR_FILE}"
  fi
  return "$rc"
}

cmd_enable() {
  mkdir -p "$YJ_BACKUP_ROOT" "$YJ_CONTROL_DIR"
  chown 10001:10001 "$YJ_BACKUP_ROOT" "$YJ_CONTROL_DIR" 2>/dev/null || true
  install_cron
  set_state ENABLED_AT "$(date '+%Y-%m-%dT%H:%M:%S%z')"
  set_state CRON_EXPR "$YJ_CRON_EXPR"
  log "ENABLED cron=[${YJ_CRON_EXPR}] 备份目录=${YJ_BACKUP_ROOT}"
  cmd_run || true
}

cmd_disable() {
  mkdir -p "$YJ_CONTROL_DIR"
  uninstall_cron
  set_state ENABLED_AT ""
  log "DISABLED 已移除 cron；备份数据与状态保留"
}

cmd_status() {
  echo "=== 备份控制状态 ==="
  if [ -f "$STATE_FILE" ]; then
    cat "$STATE_FILE"
  else
    echo "（尚无状态文件，可能未执行过 enable）"
  fi
  echo
  echo "=== cron 条目 ==="
  read_cron | grep -F "$CRON_MARK" || echo "（未安装）"
  echo
  echo "=== 字典总闸 ${YJ_DICT_KEY} ==="
  local v
  v="$(docker run --rm -v "${YJ_DATA_VOLUME}:${YJ_DATA_DIR}" --entrypoint sh "$YJ_IMAGE" -c \
      "sqlite3 '${YJ_DATA_DIR}/platform.db' \"SELECT value FROM sys_dictionary WHERE key='${YJ_DICT_KEY}';\" 2>/dev/null" \
      2>/dev/null || true)"
  if [ "$v" = "false" ]; then echo "false（已关闭：两套备份均停止，已有备份保留）"
  elif [ "$v" = "true" ]; then echo "true（已显式开启）"
  else echo "（字典无显式覆盖 → 采用 env 基线 BACKUP_ENABLED，默认开启）"; fi
  echo
  echo "=== 最近归档 ==="
  ls -1t "$YJ_BACKUP_ROOT"/yuanjian-*.tar.gz 2>/dev/null | head -5 || echo "（无归档）"
  echo
  echo "=== 最近异常 ==="
  [ -s "$ERROR_FILE" ] && tail -8 "$ERROR_FILE" || echo "（无）"
}

case "${1:-}" in
  enable)  cmd_enable ;;
  disable) cmd_disable ;;
  status)  cmd_status ;;
  run)     cmd_run ;;
  *) echo "用法: $0 {enable|disable|status|run}" >&2; exit 64 ;;
esac
