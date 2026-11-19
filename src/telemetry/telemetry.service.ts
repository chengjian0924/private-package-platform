import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { nowIso } from '../common/http.util';

/** A4 预留：证书签发生命周期的事件名在此集中定义，功能恢复时直接复用 */
export const CERT_TELEMETRY_EVENTS = {
  issueStarted: 'cert.issue.started',
  issueSucceeded: 'cert.issue.succeeded',
  issueFailed: 'cert.issue.failed',
  revoked: 'cert.revoked',
} as const;

@Injectable()
export class TelemetryService {
  constructor(private readonly db: DatabaseService) {}

  record(eventName: string, payload: Record<string, unknown>, traceId?: string | null): void {
    this.db.run(
      `INSERT INTO telemetry_events (event_name, schema_version, payload, trace_id, occurred_at) VALUES (?,?,?,?,?)`,
      eventName,
      '1.0',
      JSON.stringify(payload ?? {}),
      traceId ?? null,
      nowIso(),
    );
  }
}
