# 备份与恢复（A2 一致性备份方案）

## 1. 方案定位

| 项 | 内容 |
| --- | --- |
| 备份方式 | SQLite 使用 `sqlite3 .backup`（Backup API，在线一致性快照）+ 对象/元数据目录 `cp -a` 快照 |
| 停机要求 | 无需停机；`.backup` 在 WAL 模式下可在线执行 |
| 依赖 | 容器内已内置 `sqlite3` CLI、`cp`、`tar`、`sha256sum`；宿主无需安装任何工具（`build-offline.sh` 在构建机用 rsync 打包，与运行期无关） |
| 备份范围 | `platform.db`、`objects/`、`meta/`、`batches/` |
| 不备份 | `quarantine/`（含恶意样本，避免扩散至备份系统）、`tmp/` |
| 建议 RPO | 每日 1 次 ≤ 24 小时；可提升到每 6 小时 |
| 建议 RTO | 单机恢复 ≤ 1 小时（含校验与验证） |

> 禁止直接 `cp platform.db`：WAL 模式下会拷贝到未合并的事务状态，恢复后可能丢数据或直接损坏。

## 2. 两套备份机制与启动方式

项目里存在**两套相互独立的备份**，务必分清——它们的启动方式、备份产物、开关手段都不同：

| | 机制 A：应用内增量备份 | 机制 B：整机归档备份 |
| --- | --- | --- |
| 实现 | `src/maintenance/backup.service.ts` + `backup.scheduler.ts` | `scripts/backup.sh` + `restore.sh` |
| 启动 | **随 console 进程自动启动**，无需人工干预；心跳 60s，按间隔执行 | **需人工启动**（装 cron 或执行一次） |
| 备份内容 | 仅把对象存储 `objects/` 的包文件增量复制到备份目录 | SQLite 一致性快照 + `objects/`/`meta/`/`batches/` 打包成 `yuanjian-<时间戳>.tar.gz` |
| 落盘位置 | `<dataDir>/backups`（默认，容器内），纯包文件副本 | `/srv/yuanjian-backups`（宿主，容器内挂 `/backups`），可直接用于恢复 |
| 默认开关 | `BACKUP_ENABLED=true`（env），运行时可被字典覆盖 | 无内置开关，由是否安装定时任务决定 |
| 能否恢复 | 不能单独恢复，缺 `platform.db` 与元数据 | **完整可恢复**（推荐作为正式备份） |

**结论**：正式的、可恢复的备份是机制 B；机制 A 只是包文件的增量副本补充。两者都由字典项 `backup.enabled` 统一控制（机制 B 通过下文的 `backup-control.sh` 接入该开关）。

### 2.1 一键启动脚本：`deploy/backup-control.sh`

该脚本在**宿主服务器**执行，用于一键启停机制 B。它管理 cron、执行备份前检查字典总闸，并把运行状态与异常落盘。宿主无需 Node / Python / sqlite3（都走镜像内工具）。

```bash
cd /opt/yuanjian                      # 离线部署根目录，脚本位于 deploy/
sudo ./deploy/backup-control.sh enable     # 一键启用：建目录+授权、装 cron、立即验证一次
sudo ./deploy/backup-control.sh status     # 查看状态 / cron / 字典总闸 / 归档 / 最近异常
sudo ./deploy/backup-control.sh disable    # 一键停用：移除 cron（不动任何备份数据）
# run 子命令供 cron 调用，无需手工执行
```

**幂等与防冲突设计**（回应"重复执行不产生冲突"）：

- **重复 enable 不叠加 cron**：cron 行带唯一标记 `# yuanjian-backup-control (managed, do not edit)`，每次安装先按标记和脚本路径过滤旧行再写入，始终只有一行；`disable` 重复执行也安全。
- **备份不互相覆盖**：归档名含秒级时间戳 `yuanjian-<YYYYMMDDTHHMMSS>.tar.gz`，重复执行不会覆盖已有归档。
- **并发互斥**：`run` 用原子目录锁 `.control/.lock` 防止上一轮未结束又启动新一轮；超过 `YJ_LOCK_TTL`（默认 7200s）的陈旧锁自动清理，避免异常残留锁永久阻塞。抢锁失败记 `skipped_locked` 并正常退出。

**状态与异常记录**（回应"记录启动状态和异常信息"）——全部落在 `<备份目录>/.control/`：

| 文件 | 内容 |
| --- | --- |
| `state` | `ENABLED_AT`、`CRON_EXPR`、`LAST_RUN_AT`、`LAST_STATUS`（`success`/`failed`/`skipped_by_dictionary`/`skipped_locked`）、`LAST_ARCHIVE`、`CONSECUTIVE_FAILURES` |
| `history.log` | 追加式运行流水：`时间 \| 状态 \| 摘要` |
| `last_error` | 最近一次失败命令的完整 stderr（成功时清空） |
| `.lock/` | 并发锁目录（含 `ts` 时间戳） |

