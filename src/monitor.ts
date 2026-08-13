export type MonitorStatus = "pending" | "healthy" | "degraded" | "offline" | "unknown";

export interface MonitorTargetRef {
  userId: string;
  subId: string;
}

export interface MonitorReportInput extends MonitorTargetRef {
  checkedAt?: number;
  totalNodes: number;
  onlineNodes: number;
  medianDelayMs?: number | null;
  subscriptionFetchOk: boolean;
  errorCode?: string | null;
}

export interface MonitorAlert extends MonitorTargetRef {
  kind: "offline" | "recovered";
  totalNodes: number;
  onlineNodes: number;
  checkedAt: number;
}

interface MonitorTargetRow {
  user_id: string;
  sub_id: string;
  enabled: number;
  created_at: number;
  updated_at: number;
  last_checked_at: number | null;
  status: MonitorStatus;
  status_since: number | null;
  total_nodes: number | null;
  online_nodes: number | null;
  median_delay_ms: number | null;
  subscription_fetch_ok: number | null;
  probe_id: string | null;
  last_error: string | null;
  failure_streak: number;
  healthy_streak: number;
  alert_state: "normal" | "offline";
  last_alert_at: number | null;
}

interface MonitorAggregateRow {
  sub_id: string;
  online_24h: number | null;
  total_24h: number | null;
  samples_24h: number;
  online_7d: number | null;
  total_7d: number | null;
  samples_7d: number;
  online_30d: number | null;
  total_30d: number | null;
  samples_30d: number;
}

export interface MonitorSummary {
  userId: string;
  subId: string;
  enabled: boolean;
  createdAt: number;
  lastCheckedAt: number | null;
  status: MonitorStatus;
  statusSince: number | null;
  stale: boolean;
  totalNodes: number | null;
  onlineNodes: number | null;
  medianDelayMs: number | null;
  subscriptionFetchOk: boolean | null;
  probeId: string | null;
  lastError: string | null;
  rate24h: number | null;
  rate7d: number | null;
  rate30d: number | null;
  samples24h: number;
  samples7d: number;
  samples30d: number;
}

const MONITOR_STALE_MS = 25 * 60 * 1000;
const MONITOR_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function setMonitorEnabled(db: D1Database, userId: number, subId: string, enabled: boolean): Promise<void> {
  const now = Date.now();
  if (enabled) {
    await db.prepare(
      `INSERT INTO monitor_targets (user_id, sub_id, enabled, created_at, updated_at, status, status_since)
       VALUES (?1, ?2, 1, ?3, ?3, 'pending', ?3)
       ON CONFLICT(user_id, sub_id) DO UPDATE SET
         enabled = 1,
         updated_at = excluded.updated_at,
         status = 'pending',
         status_since = excluded.status_since,
         last_checked_at = NULL,
         total_nodes = NULL,
         online_nodes = NULL,
         median_delay_ms = NULL,
         subscription_fetch_ok = NULL,
         probe_id = NULL,
         last_error = NULL,
         failure_streak = 0,
         healthy_streak = 0`
    ).bind(String(userId), subId, now).run();
    return;
  }

  await db.prepare(
    `UPDATE monitor_targets
     SET enabled = 0, updated_at = ?3, failure_streak = 0, healthy_streak = 0
     WHERE user_id = ?1 AND sub_id = ?2`
  ).bind(String(userId), subId, now).run();
}

export async function deleteMonitorData(db: D1Database, userId: number, subId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM monitor_checks WHERE user_id = ?1 AND sub_id = ?2").bind(String(userId), subId),
    db.prepare("DELETE FROM monitor_targets WHERE user_id = ?1 AND sub_id = ?2").bind(String(userId), subId)
  ]);
}

export async function isMonitorTargetEnabled(db: D1Database, userId: string, subId: string): Promise<boolean> {
  const row = await db.prepare(
    "SELECT enabled FROM monitor_targets WHERE user_id = ?1 AND sub_id = ?2"
  ).bind(userId, subId).first<{ enabled: number }>();
  return row?.enabled === 1;
}

