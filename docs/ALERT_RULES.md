# 监控指标与告警规则（B3 / B5 / B6）

应用暴露 Prometheus 文本格式指标：`GET /metrics`。默认不校验身份，**生产必须设置 `METRICS_TOKEN` 并用网络 ACL 只允许 Prometheus 访问**；设置后需带 `Authorization: Bearer <token>`，比较使用定长比较。

## 1. 抓取配置

```yaml
scrape_configs:
  - job_name: yuanjian
    scrape_interval: 30s
    scrape_timeout: 10s
    metrics_path: /metrics
    authorization:
      credentials: "<METRICS_TOKEN>"
    static_configs:
      - targets: ["10.0.0.11:3000"]
```

## 2. 指标清单

| 指标 | 类型 | 说明 |
|---|---|---|
| `yj_up` | gauge | 进程存活，恒为 1；配合 `up{}` 判断抓取失败 |
| `yj_build_info{node,platform}` | gauge | Node 版本与平台，用于变更核对 |
| `yj_uptime_seconds` | gauge | 运行时长，骤降代表重启 |
| `yj_process_resident_memory_bytes` | gauge | RSS |
| `yj_nodejs_heap_used_bytes` | gauge | V8 堆使用量 |
| `yj_process_cpu_seconds_total` | counter | 累计 CPU 时间 |
| `yj_disk_used_percent` | gauge | `DATA_DIR` 所在文件系统已用百分比（A-05） |
| `yj_disk_available_bytes` | gauge | `DATA_DIR` 所在文件系统可用字节数（A-05） |
| `yj_disk_readonly` | gauge | 1 表示已因磁盘水位进入只读模式（A-05） |
| `yj_disk_last_check_timestamp_seconds` | gauge | 最近一次磁盘采样时间，用于判断采样是否停滞（A-05） |
| `yj_http_requests_total{scope,status}` | counter | 按请求类别（auth/read/write）与状态码聚合 |
| `yj_http_request_duration_seconds` | histogram | 同上维度，桶 0.05/0.1/0.25/0.5/1/2.5/5/10s |
| `yj_security_scan_active` | gauge | 正在执行的扫描数（上限 `SECURITY_SCAN_CONCURRENCY`） |
| `yj_security_scan_queued` | gauge | 排队扫描数（上限 `SECURITY_MAX_SCAN_QUEUE`） |
| `yj_security_advisories` | gauge | 本地漏洞库条目数，0 表示未导入 |
| `yj_security_scans_recent` | gauge | 近 24 小时扫描数 |
| `yj_clock_offset_ms{server}` | gauge | 主机相对 NTP 的偏移毫秒数；未配置 `NTP_SERVER` 时为 `NaN`（B5） |
| `yj_clock_healthy` | gauge | 1 正常 / 0 超阈值 / -1 未采样或采样失败（B5） |
| `yj_quarantine_pending` | gauge | 待人工复核的隔离样本数，长期不降说明复核流程停滞（B6） |
| `yj_quarantine_expired` | gauge | 已超过保留期但尚未销毁的样本数，正常应在每日清理后归零（B6） |
| `yj_quarantine_bytes` | gauge | 隔离区占用字节数，用于容量与独立卷规划（B6） |
| `yj_quarantine_last_purge_timestamp_seconds` | gauge | 最近一次真正执行超期销毁的时间，0 表示从未执行（B6） |

基数说明：HTTP 指标只按「类别 + 状态码」聚合，不按路径或包名打标签，避免高基数拖垮 Prometheus。

## 3. 告警规则