`enable` 会立即执行一次备份做验证；失败时脚本记录异常但**不阻断 enable 返回**（cron 已装好，后续可自动重试）。运行日志记录到 `YJ_LOG`（默认 `/var/log/yuanjian-backup.log`）。

**可覆盖的环境变量**（非默认部署或演练用）：`YJ_IMAGE`、`YJ_DATA_VOLUME`、`YJ_DATA_DIR`、`YJ_BACKUP_ROOT`、`YJ_CONTROL_DIR`、`YJ_LOG`、`YJ_CRON_EXPR`、`YJ_RETAIN_DAYS`、`YJ_LOCK_TTL`、`YJ_DICT_KEY`、`YJ_CRON_OUTPUT`。

### 2.2 字典总闸：两套备份统一开关

`backup-control.sh` 在每次 `run` 执行备份**之前**，会先在容器内读 `sys_dictionary` 表的 `backup.enabled`：

- 值为 `false` → 跳过本轮备份（状态 `skipped_by_dictionary`），**不产生新归档、不删除已有归档**；
- 值为 `true` 或字典无该行 → 正常备份（无行时采用 env 基线 `BACKUP_ENABLED`，默认开启）；
- 读取失败（容器/卷异常）→ **默认放行备份**（fail-open）：备份是安全网，不因查询通道故障而意外停摆。

这样，控制台「字典管理 → 包文件备份 → 启用包文件备份」一个开关，即可同时停/启两套备份。

## 3. 通过字典管理关闭备份

### 3.1 所需字典项与取值含义

路径：控制台 → 字典管理 → 「包文件备份」分组。API 为 `PUT /api/v1/dictionary`，需 `config:manage` 权限。

| 字典项（key） | 类型 / 取值 | 含义 | 影响范围 |
| --- | --- | --- | --- |
| `backup.enabled` | boolean，`true`/`false` | 备份**总开关**。`false`=关闭备份；`true`=开启 | 机制 A 立即生效；机制 B 下一次 `run` 起跳过 |
| `backup.intervalMinutes` | int，`1`~`10080` | 机制 A 的增量备份间隔（分钟），默认 60 | **仅机制 A**；不影响机制 B 的 cron 频率 |

> `backup.intervalMinutes` 越界（0 或 >10080）会被整体拒绝且不落库；关闭备份用 `backup.enabled=false`，不要把间隔填 0。

关闭示例（控制台操作等价于）：

```json
PUT /api/v1/dictionary
{ "values": { "backup.enabled": false } }
```

### 3.2 关闭后的处理逻辑（依据源码）

**机制 A（应用内增量备份）——即时生效**：

- `BackupScheduler.tick()` 每轮心跳重新读取 `getConfig().backup`，发现 `enabled=false` 直接返回，不再执行。
- `BackupService.runSweep()` 在开关关闭时立即返回 `enabled:false`，**连备份目录都不创建**，避免"关了却多出空目录"的误读。
- 字典保存后由 `DictionaryService.save()` 调用 `setDictionaryOverrides()` 即时套用，**无需重启、无需重建容器**；最多一个心跳周期（60s）内生效。
- 关闭只停止后续备份，**从不删除**已生成的备份文件。

**机制 B（整机归档脚本）——下一次调度起生效**：

- `backup-control.sh run` 检测到 `backup.enabled=false` 即跳过，`LAST_STATUS=skipped_by_dictionary`，不产出新归档；已存在的 `yuanjian-*.tar.gz` 原样保留。
- cron 条目**无需卸载**——开关关闭时任务照常触发但会快速跳过；需要恢复时把字典改回 `true`，下一轮自动继续备份，无需改 cron。
- 若确定长期不做整机归档，可用 `backup-control.sh disable` 卸载 cron 作为更彻底的做法（同样不动数据）。

**关闭 ≠ 删除**：两种机制在关闭后都保留全部已生成的备份，可随时用于恢复（第 5 节）。关闭只是停止新增。

### 3.3 什么情况不建议关

- `backup.enabled` 是**数据安全网**。除非有替代的、经验证的备份与恢复通道，否则生产环境不应长期关闭。
- 触发"假 ALLOW"、升级、数据迁移等高风险操作前，反而应确认备份处于开启状态并有一次成功归档（`status` 中 `LAST_STATUS=success`）。

## 4. 备份（手工执行一次）

```bash
# 一次性执行
DATA_DIR=/opt/yuanjian/data/prod BACKUP_ROOT=/opt/yuanjian/backups ./scripts/backup.sh

# 按保留期清理旧归档（默认不删除任何文件）
DATA_DIR=/opt/yuanjian/data/prod BACKUP_ROOT=/opt/yuanjian/backups RETAIN_DAYS=14 ./scripts/backup.sh --prune
```

输出物：

```
backups/
├── yuanjian-20261116T020000.tar.gz
├── yuanjian-20261116T020000.tar.gz.sha256
```

归档内包含 `platform.db`、`objects/`、`meta/`、`batches/` 与 `MANIFEST.txt`（创建时间、库校验和、版本数、对象数）。