export async function listEnabledMonitorTargets(db: D1Database): Promise<MonitorTargetRef[]> {
  const result = await db.prepare(
    "SELECT user_id, sub_id FROM monitor_targets WHERE enabled = 1 ORDER BY updated_at ASC LIMIT 200"
  ).all<{ user_id: string; sub_id: string }>();
  return result.results.map((row) => ({ userId: row.user_id, subId: row.sub_id }));
}

export async function touchMonitorProbe(db: D1Database, probeId: string, label: string, version?: string): Promise<void> {
  await db.prepare(
    `INSERT INTO monitor_probes (probe_id, label, version, last_seen_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(probe_id) DO UPDATE SET
       label = excluded.label,
       version = excluded.version,
       last_seen_at = excluded.last_seen_at`
  ).bind(probeId, label, version ?? null, Date.now()).run();
}

export async function recordMonitorReports(
  db: D1Database,
  probeId: string,
  reports: MonitorReportInput[]
): Promise<{ stored: number; alerts: MonitorAlert[] }> {
  let stored = 0;
  const alerts: MonitorAlert[] = [];

  for (const report of reports) {
    const current = await db.prepare(
      "SELECT * FROM monitor_targets WHERE user_id = ?1 AND sub_id = ?2"
    ).bind(report.userId, report.subId).first<MonitorTargetRow>();
    if (!current || current.enabled !== 1) continue;

    const now = Date.now();
    const suppliedTime = Number(report.checkedAt);
    const checkedAt = Number.isFinite(suppliedTime) && Math.abs(now - suppliedTime) <= 20 * 60 * 1000
      ? Math.trunc(suppliedTime)
      : now;
    const status = monitorStatus(report);
    const statusSince = current.status === status && current.status_since ? current.status_since : checkedAt;
    const failureStreak = status === "offline" ? current.failure_streak + 1 : 0;
    const healthyStreak = status === "healthy" ? current.healthy_streak + 1 : 0;
    let alertState = current.alert_state;
    let alert: MonitorAlert | null = null;
    if (status === "offline" && failureStreak >= 2 && alertState !== "offline") {
      alertState = "offline";
      alert = { kind: "offline", userId: report.userId, subId: report.subId, totalNodes: report.totalNodes, onlineNodes: report.onlineNodes, checkedAt };
    } else if (status === "healthy" && healthyStreak >= 2 && alertState === "offline") {
      alertState = "normal";
      alert = { kind: "recovered", userId: report.userId, subId: report.subId, totalNodes: report.totalNodes, onlineNodes: report.onlineNodes, checkedAt };
    }

    await db.batch([
      db.prepare(
        `INSERT INTO monitor_checks
         (user_id, sub_id, probe_id, checked_at, status, total_nodes, online_nodes, median_delay_ms, subscription_fetch_ok, error_code)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      ).bind(
        report.userId,
        report.subId,
        probeId,
        checkedAt,
        status,
        report.totalNodes,
        report.onlineNodes,
        report.medianDelayMs ?? null,
        report.subscriptionFetchOk ? 1 : 0,
        report.errorCode ?? null
      ),
      db.prepare(
        `UPDATE monitor_targets SET
           updated_at = ?3,
           last_checked_at = ?3,
           status = ?4,
           status_since = ?5,
           total_nodes = ?6,
           online_nodes = ?7,
           median_delay_ms = ?8,
           subscription_fetch_ok = ?9,
           probe_id = ?10,
           last_error = ?11,
           failure_streak = ?12,
           healthy_streak = ?13,
           alert_state = ?14,
           last_alert_at = CASE WHEN ?15 = 1 THEN ?3 ELSE last_alert_at END
         WHERE user_id = ?1 AND sub_id = ?2 AND enabled = 1`
      ).bind(
        report.userId,
        report.subId,
        checkedAt,
        status,
        statusSince,
        report.totalNodes,
        report.onlineNodes,
        report.medianDelayMs ?? null,
        report.subscriptionFetchOk ? 1 : 0,
        probeId,
        report.errorCode ?? null,
        failureStreak,
        healthyStreak,
        alertState,
        alert ? 1 : 0
      )
    ]);
    stored += 1;
    if (alert) alerts.push(alert);
  }

  return { stored, alerts };
}

export async function listMonitorSummaries(db: D1Database, userId: number): Promise<MonitorSummary[]> {
  const userKey = String(userId);
  const now = Date.now();
  const cut24h = now - 24 * 60 * 60 * 1000;
  const cut7d = now - 7 * 24 * 60 * 60 * 1000;
  const cut30d = now - MONITOR_RETENTION_MS;
  const [targetResult, aggregateResult] = await Promise.all([
    db.prepare("SELECT * FROM monitor_targets WHERE user_id = ?1 ORDER BY updated_at DESC").bind(userKey).all<MonitorTargetRow>(),
    db.prepare(
      `SELECT sub_id,
         SUM(CASE WHEN checked_at >= ?2 AND total_nodes > 0 THEN online_nodes ELSE 0 END) AS online_24h,
         SUM(CASE WHEN checked_at >= ?2 AND total_nodes > 0 THEN total_nodes ELSE 0 END) AS total_24h,
         SUM(CASE WHEN checked_at >= ?2 AND total_nodes > 0 THEN 1 ELSE 0 END) AS samples_24h,
         SUM(CASE WHEN checked_at >= ?3 AND total_nodes > 0 THEN online_nodes ELSE 0 END) AS online_7d,
         SUM(CASE WHEN checked_at >= ?3 AND total_nodes > 0 THEN total_nodes ELSE 0 END) AS total_7d,
         SUM(CASE WHEN checked_at >= ?3 AND total_nodes > 0 THEN 1 ELSE 0 END) AS samples_7d,
         SUM(CASE WHEN checked_at >= ?4 AND total_nodes > 0 THEN online_nodes ELSE 0 END) AS online_30d,
         SUM(CASE WHEN checked_at >= ?4 AND total_nodes > 0 THEN total_nodes ELSE 0 END) AS total_30d,
         SUM(CASE WHEN checked_at >= ?4 AND total_nodes > 0 THEN 1 ELSE 0 END) AS samples_30d
       FROM monitor_checks
       WHERE user_id = ?1 AND checked_at >= ?4
       GROUP BY sub_id`
    ).bind(userKey, cut24h, cut7d, cut30d).all<MonitorAggregateRow>()
  ]);
  const aggregates = new Map(aggregateResult.results.map((row) => [row.sub_id, row]));

  return targetResult.results.map((row) => {
    const aggregate = aggregates.get(row.sub_id);
    return {
      userId: row.user_id,
      subId: row.sub_id,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
      status: row.status,
      statusSince: row.status_since,
      stale: row.enabled === 1 && row.last_checked_at !== null && now - row.last_checked_at > MONITOR_STALE_MS,
      totalNodes: row.total_nodes,
      onlineNodes: row.online_nodes,
      medianDelayMs: row.median_delay_ms,
      subscriptionFetchOk: row.subscription_fetch_ok === null ? null : row.subscription_fetch_ok === 1,
      probeId: row.probe_id,
      lastError: row.last_error,
      rate24h: monitorRate(aggregate?.online_24h, aggregate?.total_24h),
      rate7d: monitorRate(aggregate?.online_7d, aggregate?.total_7d),
      rate30d: monitorRate(aggregate?.online_30d, aggregate?.total_30d),
      samples24h: Number(aggregate?.samples_24h ?? 0),
      samples7d: Number(aggregate?.samples_7d ?? 0),
      samples30d: Number(aggregate?.samples_30d ?? 0)
    };
  });
}

export async function cleanupMonitorHistory(db: D1Database): Promise<number> {
  const result = await db.prepare("DELETE FROM monitor_checks WHERE checked_at < ?1").bind(Date.now() - MONITOR_RETENTION_MS).run();
  return Number(result.meta.changes ?? 0);
}

function monitorStatus(report: MonitorReportInput): MonitorStatus {
  if (report.errorCode || report.totalNodes <= 0) return "unknown";
  if (report.onlineNodes <= 0) return "offline";
  return report.onlineNodes / report.totalNodes >= 0.8 ? "healthy" : "degraded";
}

function monitorRate(online?: number | null, total?: number | null): number | null {
  const totalValue = Number(total ?? 0);
  if (totalValue <= 0) return null;
  return Math.max(0, Math.min(100, Number(online ?? 0) / totalValue * 100));
}