```yaml
groups:
  - name: yuanjian-availability
    rules:
      - alert: YuanjianDown
        expr: up{job="yuanjian"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "私有包平台不可用"
          description: "{{ $labels.instance }} 连续 1 分钟无法抓取。单机部署无冗余，需人工按 runbook 重启。"

      - alert: YuanjianRestarted
        expr: resets(yj_uptime_seconds[15m]) > 0
        labels:
          severity: warning
        annotations:
          summary: "私有包平台进程发生重启"
          description: "15 分钟内 uptime 被重置，检查是否 OOM 或崩溃，并核对崩溃前日志与 traceId。"

  - name: yuanjian-resource
    rules:
      - alert: YuanjianMemoryHigh
        expr: yj_process_resident_memory_bytes > 1.2e9
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "RSS 超过 1.2GB"
          description: "常态约 90–150MB；持续偏高通常意味着大包上传或扫描对象未释放。"

      - alert: YuanjianHeapHigh
        expr: yj_nodejs_heap_used_bytes > 8e8
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "V8 堆使用超过 800MB"
          description: "接近默认堆上限，存在 OOM 风险；检查 npm publish 体积与扫描并发。"

      - alert: YuanjianDiskUsageHigh
        expr: yj_disk_used_percent >= 85
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "DATA_DIR 磁盘使用率超过 85%"
          description: "已进入告警水位，写接口仍可用；需清理历史批次/隔离区或扩容，避免触及 95% 只读阈值。"

      - alert: YuanjianDiskReadOnly
        expr: yj_disk_readonly == 1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "平台因磁盘水位进入只读模式"
          description: "已用 ≥95% 或剩余空间低于 DISK_MIN_FREE_BYTES，所有写请求返回 507 STORAGE_READ_ONLY；立即清理磁盘，恢复后守卫会自动解除只读。"

  - name: yuanjian-api
    rules:
      - alert: YuanjianServerErrorRate
        expr: |
          sum(rate(yj_http_requests_total{status=~"5.."}[5m]))
          /
          clamp_min(sum(rate(yj_http_requests_total[5m])), 0.001) > 0.02
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "5xx 比例超过 2%"
          description: "按 traceId 抽样定位；常见原因见 docs/ALERT_RULES.md 第 5 节。"

      - alert: YuanjianScanBusyRate
        expr: sum(rate(yj_http_requests_total{status="503"}[5m])) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "扫描队列打满导致 503（SEC_SCAN_BUSY）"
          description: "正常发布已受影响；临时调大 SECURITY_SCAN_CONCURRENCY 或降低 SECURITY_MAX_SCAN_QUEUE 之外的入口压力。"

      - alert: YuanjianRateLimitedSpike
        expr: sum(rate(yj_http_requests_total{status="429"}[10m])) > 1
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "429 限流持续触发"
          description: "可能是流水线批量发布触发写配额，也可能是异常来源；核对 ip 维度日志后再决定调阈值。"

      - alert: YuanjianSlowRequests
        expr: histogram_quantile(0.95, sum by (le) (rate(yj_http_request_duration_seconds_bucket[5m]))) > 3
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "P95 响应超过 3 秒"
          description: "发布链路含同步扫描，大包会拉高耗时；持续偏高需评估 RV-04 的 CPU 隔离改造。"

  - name: yuanjian-security
    rules:
      - alert: YuanjianScanQueueBacklog
        expr: yj_security_scan_queued > 20
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "扫描排队超过 20"
          description: "队列上限默认 50，超过会直接返回 503；检查是否有异常大包或扫描卡住。"

      - alert: YuanjianScanQueueSaturated
        expr: yj_security_scan_queued > 40
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "扫描队列接近打满"
          description: "新发布很快会被拒绝，需立即介入。"

      - alert: YuanjianAdvisoryDbEmpty
        expr: yj_security_advisories == 0
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "本地漏洞库为空"
          description: "漏洞维度会标记为 unknown，发布仅告警不拦截；需导入漏洞数据。"

  - name: yuanjian-clock
    rules:
      - alert: YuanjianClockOffsetHigh
        expr: yj_clock_healthy == 0
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "主机时钟偏移超过阈值"
          description: "yj_clock_offset_ms 绝对值超过 NTP_MAX_OFFSET_MS；会话过期与审计时间依赖可信时钟，先校时再排查登录异常。"

  - name: yuanjian-quarantine
    rules:
      - alert: YuanjianQuarantineBacklog
        expr: yj_quarantine_pending > 20
        for: 24h
        labels:
          severity: warning
        annotations:
          summary: "隔离样本待复核积压超过 20"
          description: "复核流程可能停滞；样本会在 QUARANTINE_RETENTION_DAYS 天后自动销毁，需确认销毁前已完成处置决策。"

      - alert: YuanjianQuarantineExpired
        expr: yj_quarantine_expired > 0
        for: 26h
        labels:
          severity: warning
        annotations:
          summary: "存在超过保留期仍未销毁的隔离样本"
          description: "正常应在每日清理后归零；持续大于 0 说明销毁任务未执行或失败，核对 yj_quarantine_last_purge_timestamp_seconds 与 scheduler 日志。"
```

## 4. 分级与处置

| 级别 | 场景 | 处置 |
|---|---|---|
| critical | 服务不可用、5xx > 2%、队列将满、磁盘进入只读（≥95% 或剩余低于下限） | 立即介入，先保可用再定位 |
| warning | 重启、内存/堆偏高、P95 慢、429 增多、漏洞库空、磁盘 ≥85%、时钟偏移超限、隔离样本积压或超期未销毁 | 当班处理，24 小时内闭环 |

告警建议带 `runbook_url` 指向 `docs/BACKUP_RESTORE.md`（恢复）与本文第 5 节（排障）。

## 5. 常见 5xx 排查路径

1. `YuanjianScanBusyRate` 触发 → 扫描队列满，属容量问题，不是缺陷。
2. `YuanjianMemoryHigh` 与 5xx 同时出现 → 优先怀疑大包上传或 npm publish 峰值，核对 `yj_http_requests_total{scope="write"}` 与访问日志中的字节数。
3. 仅个别接口 5xx → 按响应里的 `traceId` 检索结构化日志 `logger="HTTP"` 与 `logger="Config"` 行。

## 6. 已知缺口

- 应用已采集 `DATA_DIR` 磁盘水位（A-05），但未采集对象存储总量与数据库文件大小；细粒度文件系统指标仍建议配合 `node_exporter` 的 `node_filesystem_*`。
- 无按接口维度的耗时指标（为避免高基数），深度排障依赖 traceId 日志。
- 隔离区指标按扫描目录递归统计文件大小，样本量特别大时 `/metrics` 抓取会变慢；建议把 `QUARANTINE_DIR` 放到独立卷并保持待复核数在两位数以内。
- 告警规则为样例，阈值基于当前单机基线，接入真实流量后需按 §2 水位复核。