脚本行为：

1. `sqlite3 <db> ".backup"` 生成一致性快照。
2. 对快照执行 `PRAGMA integrity_check`，非 `ok` 立即失败（退出码 3），不产出半成品归档。
3. 用 `cp -a` 复制对象与元数据（原 rsync 方案已废弃：镜像基于 bookworm-slim 未装 rsync，会让备份在容器内静默失败）；清单落盘后再打包并生成校验和。

## 5. 定时任务

**推荐用一键脚本**（幂等安装 + 字典总闸 + 状态记录，见 2.1）：

```bash
sudo /opt/yuanjian/deploy/backup-control.sh enable
```

等价的手工 cron（不带字典总闸与状态记录，仅在无法使用脚本时采用）。镜像 tag 必须与目标机架构一致，`yuanjian:arm64` 用于 aarch64，`yuanjian:amd64` 用于 x86_64：

```cron
# 每天 02:00 备份并保留 14 天（下例为 arm64）
0 2 * * * cd /opt/yuanjian && docker run --rm -v yuanjian_data:/var/lib/yuanjian/data -v /srv/yuanjian-backups:/backups -e DATA_DIR=/var/lib/yuanjian/data -e BACKUP_ROOT=/backups -u 10001:10001 yuanjian:arm64 /app/scripts/backup.sh --prune >> /var/log/yuanjian-backup.log 2>&1
```

要求：

- 备份目录与数据目录分盘或分机，避免同时损坏。
- 备份目录权限 0700，仅运维账号可读（一键脚本已按 `10001:10001` 授权）。
- 若纳入等保，需将每日归档转储至只读存储或备份服务器，保留 ≥180 天。
- 监控 `backup.sh` 退出码与最近归档时间，超过 26 小时无新归档应告警。曾实测发现旧脚本因镜像缺 `rsync` 每天静默失败、零归档却无人察觉，务必配成功哨兵：

```bash
test -n "$(find /srv/yuanjian-backups -name 'yuanjian-*.tar.gz' -mtime -1 -print -quit)" \
  && echo "backup OK" || echo "ALERT: 24h 内无新备份归档"
```

## 6. 恢复

```bash
# 目标目录为空
./scripts/restore.sh /opt/yuanjian/backups/yuanjian-20261116T020000.tar.gz /opt/yuanjian/data/prod

# 目标目录已有数据（旧目录会改名为 <target>.pre-restore-<时间戳>，不删除）
./scripts/restore.sh /opt/yuanjian/backups/yuanjian-20261116T020000.tar.gz /opt/yuanjian/data/prod --force
```

脚本校验顺序：

1. 归档存在且 `.sha256` 存在，校验和不匹配直接拒绝（退出码 3）。
2. 归档内必须含 `platform.db`。
3. 恢复前的库执行 `PRAGMA integrity_check`。
4. 目标非空且未加 `--force` 时拒绝（退出码 4）。

恢复后必须验证：

```bash
curl -s http://127.0.0.1:<PORT>/api/v1/health     # status=ok，packages 与 MANIFEST 一致
sqlite3 <DATA_DIR>/platform.db "SELECT COUNT(*) FROM package_versions;"   # 与清单 versions 一致
```

再随机下载一个包，确认 `X-Package-Security` 响应头与文件大小正常，最后清理 `.pre-restore-*` 目录。

## 7. 演练与验收

| 项 | 验收标准 |
| --- | --- |
| 备份成功 | 退出码 0；归档与 `.sha256` 同时存在；`MANIFEST.txt` 的 `db_integrity=ok` |
| 归档完整性 | 重新计算 sha256 与 `.sha256` 文件一致 |
| 恢复正确性 | 恢复到新目录后 `/api/v1/health` 正常，`package_versions` 计数与清单一致 |
| 内容正确性 | 随机抽样 3 个包可下载，sha256 与库内记录一致 |
| 一键脚本幂等 | 连续 `enable` 两次 cron 仅一行；重复 `run` 归档名不冲突 |
| 字典总闸 | `backup.enabled=false` 后 `run` 记 `skipped_by_dictionary` 且零新增归档；改回 `true` 自动恢复 |
| 时间指标 | 记录实际备份耗时与恢复耗时，用于校准 RTO 承诺 |
| 演练频率 | 每季度至少 1 次，演练记录归档备查 |

## 8. 已知限制

- 恢复依赖人工切换：脚本不负责停止/启动服务，执行前需先停服务，避免恢复期间仍有写入。
- `batches/` 随备份一起恢复，可能包含历史导入文件；如需最小化备份，可自行从脚本目录列表中移除。
- 该方案解决的是单机数据一致性，不解决主机级故障：主机宕机仍需人工在新机器恢复，RTO 以此为前提。
- 字典总闸读取采用 fail-open：若查询通道（容器/卷）故障，备份会照常执行而非停止——这是刻意的安全取舍，代价是极端情况下无法通过字典即时止损，此时应改用 `disable` 卸载 cron。
