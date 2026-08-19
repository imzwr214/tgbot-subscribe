import { generateClashNodeSubscription, generateMihomoSubscription, MihomoExportError } from "./mihomo/generate";
import {
  cleanupMonitorHistory,
  deleteMonitorData,
  isMonitorTargetEnabled,
  listEnabledMonitorTargets,
  listEnabledMonitorUserIds,
  listMonitorSummaries,
  MonitorReportInput,
  MonitorSummary,
  recordMonitorReports,
  setMonitorEnabled,
  touchMonitorProbe
} from "./monitor";

interface Env {
  BOT_TOKEN: string;
  ADMIN_USER_IDS?: string;
  ALLOWED_USER_IDS?: string;
  DEBUG_TOKEN?: string;
  SETUP_TOKEN?: string;
  WEB_TOKEN?: string;
  SUB_FETCH_PREFIX?: string;
  SUB_FETCH_PROXY?: string;
  BUILD_COMMIT?: string;
  BUILD_DIRTY?: string;
  BUILD_SOURCE_HASH?: string;
  BUILD_TIME?: string;
  SUB_KV: KVNamespace;
  MONITOR_DB: D1Database;
  MONITOR_TOKEN?: string;
}

interface TelegramUpdate {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
  message_id: number;
  text?: string;
  chat: { id: number; type: string };
  from?: TelegramUser;
  reply_to_message?: TelegramMessage;
  [key: string]: unknown;
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
  from: TelegramUser;
}

interface TelegramUser {
  id: number;
  is_bot?: boolean;
}

interface SubscriptionUserInfo {
  upload: number;
  download: number;
  total: number;
  expire: number | null;
  resetDay: number | null;
  purchasedAt: number | null;
  startAt: number | null;
  nextResetAt: number | null;
  resetEstimated: boolean;
}

interface ParsedNode {
  name: string;
  protocol: string;
  region: string;
  raw: string;
  isPolicy: boolean;
  isNotice: boolean;
}

interface ParsedSubscription {
  raw: string;
  userInfo: SubscriptionUserInfo | null;
  nodes: ParsedNode[];
  sourceType: "base64" | "yaml" | "text";
  airportName: string;
}

type QueryInput =
  | { kind: "subscription"; url: string }
  | { kind: "node"; uri: string }
  | { kind: "nodes"; uris: string[] };

interface CachedSubscription extends ParsedSubscription {
  url: string;
  updatedAt: string;
}

interface CachedNode {
  uri: string;
  name: string;
  protocol: string;
  region: string;
  updatedAt: string;
}

interface CachedNodeBundle {
  nodes: CachedNode[];
  updatedAt: string;
}

interface LegacySavedSubscription {
  url: string;
  updatedAt: string;
}

interface SavedSubscriptionItem {
  id: string;
  kind?: "subscription" | "node";
  name: string;
  customName?: string;
  url: string;
  airportName?: string;
  createdAt: string;
  updatedAt: string;
  lastQueryAt?: string;
  snapshotUpdatedAt?: string;
  snapshotNodeCount?: number;
  lastRefreshAttemptAt?: string;
  lastRefreshError?: string;
}

interface ShortLinkBase {
  createdBy: number;
  createdAt: string;
}

interface PendingSavedSubscriptionSourceUpdate {
  subId: string;
  chatId: number;
  promptMessageId: number;
}

interface NodeSelectionState {
  selectedIds: string[];
}

type ShortSubscription =
  | (ShortLinkBase & {
      kind?: "subscription";
      url: string;
      format: "base64" | "yaml" | "mihomo";
    })
  | (ShortLinkBase & {
      kind: "node";
      uri: string;
      format: "base64";
    })
  | (ShortLinkBase & {
      kind: "node-collection";
      format: "base64";
    })
  | (ShortLinkBase & {
      kind: "node-collection";
      format: "mihomo";
      base64ShortId?: string;
    })
  | (ShortLinkBase & {
      kind: "node-selection";
      nodeIds: string[];
      format: "mihomo";
    })
  | (ShortLinkBase & {
      kind: "saved-subscription";
      subId: string;
      format: "mihomo";
    });

interface TelegramMessageEntity {
  type: "blockquote" | "code" | "url";
  offset: number;
  length: number;
}

interface FormattedText {
  text: string;
  entities: TelegramMessageEntity[];
}

interface CallbackAction {
  name: string;
  cacheId?: string;
  subId?: string;
  page?: number;
}

interface NodeSelectionPage {
  items: SavedSubscriptionItem[];
  page: number;
  totalPages: number;
}

interface WebRequestBody {
  admin?: string;
  user_id?: string | number;
  url?: string;
  id?: string;
  token?: string;
  save?: boolean;
  refresh?: boolean;
}

interface InternalMonitorReportBody {
  probeId?: unknown;
  probeLabel?: unknown;
  version?: unknown;
  results?: unknown;
}

const CACHE_TTL_SECONDS = 60 * 30;
const SHORT_LINK_TTL_SECONDS = 60 * 60 * 24 * 30;
const REQUEST_TIMEOUT_MS = 8000;
const SAVED_PAGE_SIZE = 10;
const SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000;
const PREFERRED_UA = "clash-verge/v2.0.0";
const KOIPY_SUBSCRIPTION_UA_MARKER = "Koipy-MiaoSpeed/";
const AUTHORIZED_USERS_KEY = "authorized_users";
const WEB_ADMIN_NAME = "imzwr";
const PRIVATE_SUB_MENU_TEXT = "📦 我的订阅";
const MONITOR_DAILY_REPORT_CRON = "0 1 * * *";
const PENDING_SAVED_SOURCE_UPDATE_TTL_SECONDS = 60 * 10;
const NODE_SELECTION_TTL_SECONDS = 60 * 30;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/version") {
        return json({
          ok: true,
          commit: env.BUILD_COMMIT ?? "unknown",
          dirty: env.BUILD_DIRTY === "true",
          sourceHash: env.BUILD_SOURCE_HASH ?? "unknown",
          builtAt: env.BUILD_TIME ?? "unknown"
        });
      }

      if (request.method === "GET" && url.pathname === "/") {
        if ((request.headers.get("accept") ?? "").includes("text/html")) {
          return html(webAppHtml());
        }
        return json({ ok: true, message: "bot running" });
      }

      if (request.method === "GET" && url.pathname === "/admin") {
        return html(webAdminHtml());
      }

      if (request.method === "POST" && url.pathname === "/web/query") {
        return webQuerySubscription(request, env);
      }

      if (request.method === "POST" && url.pathname === "/web/admin/users") {
        return webAdminUsers(request, env);
      }

      if (request.method === "POST" && url.pathname === "/web/saved") {
        return webSavedSubscriptions(request, env);
      }

      if (request.method === "POST" && url.pathname === "/web/query-saved") {
        return webQuerySavedSubscription(request, env);
      }

      if (request.method === "POST" && url.pathname === "/web/delete-saved") {
        return webDeleteSavedSubscription(request, env);
      }

      if (request.method === "GET" && url.pathname === "/internal/monitor/jobs") {
        return internalMonitorJobs(request, env, url);
      }

      if (request.method === "GET" && url.pathname === "/internal/monitor/provider") {
        return internalMonitorProvider(request, env, url);
      }

      if (request.method === "POST" && url.pathname === "/internal/monitor/report") {
        return internalMonitorReport(request, env);
      }

      if (request.method === "POST" && url.pathname === "/internal/monitor/setup") {
        return internalMonitorSetup(request, env);
      }

      if (request.method === "GET" && url.pathname === "/internal/monitor/telegram-status") {
        return internalMonitorTelegramStatus(request, env);
      }

      if (request.method === "GET" && url.pathname === "/setup") {
        return setupWebhook(request, env, url);
      }

      if (request.method === "GET" && url.pathname === "/debug/subscription") {
        return debugSubscription(url, env);
      }

      if (request.method === "GET" && url.pathname.startsWith("/s/")) {
        return exportShortLink(url.pathname.slice(3), env, request.headers.get("user-agent") ?? "");
      }

      if (request.method === "GET" && url.pathname.startsWith("/m/")) {
        return exportShortLink(url.pathname.slice(3), env, request.headers.get("user-agent") ?? "");
      }

      if (request.method === "POST" && url.pathname === "/telegram/webhook") {
        const update = (await request.json()) as TelegramUpdate;
        await handleTelegramUpdate(update, request, env);
        return json({ ok: true });
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error("request failed", safeError(error));
      return json({ ok: false, error: safeError(error) }, 500);
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron !== MONITOR_DAILY_REPORT_CRON) return;

    try {
      await sendDailyMonitorReports(env);
    } catch (error) {
      console.error("daily monitor reports failed", safeError(error));
    }

    try {
      await cleanupMonitorHistory(env.MONITOR_DB);
    } catch (error) {
      console.error("monitor cleanup failed", safeError(error));
    }
  }
};

async function setupWebhook(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.SETUP_TOKEN || url.searchParams.get("token") !== env.SETUP_TOKEN) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const webhookUrl = `${new URL(request.url).origin}/telegram/webhook`;
  const result = await telegramApi(env, "setWebhook", {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query"]
  });
  const commands = await setupBotCommands(env);
  return json({
    ok: result.ok === true && commands.defaultCommands,
    webhook: webhookUrl,
    commands,
    description: result.description ?? ""
  });
}

async function setupBotCommands(env: Env): Promise<{ defaultCommands: boolean; adminCommandChats: string[] }> {
  const defaultResult = await telegramApi(env, "setMyCommands", {
    commands: botCommands()
  });

  const adminCommandChats: string[] = [];
  for (const adminUserId of parseUserIdList(env.ADMIN_USER_IDS)) {
    await telegramApi(env, "setMyCommands", {
      commands: adminBotCommands(),
      scope: { type: "chat", chat_id: adminUserId }
    });
    adminCommandChats.push(adminUserId);
  }

  return { defaultCommands: defaultResult.ok === true, adminCommandChats };
}

function botCommands(): Array<{ command: string; description: string }> {
  return [
    { command: "whoami", description: "查看自己的 Telegram user id" },
    { command: "query", description: "查询订阅或批量添加节点" },
    { command: "sub", description: "管理订阅与节点合集" },
    { command: "monitor", description: "选择机场并管理稳定性监测" },
    { command: "monitorreport", description: "查看已开启机场的稳定性汇总" },
    { command: "help", description: "查看帮助" }
  ];
}

function adminBotCommands(): Array<{ command: string; description: string }> {
  return [
    ...botCommands(),
    { command: "users", description: "查看授权用户列表" },
    { command: "allow", description: "授权用户：/allow userId" },
    { command: "revoke", description: "取消授权：/revoke userId" }
  ];
}

async function webQuerySubscription(request: Request, env: Env): Promise<Response> {
  const body = await readWebRequestBody(request);
  const userId = await authorizeWebUser(request, body, env);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 403);

  const subUrl = typeof body.url === "string" ? extractHttpUrl(body.url) : null;
  if (!subUrl) return json({ ok: false, error: "missing url" }, 400);

  try {
    const result = await fetchAndParseSubscription(subUrl, env);
    const cached: CachedSubscription = { url: subUrl, updatedAt: new Date().toISOString(), ...result };
    const saved = body.save === false ? null : await saveSubscription(env, userId, cached);
    return json({
      ok: true,
      result: webSubscriptionSummary(result),
      saved: saved ? webSavedSubscriptionItem(saved) : null,
      subscriptions: webSavedSubscriptionItems(await getSavedSubscriptions(env, userId))
    });
  } catch (error) {
    return json({ ok: false, error: safeError(error) }, 502);
  }
}

async function webAdminUsers(request: Request, env: Env): Promise<Response> {
  const body = await readWebRequestBody(request);
  if (!authorizeWebAdmin(request, body, env)) return json({ ok: false, error: "unauthorized" }, 403);

  const admins = parseUserIdList(env.ADMIN_USER_IDS);
  const envAllowed = parseUserIdList(env.ALLOWED_USER_IDS);
  const kvAllowed = await getKvAuthorizedUserIds(env);
  const savedUserIds = await listSavedSubscriptionUserIds(env);
  const userIds = sortUserIds(new Set([...admins, ...envAllowed, ...kvAllowed, ...savedUserIds]));
  const users = [];

  for (const userId of userIds) {
    const subscriptions = await getSavedSubscriptions(env, Number(userId));
    const labels = [];
    if (admins.has(userId)) labels.push("admin");
    if (envAllowed.has(userId)) labels.push("env allowlist");
    if (kvAllowed.has(userId)) labels.push("kv user");
    if (savedUserIds.has(userId)) labels.push("saved");
    users.push({
      userId,
      labels,
      subscriptionCount: subscriptions.length,
      subscriptions: subscriptions.map(webAdminSavedSubscriptionItem)
    });
  }

  return json({ ok: true, users });
}

async function webSavedSubscriptions(request: Request, env: Env): Promise<Response> {
  const body = await readWebRequestBody(request);
  const userId = await authorizeWebUser(request, body, env);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 403);

  return json({
    ok: true,
    subscriptions: webSavedSubscriptionItems(await getSavedSubscriptions(env, userId))
  });
}

async function webQuerySavedSubscription(request: Request, env: Env): Promise<Response> {
  const body = await readWebRequestBody(request);
  const userId = await authorizeWebUser(request, body, env);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 403);
  if (!isValidSubscriptionId(body.id)) return json({ ok: false, error: "missing id" }, 400);

  const subscriptions = await getSavedSubscriptions(env, userId);
  const item = subscriptions.find((subscription) => subscription.id === body.id);
  if (!item) return json({ ok: false, error: "not found" }, 404);

  if (savedItemKind(item) === "node") {
    await touchSavedSubscriptionLastQueryAt(env, userId, item.id);
    return json({
      ok: true,
      node: webNodeSummary(item.url),
      subscriptions: webSavedSubscriptionItems(await getSavedSubscriptions(env, userId))
    });
  }

  if (body.refresh === true) {
    try {
      const result = await fetchAndParseSubscription(item.url, env);
      if (result.nodes.length === 0) throw new Error("订阅未解析出节点，已保留旧快照");
      const cached: CachedSubscription = { url: item.url, updatedAt: new Date().toISOString(), ...result };
      await saveSubscription(env, userId, cached);
      return json({ ok: true, result: webSubscriptionSummary(cached), saved: webSavedSubscriptionItem(item), subscriptions: webSavedSubscriptionItems(await getSavedSubscriptions(env, userId)) });
    } catch (error) {
      item.lastRefreshAttemptAt = new Date().toISOString();
      item.lastRefreshError = safeError(error);
      await putSavedSubscriptions(env, userId, subscriptions);
      return json({ ok: false, error: `${item.lastRefreshError}；已保留旧快照` }, 502);
    }
  }

  const snapshot = await getSavedSubscriptionSnapshot(env, userId, item.id);
  if (!snapshot) return json({ ok: false, error: "该订阅尚无本地快照，请手动刷新后再查看" }, 409);
  await touchSavedSubscriptionLastQueryAt(env, userId, item.id);
  return json({
    ok: true,
    result: webSubscriptionSummary(snapshot),
    saved: webSavedSubscriptionItem(item),
    subscriptions: webSavedSubscriptionItems(await getSavedSubscriptions(env, userId))
  });

  /*
  try {
    const result = await fetchAndParseSubscription(item.url, env);
    await touchSavedSubscriptionLastQueryAt(env, userId, item.id);
    return json({
      ok: true,
      result: webSubscriptionSummary(result),
      saved: webSavedSubscriptionItem(item),
      subscriptions: webSavedSubscriptionItems(await getSavedSubscriptions(env, userId))
    });
  } catch (error) {
    return json({ ok: false, error: safeError(error) }, 502);
  }
}

*/
}

async function webDeleteSavedSubscription(request: Request, env: Env): Promise<Response> {
  const body = await readWebRequestBody(request);
  const userId = await authorizeWebUser(request, body, env);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 403);
  if (!isValidSubscriptionId(body.id)) return json({ ok: false, error: "missing id" }, 400);

  const subscriptions = await getSavedSubscriptions(env, userId);
  const nextSubscriptions = subscriptions.filter((subscription) => subscription.id !== body.id);
  await putSavedSubscriptions(env, userId, nextSubscriptions);
  const removed = subscriptions.find((subscription) => subscription.id === body.id);
  if (removed && savedItemKind(removed) === "subscription") {
    await revokeSavedSubscriptionMihomoLink(env, userId, body.id);
  }
  try {
    await deleteMonitorData(env.MONITOR_DB, userId, body.id);
  } catch (error) {
    console.error("failed to delete monitor data", safeError(error));
  }
  return json({ ok: true, subscriptions: webSavedSubscriptionItems(nextSubscriptions) });
}

async function internalMonitorJobs(request: Request, env: Env, url: URL): Promise<Response> {
  if (!authorizeMonitor(request, env)) return json({ ok: false, error: "unauthorized" }, 403);
  const probeId = cleanMonitorIdentifier(url.searchParams.get("probe_id"), "probe");
  const label = cleanMonitorLabel(url.searchParams.get("label"), probeId);
  const version = cleanMonitorIdentifier(url.searchParams.get("version"), "unknown");
  await touchMonitorProbe(env.MONITOR_DB, probeId, label, version);
  return json({ ok: true, intervalSeconds: 600, targets: await listEnabledMonitorTargets(env.MONITOR_DB) });
}

async function internalMonitorProvider(request: Request, env: Env, url: URL): Promise<Response> {
  if (!authorizeMonitor(request, env)) return json({ ok: false, error: "unauthorized" }, 403);
  const userId = normalizeUserId(url.searchParams.get("user_id") ?? "");
  const subId = url.searchParams.get("sub_id") ?? "";
  if (!userId || !isValidSubscriptionId(subId)) return json({ ok: false, error: "invalid target" }, 400);
  if (!(await isMonitorTargetEnabled(env.MONITOR_DB, userId, subId))) return json({ ok: false, error: "target disabled" }, 404);

  const numericUserId = Number(userId);
  const subscriptions = await getSavedSubscriptions(env, numericUserId);
  const item = subscriptions.find((entry) => entry.id === subId && savedItemKind(entry) === "subscription");
  if (!item) return json({ ok: false, error: "target not found" }, 404);

  try {
    const result = await fetchAndParseSubscription(item.url, env);
    if (getUsableNodes(result.nodes).length === 0) throw new Error("subscription has no usable nodes");
    return monitorProviderResponse(result.raw, true, result.sourceType);
  } catch (error) {
    const snapshot = await getSavedSubscriptionSnapshot(env, numericUserId, subId);
    if (snapshot?.raw && getUsableNodes(snapshot.nodes).length > 0) {
      return monitorProviderResponse(snapshot.raw, false, snapshot.sourceType);
    }
    console.error("monitor provider unavailable", safeError(error));
    return json({ ok: false, error: "subscription unavailable and no usable snapshot" }, 502);
  }
}

async function internalMonitorReport(request: Request, env: Env): Promise<Response> {
  if (!authorizeMonitor(request, env)) return json({ ok: false, error: "unauthorized" }, 403);
  let body: InternalMonitorReportBody;
  try {
    body = (await request.json()) as InternalMonitorReportBody;
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }
  const probeId = cleanMonitorIdentifier(body.probeId, "probe");
  const probeLabel = cleanMonitorLabel(body.probeLabel, probeId);
  const version = cleanMonitorIdentifier(body.version, "unknown");
  if (!Array.isArray(body.results) || body.results.length === 0 || body.results.length > 100) {
    return json({ ok: false, error: "invalid results" }, 400);
  }
  const reports = body.results.map(normalizeMonitorReport).filter((value): value is MonitorReportInput => value !== null);
  if (reports.length !== body.results.length) return json({ ok: false, error: "invalid report" }, 400);

  await touchMonitorProbe(env.MONITOR_DB, probeId, probeLabel, version);
  const result = await recordMonitorReports(env.MONITOR_DB, probeId, reports);
  for (const alert of result.alerts) {
    try {
      const subscriptions = await getSavedSubscriptions(env, Number(alert.userId));
      const item = subscriptions.find((entry) => entry.id === alert.subId);
      const name = item ? savedItemDisplayName(item) : "已删除的机场订阅";
      const text = alert.kind === "offline"
        ? `🔴 机场掉线提醒\n${name}\n\n海创探针已连续两次未发现可用节点。\n检测时间：${formatIsoDateTime(new Date(alert.checkedAt).toISOString())}`
        : `🟢 机场恢复提醒\n${name}\n\n海创探针已连续两次检测正常，当前在线 ${alert.onlineNodes}/${alert.totalNodes} 个节点。\n检测时间：${formatIsoDateTime(new Date(alert.checkedAt).toISOString())}`;
      await sendMessage(env, Number(alert.userId), text, { inline_keyboard: [[{ text: "查看监测详情", callback_data: `monitor_item:${alert.subId}` }]] });
    } catch (error) {
      console.error("failed to send monitor alert", safeError(error));
    }
  }
  return json({ ok: true, stored: result.stored, alerts: result.alerts.length });
}

async function internalMonitorSetup(request: Request, env: Env): Promise<Response> {
  if (!authorizeMonitor(request, env)) return json({ ok: false, error: "unauthorized" }, 403);
  return json({ ok: true, commands: await setupBotCommands(env) });
}

async function internalMonitorTelegramStatus(request: Request, env: Env): Promise<Response> {
  if (!authorizeMonitor(request, env)) return json({ ok: false, error: "unauthorized" }, 403);
  const [webhook, commands] = await Promise.all([
    telegramApi(env, "getWebhookInfo", {}),
    telegramApi(env, "getMyCommands", {})
  ]);
  const webhookInfo = webhook.result ?? {};
  return json({
    ok: true,
    webhook: {
      url: typeof webhookInfo.url === "string" ? webhookInfo.url : "",
      pendingUpdateCount: Number(webhookInfo.pending_update_count ?? 0),
      lastErrorMessage: typeof webhookInfo.last_error_message === "string" ? webhookInfo.last_error_message : null,
      allowedUpdates: Array.isArray(webhookInfo.allowed_updates) ? webhookInfo.allowed_updates : []
    },
    commands: commands.result ?? []
  });
}

function authorizeMonitor(request: Request, env: Env): boolean {
  if (!env.MONITOR_TOKEN) return false;
  return request.headers.get("authorization") === `Bearer ${env.MONITOR_TOKEN}`;
}

function monitorProviderResponse(raw: string, fetchOk: boolean, sourceType: ParsedSubscription["sourceType"]): Response {
  return new Response(raw, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Monitor-Subscription-Fetch": fetchOk ? "ok" : "fallback",
      "X-Monitor-Source-Type": sourceType
    }
  });
}

function cleanMonitorIdentifier(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._-]{1,40}$/.test(text) ? text : fallback;
}

function cleanMonitorLabel(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? cleanDisplayText(value).slice(0, 40) : "";
  return text || fallback;
}

function normalizeMonitorReport(value: unknown): MonitorReportInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const userId = normalizeUserId(input.userId as string | number);
  const subId = typeof input.subId === "string" ? input.subId : "";
  const totalNodes = Number(input.totalNodes);
  const onlineNodes = Number(input.onlineNodes);
  const checkedAt = Number(input.checkedAt);
  const delayValue = input.medianDelayMs === null || input.medianDelayMs === undefined ? null : Number(input.medianDelayMs);
  const errorCode = typeof input.errorCode === "string" && /^[a-z0-9_-]{1,60}$/i.test(input.errorCode) ? input.errorCode : null;
  if (
    !userId || !isValidSubscriptionId(subId) ||
    !Number.isInteger(totalNodes) || totalNodes < 0 || totalNodes > 500 ||
    !Number.isInteger(onlineNodes) || onlineNodes < 0 || onlineNodes > totalNodes ||
    typeof input.subscriptionFetchOk !== "boolean" ||
    (delayValue !== null && (!Number.isInteger(delayValue) || delayValue < 0 || delayValue > 65535))
  ) return null;
  return {
    userId,
    subId,
    checkedAt: Number.isFinite(checkedAt) ? checkedAt : undefined,
    totalNodes,
    onlineNodes,
    medianDelayMs: delayValue,
    subscriptionFetchOk: input.subscriptionFetchOk,
    errorCode
  };
}

async function readWebRequestBody(request: Request): Promise<WebRequestBody> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body as WebRequestBody : {};
  } catch {
    return {};
  }
}

async function authorizeWebUser(request: Request, body: WebRequestBody, env: Env): Promise<number | null> {
  if (env.WEB_TOKEN) {
    const token = request.headers.get("x-web-token") || (typeof body.token === "string" ? body.token : "");
    if (token !== env.WEB_TOKEN) return null;
  }

  const userId = normalizeUserId(body.user_id ?? "");
  if (!userId) return null;
  const numericUserId = Number(userId);
  return await isAllowedUser(numericUserId, env) ? numericUserId : null;
}

function authorizeWebAdmin(request: Request, body: WebRequestBody, env: Env): boolean {
  if (!env.WEB_TOKEN) return false;
  const token = request.headers.get("x-web-token") || (typeof body.token === "string" ? body.token : "");
  if (token !== env.WEB_TOKEN) return false;
  return typeof body.admin === "string" && body.admin.trim() === WEB_ADMIN_NAME;
}

function isValidSubscriptionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{12}$/i.test(value);
}

function webSavedSubscriptionItems(subscriptions: SavedSubscriptionItem[]) {
  return subscriptions.map(webSavedSubscriptionItem);
}

function webSavedSubscriptionItem(item: SavedSubscriptionItem) {
  return {
    id: item.id,
    kind: savedItemKind(item),
    name: savedItemDisplayName(item),
    customName: item.customName,
    airportName: item.airportName,
    updatedAt: item.updatedAt,
    lastQueryAt: item.lastQueryAt,
    snapshotUpdatedAt: item.snapshotUpdatedAt,
    snapshotNodeCount: item.snapshotNodeCount,
    lastRefreshAttemptAt: item.lastRefreshAttemptAt,
    lastRefreshError: item.lastRefreshError
  };
}

function webAdminSavedSubscriptionItem(item: SavedSubscriptionItem) {
  return {
    ...webSavedSubscriptionItem(item),
    createdAt: item.createdAt,
    url: item.url
  };
}

async function listSavedSubscriptionUserIds(env: Env): Promise<Set<string>> {
  const userIds = new Set<string>();
  let cursor: string | undefined;

  do {
    const options: KVNamespaceListOptions = { prefix: "user:" };
    if (cursor) options.cursor = cursor;
    const result = await env.SUB_KV.list(options);
    for (const key of result.keys) {
      const match = key.name.match(/^user:(\d+):subscriptions?$/);
      if (match) userIds.add(match[1]);
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  return userIds;
}

function webSubscriptionSummary(result: ParsedSubscription) {
  const usableNodes = getUsableNodes(result.nodes);
  const used = result.userInfo ? result.userInfo.upload + result.userInfo.download : 0;
  return {
    airportName: result.airportName,
    sourceType: result.sourceType,
    traffic: result.userInfo ? {
      used: formatBytes(used),
      total: result.userInfo.total > 0 ? formatBytes(result.userInfo.total) : "未知",
      remaining: result.userInfo.total > 0 ? formatBytes(Math.max(result.userInfo.total - used, 0)) : "未知",
      expireDate: result.userInfo.expire ? formatDate(result.userInfo.expire) : "长期有效",
      expireIn: formatExpireMinutes(result.userInfo.expire),
      reset: formatResetInfoLine(result.userInfo).replace(/^🔄\s*/, "")
    } : null,
    nodes: {
      total: result.nodes.length,
      usable: usableNodes.length,
      protocols: formatCounts(countBy(usableNodes.map((node) => node.protocol))) || "未知",
      regions: formatRegionCounts(countBy(usableNodes.map((node) => node.region))) || "未知"
    }
  };
}

function webNodeSummary(uri: string) {
  const node = parseNodeLines([uri])[0];
  if (!node) return { ok: false, error: "节点解析失败" };
  return {
    ok: true,
    name: node.name,
    protocol: node.protocol,
    region: node.region
  };
}

async function debugSubscription(url: URL, env: Env): Promise<Response> {
  if (!env.DEBUG_TOKEN || url.searchParams.get("token") !== env.DEBUG_TOKEN) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const userId = Number(url.searchParams.get("user_id") ?? "");
  const targetUrl = url.searchParams.get("url");
  if (!userId || !(await isAllowedUser(userId, env))) {
    return json({ ok: false, error: "unauthorized" }, 403);
  }
  if (!targetUrl) {
    return json({ ok: false, error: "missing url" }, 400);
  }

  const result = await fetchAndParseSubscription(targetUrl, env);
  const usableNodes = getUsableNodes(result.nodes);
  return json({
    ok: true,
    sourceType: result.sourceType,
    hasUserInfo: result.userInfo !== null,
    userInfo: result.userInfo,
    nodes: result.nodes.length,
    usableNodes: usableNodes.length,
    protocols: Object.fromEntries(countBy(usableNodes.map((node) => node.protocol))),
    regions: Object.fromEntries(countBy(usableNodes.map((node) => node.region)))
  });
}

async function handleTelegramUpdate(update: TelegramUpdate, request: Request, env: Env): Promise<void> {
  if (update.message) {
    await handleMessage(update.message, request, env);
  } else if (update.callback_query) {
    await handleCallback(update.callback_query, request, env);
  }
}

async function handleMessage(message: TelegramMessage, request: Request, env: Env): Promise<void> {
  const userId = message.from?.id;
  const rawText = (message.text ?? "").trim();
  const text = message.chat.type === "private" && rawText === PRIVATE_SUB_MENU_TEXT ? "/sub" : rawText;
  const command = text.split(/\s+/)[0]?.replace(/@[A-Za-z0-9_]+$/, "") ?? "";

  if (command === "/whoami") {
    if (!userId) {
      await sendMessage(env, message.chat.id, "无法识别你的 Telegram user id。");
      return;
    }
    await sendMessage(env, message.chat.id, `你的 Telegram user id 是：${userId}\n请把这个 ID 发给管理员授权。`);
    return;
  }

  if (!userId || !(await isAllowedUser(userId, env))) {
    await sendMessage(env, message.chat.id, "未授权，请联系管理员授权");
    return;
  }

  if (await replaceSavedSubscriptionSourceFromReply(message, userId, env)) {
    return;
  }

  if (await renameSavedItemFromReply(message, userId, env)) {
    return;
  }

  if (command === "/users") {
    if (!isAdminUser(userId, env)) {
      await sendMessage(env, message.chat.id, "只有管理员可以查看授权用户列表。");
      return;
    }
    await sendMessage(env, message.chat.id, await formatAuthorizedUsersMessage(env));
    return;
  }

  if (command === "/allow") {
    if (!isAdminUser(userId, env)) {
      await sendMessage(env, message.chat.id, "只有管理员可以授权用户。");
      return;
    }
    await handleAllowCommand(message, env, text);
    return;
  }

  if (command === "/revoke") {
    if (!isAdminUser(userId, env)) {
      await sendMessage(env, message.chat.id, "只有管理员可以取消授权用户。");
      return;
    }
    await handleRevokeCommand(message, env, text);
    return;
  }

  if (command === "/start" || command === "/help") {
    await sendMessage(env, message.chat.id, helpTextV2(), mainKeyboardV2());
    if (message.chat.type === "private") {
      await sendMessage(env, message.chat.id, "底部快捷菜单已开启。", privateSubMenuKeyboard());
    }
    return;
  }

  if (command === "/sub") {
    await sendSubscriptionList(env, message.chat.id, userId);
    return;
  }

  if (command === "/monitor") {
    await sendMonitorList(env, message.chat.id, userId);
    return;
  }

  if (command === "/monitorreport") {
    await sendMonitorReport(env, message.chat.id, userId);
    return;
  }

  if (command === "/query" && !extractQueryInput(text)) {
    await sendMessage(env, message.chat.id, "用法：/query <订阅链接或节点链接>");
    return;
  }

  if (command === "/json") {
    await exportDebugJsonForReply(message, userId, env);
    return;
  }

  const input = extractQueryInput(text);
  if (!input) {
    await sendMessage(env, message.chat.id, "请发送订阅链接或节点链接，或发送 /help 查看用法。");
    return;
  }

  if (input.kind === "node") {
    await sendNodeResult(input.uri, userId, message.chat.id, env, message.message_id);
    return;
  }

  if (input.kind === "nodes") {
    await sendNodeBundleResult(input.uris, userId, message.chat.id, env, message.message_id);
    return;
  }

  await queryAndSend(input.url, userId, message.chat.id, env, message.message_id);
}

async function handleCallback(callback: TelegramCallbackQuery, request: Request, env: Env): Promise<void> {
  const userId = callback.from.id;
  const chatId = callback.message?.chat.id;
  const data = callback.data ?? "";
  const action = parseCallbackAction(data);
  const callbackStatus = callbackStatusText(action.name);
  await telegramApi(env, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text: callbackStatus
  });

  if (!chatId) {
    return;
  }

  if (!(await isAllowedUser(userId, env))) {
    await sendMessage(env, chatId, "未授权，请联系管理员授权");
    return;
  }

  if (action.name === "cancel") {
    const saved = await getSavedSubscriptions(env, userId);
    await editCallbackMessage(env, callback, formatSubscriptionListText(saved), subscriptionListKeyboard(saved));
    return;
  }

  if (action.name === "saved_page") {
    const saved = await getSavedSubscriptions(env, userId);
    await editCallbackMessage(env, callback, formatSubscriptionListText(saved, action.page), subscriptionListKeyboard(saved, action.page));
    return;
  }

  if (["monitor_list", "monitor_back", "monitor_page"].includes(action.name)) {
    await showMonitorList(callback, userId, env, action.page);
    return;
  }

  if (action.name === "monitor_item" && action.subId) {
    await showMonitorTarget(action.subId, callback, userId, env);
    return;
  }

  if (["monitor_enable", "monitor_pause"].includes(action.name) && action.subId) {
    await updateMonitorTarget(action.subId, action.name === "monitor_enable", callback, userId, env);
    return;
  }

  if (["manage_nodes", "nodes_page"].includes(action.name)) {
    const saved = await getSavedSubscriptions(env, userId);
    await editCallbackMessage(env, callback, formatNodeCollectionListText(saved, action.page), nodeCollectionListKeyboard(saved, action.page));
    return;
  }

  if (action.name === "rename_saved" && action.subId) {
    await promptRenameSavedItem(action.subId, userId, chatId, env);
    return;
  }

  if (action.name === "replace_saved_source" && action.subId) {
    await promptReplaceSavedSubscriptionSource(action.subId, userId, callback, env);
    return;
  }

  if (action.name === "export_saved_mihomo" && action.subId) {
    await exportSavedSubscriptionMihomo(action.subId, userId, callback, request, env);
    return;
  }

  if (action.name === "reset_saved_mihomo" && action.subId) {
    await resetSavedSubscriptionMihomo(action.subId, userId, callback, request, env);
    return;
  }

  if (action.name === "confirm_clear_nodes") {
    await confirmClearNodeCollection(userId, callback, env);
    return;
  }

  if (action.name === "clear_nodes") {
    await clearNodeCollection(userId, callback, env);
    return;
  }

  if (action.name === "query_saved" && action.subId) {
    await querySavedSubscription(action.subId, userId, callback, env);
    return;
  }

  if (action.name === "refresh_saved" && action.subId) {
    await refreshSavedSubscription(action.subId, userId, callback, env);
    return;
  }

  if (["nodes_saved", "collapse_nodes_saved"].includes(action.name) && action.subId) {
    await showSavedSubscriptionSnapshot(action.subId, userId, callback, env, action.name === "nodes_saved");
    return;
  }

  if (action.name === "delete_saved" && action.subId) {
    await confirmDeleteSavedSubscription(action.subId, userId, callback, env);
    return;
  }

  if (action.name === "confirm_delete_saved" && action.subId) {
    await deleteSavedSubscriptionFromCallback(action.subId, userId, callback, env);
    return;
  }

  if (action.name === "save_node") {
    const cachedNode = await getCachedNode(env, userId, action.cacheId);
    if (!cachedNode) {
      await sendMessage(env, chatId, "节点缓存已过期，请重新发送节点链接。");
      return;
    }
    const saved = await saveNode(env, userId, cachedNode);
    const nodeCount = await getSavedNodeCount(env, userId);
    await sendMessage(
      env,
      chatId,
      `已加入节点合集：${savedItemDisplayName(saved)}\n当前合集共 ${nodeCount} 个节点。`,
      nodeCollectionKeyboard(nodeCount, true)
    );
    return;
  }

  if (action.name === "save_nodes") {
    const cachedBundle = await getCachedNodeBundle(env, userId, action.cacheId);
    if (!cachedBundle) {
      await sendMessage(env, chatId, "节点批量缓存已过期，请重新发送节点链接。");
      return;
    }
    const result = await saveNodes(env, userId, cachedBundle.nodes);
    await sendMessage(
      env,
      chatId,
      `节点合集已更新：新增 ${result.added} 个，当前共 ${result.total} 个节点。`,
      nodeCollectionKeyboard(result.total, true)
    );
    return;
  }

  if (action.name === "select_nodes") {
    await startNodeSelection(userId, callback, env);
    return;
  }

  if (action.name === "toggle_node" && action.subId) {
    await toggleSelectedNode(action.subId, userId, callback, env);
    return;
  }

  if (action.name === "node_selection_page") {
    await showNodeSelection(userId, callback, env, action.page);
    return;
  }

  if (["select_nodes_all", "select_nodes_none"].includes(action.name)) {
    await setSelectedNodes(userId, callback, env, action.name === "select_nodes_all");
    return;
  }

  if (action.name === "export_selected_nodes") {
    await exportSelectedNodeCollection(userId, chatId, callback, request, env);
    return;
  }

  if (action.name === "node_selection_cancel") {
    await env.SUB_KV.delete(nodeSelectionKey(userId));
    const saved = await getSavedSubscriptions(env, userId);
    await editCallbackMessage(env, callback, formatNodeCollectionListText(saved), nodeCollectionListKeyboard(saved));
    return;
  }

  if (["export_node_collection", "merge_nodes", "mihomo_nodes"].includes(action.name)) {
    const uris = await getSavedNodeUris(env, userId);
    if (uris.length === 0) {
      await sendMessage(env, chatId, "节点合集还是空的，请先发送节点链接并加入合集。");
      return;
    }
    try {
      const origin = new URL(request.url).origin;
      const generated = generateClashNodeSubscription(uris);
      const body = generateMihomoSubscription(generated.yaml);
      const mihomoShortId = await createNodeCollectionShortLink(env, userId);
      const validDays = Math.floor(SHORT_LINK_TTL_SECONDS / (60 * 60 * 24));
      const skipped = generated.skippedCount > 0
        ? `\n\n未导出 ${generated.skippedCount} 个暂不支持的节点：${generated.skippedProtocols.join("、")}`
        : "";
      await sendTextDocument(env, chatId, "node-collection-Mihomo.yaml", body, `节点合集 Mihomo 配置已生成（${generated.exportedCount} 个节点）`);
      await sendMessage(
        env,
        chatId,
        `节点合集 Mihomo 订阅已生成（${generated.exportedCount} 个节点，${validDays} 天有效）：\n${origin}/m/${mihomoShortId}${skipped}\n\n合集节点变动后会自动更新。链接内含节点凭据，请勿公开分享。`
      );
    } catch (error) {
      await sendMessage(env, chatId, mihomoExportErrorMessage(error));
    }
    return;
  }

  const cached = await getCachedSubscription(env, userId, action.cacheId);
  if (!cached && !["refresh", "nodes", "collapse_nodes"].includes(action.name)) {
    await sendMessage(env, chatId, "缓存已过期，请重新发送订阅链接或使用 /sub。");
    return;
  }

  const cachedUrl = await getCachedSubscriptionUrl(env, userId, action.cacheId);

  if (action.name === "refresh") {
    const saved = await getSavedSubscriptions(env, userId);
    const subUrl = cached?.url ?? cachedUrl ?? (saved.length === 1 ? saved[0].url : undefined);
    if (!subUrl) {
      await editCallbackMessage(env, callback, formatSubscriptionListText(saved), subscriptionListKeyboard(saved));
      return;
    }
    await queryAndEdit(subUrl, userId, callback, env, action.cacheId);
    return;
  }

  if (action.name === "nodes") {
    if (cached) {
      await editCallbackMessage(env, callback, formatSubscriptionWithNodesMessage(cached), actionKeyboard(true, action.cacheId));
      return;
    }
    const subUrl = cachedUrl;
    if (!subUrl) {
      await sendMessage(env, chatId, "缓存已过期，请重新发送订阅链接或使用 /sub。");
      return;
    }
    await queryAndEdit(subUrl, userId, callback, env, action.cacheId, true);
    return;
  }

  if (action.name === "collapse_nodes") {
    if (cached) {
      await editCallbackMessage(env, callback, formatSubscriptionMessage(cached, cached.url), actionKeyboard(false, action.cacheId));
      return;
    }
    const subUrl = cachedUrl;
    if (!subUrl) {
      await sendMessage(env, chatId, "缓存已过期，请重新发送订阅链接或使用 /sub。");
      return;
    }
    await queryAndEdit(subUrl, userId, callback, env, action.cacheId, false);
    return;
  }

  if (action.name === "export_yaml" && cached) {
    await sendTextDocument(env, chatId, rawSubscriptionFilename(cached), cached.raw.trim(), "原始订阅文件已生成");
    return;
  }

  if (["export_mihomo", "short_mihomo"].includes(action.name) && cached) {
    try {
      const body = generateMihomoSubscription(cached.raw);
      const shortId = await createShortLink(env, userId, cached.url, "mihomo");
      const origin = new URL(request.url).origin;
      await sendTextDocument(env, chatId, mihomoSubscriptionFilename(cached), body, "Mihomo 配置已生成");
      await editCallbackMessage(
        env,
        callback,
        `Mihomo 配置与临时订阅链接已生成（30 天有效）：\n${origin}/m/${shortId}\n\n保存订阅后可生成不会自动过期的长期地址。`,
        actionKeyboard(false, action.cacheId)
      );
    } catch (error) {
      await sendMessage(env, chatId, mihomoExportErrorMessage(error));
    }
    return;
  }

  if (action.name === "save" && cached) {
    const saved = await saveSubscription(env, userId, cached);
    await sendMessage(env, chatId, `已保存订阅：${savedItemDisplayName(saved)}\n以后发送 /sub 可以查看自己的订阅列表。`);
    return;
  }

  await sendMessage(env, chatId, "暂不支持这个操作。");
}

async function startNodeSelection(userId: number, callback: TelegramCallbackQuery, env: Env): Promise<void> {
  const items = savedNodeItems(await getSavedSubscriptions(env, userId));
  if (items.length === 0) {
    await editCallbackMessage(env, callback, "节点合集还是空的，请先发送节点链接并加入合集。", nodeCollectionListKeyboard([]));
    return;
  }
  await putNodeSelection(env, userId, items.map((item) => item.id));
  await showNodeSelection(userId, callback, env, 0);
}

async function toggleSelectedNode(subId: string, userId: number, callback: TelegramCallbackQuery, env: Env): Promise<void> {
  const items = savedNodeItems(await getSavedSubscriptions(env, userId));
  const state = await getNodeSelection(env, userId);
  if (!state || !items.some((item) => item.id === subId)) {
    await editCallbackMessage(env, callback, "节点选择已过期或节点已删除，请重新开始选择。", nodeCollectionListKeyboard(await getSavedSubscriptions(env, userId)));
    return;
  }
  const selected = new Set(state.selectedIds.filter((id) => items.some((item) => item.id === id)));
  if (selected.has(subId)) selected.delete(subId);
  else selected.add(subId);
  await putNodeSelection(env, userId, [...selected]);
  await showNodeSelection(userId, callback, env, nodeSelectionPageForItem(items, subId));
}

async function setSelectedNodes(userId: number, callback: TelegramCallbackQuery, env: Env, selectAll: boolean): Promise<void> {
  const items = savedNodeItems(await getSavedSubscriptions(env, userId));
  if (items.length === 0) {
    await editCallbackMessage(env, callback, "节点合集还是空的，请先发送节点链接并加入合集。", nodeCollectionListKeyboard([]));
    return;
  }
  await putNodeSelection(env, userId, selectAll ? items.map((item) => item.id) : []);
  await showNodeSelection(userId, callback, env, 0);
}

async function showNodeSelection(userId: number, callback: TelegramCallbackQuery, env: Env, requestedPage = 0): Promise<void> {
  const items = savedNodeItems(await getSavedSubscriptions(env, userId));
  const state = await getNodeSelection(env, userId);
  if (!state || items.length === 0) {
    await editCallbackMessage(env, callback, "节点选择已过期或节点合集为空，请重新开始选择。", nodeCollectionListKeyboard(await getSavedSubscriptions(env, userId)));
    return;
  }
  const selectedIds = new Set(state.selectedIds.filter((id) => items.some((item) => item.id === id)));
  const page = nodeSelectionPage(items, requestedPage);
  const lines = [`选择要生成订阅的节点：已选 ${selectedIds.size}/${items.length} 个（第 ${page.page + 1}/${page.totalPages} 页）`, "点击节点可勾选或取消；选择状态保留 30 分钟。"];
  for (const item of page.items) {
    const protocol = parseNodeLines([item.url])[0]?.protocol ?? "未知";
    lines.push(`${selectedIds.has(item.id) ? "✅" : "⬜"} ${savedItemDisplayName(item)}（${protocol}）`);
  }
  await editCallbackMessage(env, callback, lines.join("\n"), nodeSelectionKeyboard(page, selectedIds));
}

async function exportSelectedNodeCollection(userId: number, chatId: number, callback: TelegramCallbackQuery, request: Request, env: Env): Promise<void> {
  const items = savedNodeItems(await getSavedSubscriptions(env, userId));
  const state = await getNodeSelection(env, userId);
  if (!state || items.length === 0) {
    await editCallbackMessage(env, callback, "节点选择已过期或节点合集为空，请重新开始选择。", nodeCollectionListKeyboard(await getSavedSubscriptions(env, userId)));
    return;
  }
  const selectedIds = new Set(state.selectedIds);
  const selectedItems = items.filter((item) => selectedIds.has(item.id));
  if (selectedItems.length === 0) {
    await editCallbackMessage(env, callback, "还没有选择节点，请至少勾选一个节点后再生成。", nodeSelectionKeyboard(nodeSelectionPage(items, 0), selectedIds));
    return;
  }

  try {
    const generated = generateClashNodeSubscription(selectedItems.map((item) => item.url));
    const body = generateMihomoSubscription(generated.yaml);
    const mihomoShortId = await createSelectedNodeCollectionShortLink(env, userId, selectedItems.map((item) => item.id));
    const origin = new URL(request.url).origin;
    const validDays = Math.floor(SHORT_LINK_TTL_SECONDS / (60 * 60 * 24));
    const skipped = generated.skippedCount > 0
      ? `\n\n未导出 ${generated.skippedCount} 个暂不支持的节点：${generated.skippedProtocols.join("、")}`
      : "";
    await sendTextDocument(env, chatId, "selected-node-collection-Mihomo.yaml", body, `已选节点 Mihomo 配置已生成（${generated.exportedCount} 个节点）`);
    await sendMessage(
      env,
      chatId,
      `已选节点 Mihomo 订阅已生成（已选 ${selectedItems.length} 个，导出 ${generated.exportedCount} 个，${validDays} 天有效）：\n${origin}/m/${mihomoShortId}${skipped}\n\n所选节点被删除后会自动从该订阅中移除。链接内含节点凭据，请勿公开分享。`
    );
    await env.SUB_KV.delete(nodeSelectionKey(userId));
    await editCallbackMessage(env, callback, "已生成所选节点订阅。", nodeCollectionListKeyboard(await getSavedSubscriptions(env, userId)));
  } catch (error) {
    await editCallbackMessage(env, callback, mihomoExportErrorMessage(error), nodeSelectionKeyboard(nodeSelectionPage(items, 0), selectedIds));
  }
}

async function queryAndSend(subUrl: string, userId: number, chatId: number, env: Env, replyToMessageId?: number): Promise<void> {
  const loadingMessageId = await sendTemporaryStatus(env, chatId, "查询中...", replyToMessageId);
  try {
    const result = await fetchAndParseSubscription(subUrl, env);
    const cacheId = createCacheId();
    await cacheSubscription(env, userId, { url: subUrl, updatedAt: new Date().toISOString(), ...result }, cacheId);
    await sendFormattedMessage(env, chatId, formatSubscriptionMessage(result, subUrl), actionKeyboard(false, cacheId), replyToMessageId);
  } catch (error) {
    await sendMessage(env, chatId, `订阅查询失败：${safeError(error)}`, undefined, replyToMessageId);
  } finally {
    if (loadingMessageId) await deleteMessageSafely(env, chatId, loadingMessageId);
  }
}

async function sendNodeResult(uri: string, userId: number, chatId: number, env: Env, replyToMessageId?: number): Promise<void> {
  const node = parseNodeLines([uri])[0];
  if (!node) {
    await sendFormattedMessage(env, chatId, formatSingleNodeMessage(uri), undefined, replyToMessageId);
    return;
  }

  const cacheId = createCacheId();
  await cacheNode(env, userId, {
    uri,
    name: node.name,
    protocol: node.protocol,
    region: node.region,
    updatedAt: new Date().toISOString()
  }, cacheId);
  await sendFormattedMessage(env, chatId, formatSingleNodeMessage(uri), nodeActionKeyboard(cacheId), replyToMessageId);
}

async function sendNodeBundleResult(uris: string[], userId: number, chatId: number, env: Env, replyToMessageId?: number): Promise<void> {
  const parsedNodes = dedupeNodeUris(uris)
    .map((uri) => ({ uri, node: parseNodeLines([uri])[0] }))
    .filter((entry): entry is { uri: string; node: ParsedNode } => Boolean(entry.node));
  if (parsedNodes.length === 0) {
    await sendMessage(env, chatId, "未解析到可用节点链接。", undefined, replyToMessageId);
    return;
  }
  if (parsedNodes.length === 1) {
    await sendNodeResult(parsedNodes[0].uri, userId, chatId, env, replyToMessageId);
    return;
  }

  const cacheId = createCacheId();
  const updatedAt = new Date().toISOString();
  const bundle: CachedNodeBundle = {
    updatedAt,
    nodes: parsedNodes.map(({ uri, node }) => ({
      uri,
      name: node.name,
      protocol: node.protocol,
      region: node.region,
      updatedAt
    }))
  };
  await cacheNodeBundle(env, userId, bundle, cacheId);
  await sendMessage(env, chatId, formatNodeBundleMessage(bundle.nodes), nodeBundleKeyboard(cacheId), replyToMessageId);
}

function formatNodeBundleMessage(nodes: CachedNode[]): string {
  const lines = [`已识别 ${nodes.length} 个节点：`];
  for (const [index, node] of nodes.slice(0, 50).entries()) {
    lines.push(`${index + 1}. ${cleanDisplayText(node.name)} (${node.protocol})`);
  }
  if (nodes.length > 50) lines.push(`还有 ${nodes.length - 50} 个节点未显示。`);
  lines.push("", "点击下方按钮可一次全部加入你的节点合集。");
  return lines.join("\n");
}

async function queryAndEdit(subUrl: string, userId: number, callback: TelegramCallbackQuery, env: Env, existingCacheId?: string, nodesExpanded = false): Promise<void> {
  try {
    const result = await fetchAndParseSubscription(subUrl, env);
    const cacheId = existingCacheId ?? createCacheId();
    const cached = { url: subUrl, updatedAt: new Date().toISOString(), ...result };
    await cacheSubscription(env, userId, cached, cacheId);
    const message = nodesExpanded ? formatSubscriptionWithNodesMessage(cached) : formatSubscriptionMessage(result, subUrl);
    await editCallbackMessage(env, callback, message, actionKeyboard(nodesExpanded, cacheId));
  } catch (error) {
    await editCallbackMessage(env, callback, `订阅查询失败：${safeError(error)}`, actionKeyboard(nodesExpanded, existingCacheId));
  }
}

async function sendSubscriptionList(env: Env, chatId: number, userId: number, page = 0): Promise<void> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  await sendMessage(env, chatId, formatSubscriptionListText(subscriptions, page), subscriptionListKeyboard(subscriptions, page));
}

async function sendMonitorList(env: Env, chatId: number, userId: number, page = 0): Promise<void> {
  const [subscriptions, summaries] = await Promise.all([
    getSavedSubscriptions(env, userId),
    listMonitorSummaries(env.MONITOR_DB, userId)
  ]);
  await sendMessage(env, chatId, formatMonitorListText(subscriptions, summaries, page), monitorListKeyboard(subscriptions, summaries, page));
}

async function sendMonitorReport(env: Env, chatId: number, userId: number, title = "📊 机场稳定性报告"): Promise<void> {
  const [subscriptions, summaries] = await Promise.all([
    getSavedSubscriptions(env, userId),
    listMonitorSummaries(env.MONITOR_DB, userId)
  ]);
  const savedById = new Map(subscriptions.map((item) => [item.id, item]));
  const enabled = summaries.filter((summary) => summary.enabled);
  if (enabled.length === 0) {
    await sendMessage(env, chatId, "还没有开启稳定性监测的机场。请先发送 /monitor 选择机场并开启监测。");
    return;
  }

  const header = [
    title,
    "检测点：海创 VPS｜每10分钟一次",
    `生成时间：${formatIsoDateTime(new Date().toISOString())}`
  ].join("\n");
  const sections = enabled.map((summary) => formatMonitorReportSection(savedById.get(summary.subId), summary));
  const keyboard = { inline_keyboard: [[{ text: "📡 管理监测", callback_data: "monitor_list" }]] };
  let message = header;
  for (const section of sections) {
    const next = `${message}\n\n${section}`;
    if (next.length > 3800 && message !== header) {
      await sendMessage(env, chatId, message, keyboard);
      message = `${header}（续）\n\n${section}`;
    } else {
      message = next;
    }
  }
  await sendMessage(env, chatId, message, keyboard);
}

async function sendDailyMonitorReports(env: Env): Promise<void> {
  const userIds = await listEnabledMonitorUserIds(env.MONITOR_DB);
  for (const userKey of userIds) {
    const userId = Number(userKey);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      console.error("invalid monitor report user id");
      continue;
    }

    try {
      await sendMonitorReport(env, userId, userId, "📅 每日机场健康报告");
    } catch (error) {
      console.error("daily monitor report failed", safeError(error));
    }
  }
}

async function showMonitorList(callback: TelegramCallbackQuery, userId: number, env: Env, page = 0): Promise<void> {
  const [subscriptions, summaries] = await Promise.all([
    getSavedSubscriptions(env, userId),
    listMonitorSummaries(env.MONITOR_DB, userId)
  ]);
  await editCallbackMessage(env, callback, formatMonitorListText(subscriptions, summaries, page), monitorListKeyboard(subscriptions, summaries, page));
}

async function showMonitorTarget(subId: string, callback: TelegramCallbackQuery, userId: number, env: Env): Promise<void> {
  const [subscriptions, summaries] = await Promise.all([
    getSavedSubscriptions(env, userId),
    listMonitorSummaries(env.MONITOR_DB, userId)
  ]);
  const item = subscriptions.find((entry) => entry.id === subId && savedItemKind(entry) === "subscription");
  if (!item) {
    await editCallbackMessage(env, callback, "机场订阅不存在或已经删除。", monitorListKeyboard(subscriptions, summaries));
    return;
  }
  const summary = summaries.find((entry) => entry.subId === subId);
  await editCallbackMessage(env, callback, formatMonitorTargetText(item, summary), monitorTargetKeyboard(subId, summary?.enabled === true));
}

async function updateMonitorTarget(
  subId: string,
  enabled: boolean,
  callback: TelegramCallbackQuery,
  userId: number,
  env: Env
): Promise<void> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  const item = subscriptions.find((entry) => entry.id === subId && savedItemKind(entry) === "subscription");
  if (!item) {
    await editCallbackMessage(env, callback, "机场订阅不存在或已经删除。", { inline_keyboard: [[{ text: "⬅️ 返回监测列表", callback_data: "monitor_back" }]] });
    return;
  }
  await setMonitorEnabled(env.MONITOR_DB, userId, subId, enabled);
  const summaries = await listMonitorSummaries(env.MONITOR_DB, userId);
  const summary = summaries.find((entry) => entry.subId === subId);
  const prefix = enabled ? "已开启监测，海创探针将在10分钟内完成首轮检测。\n\n" : "已暂停监测，历史记录会保留30天。\n\n";
  await editCallbackMessage(env, callback, `${prefix}${formatMonitorTargetText(item, summary)}`, monitorTargetKeyboard(subId, enabled));
}

function formatMonitorListText(subscriptions: SavedSubscriptionItem[], summaries: MonitorSummary[], requestedPage = 0): string {
  const page = savedItemsPage(subscriptions, "subscription", requestedPage);
  if (page.total === 0) return "还没有保存的机场订阅。请先查询并保存订阅，再开启稳定性监测。";
  const summaryById = new Map(summaries.map((summary) => [summary.subId, summary]));
  const lines = [
    "📡 机场稳定性监测",
    "检测点：海创 VPS｜每10分钟一次",
    "请选择一个机场开启、暂停或查看监测。",
    "",
    `机场：${page.total} 个（第 ${page.page + 1}/${page.totalPages} 页）`
  ];
  for (const [index, item] of page.items.entries()) {
    const summary = summaryById.get(item.id);
    lines.push(`${page.page * SAVED_PAGE_SIZE + index + 1}. ${monitorStatusIcon(summary)} ${savedItemDisplayName(item)} — ${monitorListStatus(summary)}`);
  }
  return lines.join("\n");
}

function monitorListKeyboard(subscriptions: SavedSubscriptionItem[], summaries: MonitorSummary[], requestedPage = 0) {
  const page = savedItemsPage(subscriptions, "subscription", requestedPage);
  if (page.total === 0) return { inline_keyboard: [[{ text: "⬅️ 返回保存列表", callback_data: "cancel" }]] };
  const summaryById = new Map(summaries.map((summary) => [summary.subId, summary]));
  const rows: Array<Array<{ text: string; callback_data: string }>> = page.items.map((item) => [{
    text: `${monitorStatusIcon(summaryById.get(item.id))} ${savedItemDisplayName(item).slice(0, 30)}`,
    callback_data: `monitor_item:${item.id}`
  }]);
  const pagination = paginationRow("monitor_page", page.page, page.totalPages);
  if (pagination.length > 0) rows.push(pagination);
  rows.push([{ text: "⬅️ 返回保存列表", callback_data: "cancel" }]);
  return { inline_keyboard: rows };
}

function formatMonitorTargetText(item: SavedSubscriptionItem, summary?: MonitorSummary): string {
  const lines = [`📡 ${savedItemDisplayName(item)}`, "检测点：海创 VPS"];
  if (!summary?.enabled) {
    lines.push("", "状态：⚪ 尚未开启监测", "开启后每10分钟执行一次真实节点连通测试。", "不会进行下载测速，也不会覆盖手动保存的订阅快照。");
    return lines.join("\n");
  }

  const status = effectiveMonitorStatus(summary);
  lines.push(`状态：${monitorStatusIcon(summary)} ${monitorStatusLabel(status)}`);
  if (summary.totalNodes !== null && summary.onlineNodes !== null && !summary.stale) {
    const ratio = summary.totalNodes > 0 ? summary.onlineNodes / summary.totalNodes * 100 : 0;
    lines.push(`在线节点：${summary.onlineNodes}/${summary.totalNodes}（${ratio.toFixed(1)}%）`);
  }
  if (summary.medianDelayMs !== null && !summary.stale) lines.push(`在线节点中位延迟：${summary.medianDelayMs} ms`);
  if (summary.statusSince && !summary.stale && ["healthy", "degraded", "offline"].includes(status)) {
    const label = status === "healthy" ? "连续稳定" : status === "degraded" ? "异常持续" : "离线持续";
    lines.push(`${label}：${formatElapsedDuration(summary.statusSince)}`);
  }
  lines.push(
    `24小时节点在线率：${formatMonitorRate(summary.rate24h)}`,
    `7天节点在线率：${formatMonitorRate(summary.rate7d)}`,
    `30天节点在线率：${formatMonitorRate(summary.rate30d)}`,
    `24小时监测覆盖：${formatMonitorCoverage(summary, 24 * 60 * 60 * 1000, summary.samples24h)}`
  );
  if (summary.subscriptionFetchOk !== null && !summary.stale) {
    lines.push(`订阅接口：${summary.subscriptionFetchOk ? "正常" : "异常，已使用上次成功快照测试"}`);
  }
  lines.push(`最后检测：${summary.lastCheckedAt ? formatIsoDateTime(new Date(summary.lastCheckedAt).toISOString()) : "等待首轮检测"}`);
  if (summary.lastError) lines.push(`探针信息：${monitorErrorText(summary.lastError)}`);
  return lines.join("\n");
}

function formatMonitorReportSection(item: SavedSubscriptionItem | undefined, summary: MonitorSummary): string {
  const name = item ? savedItemDisplayName(item) : "已删除的机场订阅";
  const status = effectiveMonitorStatus(summary);
  const lines = [`${monitorStatusIcon(summary)} ${name}`, `状态：${monitorStatusLabel(status)}`];
  if (summary.totalNodes !== null && summary.onlineNodes !== null && !summary.stale) {
    const ratio = summary.totalNodes > 0 ? summary.onlineNodes / summary.totalNodes * 100 : 0;
    lines.push(`当前节点：${summary.onlineNodes}/${summary.totalNodes} 在线（${ratio.toFixed(1)}%）`);
  }
  if (summary.medianDelayMs !== null && !summary.stale) lines.push(`中位延迟：${summary.medianDelayMs} ms`);
  lines.push(
    `稳定率：24小时 ${formatMonitorRate(summary.rate24h)}｜7天 ${formatMonitorRate(summary.rate7d)}｜30天 ${formatMonitorRate(summary.rate30d)}`,
    `24小时覆盖：${formatMonitorCoverage(summary, 24 * 60 * 60 * 1000, summary.samples24h)}`,
    `最后检测：${summary.lastCheckedAt ? formatIsoDateTime(new Date(summary.lastCheckedAt).toISOString()) : "等待首轮检测"}`
  );
  if (summary.lastError) lines.push(`探针信息：${monitorErrorText(summary.lastError)}`);
  return lines.join("\n");
}

function monitorTargetKeyboard(subId: string, enabled: boolean) {
  return {
    inline_keyboard: [
      enabled
        ? [{ text: "⏸ 暂停监测", callback_data: `monitor_pause:${subId}` }, { text: "🔄 刷新状态", callback_data: `monitor_item:${subId}` }]
        : [{ text: "▶️ 开启监测", callback_data: `monitor_enable:${subId}` }],
      [{ text: "⬅️ 返回监测列表", callback_data: "monitor_back" }]
    ]
  };
}

function effectiveMonitorStatus(summary?: MonitorSummary): MonitorSummary["status"] | "paused" {
  if (!summary?.enabled) return "paused";
  return summary.stale ? "unknown" : summary.status;
}

function monitorStatusIcon(summary?: MonitorSummary): string {
  const status = effectiveMonitorStatus(summary);
  if (status === "healthy") return "🟢";
  if (status === "degraded") return "🟡";
  if (status === "offline") return "🔴";
  if (status === "unknown" || status === "pending") return "⚪";
  return "⚫";
}

function monitorStatusLabel(status: ReturnType<typeof effectiveMonitorStatus>): string {
  if (status === "healthy") return "正常";
  if (status === "degraded") return "部分节点异常";
  if (status === "offline") return "离线";
  if (status === "unknown") return "探针结果过期或异常";
  if (status === "pending") return "等待首轮检测";
  return "已暂停";
}

function monitorListStatus(summary?: MonitorSummary): string {
  const status = effectiveMonitorStatus(summary);
  if (!summary?.enabled) return "未开启";
  if (status === "pending") return "等待首轮检测";
  if (status === "unknown") return "结果未知";
  if (summary.totalNodes === null || summary.onlineNodes === null) return monitorStatusLabel(status);
  return `${summary.onlineNodes}/${summary.totalNodes} 在线`;
}

function formatMonitorRate(value: number | null): string {
  return value === null ? "样本不足" : `${value.toFixed(1)}%`;
}

function formatMonitorCoverage(summary: MonitorSummary, windowMs: number, samples: number): string {
  const monitoredMs = Math.max(0, Math.min(windowMs, Date.now() - summary.createdAt));
  const expected = Math.max(1, Math.ceil(monitoredMs / (10 * 60 * 1000)));
  return `${Math.min(100, samples / expected * 100).toFixed(1)}%（${samples}/${expected} 次）`;
}

function formatElapsedDuration(timestampMs: number): string {
  return formatDurationMinutes(Math.max(0, Math.floor((Date.now() - timestampMs) / 60000)));
}

function monitorErrorText(code: string): string {
  const messages: Record<string, string> = {
    no_nodes: "订阅未解析出可测试节点",
    provider_parse_failed: "Mihomo 无法解析订阅格式",
    probe_failed: "探针执行失败"
  };
  if (/^provider_http_\d{3}$/.test(code)) return "订阅获取失败";
  return messages[code] ?? "探针暂时异常";
}

function formatSubscriptionListText(subscriptions: SavedSubscriptionItem[], requestedPage = 0): string {
  if (subscriptions.length === 0) {
    return "还没有保存订阅或节点。请先发送链接，查询成功后点击保存。";
  }

  const nodeCount = subscriptions.filter((item) => savedItemKind(item) === "node").length;
  const page = savedItemsPage(subscriptions, "subscription", requestedPage);
  const lines = ["你的保存列表："];
  if (nodeCount > 0) {
    lines.push(`节点合集：${nodeCount} 个节点`, "");
  }
  if (page.total === 0) {
    lines.push("订阅：暂无");
    return lines.join("\n");
  }
  lines.push(`订阅：${page.total} 个（第 ${page.page + 1}/${page.totalPages} 页）`);
  for (const [index, item] of page.items.entries()) {
    const snapshotInfo = item.snapshotUpdatedAt
      ? `快照 ${item.snapshotNodeCount ?? 0} 节点 / ${formatIsoDateTime(item.snapshotUpdatedAt)}`
      : "快照尚未生成";
    lines.push(`${page.page * SAVED_PAGE_SIZE + index + 1}. ${savedItemDisplayName(item)}`);
    lines.push(`   ${snapshotInfo}${item.lastRefreshError ? " / 最近刷新失败，已保留快照" : ""}`);
  }
  return lines.join("\n");
}

function subscriptionListKeyboard(subscriptions: SavedSubscriptionItem[], requestedPage = 0) {
  if (subscriptions.length === 0) return undefined;
  const nodeCount = subscriptions.filter((item) => savedItemKind(item) === "node").length;
  const page = savedItemsPage(subscriptions, "subscription", requestedPage);
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  if (nodeCount > 0) {
    rows.push([{ text: `📦 节点合集 (${nodeCount})`, callback_data: "manage_nodes" }]);
  }
  rows.push(...page.items.map((item) => [
    { text: savedItemButtonText(item), callback_data: `query_saved:${item.id}` },
    { text: "✏️", callback_data: `rename_saved:${item.id}` },
    { text: "删除", callback_data: `delete_saved:${item.id}` }
  ]));
  const pagination = paginationRow("saved_page", page.page, page.totalPages);
  if (pagination.length > 0) rows.push(pagination);
  return {
    inline_keyboard: rows
  };
}

function savedItemButtonText(item: SavedSubscriptionItem): string {
  return savedItemDisplayName(item).slice(0, 28);
}

function savedItemDisplayName(item: SavedSubscriptionItem): string {
  return (item.customName || item.airportName || item.name || subscriptionNameFromUrl(item.url)).trim() || "未命名订阅";
}

function formatNodeCollectionListText(subscriptions: SavedSubscriptionItem[], requestedPage = 0): string {
  const page = savedItemsPage(subscriptions, "node", requestedPage);
  if (page.total === 0) return "节点合集还是空的，请先发送节点链接并加入合集。";
  const lines = [`节点合集：${page.total} 个（第 ${page.page + 1}/${page.totalPages} 页）`];
  for (const [index, item] of page.items.entries()) {
    const protocol = parseNodeLines([item.url])[0]?.protocol ?? "未知";
    lines.push(`${page.page * SAVED_PAGE_SIZE + index + 1}. ${savedItemDisplayName(item)}（${protocol}）`);
  }
  return lines.join("\n");
}

function nodeCollectionListKeyboard(subscriptions: SavedSubscriptionItem[], requestedPage = 0) {
  const page = savedItemsPage(subscriptions, "node", requestedPage);
  if (page.total === 0) return { inline_keyboard: [[{ text: "⬅️ 返回保存列表", callback_data: "cancel" }]] };
  const rows: Array<Array<{ text: string; callback_data: string }>> = [
    [{ text: `🎯 选择节点生成 Mihomo (${page.total})`, callback_data: "select_nodes" }],
    [{ text: `⚡ 全部节点生成 Mihomo (${page.total})`, callback_data: "export_node_collection" }],
    ...page.items.map((item) => [
      { text: savedItemButtonText(item), callback_data: `query_saved:${item.id}` },
      { text: "✏️", callback_data: `rename_saved:${item.id}` },
      { text: "删除", callback_data: `delete_saved:${item.id}` }
    ])
  ];
  const pagination = paginationRow("nodes_page", page.page, page.totalPages);
  if (pagination.length > 0) rows.push(pagination);
  rows.push([{ text: "清空节点合集", callback_data: "confirm_clear_nodes" }]);
  rows.push([{ text: "⬅️ 返回保存列表", callback_data: "cancel" }]);
  return { inline_keyboard: rows };
}

function savedNodeItems(subscriptions: SavedSubscriptionItem[]): SavedSubscriptionItem[] {
  return subscriptions
    .filter((item) => savedItemKind(item) === "node")
    .sort((left, right) => (right.lastQueryAt ?? right.updatedAt).localeCompare(left.lastQueryAt ?? left.updatedAt));
}

function nodeSelectionPage(items: SavedSubscriptionItem[], requestedPage = 0): NodeSelectionPage {
  const totalPages = Math.max(1, Math.ceil(items.length / SAVED_PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), totalPages - 1);
  return {
    items: items.slice(page * SAVED_PAGE_SIZE, (page + 1) * SAVED_PAGE_SIZE),
    page,
    totalPages
  };
}

function nodeSelectionPageForItem(items: SavedSubscriptionItem[], subId: string): number {
  const index = items.findIndex((item) => item.id === subId);
  return index < 0 ? 0 : Math.floor(index / SAVED_PAGE_SIZE);
}

function nodeSelectionKeyboard(page: NodeSelectionPage, selectedIds: Set<string>) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = page.items.map((item) => [
    {
      text: `${selectedIds.has(item.id) ? "✅" : "⬜"} ${savedItemButtonText(item)}`,
      callback_data: `toggle_node:${item.id}`
    }
  ]);
  const pagination = paginationRow("node_selection_page", page.page, page.totalPages);
  if (pagination.length > 0) rows.push(pagination);
  rows.push([
    { text: "全选", callback_data: "select_nodes_all" },
    { text: "全不选", callback_data: "select_nodes_none" }
  ]);
  rows.push([{ text: `⚙️ 生成已选节点订阅 (${selectedIds.size})`, callback_data: "export_selected_nodes" }]);
  rows.push([{ text: "⬅️ 取消选择", callback_data: "node_selection_cancel" }]);
  return { inline_keyboard: rows };
}

function savedItemsPage(subscriptions: SavedSubscriptionItem[], kind: "subscription" | "node", requestedPage = 0) {
  const items = subscriptions
    .filter((item) => savedItemKind(item) === kind)
    .sort((left, right) => (right.lastQueryAt ?? right.updatedAt).localeCompare(left.lastQueryAt ?? left.updatedAt));
  const totalPages = Math.max(1, Math.ceil(items.length / SAVED_PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), totalPages - 1);
  return {
    items: items.slice(page * SAVED_PAGE_SIZE, (page + 1) * SAVED_PAGE_SIZE),
    page,
    total: items.length,
    totalPages
  };
}

function paginationRow(prefix: string, page: number, totalPages: number): Array<{ text: string; callback_data: string }> {
  if (totalPages <= 1) return [];
  const row: Array<{ text: string; callback_data: string }> = [];
  if (page > 0) row.push({ text: "⬅️ 上一页", callback_data: `${prefix}:${page - 1}` });
  row.push({ text: `${page + 1}/${totalPages}`, callback_data: `${prefix}:${page}` });
  if (page + 1 < totalPages) row.push({ text: "下一页 ➡️", callback_data: `${prefix}:${page + 1}` });
  return row;
}

async function querySavedSubscription(subId: string, userId: number, callback: TelegramCallbackQuery, env: Env): Promise<void> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  const item = subscriptions.find((subscription) => subscription.id === subId);
  if (!item) {
    await editCallbackMessage(env, callback, "订阅不存在或已经删除。", subscriptionListKeyboard(subscriptions));
    return;
  }

  if (savedItemKind(item) === "node") {
    await touchSavedSubscriptionLastQueryAt(env, userId, subId);
    await editCallbackMessage(env, callback, formatSingleNodeMessage(item.url), nodeActionKeyboard(undefined, true, subId));
    return;
  }

  await showSavedSubscriptionSnapshot(subId, userId, callback, env, false);
  return;

  /*
  try {
    const result = await fetchAndParseSubscription(item.url, env);
    const cacheId = createCacheId();
    await cacheSubscription(env, userId, { url: item.url, updatedAt: new Date().toISOString(), ...result }, cacheId);
    await touchSavedSubscriptionLastQueryAt(env, userId, subId);
    await editCallbackMessage(env, callback, formatSubscriptionMessage(result, item.url), actionKeyboard(false, cacheId, true));
  } catch (error) {
    await editCallbackMessage(env, callback, `订阅查询失败：${safeError(error)}`, subscriptionListKeyboard(subscriptions));
  }
}

*/
}

async function showSavedSubscriptionSnapshot(subId: string, userId: number, callback: TelegramCallbackQuery, env: Env, nodesExpanded: boolean): Promise<void> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  const item = subscriptions.find((subscription) => subscription.id === subId);
  if (!item || savedItemKind(item) !== "subscription") {
    await editCallbackMessage(env, callback, formatSubscriptionListText(subscriptions), subscriptionListKeyboard(subscriptions));
    return;
  }
  const snapshot = await getSavedSubscriptionSnapshot(env, userId, subId);
  if (!snapshot) {
    await editCallbackMessage(env, callback, "该订阅是旧保存记录，尚未保存本地快照。请点击“手动刷新订阅”生成快照。", savedSubscriptionKeyboard(subId, false));
    return;
  }
  await touchSavedSubscriptionLastQueryAt(env, userId, subId);
  const cacheId = createCacheId();
  await cacheSubscription(env, userId, snapshot, cacheId);
  const message = nodesExpanded
    ? formatSubscriptionWithNodesMessage(snapshot, snapshot.updatedAt)
    : formatSubscriptionMessage(snapshot, snapshot.url, snapshot.updatedAt);
  await editCallbackMessage(env, callback, message, savedSubscriptionKeyboard(subId, nodesExpanded, cacheId));
}

async function refreshSavedSubscription(subId: string, userId: number, callback: TelegramCallbackQuery, env: Env): Promise<void> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  const item = subscriptions.find((subscription) => subscription.id === subId);
  if (!item || savedItemKind(item) !== "subscription") {
    await editCallbackMessage(env, callback, formatSubscriptionListText(subscriptions), subscriptionListKeyboard(subscriptions));
    return;
  }
  item.lastRefreshAttemptAt = new Date().toISOString();
  try {
    const result = await fetchAndParseSubscription(item.url, env);
    if (result.nodes.length === 0) throw new Error("订阅未解析出节点，已保留旧快照");
    const cached: CachedSubscription = { url: item.url, updatedAt: new Date().toISOString(), ...result };
    await saveSubscription(env, userId, cached);
    const latestSubscriptions = await getSavedSubscriptions(env, userId);
    const latestItem = latestSubscriptions.find((subscription) => subscription.id === subId);
    if (latestItem) {
      latestItem.lastRefreshAttemptAt = item.lastRefreshAttemptAt;
      await putSavedSubscriptions(env, userId, latestSubscriptions);
    }
    const cacheId = createCacheId();
    await cacheSubscription(env, userId, cached, cacheId);
    await editCallbackMessage(env, callback, formatSubscriptionMessage(cached, cached.url, cached.updatedAt), savedSubscriptionKeyboard(subId, false, cacheId));
  } catch (error) {
    item.lastRefreshError = safeError(error);
    await putSavedSubscriptions(env, userId, subscriptions);
    const snapshot = await getSavedSubscriptionSnapshot(env, userId, subId);
    const prefix = `刷新失败：${item.lastRefreshError}\n已保留上一次成功快照。\n\n`;
    await editCallbackMessage(env, callback, snapshot ? prependText(formatSubscriptionMessage(snapshot, snapshot.url, snapshot.updatedAt), prefix) : `${prefix}请稍后重试。`, savedSubscriptionKeyboard(subId, false));
  }
}

async function exportSavedSubscriptionMihomo(subId: string, userId: number, callback: TelegramCallbackQuery, request: Request, env: Env): Promise<void> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  const item = subscriptions.find((subscription) => subscription.id === subId);
  if (!item || savedItemKind(item) !== "subscription") {
    await editCallbackMessage(env, callback, formatSubscriptionListText(subscriptions), subscriptionListKeyboard(subscriptions));
    return;
  }

  const snapshot = await getSavedSubscriptionSnapshot(env, userId, subId);
  if (!snapshot || getUsableNodes(snapshot.nodes).length === 0) {
    await editCallbackMessage(env, callback, "该订阅尚无可用本地快照。请先点击“手动刷新订阅”成功后再生成长期地址。", savedSubscriptionKeyboard(subId, false));
    return;
  }

  try {
    const body = generateMihomoSubscription(snapshot.raw);
    const stableId = await getOrCreateSavedSubscriptionMihomoLink(env, userId, subId);
    const origin = new URL(request.url).origin;
    const link = `${origin}/m/${stableId}`;
    const chatId = callback.message?.chat.id;
    if (!chatId) return;
    await sendTextDocument(env, chatId, mihomoSubscriptionFilename(snapshot), body, "长期 Mihomo 配置已生成");
    await editCallbackMessage(
      env,
      callback,
      `长期 Mihomo 订阅已生成：\n${link}\n\n此地址不会自动过期。机场更换订阅链接时，请用“更新订阅源地址”；如地址泄露，可用“重置长期订阅地址”。链接内含节点凭据，请勿公开分享。`,
      savedSubscriptionKeyboard(subId, false)
    );
  } catch (error) {
    await editCallbackMessage(env, callback, mihomoExportErrorMessage(error), savedSubscriptionKeyboard(subId, false));
  }
}

async function resetSavedSubscriptionMihomo(subId: string, userId: number, callback: TelegramCallbackQuery, request: Request, env: Env): Promise<void> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  const item = subscriptions.find((subscription) => subscription.id === subId);
  if (!item || savedItemKind(item) !== "subscription") {
    await editCallbackMessage(env, callback, formatSubscriptionListText(subscriptions), subscriptionListKeyboard(subscriptions));
    return;
  }

  const stableId = await resetSavedSubscriptionMihomoLink(env, userId, subId);
  const origin = new URL(request.url).origin;
  await editCallbackMessage(
    env,
    callback,
    `长期 Mihomo 订阅地址已重置：\n${origin}/m/${stableId}\n\n旧地址已撤销。链接内含节点凭据，请勿公开分享。`,
    savedSubscriptionKeyboard(subId, false)
  );
}

async function promptReplaceSavedSubscriptionSource(subId: string, userId: number, callback: TelegramCallbackQuery, env: Env): Promise<void> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  const item = subscriptions.find((subscription) => subscription.id === subId);
  const chatId = callback.message?.chat.id;
  if (!item || savedItemKind(item) !== "subscription" || !chatId) {
    await editCallbackMessage(env, callback, formatSubscriptionListText(subscriptions), subscriptionListKeyboard(subscriptions));
    return;
  }

  const prompt = await sendMessage(
    env,
    chatId,
    "请回复这条消息，发送新的机场订阅链接。链接验证成功后，长期 Mihomo 地址保持不变。",
    { force_reply: true, input_field_placeholder: "粘贴新的机场订阅链接" }
  );
  const promptMessageId = prompt.result?.message_id;
  if (typeof promptMessageId === "number") {
    const pending: PendingSavedSubscriptionSourceUpdate = { subId, chatId, promptMessageId };
    await env.SUB_KV.put(pendingSavedSubscriptionSourceUpdateKey(userId), JSON.stringify(pending), { expirationTtl: PENDING_SAVED_SOURCE_UPDATE_TTL_SECONDS });
  }
  await editCallbackMessage(env, callback, `请回复我刚发送的消息，粘贴“${savedItemDisplayName(item)}”的新机场订阅链接。`, savedSubscriptionKeyboard(subId, false));
}

async function replaceSavedSubscriptionSourceFromReply(message: TelegramMessage, userId: number, env: Env): Promise<boolean> {
  const pending = await env.SUB_KV.get<PendingSavedSubscriptionSourceUpdate>(pendingSavedSubscriptionSourceUpdateKey(userId), "json");
  if (!pending || pending.chatId !== message.chat.id || pending.promptMessageId !== message.reply_to_message?.message_id) return false;

  const input = extractQueryInput((message.text ?? "").trim());
  if (!input || input.kind !== "subscription") {
    await sendMessage(env, message.chat.id, "请回复有效的机场订阅链接。原地址和本地快照未改动。", undefined, message.message_id);
    return true;
  }

  const subscriptions = await getSavedSubscriptions(env, userId);
  const item = subscriptions.find((subscription) => subscription.id === pending.subId);
  if (!item || savedItemKind(item) !== "subscription") {
    await env.SUB_KV.delete(pendingSavedSubscriptionSourceUpdateKey(userId));
    await sendMessage(env, message.chat.id, "保存订阅不存在或已经删除。", undefined, message.message_id);
    return true;
  }
  if (subscriptions.some((subscription) => subscription.id !== item.id && subscription.url === input.url)) {
    await sendMessage(env, message.chat.id, "这个订阅链接已经保存过了。原地址和本地快照未改动。", undefined, message.message_id);
    return true;
  }

  try {
    const result = await fetchAndParseSubscription(input.url, env);
    if (getUsableNodes(result.nodes).length === 0) throw new Error("订阅未解析出可用节点");
    const now = new Date().toISOString();
    const cached: CachedSubscription = { url: input.url, updatedAt: now, ...result };
    item.url = input.url;
    item.name = savedSubscriptionName(cached);
    item.airportName = cached.airportName;
    item.updatedAt = now;
    item.snapshotUpdatedAt = now;
    item.snapshotNodeCount = getUsableNodes(cached.nodes).length;
    item.lastRefreshAttemptAt = now;
    item.lastRefreshError = undefined;
    await putSavedSubscriptionSnapshot(env, userId, item.id, cached);
    await putSavedSubscriptions(env, userId, subscriptions);
    await env.SUB_KV.delete(pendingSavedSubscriptionSourceUpdateKey(userId));
    await sendMessage(
      env,
      message.chat.id,
      `订阅源地址已更新：${savedItemDisplayName(item)}\n长期 Mihomo 地址保持不变。`,
      savedSubscriptionKeyboard(item.id, false),
      message.message_id
    );
  } catch {
    await sendMessage(env, message.chat.id, "新订阅链接验证失败。原地址和本地快照未改动；请确认链接有效后继续回复此消息重试。", undefined, message.message_id);
  }
  return true;
}

async function confirmDeleteSavedSubscription(subId: string, userId: number, callback: TelegramCallbackQuery, env: Env): Promise<void> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  const item = subscriptions.find((subscription) => subscription.id === subId);
  if (!item) {
    await editCallbackMessage(env, callback, "订阅不存在或已经删除。", subscriptionListKeyboard(subscriptions));
    return;
  }

  const kindLabel = savedItemKind(item) === "node" ? "节点" : "订阅";
  await editCallbackMessage(env, callback, `确认删除${kindLabel}“${savedItemDisplayName(item)}”？`, {
    inline_keyboard: [
      [{ text: "确认删除", callback_data: `confirm_delete_saved:${item.id}` }],
      [{ text: "取消", callback_data: "cancel" }]
    ]
  });
}

async function deleteSavedSubscriptionFromCallback(subId: string, userId: number, callback: TelegramCallbackQuery, env: Env): Promise<void> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  const item = subscriptions.find((subscription) => subscription.id === subId);
  if (!item) {
    await editCallbackMessage(env, callback, "订阅不存在或已经删除。", subscriptionListKeyboard(subscriptions));
    return;
  }

  const nextSubscriptions = subscriptions.filter((subscription) => subscription.id !== subId);
  await putSavedSubscriptions(env, userId, nextSubscriptions);
  if (savedItemKind(item) === "subscription") {
    await revokeSavedSubscriptionMihomoLink(env, userId, subId);
    try {
      await deleteMonitorData(env.MONITOR_DB, userId, subId);
    } catch (error) {
      console.error("failed to delete monitor data", safeError(error));
    }
  }
  await editCallbackMessage(env, callback, `已删除：${savedItemDisplayName(item)}\n\n${formatSubscriptionListText(nextSubscriptions)}`, subscriptionListKeyboard(nextSubscriptions));
}

async function promptRenameSavedItem(subId: string, userId: number, chatId: number, env: Env): Promise<void> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  const item = subscriptions.find((entry) => entry.id === subId);
  if (!item) {
    await sendMessage(env, chatId, "保存项不存在或已经删除。");
    return;
  }
  await sendMessage(
    env,
    chatId,
    `请回复这条消息发送新名称。\n当前名称：${savedItemDisplayName(item)}\n重命名编号：${item.id}`,
    { force_reply: true, input_field_placeholder: "输入新名称（最多 40 个字符）" }
  );
}

async function renameSavedItemFromReply(message: TelegramMessage, userId: number, env: Env): Promise<boolean> {
  const prompt = message.reply_to_message?.text ?? "";
  const subId = prompt.match(/重命名编号：([a-f0-9]{12})/i)?.[1];
  if (!subId) return false;

  const name = cleanDisplayText(message.text ?? "").slice(0, 40);
  if (!name) {
    await sendMessage(env, message.chat.id, "名称不能为空，请重新点击重命名。", undefined, message.message_id);
    return true;
  }
  const subscriptions = await getSavedSubscriptions(env, userId);
  const item = subscriptions.find((entry) => entry.id === subId);
  if (!item) {
    await sendMessage(env, message.chat.id, "保存项不存在或已经删除。", undefined, message.message_id);
    return true;
  }
  item.customName = name;
  item.updatedAt = new Date().toISOString();
  await putSavedSubscriptions(env, userId, subscriptions);
  await sendMessage(
    env,
    message.chat.id,
    `已重命名为：${name}\n\n${formatSubscriptionListText(subscriptions)}`,
    subscriptionListKeyboard(subscriptions),
    message.message_id
  );
  return true;
}

async function confirmClearNodeCollection(userId: number, callback: TelegramCallbackQuery, env: Env): Promise<void> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  const nodeCount = subscriptions.filter((item) => savedItemKind(item) === "node").length;
  if (nodeCount === 0) {
    await editCallbackMessage(env, callback, "节点合集已经是空的。", subscriptionListKeyboard(subscriptions));
    return;
  }
  await editCallbackMessage(env, callback, `确认清空节点合集中的 ${nodeCount} 个节点？保存的机场订阅不会受影响。`, {
    inline_keyboard: [
      [{ text: "确认清空", callback_data: "clear_nodes" }],
      [{ text: "取消", callback_data: "manage_nodes" }]
    ]
  });
}

async function clearNodeCollection(userId: number, callback: TelegramCallbackQuery, env: Env): Promise<void> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  const nextSubscriptions = subscriptions.filter((item) => savedItemKind(item) === "subscription");
  const removed = subscriptions.length - nextSubscriptions.length;
  await putSavedSubscriptions(env, userId, nextSubscriptions);
  await editCallbackMessage(
    env,
    callback,
    `已清空节点合集，共删除 ${removed} 个节点。保存的机场订阅未受影响。\n\n${formatSubscriptionListText(nextSubscriptions)}`,
    subscriptionListKeyboard(nextSubscriptions)
  );
}

async function touchSavedSubscriptionLastQueryAt(env: Env, userId: number, subId: string): Promise<void> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  const item = subscriptions.find((subscription) => subscription.id === subId);
  if (!item) return;
  item.lastQueryAt = new Date().toISOString();
  await putSavedSubscriptions(env, userId, subscriptions);
}

async function exportDebugJsonForReply(message: TelegramMessage, userId: number, env: Env): Promise<void> {
  const replied = message.reply_to_message;
  if (!replied) {
    await sendMessage(env, message.chat.id, "请回复机器人发出的订阅结果消息，再发送 /json。", undefined, message.message_id);
    return;
  }

  await sendJsonDocument(env, message.chat.id, "reply-message.json", JSON.stringify(replied, null, 2), "已导出引用消息 JSON");
}

async function fetchAndParseSubscription(url: string, env: Env): Promise<ParsedSubscription> {
  let lastError: unknown = null;
  let bestResult: ParsedSubscription | null = null;
  let bestScore = -1;

  for (const target of subscriptionRequestTargets(url, env)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(target.url, {
        signal: controller.signal,
        headers: target.headers
      });

      if (!response.ok) {
        lastError = new Error(formatSubscriptionHttpError(response.status, target.viaProxy));
        continue;
      }

      const raw = await response.text();
      if (!raw.trim()) {
        lastError = new Error("订阅内容为空");
        continue;
      }

      const parsed = parseSubscriptionBody(raw);
      const userInfo = supplementUserInfoFromNoticeNodes(parseSubscriptionUserInfo(response.headers), parsed.nodes);
      const result: ParsedSubscription = {
        raw,
        userInfo,
        nodes: parsed.nodes,
        sourceType: parsed.sourceType,
        airportName: detectAirportName(url, raw, response.headers)
      };
      const score = scoreSubscriptionResult(result);
      if (score > bestScore) {
        bestScore = score;
        bestResult = result;
      }
      if (result.userInfo && getUsableNodes(result.nodes).length > 0) {
        return result;
      }
    } catch (error) {
      lastError = error instanceof Error && error.name === "AbortError" ? new Error("请求超时") : error;
    } finally {
      clearTimeout(timeout);
    }
  }

  if (bestResult) {
    return bestResult;
  }

  throw lastError ?? new Error("订阅请求失败");
}

function subscriptionRequestTargets(url: string, env: Env): Array<{ url: string; headers: HeadersInit; viaProxy: boolean }> {
  const targets: Array<{ url: string; headers: HeadersInit; viaProxy: boolean }> = [];
  const proxy = env.SUB_FETCH_PROXY?.trim();
  if (proxy) {
    const proxyUrl = new URL(proxy);
    proxyUrl.searchParams.set("url", url.trim());
    proxyUrl.searchParams.set("ua", PREFERRED_UA);
    proxyUrl.searchParams.set("_ts", String(Date.now()));
    targets.push({
      url: proxyUrl.toString(),
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      viaProxy: true
    });
  }

  targets.push(...subscriptionRequestHeadersList().map((headers) => ({ url, headers, viaProxy: false })));
  return targets;
}

function subscriptionRequestHeadersList(): HeadersInit[] {
  const common = {
    Accept: "text/plain, application/octet-stream, application/yaml, text/yaml, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache"
  };

  return [
    { ...common, "User-Agent": PREFERRED_UA },
    { ...common, "User-Agent": "FlClash/0.8.86" },
    { ...common, "User-Agent": "Clash.Meta" },
    { ...common, "User-Agent": "Shadowrocket/1993 CFNetwork/1496.0.7 Darwin/23.5.0" },
    { ...common, "User-Agent": "v2rayN/6.45" }
  ];
}

function scoreSubscriptionResult(result: ParsedSubscription): number {
  let score = getUsableNodes(result.nodes).length * 10;
  if (result.userInfo) score += 1000;
  if (result.sourceType === "yaml") score += 100;
  if (result.sourceType === "base64") score += 20;
  return score;
}

function parseSubscriptionUserInfo(headers: Headers): SubscriptionUserInfo | null {
  const value = headers.get("subscription-userinfo");
  const purchasedAt = parseHeaderTimestamp(
    headers.get("x-subscription-purchased-at") ?? headers.get("x-subscription-created-at")
  );
  const startAt = parseHeaderTimestamp(headers.get("x-subscription-start-at"));

  if (!value) return null;

  const pairs = new Map<string, number>();
  for (const part of value.split(";")) {
    const [key, rawValue] = part.trim().split("=");
    const numberValue = Number(rawValue);
    if (key && Number.isFinite(numberValue)) {
      pairs.set(key, numberValue);
    }
  }

  const upload = pairs.get("upload") ?? 0;
  const download = pairs.get("download") ?? 0;
  const total = pairs.get("total") ?? 0;
  const expire = pairs.get("expire") ?? null;
  const resetDay = pairs.get("reset_day") ?? pairs.get("resetDay") ?? null;
  const nextResetAt = estimateNextResetAt(purchasedAt ?? startAt, expire, resetDay);
  const resetEstimated = resetDay === null && nextResetAt !== null;
  if (
    upload === 0 &&
    download === 0 &&
    total === 0 &&
    expire === null &&
    resetDay === null &&
    purchasedAt === null &&
    startAt === null
  ) return null;
  return { upload, download, total, expire, resetDay, purchasedAt, startAt, nextResetAt, resetEstimated };
}

function parseHeaderTimestamp(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const numberValue = Number(trimmed);
  if (Number.isFinite(numberValue)) {
    const seconds = numberValue > 9999999999 ? Math.floor(numberValue / 1000) : Math.floor(numberValue);
    return seconds > 0 ? seconds : null;
  }

  const parsedMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedMs)) return null;
  const seconds = Math.floor(parsedMs / 1000);
  return seconds > 0 ? seconds : null;
}

function estimateNextResetAt(startSeconds: number | null, expireSeconds: number | null, resetDay: number | null): number | null {
  if (resetDay !== null || !startSeconds || !expireSeconds) return null;

  const cycleSeconds = 30 * 24 * 60 * 60;
  const cyclesPassed = Math.floor((Date.now() / 1000 - startSeconds) / cycleSeconds) + 1;
  const nextResetAt = startSeconds + cyclesPassed * cycleSeconds;
  return nextResetAt > expireSeconds ? null : nextResetAt;
}

function supplementUserInfoFromNoticeNodes(userInfo: SubscriptionUserInfo | null, nodes: ParsedNode[]): SubscriptionUserInfo | null {
  if (!userInfo || userInfo.resetDay !== null || userInfo.nextResetAt !== null) return userInfo;

  const noticeText = nodes.filter((node) => node.isNotice).map((node) => node.name).join("\n");
  if (!noticeText) return userInfo;

  const resetDay = parseResetDayFromNoticeText(noticeText);
  if (resetDay !== null) return { ...userInfo, resetDay };

  const nextResetAt = parseNextResetAtFromNoticeText(noticeText);
  if (nextResetAt !== null) return { ...userInfo, nextResetAt, resetEstimated: true };

  return userInfo;
}

function parseResetDayFromNoticeText(text: string): number | null {
  const patterns = [
    /每(?:月|个月)\s*(\d{1,2})\s*(?:日|号)/i,
    /(?:重置|续费|renew|reset)[^\d\n]{0,12}每(?:月|个月)?\s*(\d{1,2})\s*(?:日|号)/i,
    /每(?:月|个月)?\s*(\d{1,2})\s*(?:日|号)[^\n]{0,12}(?:重置|续费|renew|reset)/i
  ];

  for (const pattern of patterns) {
    const day = Number(text.match(pattern)?.[1]);
    if (Number.isInteger(day) && day >= 1 && day <= 31) return day;
  }
  return null;
}

function parseNextResetAtFromNoticeText(text: string): number | null {
  const explicitDate =
    parseResetDateMatch(text.match(/(?:重置|续费|renew|reset)[^\d\n]{0,20}(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/i)) ??
    parseResetDateMatch(text.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})[^\n]{0,20}(?:重置|续费|renew|reset)/i));
  if (explicitDate !== null) return explicitDate;

  const monthDay =
    parseMonthDayResetMatch(text.match(/(?:重置|续费)[^\d\n]{0,20}(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?/i)) ??
    parseMonthDayResetMatch(text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?[^\n]{0,20}(?:重置|续费)/i));
  if (monthDay !== null) return monthDay;

  const remainingDays =
    parseRemainingDaysResetMatch(text.match(/(?:重置|续费|renew|reset)[^\d\n]{0,20}(\d{1,3})\s*(?:天|day|days|d)\b/i)) ??
    parseRemainingDaysResetMatch(text.match(/(\d{1,3})\s*(?:天|day|days|d)\b[^\n]{0,20}(?:重置|续费|renew|reset)/i));
  return remainingDays;
}

function parseResetDateMatch(match: RegExpMatchArray | null): number | null {
  if (!match) return null;
  return timestampFromUtcDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

function parseMonthDayResetMatch(match: RegExpMatchArray | null): number | null {
  if (!match) return null;
  const now = new Date();
  const month = Number(match[1]);
  const day = Number(match[2]);
  const currentYear = now.getUTCFullYear();
  const currentYearTimestamp = timestampFromUtcDate(currentYear, month, day);
  if (currentYearTimestamp === null) return null;
  return currentYearTimestamp * 1000 + 24 * 60 * 60 * 1000 < Date.now()
    ? timestampFromUtcDate(currentYear + 1, month, day)
    : currentYearTimestamp;
}

function parseRemainingDaysResetMatch(match: RegExpMatchArray | null): number | null {
  if (!match) return null;
  const days = Number(match[1]);
  if (!Number.isInteger(days) || days < 0 || days > 366) return null;
  return Math.floor((Date.now() + days * 24 * 60 * 60 * 1000) / 1000);
}

function timestampFromUtcDate(year: number, month: number, day: number): number | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 2020 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return Math.floor(date.getTime() / 1000);
}

function parseSubscriptionBody(raw: string): { sourceType: ParsedSubscription["sourceType"]; nodes: ParsedNode[] } {
  const decoded = tryDecodeBase64(raw.trim());
  if (decoded && looksLikeNodeText(decoded)) {
    return { sourceType: "base64", nodes: parseNodeLines(decoded.split(/\r?\n/)) };
  }

  if (/^\s*(proxies|outbounds)\s*:/m.test(raw) || /^\s*-\s*(name|tag)\s*:/m.test(raw)) {
    return { sourceType: "yaml", nodes: parseYamlNodes(raw) };
  }

  return { sourceType: "text", nodes: parseNodeLines(raw.split(/\r?\n/)) };
}

function parseNodeLines(lines: string[]): ParsedNode[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => /^[a-z0-9+.-]+:\/\//i.test(line))
    .map((line) => {
      const protocol = detectProtocol(line);
      const name = decodeNodeName(line);
      return makeNode(name, protocol, line);
    });
}

function parseYamlNodes(raw: string): ParsedNode[] {
  return dedupeNodes([...parseYamlBlockNodes(raw), ...parseYamlLineNodes(raw)]);
}

function parseYamlBlockNodes(raw: string): ParsedNode[] {
  const nodes: ParsedNode[] = [];
  const lines = raw.split(/\r?\n/);
  let section = "";

  for (let index = 0; index < lines.length; index += 1) {
    const sectionMatch = lines[index].match(/^([A-Za-z0-9_-]+)\s*:/);
    if (sectionMatch && !lines[index].startsWith(" ")) {
      section = sectionMatch[1].toLowerCase();
      continue;
    }
    if (section && !["proxies", "outbounds"].includes(section)) continue;

    const startMatch = lines[index].match(/^\s*-\s*(name|tag)\s*:\s*(.+)\s*$/);
    if (!startMatch) continue;

    const name = stripYamlQuotes(startMatch[2]);
    let protocol = "unknown";
    for (let offset = 1; offset <= 20 && index + offset < lines.length; offset += 1) {
      if (/^\s*-\s*(name|tag)\s*:/i.test(lines[index + offset])) break;
      const typeMatch = lines[index + offset].match(/^\s*(type|protocol)\s*:\s*(.+)\s*$/);
      if (typeMatch) {
        protocol = stripYamlQuotes(typeMatch[2]).toLowerCase();
        break;
      }
    }
    nodes.push(makeNode(name, protocol, ""));
  }

  return nodes;
}

function parseYamlLineNodes(raw: string): ParsedNode[] {
  const nodes: ParsedNode[] = [];
  const lines = raw.split(/\r?\n/);
  let section = "";

  for (const line of lines) {
    const sectionMatch = line.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (sectionMatch && !line.startsWith(" ")) {
      section = sectionMatch[1].toLowerCase();
      continue;
    }
    if (section && !["proxies", "outbounds"].includes(section)) continue;
    if (!line.includes("name:") && !line.includes("tag:")) continue;
    if (!line.includes("type:") && !line.includes("protocol:")) continue;

    const name = extractYamlValue(line, ["name", "tag"]);
    const protocol = extractYamlValue(line, ["type", "protocol"]) ?? "unknown";
    if (name) nodes.push(makeNode(name, protocol, line.trim()));
  }

  return nodes;
}

function extractYamlValue(value: string, keys: string[]): string | null {
  for (const key of keys) {
    const match = value.match(new RegExp(`(?:^|[,\\s{])${key}\\s*:\\s*('([^']*)'|"([^"]*)"|([^,{}\\n]+))`, "i"));
    const rawValue = match?.[2] ?? match?.[3] ?? match?.[4];
    if (rawValue) return stripYamlQuotes(rawValue).trim();
  }
  return null;
}

function makeNode(name: string, protocol: string, raw: string): ParsedNode {
  const normalizedProtocol = protocol.toLowerCase().trim() || "unknown";
  return {
    name,
    protocol: normalizedProtocol,
    region: detectRegion(name),
    raw,
    isPolicy: isPolicyProtocol(normalizedProtocol),
    isNotice: isNoticeNode(name)
  };
}

function isPolicyProtocol(protocol: string): boolean {
  return ["select", "url-test", "fallback", "load-balance", "relay", "direct", "reject"].includes(protocol.toLowerCase());
}

function isNoticeNode(name: string): boolean {
  return /不支持|请更换|客户端|教程|官网|剩余|套餐|到期|过期|流量|traffic|expire|reset/i.test(name);
}

function getUsableNodes(nodes: ParsedNode[]): ParsedNode[] {
  return nodes.filter((node) => !node.isPolicy && !node.isNotice);
}

function dedupeNodes(nodes: ParsedNode[]): ParsedNode[] {
  const seen = new Set<string>();
  const result: ParsedNode[] = [];
  for (const node of nodes) {
    const key = `${node.protocol}:${node.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(node);
  }
  return result;
}

function looksLikeNodeText(value: string): boolean {
  return /(^|\n)[a-z0-9+.-]+:\/\//i.test(value);
}

function detectProtocol(line: string): string {
  return line.match(/^([a-z0-9+.-]+):\/\//i)?.[1].toLowerCase() ?? "unknown";
}

function decodeNodeName(line: string): string {
  const hashIndex = line.indexOf("#");
  if (hashIndex >= 0) return safeDecodeURIComponent(line.slice(hashIndex + 1)) || "未命名节点";
  return `${detectProtocol(line).toUpperCase()} 节点`;
}

function detectRegion(name: string): string {
  const regionRules: Array<[string, RegExp]> = [
    ["香港", /🇭🇰|香港|港|hk|hong ?kong/i],
    ["台湾", /🇹🇼|台湾|台灣|台|tw|taiwan/i],
    ["日本", /🇯🇵|日本|日|jp|japan/i],
    ["新加坡", /🇸🇬|新加坡|狮城|sg|singapore/i],
    ["美国", /🇺🇸|美国|美國|美|us|usa|america/i],
    ["韩国", /🇰🇷|韩国|韓國|韩|kr|korea/i],
    ["英国", /🇬🇧|英国|英國|英|uk|gb|britain/i],
    ["德国", /🇩🇪|德国|德國|德|de|germany/i],
    ["法国", /🇫🇷|法国|法國|法|fr|france/i]
  ];
  return regionRules.find(([, pattern]) => pattern.test(name))?.[0] ?? "其他";
}

function tryDecodeBase64(value: string): string | null {
  const normalized = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=_-]+$/.test(normalized) || normalized.length < 8) return null;
  try {
    const base64 = normalized.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function toBase64Subscription(cached: CachedSubscription): string {
  if (cached.sourceType === "base64") return cached.raw.trim();
  const joined = cached.nodes.map((node) => node.raw).filter(Boolean).join("\n");
  return btoa(unescape(encodeURIComponent(joined || cached.raw)));
}

function toYamlSubscription(cached: CachedSubscription): string {
  if (cached.sourceType === "yaml") return cached.raw.trim();
  const proxies = cached.nodes.map((node) => `  - name: "${escapeYaml(node.name)}"\n    type: ${node.protocol}\n    raw: "${escapeYaml(node.raw)}"`);
  return `proxies:\n${proxies.join("\n")}`;
}

function rawSubscriptionFilename(cached: CachedSubscription): string {
  if (cached.sourceType === "yaml") return `${safeDocumentBasename(cached.airportName) || "subscription"}.yaml`;
  if (cached.sourceType === "base64") return "subscription-base64.txt";
  return "subscription.txt";
}

function mihomoSubscriptionFilename(cached: CachedSubscription): string {
  return `${safeDocumentBasename(cached.airportName) || "subscription"}-Mihomo.yaml`;
}

function safeDocumentBasename(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function actionKeyboard(nodesExpanded = false, cacheId?: string, backToList = false) {
  const callback = (name: string) => cacheId ? `${name}:${cacheId}` : name;
  const inlineKeyboard = [
    [
      { text: "🔄 刷新订阅信息", callback_data: callback("refresh") },
      nodesExpanded
        ? { text: "📄 折叠全部节点", callback_data: callback("collapse_nodes") }
        : { text: "📄 显示全部节点", callback_data: callback("nodes") }
    ],
    [{ text: "📥 导出原始订阅", callback_data: callback("export_yaml") }],
    [{ text: "⚙️ Mihomo配置与订阅", callback_data: callback("export_mihomo") }],
    [{ text: "💾 保存订阅", callback_data: callback("save") }]
  ];
  if (backToList) {
    inlineKeyboard.push([{ text: "↩️ 返回保存列表", callback_data: "cancel" }]);
  }
  return {
    inline_keyboard: inlineKeyboard
  };
}

function savedSubscriptionKeyboard(subId: string, nodesExpanded: boolean, cacheId?: string) {
  const callback = (name: string) => cacheId ? `${name}:${cacheId}` : name;
  return {
    inline_keyboard: [
      [
        { text: "🔄 手动刷新订阅", callback_data: `refresh_saved:${subId}` },
        nodesExpanded
          ? { text: "📋 折叠全部节点", callback_data: `collapse_nodes_saved:${subId}` }
          : { text: "📋 显示全部节点", callback_data: `nodes_saved:${subId}` }
      ],
      [{ text: "📡 机场稳定性监测", callback_data: `monitor_item:${subId}` }],
      [{ text: "📄 导出原始订阅", callback_data: callback("export_yaml") }],
      [{ text: "⚙️ 生成长期 Mihomo 订阅", callback_data: `export_saved_mihomo:${subId}` }],
      [{ text: "✏️ 更新订阅源地址", callback_data: `replace_saved_source:${subId}` }],
      [{ text: "🔗 重置长期订阅地址", callback_data: `reset_saved_mihomo:${subId}` }],
      [{ text: "⬅️ 返回保存列表", callback_data: "cancel" }]
    ]
  };
}

function nodeActionKeyboard(cacheId?: string, backToList = false, savedNodeId?: string) {
  const inlineKeyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  if (cacheId) {
    inlineKeyboard.push([{ text: "➕ 加入节点合集", callback_data: `save_node:${cacheId}` }]);
  } else if (savedNodeId) {
    inlineKeyboard.push([{ text: "🎯 选择节点生成 Mihomo", callback_data: "select_nodes" }]);
    inlineKeyboard.push([{ text: "⚡ 全部节点生成 Mihomo", callback_data: "export_node_collection" }]);
    inlineKeyboard.push([{ text: "✏️ 重命名", callback_data: `rename_saved:${savedNodeId}` }]);
  }
  if (backToList) {
    inlineKeyboard.push([{ text: "↩️ 返回保存列表", callback_data: "cancel" }]);
  }
  return {
    inline_keyboard: inlineKeyboard
  };
}

function nodeBundleKeyboard(cacheId: string) {
  return {
    inline_keyboard: [[{ text: "➕ 全部加入节点合集", callback_data: `save_nodes:${cacheId}` }]]
  };
}

function nodeCollectionKeyboard(nodeCount: number, backToList = false) {
  const inlineKeyboard = [
    [{ text: `🎯 选择节点生成 Mihomo (${nodeCount})`, callback_data: "select_nodes" }],
    [{ text: `⚡ 全部节点生成 Mihomo (${nodeCount})`, callback_data: "export_node_collection" }],
    [{ text: "📦 管理节点合集", callback_data: "manage_nodes" }]
  ];
  if (backToList) inlineKeyboard.push([{ text: "⬅️ 返回保存列表", callback_data: "cancel" }]);
  return { inline_keyboard: inlineKeyboard };
}

function mainKeyboard() {
  return { inline_keyboard: [[{ text: "查询已保存订阅", callback_data: "refresh" }]] };
}

function helpText(): string {
  return [
    "发送订阅链接，我会查询流量、过期时间和节点列表。",
    "",
    "可用命令：",
    "/sub 查询已保存订阅",
    "/help 查看帮助",
    "",
    "提示：订阅链接会按敏感信息处理，日志不会输出完整链接。"
  ].join("\n");
}

function mainKeyboardV2() {
  return {
    inline_keyboard: [
      [{ text: "查看已保存订阅", callback_data: "refresh" }],
      [{ text: "📡 机场稳定性监测", callback_data: "monitor_list" }]
    ]
  };
}

function privateSubMenuKeyboard() {
  return {
    keyboard: [[{ text: PRIVATE_SUB_MENU_TEXT }]],
    resize_keyboard: true,
    is_persistent: true
  };
}

function helpTextV2(): string {
  return [
    "发送订阅链接，我会查询流量、过期时间和节点列表。",
    "也可以一次发送多条节点链接，全部加入合集后生成 Mihomo 配置。",
    "",
    "可用命令：",
    "/whoami 查看自己的 Telegram user id",
    "/query <订阅或节点链接> 群聊里查询",
    "/sub 管理订阅与节点合集",
    "/monitor 选择机场并管理稳定性监测",
    "/monitorreport 查看已开启机场的稳定性汇总",
    "/users 管理员查看授权用户",
    "/allow <userId> 管理员授权用户",
    "/revoke <userId> 管理员取消授权用户",
    "/help 查看帮助",
    "",
    "未授权用户只能使用 /whoami。"
  ].join("\n");
}

function formatSubscriptionMessage(result: ParsedSubscription, subUrl: string, snapshotUpdatedAt?: string): FormattedText {
  const usableNodes = getUsableNodes(result.nodes);
  const protocols = countBy(usableNodes.map((node) => node.protocol));
  const regions = countBy(usableNodes.map((node) => node.region));
  const message = createFormattedText();

  appendLine(message, "📊 订阅查询结果");
  appendAirportNameLine(message, result.airportName);
  appendLine(message, `📦 格式: ${result.sourceType}`);
  if (snapshotUpdatedAt) {
    appendLine(message, `🕒 本地快照: ${formatIsoDateTime(snapshotUpdatedAt)}`);
    if (isSnapshotStale(snapshotUpdatedAt)) appendLine(message, "⚠️ 快照已超过 24 小时，数据可能已变化");
  }
  appendLine(message, "🔗 订阅链接:");
  appendCodeLine(message, subUrl);
  appendLine(message);

  if (result.userInfo) {
    const used = result.userInfo.upload + result.userInfo.download;
    appendBlockQuote(message, [
      `📈 已用/总量: ${formatBytes(used)} / ${formatBytes(result.userInfo.total)}`,
      `🟢 剩余流量: ${result.userInfo.total > 0 ? formatBytes(Math.max(result.userInfo.total - used, 0)) : "未知"}`,
      `⏳ 过期时间: ${result.userInfo.expire ? formatDate(result.userInfo.expire) : "长期有效"}`,
      `⌛ 剩余时间: ${formatExpireMinutes(result.userInfo.expire)}`,
      formatResetInfoLine(result.userInfo)
    ]);
  } else {
    appendBlockQuote(message, ["📈 流量详情: 订阅未提供流量头"]);
  }

  appendBlockQuote(message, [
    `🌐 节点总数: ${result.nodes.length}`,
    `✅ 可用节点: ${usableNodes.length}`,
    `🧩 协议类型: ${formatCounts(protocols) || "未知"}`,
    `🗺 国家/地区: ${formatRegionCounts(regions) || "未知"}`
  ]);

  return trimFormattedText(message);
}

function formatSubscriptionWithNodesMessage(cached: CachedSubscription, snapshotUpdatedAt?: string): FormattedText {
  const message = formatSubscriptionMessage(cached, cached.url, snapshotUpdatedAt);
  appendLine(message);
  appendBlockQuote(message, ["节点列表:", ...formatNodeListLines(cached.nodes)]);
  return clipFormattedText(trimFormattedText(message), 4096);
}

function formatSingleNodeMessage(uri: string): FormattedText {
  const node = parseNodeLines([uri])[0];
  const message = createFormattedText();
  if (!node) {
    appendLine(message, "节点解析失败：暂不支持这个节点格式。");
    return trimFormattedText(message);
  }

  appendLine(message, "节点解析结果");
  appendLine(message);
  appendBlockQuote(message, [
    `节点名称: ${node.name}`,
    `协议类型: ${node.protocol}`,
    `节点地区: ${node.region}`
  ]);
  appendLine(message, "节点链接:");
  appendCodeLine(message, uri);
  return trimFormattedText(message);
}

function formatNodeListLines(nodes: ParsedNode[]): string[] {
  const usableNodes = getUsableNodes(nodes);
  if (usableNodes.length === 0) {
    return ["未解析到真实代理节点。当前订阅内容可能只有说明、策略组，或使用了暂未支持的格式。"];
  }

  const visibleNodes = usableNodes.slice(0, 80);
  const lines = visibleNodes.map((node, index) => `${index + 1}. ${cleanDisplayText(node.name)} (${cleanDisplayText(node.protocol)})`);
  if (usableNodes.length > visibleNodes.length) {
    lines.push(`还有 ${usableNodes.length - visibleNodes.length} 个节点未显示。`);
  }
  return lines;
}

function createFormattedText(): FormattedText {
  return { text: "", entities: [] };
}

function appendLine(message: FormattedText, line = ""): void {
  message.text += `${line}\n`;
}

function appendAirportNameLine(message: FormattedText, airportName: string): void {
  const prefix = "📋 机场名称: ";
  const offset = message.text.length + prefix.length;
  message.text += `${prefix}${airportName}\n`;
  if (looksLikeHostname(airportName)) {
    message.entities.push({ type: "url", offset, length: airportName.length });
  }
}

function appendCodeLine(message: FormattedText, value: string): void {
  const offset = message.text.length;
  message.text += `${value}\n`;
  message.entities.push({ type: "code", offset, length: value.length });
}

function appendBlockQuote(message: FormattedText, lines: string[]): void {
  const block = lines.join("\n");
  const offset = message.text.length;
  message.text += `${block}\n`;
  if (block.length > 0) {
    message.entities.push({ type: "blockquote", offset, length: block.length });
  }
}

function trimFormattedText(message: FormattedText): FormattedText {
  while (message.text.endsWith("\n")) {
    const nextLength = message.text.length - 1;
    message.text = message.text.slice(0, nextLength);
    message.entities = message.entities
      .filter((entity) => entity.offset < nextLength)
      .map((entity) => ({ ...entity, length: Math.min(entity.length, nextLength - entity.offset) }))
      .filter((entity) => entity.length > 0);
  }
  return message;
}

function prependText(message: FormattedText, prefix: string): FormattedText {
  return { text: prefix + message.text, entities: message.entities.map((entity) => ({ ...entity, offset: entity.offset + prefix.length })) };
}

function clipFormattedText(message: FormattedText, maxLength: number): FormattedText {
  if (message.text.length <= maxLength) return message;
  const suffix = "\n\n还有更多内容无法显示。";
  const cutLength = Math.max(0, maxLength - suffix.length);
  const text = `${message.text.slice(0, cutLength)}${suffix}`;
  const entities = message.entities
    .filter((entity) => entity.offset < cutLength)
    .map((entity) => ({ ...entity, length: Math.min(entity.length, cutLength - entity.offset) }))
    .filter((entity) => entity.length > 0);
  return { text, entities };
}

function cleanDisplayText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function looksLikeHostname(value: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value.trim());
}
async function sendMessage(env: Env, chatId: number, text: string, replyMarkup?: unknown, replyToMessageId?: number): Promise<Record<string, any>> {
  return telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4096),
    disable_web_page_preview: true,
    reply_markup: replyMarkup,
    reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined
  });
}

async function sendTemporaryStatus(env: Env, chatId: number, text: string, replyToMessageId?: number): Promise<number | undefined> {
  const result = await sendMessage(env, chatId, text, undefined, replyToMessageId);
  const messageId = result.result?.message_id;
  return typeof messageId === "number" ? messageId : undefined;
}

async function deleteMessageSafely(env: Env, chatId: number, messageId: number): Promise<void> {
  try {
    await telegramApi(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch {
    // Ignore cleanup failures; the query result/error has already been sent.
  }
}

async function sendFormattedMessage(env: Env, chatId: number, content: FormattedText, replyMarkup?: unknown, replyToMessageId?: number): Promise<void> {
  const clipped = clipFormattedText(content, 4096);
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: clipped.text,
    entities: clipped.entities,
    disable_web_page_preview: true,
    reply_markup: replyMarkup,
    reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined
  });
}

async function editCallbackMessage(env: Env, callback: TelegramCallbackQuery, content: string | FormattedText, replyMarkup?: unknown): Promise<void> {
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;
  if (!chatId || !messageId) return;

  const payloadText = typeof content === "string" ? content.slice(0, 4096) : clipFormattedText(content, 4096).text;
  const payloadEntities = typeof content === "string" ? undefined : clipFormattedText(content, 4096).entities;

  try {
    await telegramApi(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: payloadText,
      entities: payloadEntities,
      disable_web_page_preview: true,
      reply_markup: replyMarkup
    });
  } catch (error) {
    if (!safeError(error).includes("message is not modified")) throw error;
  }
}

async function sendTextDocument(env: Env, chatId: number, filename: string, content: string, caption?: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([content], { type: "text/plain;charset=utf-8" }), filename);

  await telegramMultipartApi(env, "sendDocument", form);
}

async function sendJsonDocument(env: Env, chatId: number, filename: string, content: string, caption?: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([content], { type: "application/json;charset=utf-8" }), filename);

  await telegramMultipartApi(env, "sendDocument", form);
}

async function telegramApi(env: Env, method: string, payload: Record<string, unknown>): Promise<Record<string, any>> {
  if (!env.BOT_TOKEN) throw new Error("缺少 BOT_TOKEN");
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = (await response.json()) as Record<string, any>;
  if (!response.ok || result.ok === false) {
    throw new Error(typeof result.description === "string" ? result.description : "Telegram API 调用失败");
  }
  return result;
}

async function telegramMultipartApi(env: Env, method: string, form: FormData): Promise<Record<string, any>> {
  if (!env.BOT_TOKEN) throw new Error("缺少 BOT_TOKEN");
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    body: form
  });
  const result = (await response.json()) as Record<string, any>;
  if (!response.ok || result.ok === false) {
    throw new Error(typeof result.description === "string" ? result.description : "Telegram API 调用失败");
  }
  return result;
}

async function getSavedSubscriptions(env: Env, userId: number): Promise<SavedSubscriptionItem[]> {
  const key = savedSubscriptionsKey(userId);
  const existing = await env.SUB_KV.get<SavedSubscriptionItem[]>(key, "json");
  if (Array.isArray(existing)) {
    return existing.filter(isSavedSubscriptionItem);
  }

  const legacy = await env.SUB_KV.get<LegacySavedSubscription>(legacySavedSubscriptionKey(userId), "json");
  if (!legacy?.url) {
    return [];
  }

  const now = new Date().toISOString();
  const migrated: SavedSubscriptionItem[] = [{
    id: createSubscriptionId(),
    kind: "subscription",
    name: subscriptionNameFromUrl(legacy.url),
    url: legacy.url,
    createdAt: legacy.updatedAt || now,
    updatedAt: legacy.updatedAt || now
  }];
  await putSavedSubscriptions(env, userId, migrated);
  return migrated;
}

async function saveSubscription(env: Env, userId: number, cached: CachedSubscription): Promise<SavedSubscriptionItem> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  const now = new Date().toISOString();
  const existing = subscriptions.find((item) => item.url === cached.url);
  if (existing) {
    existing.name = savedSubscriptionName(cached);
    existing.airportName = cached.airportName;
    existing.updatedAt = now;
    existing.snapshotUpdatedAt = cached.updatedAt;
    existing.snapshotNodeCount = getUsableNodes(cached.nodes).length;
    existing.lastRefreshAttemptAt = now;
    existing.lastRefreshError = undefined;
    await putSavedSubscriptionSnapshot(env, userId, existing.id, cached);
    await putSavedSubscriptions(env, userId, subscriptions);
    return existing;
  }

  const item: SavedSubscriptionItem = {
    id: createSubscriptionId(),
    kind: "subscription",
    name: savedSubscriptionName(cached),
    url: cached.url,
    airportName: cached.airportName,
    createdAt: now,
    updatedAt: now,
    snapshotUpdatedAt: cached.updatedAt,
    snapshotNodeCount: getUsableNodes(cached.nodes).length,
    lastRefreshAttemptAt: now
  };
  subscriptions.push(item);
  await putSavedSubscriptionSnapshot(env, userId, item.id, cached);
  await putSavedSubscriptions(env, userId, subscriptions);
  return item;
}

function savedSubscriptionSnapshotKey(userId: number, subId: string): string {
  return `user:${userId}:subscription-snapshot:${subId}`;
}

async function getSavedSubscriptionSnapshot(env: Env, userId: number, subId: string): Promise<CachedSubscription | null> {
  return env.SUB_KV.get<CachedSubscription>(savedSubscriptionSnapshotKey(userId, subId), "json");
}

async function putSavedSubscriptionSnapshot(env: Env, userId: number, subId: string, snapshot: CachedSubscription): Promise<void> {
  await env.SUB_KV.put(savedSubscriptionSnapshotKey(userId, subId), JSON.stringify(snapshot));
}

async function saveNode(env: Env, userId: number, cached: CachedNode): Promise<SavedSubscriptionItem> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  const now = new Date().toISOString();
  const existing = subscriptions.find((item) => item.url === cached.uri);
  if (existing) {
    existing.kind = "node";
    existing.name = cached.name;
    existing.updatedAt = now;
    await putSavedSubscriptions(env, userId, subscriptions);
    return existing;
  }

  const item: SavedSubscriptionItem = {
    id: createSubscriptionId(),
    kind: "node",
    name: cached.name,
    url: cached.uri,
    createdAt: now,
    updatedAt: now
  };
  subscriptions.push(item);
  await putSavedSubscriptions(env, userId, subscriptions);
  return item;
}

async function saveNodes(env: Env, userId: number, cachedNodes: CachedNode[]): Promise<{ added: number; total: number }> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  const existingUris = new Set(subscriptions.filter((item) => savedItemKind(item) === "node").map((item) => item.url));
  const now = new Date().toISOString();
  let added = 0;
  for (const cached of cachedNodes) {
    if (existingUris.has(cached.uri)) continue;
    subscriptions.push({
      id: createSubscriptionId(),
      kind: "node",
      name: cached.name,
      url: cached.uri,
      createdAt: now,
      updatedAt: now
    });
    existingUris.add(cached.uri);
    added += 1;
  }
  if (added > 0) await putSavedSubscriptions(env, userId, subscriptions);
  return { added, total: existingUris.size };
}

async function getSavedNodeUris(env: Env, userId: number): Promise<string[]> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  return dedupeNodeUris(
    subscriptions
      .filter((item) => savedItemKind(item) === "node")
      .map((item) => item.url)
  );
}

async function getSavedNodeCount(env: Env, userId: number): Promise<number> {
  return (await getSavedNodeUris(env, userId)).length;
}

async function putSavedSubscriptions(env: Env, userId: number, subscriptions: SavedSubscriptionItem[]): Promise<void> {
  await env.SUB_KV.put(savedSubscriptionsKey(userId), JSON.stringify(subscriptions));
}

function savedSubscriptionsKey(userId: number): string {
  return `user:${userId}:subscriptions`;
}

function legacySavedSubscriptionKey(userId: number): string {
  return `user:${userId}:subscription`;
}

function isSavedSubscriptionItem(value: unknown): value is SavedSubscriptionItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SavedSubscriptionItem>;
  return (
    typeof item.id === "string" &&
    (item.kind === undefined || item.kind === "subscription" || item.kind === "node") &&
    typeof item.name === "string" &&
    typeof item.url === "string" &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string"
  );
}

function savedItemKind(item: SavedSubscriptionItem): "subscription" | "node" {
  return item.kind ?? "subscription";
}

function savedSubscriptionName(cached: CachedSubscription): string {
  const name = cached.airportName?.trim();
  return name || subscriptionNameFromUrl(cached.url);
}

function subscriptionNameFromUrl(value: string): string {
  try {
    const hostname = new URL(value).hostname.replace(/^api\./, "");
    return hostname || "未命名订阅";
  } catch {
    return "未命名订阅";
  }
}

async function getCachedSubscription(env: Env, userId: number, cacheId?: string): Promise<CachedSubscription | null> {
  if (cacheId) {
    return env.SUB_KV.get(`cache:${userId}:${cacheId}`, "json");
  }
  return env.SUB_KV.get(`cache:${userId}`, "json");
}

async function getCachedSubscriptionUrl(env: Env, userId: number, cacheId?: string): Promise<string | null> {
  if (!cacheId) return null;
  return env.SUB_KV.get(`cache-url:${userId}:${cacheId}`, "text");
}

async function cacheSubscription(env: Env, userId: number, cached: CachedSubscription, cacheId?: string): Promise<void> {
  const body = JSON.stringify(cached);
  await env.SUB_KV.put(`cache:${userId}`, body, { expirationTtl: CACHE_TTL_SECONDS });
  if (cacheId) {
    await env.SUB_KV.put(`cache:${userId}:${cacheId}`, body, { expirationTtl: CACHE_TTL_SECONDS });
    await env.SUB_KV.put(`cache-url:${userId}:${cacheId}`, cached.url);
  }
}

async function getCachedNode(env: Env, userId: number, cacheId?: string): Promise<CachedNode | null> {
  if (!cacheId) return null;
  return env.SUB_KV.get(`cache:node:${userId}:${cacheId}`, "json");
}

async function cacheNode(env: Env, userId: number, cached: CachedNode, cacheId: string): Promise<void> {
  await env.SUB_KV.put(`cache:node:${userId}:${cacheId}`, JSON.stringify(cached), { expirationTtl: CACHE_TTL_SECONDS });
}

async function getCachedNodeBundle(env: Env, userId: number, cacheId?: string): Promise<CachedNodeBundle | null> {
  if (!cacheId) return null;
  return env.SUB_KV.get(`cache:nodes:${userId}:${cacheId}`, "json");
}

async function cacheNodeBundle(env: Env, userId: number, cached: CachedNodeBundle, cacheId: string): Promise<void> {
  await env.SUB_KV.put(`cache:nodes:${userId}:${cacheId}`, JSON.stringify(cached), { expirationTtl: CACHE_TTL_SECONDS });
}

function createCacheId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function createSubscriptionId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function parseCallbackAction(data: string): CallbackAction {
  if (data === "cancel") return { name: "cancel" };

  const [name, value] = data.split(":", 2);
  if (["query_saved", "delete_saved", "confirm_delete_saved", "refresh_saved", "nodes_saved", "collapse_nodes_saved", "rename_saved", "replace_saved_source", "export_saved_mihomo", "reset_saved_mihomo", "toggle_node", "monitor_item", "monitor_enable", "monitor_pause"].includes(name)) {
    return { name, subId: value && /^[a-f0-9]{12}$/i.test(value) ? value : undefined };
  }
  if (["saved_page", "nodes_page", "node_selection_page", "monitor_page"].includes(name)) {
    const page = Number(value);
    return { name, page: Number.isInteger(page) && page >= 0 ? page : 0 };
  }

  return { name, cacheId: value && /^[a-f0-9]{12}$/i.test(value) ? value : undefined };
}

function callbackStatusText(actionName: string): string | undefined {
  if (actionName === "refresh_saved") return "正在刷新订阅…";
  if (["refresh", "nodes", "collapse_nodes"].includes(actionName)) return "正在查询订阅…";
  return undefined;
}

async function createShortLink(env: Env, userId: number, url: string, format: "yaml" | "mihomo"): Promise<string> {
  const shortId = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const payload: ShortSubscription = { kind: "subscription", url, format, createdBy: userId, createdAt: new Date().toISOString() };
  await env.SUB_KV.put(`short:${shortId}`, JSON.stringify(payload), { expirationTtl: SHORT_LINK_TTL_SECONDS });
  return shortId;
}

async function createNodeCollectionShortLink(env: Env, userId: number): Promise<string> {
  const shortId = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const payload: ShortSubscription = {
    kind: "node-collection",
    format: "mihomo",
    createdBy: userId,
    createdAt: new Date().toISOString()
  };
  await env.SUB_KV.put(`short:${shortId}`, JSON.stringify(payload), { expirationTtl: SHORT_LINK_TTL_SECONDS });
  return shortId;
}

async function createSelectedNodeCollectionShortLink(env: Env, userId: number, nodeIds: string[]): Promise<string> {
  const shortId = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const payload: ShortSubscription = {
    kind: "node-selection",
    nodeIds: [...new Set(nodeIds)],
    format: "mihomo",
    createdBy: userId,
    createdAt: new Date().toISOString()
  };
  await env.SUB_KV.put(`short:${shortId}`, JSON.stringify(payload), { expirationTtl: SHORT_LINK_TTL_SECONDS });
  return shortId;
}

function savedSubscriptionMihomoLinkKey(userId: number, subId: string): string {
  return `user:${userId}:saved-subscription-mihomo-link:${subId}`;
}

function pendingSavedSubscriptionSourceUpdateKey(userId: number): string {
  return `user:${userId}:pending-saved-subscription-source-update`;
}

function nodeSelectionKey(userId: number): string {
  return `user:${userId}:node-selection`;
}

async function getNodeSelection(env: Env, userId: number): Promise<NodeSelectionState | null> {
  const state = await env.SUB_KV.get<NodeSelectionState>(nodeSelectionKey(userId), "json");
  return state && Array.isArray(state.selectedIds) && state.selectedIds.every((id) => typeof id === "string") ? state : null;
}

async function putNodeSelection(env: Env, userId: number, selectedIds: string[]): Promise<void> {
  const state: NodeSelectionState = { selectedIds: [...new Set(selectedIds)] };
  await env.SUB_KV.put(nodeSelectionKey(userId), JSON.stringify(state), { expirationTtl: NODE_SELECTION_TTL_SECONDS });
}

async function getOrCreateSavedSubscriptionMihomoLink(env: Env, userId: number, subId: string): Promise<string> {
  const linkKey = savedSubscriptionMihomoLinkKey(userId, subId);
  const existingId = await env.SUB_KV.get(linkKey);
  if (existingId && /^[a-f0-9]{32}$/i.test(existingId)) {
    const existing = await env.SUB_KV.get<ShortSubscription>(`short:${existingId}`, "json");
    if (existing?.kind === "saved-subscription" && existing.createdBy === userId && existing.subId === subId && existing.format === "mihomo") {
      return existingId;
    }
  }

  const stableId = crypto.randomUUID().replace(/-/g, "");
  const payload: ShortSubscription = {
    kind: "saved-subscription",
    subId,
    format: "mihomo",
    createdBy: userId,
    createdAt: new Date().toISOString()
  };
  await env.SUB_KV.put(`short:${stableId}`, JSON.stringify(payload));
  await env.SUB_KV.put(linkKey, stableId);
  return stableId;
}

async function revokeSavedSubscriptionMihomoLink(env: Env, userId: number, subId: string): Promise<void> {
  const linkKey = savedSubscriptionMihomoLinkKey(userId, subId);
  const stableId = await env.SUB_KV.get(linkKey);
  if (stableId && /^[a-f0-9]{32}$/i.test(stableId)) {
    await env.SUB_KV.delete(`short:${stableId}`);
  }
  await env.SUB_KV.delete(linkKey);
}

async function resetSavedSubscriptionMihomoLink(env: Env, userId: number, subId: string): Promise<string> {
  await revokeSavedSubscriptionMihomoLink(env, userId, subId);
  return getOrCreateSavedSubscriptionMihomoLink(env, userId, subId);
}

async function exportShortLink(shortId: string, env: Env, userAgent: string): Promise<Response> {
  if (!/^(?:[a-z0-9]{10}|[a-f0-9]{32})$/i.test(shortId)) return new Response("Invalid short link", { status: 400 });
  const short = await env.SUB_KV.get<ShortSubscription>(`short:${shortId}`, "json");
  if (!short) return new Response("Short link not found or expired", { status: 404 });

  if (short.kind === "saved-subscription") {
    const subscriptions = await getSavedSubscriptions(env, short.createdBy);
    const item = subscriptions.find((subscription) => subscription.id === short.subId && savedItemKind(subscription) === "subscription");
    if (!item) return new Response("Saved subscription not found", { status: 404 });

    let cached: CachedSubscription | null = null;
    try {
      const result = await fetchAndParseSubscription(item.url, env);
      if (getUsableNodes(result.nodes).length === 0) throw new Error("subscription has no usable nodes");
      cached = { ...result, url: item.url, updatedAt: new Date().toISOString() };
    } catch {
      const snapshot = await getSavedSubscriptionSnapshot(env, short.createdBy, item.id);
      if (snapshot?.raw && getUsableNodes(snapshot.nodes).length > 0) {
        cached = snapshot;
      }
    }
    if (!cached) return new Response("Subscription upstream unavailable and no usable snapshot", { status: 502 });

    try {
      return new Response(generateMihomoSubscription(cached.raw), {
        headers: {
          "Content-Type": "text/yaml; charset=utf-8",
          "Profile-Update-Interval": "24"
        }
      });
    } catch (error) {
      if (error instanceof MihomoExportError) return new Response(error.message, { status: 422 });
      throw error;
    }
  }

  if (short.kind === "node") {
    if (!parseNodeLines([short.uri])[0]) return new Response("Invalid node link", { status: 422 });
    return new Response(encodeUtf8Base64(short.uri.trim()), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Profile-Update-Interval": "24"
      }
    });
  }

  if (short.kind === "node-selection") {
    const selectedIds = new Set(short.nodeIds);
    const uris = dedupeNodeUris(
      savedNodeItems(await getSavedSubscriptions(env, short.createdBy))
        .filter((item) => selectedIds.has(item.id))
        .map((item) => item.url)
    );
    if (uris.length === 0) return new Response("Selected nodes are empty or removed", { status: 404 });
    try {
      const generated = generateClashNodeSubscription(uris);
      return new Response(generateMihomoSubscription(generated.yaml), {
        headers: {
          "Content-Type": "text/yaml; charset=utf-8",
          "Profile-Update-Interval": "24"
        }
      });
    } catch (error) {
      if (error instanceof MihomoExportError) return new Response(error.message, { status: 422 });
      throw error;
    }
  }

  if (short.kind === "node-collection") {
    const uris = await getSavedNodeUris(env, short.createdBy);
    if (uris.length === 0) return new Response("Node collection is empty", { status: 404 });
    let body: string;
    try {
      const generated = generateClashNodeSubscription(uris);
      // Koipy/MiaoSpeed needs nodes only; embedded Mihomo DNS alters script-test resolution.
      body = short.format === "mihomo" && !userAgent.includes(KOIPY_SUBSCRIPTION_UA_MARKER)
        ? generateMihomoSubscription(generated.yaml)
        : generated.yaml;
    } catch (error) {
      if (error instanceof MihomoExportError) return new Response(error.message, { status: 422 });
      throw error;
    }
    return new Response(body, {
      headers: {
        "Content-Type": "text/yaml; charset=utf-8",
        "Profile-Update-Interval": "24",
        "Vary": "User-Agent"
      }
    });
  }

  const result = await fetchAndParseSubscription(short.url, env);
  const cached = { ...result, url: short.url, updatedAt: short.createdAt };
  let body: string;
  try {
    body = short.format === "mihomo"
      ? generateMihomoSubscription(cached.raw)
      : short.format === "yaml"
        ? toYamlSubscription(cached)
        : toBase64Subscription(cached);
  } catch (error) {
    if (error instanceof MihomoExportError) return new Response(error.message, { status: 422 });
    throw error;
  }
  const isYaml = short.format === "yaml" || short.format === "mihomo";
  return new Response(body, {
    headers: {
      "Content-Type": isYaml ? "text/yaml; charset=utf-8" : "text/plain; charset=utf-8",
      "Profile-Update-Interval": "24"
    }
  });
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function mihomoExportErrorMessage(error: unknown): string {
  const detail = error instanceof MihomoExportError ? error.message : safeError(error);
  return `Mihomo 导出失败：${detail}\n\n机场订阅需要标准 Clash/Mihomo YAML；手动节点合集当前可直接转换 VLESS 节点。`;
}

async function isAllowedUser(userId: number, env: Env): Promise<boolean> {
  const id = String(userId);
  if (isAdminUser(userId, env)) return true;
  if (parseUserIdList(env.ALLOWED_USER_IDS).has(id)) return true;
  return (await getKvAuthorizedUserIds(env)).has(id);
}

function isAdminUser(userId: number, env: Env): boolean {
  return parseUserIdList(env.ADMIN_USER_IDS).has(String(userId));
}

async function handleAllowCommand(message: TelegramMessage, env: Env, text: string): Promise<void> {
  const targetUserId = parseCommandUserId(text);
  if (!targetUserId) {
    await sendMessage(env, message.chat.id, "用法：/allow <userId>");
    return;
  }

  const admins = parseUserIdList(env.ADMIN_USER_IDS);
  const envAllowed = parseUserIdList(env.ALLOWED_USER_IDS);
  const kvAllowed = await getKvAuthorizedUserIds(env);
  if (admins.has(targetUserId) || envAllowed.has(targetUserId) || kvAllowed.has(targetUserId)) {
    await sendMessage(env, message.chat.id, `用户 ${targetUserId} 已授权`);
    return;
  }

  kvAllowed.add(targetUserId);
  await putKvAuthorizedUserIds(env, kvAllowed);
  await sendMessage(env, message.chat.id, `已授权用户 ${targetUserId}`);
}

async function handleRevokeCommand(message: TelegramMessage, env: Env, text: string): Promise<void> {
  const targetUserId = parseCommandUserId(text);
  if (!targetUserId) {
    await sendMessage(env, message.chat.id, "用法：/revoke <userId>");
    return;
  }

  if (parseUserIdList(env.ADMIN_USER_IDS).has(targetUserId)) {
    await sendMessage(env, message.chat.id, "不能取消授权管理员用户。");
    return;
  }

  if (parseUserIdList(env.ALLOWED_USER_IDS).has(targetUserId)) {
    await sendMessage(env, message.chat.id, "该用户来自环境变量白名单，请到 Cloudflare 环境变量中移除");
    return;
  }

  const kvAllowed = await getKvAuthorizedUserIds(env);
  if (!kvAllowed.has(targetUserId)) {
    await sendMessage(env, message.chat.id, `用户 ${targetUserId} 不在 KV 授权列表中。`);
    return;
  }

  kvAllowed.delete(targetUserId);
  await putKvAuthorizedUserIds(env, kvAllowed);
  await sendMessage(env, message.chat.id, `已取消授权用户 ${targetUserId}`);
}

async function formatAuthorizedUsersMessage(env: Env): Promise<string> {
  const admins = parseUserIdList(env.ADMIN_USER_IDS);
  const envAllowed = parseUserIdList(env.ALLOWED_USER_IDS);
  const kvAllowed = await getKvAuthorizedUserIds(env);
  const allUserIds = new Set([...admins, ...envAllowed, ...kvAllowed]);
  if (allUserIds.size === 0) {
    return "当前没有已授权用户。";
  }

  const lines = ["当前已授权用户列表："];
  for (const userId of sortUserIds(allUserIds)) {
    const labels: string[] = [];
    if (admins.has(userId)) labels.push("admin");
    if (envAllowed.has(userId)) labels.push("env allowlist");
    if (kvAllowed.has(userId)) labels.push("kv user");
    lines.push(`${userId} - ${labels.join(", ")}`);
  }
  return lines.join("\n");
}

async function getKvAuthorizedUserIds(env: Env): Promise<Set<string>> {
  try {
    const values = await env.SUB_KV.get<Array<string | number>>(AUTHORIZED_USERS_KEY, "json");
    if (!Array.isArray(values)) return new Set();
    return new Set(values.map((value) => normalizeUserId(value)).filter((value): value is string => value !== null));
  } catch (error) {
    console.error("failed to read authorized users", safeError(error));
    return new Set();
  }
}

async function putKvAuthorizedUserIds(env: Env, ids: Set<string>): Promise<void> {
  await env.SUB_KV.put(AUTHORIZED_USERS_KEY, JSON.stringify(sortUserIds(ids)));
}

function parseUserIdList(value?: string): Set<string> {
  return new Set((value ?? "").split(",").map((item) => normalizeUserId(item)).filter((item): item is string => item !== null));
}

function parseCommandUserId(text: string): string | null {
  return normalizeUserId(text.split(/\s+/)[1] ?? "");
}

function normalizeUserId(value: string | number): string | null {
  const id = String(value).trim();
  return /^\d{1,20}$/.test(id) ? id : null;
}

function sortUserIds(ids: Iterable<string>): string[] {
  return [...ids].sort((a, b) => {
    const left = BigInt(a);
    const right = BigInt(b);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

function extractQueryInput(text: string): QueryInput | null {
  const nodes = extractNodeUris(text);
  if (nodes.length === 1) return { kind: "node", uri: nodes[0] };
  if (nodes.length > 1) return { kind: "nodes", uris: nodes };

  const url = extractHttpUrl(text);
  if (url) return { kind: "subscription", url };

  return null;
}

function extractHttpUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  try {
    return new URL(match[0]).toString();
  } catch {
    return null;
  }
}

function extractNodeUris(text: string): string[] {
  return dedupeNodeUris(
    text.match(/\b(?:vless|vmess|ss|ssr|trojan|hysteria2|hy2|tuic|anytls):\/\/[^\s<>"']+/gi) ?? []
  );
}

function dedupeNodeUris(uris: string[]): string[] {
  return [...new Set(uris.map((uri) => uri.trim()).filter(Boolean))];
}

function formatSubscriptionHttpError(status: number, viaProxy = false): string {
  if (status === 403) return viaProxy ? "订阅代理返回 403" : "订阅服务器返回 403";
  if (status === 401) return "订阅服务器返回 401，请检查订阅链接 token 是否有效";
  if (status === 404) return "订阅服务器返回 404，请检查订阅链接是否正确";
  if (status === 429) return "订阅服务器返回 429，请稍后再试";
  if (status >= 500 && viaProxy) return `订阅代理返回 ${status}`;
  return `订阅服务器返回 ${status}`;
}

function maskUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of ["token", "key", "sub", "password", "pass", "OwO"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "***");
    }
    return url.toString();
  } catch {
    return "[invalid url]";
  }
}

function detectAirportName(url: string, raw: string, headers?: Headers): string {
  const headerName = detectAirportNameFromHeaders(headers);
  if (headerName) return headerName;

  const yamlName = raw.match(/^\s*(?:profile|airport|subscription)?\s*name\s*:\s*['"]?([^'"\n]+)['"]?\s*$/im)?.[1]?.trim();
  if (yamlName && yamlName.length <= 40) return yamlName;

  const host = safeHostname(url);
  const knownNames: Array<[RegExp, string]> = [
    [/nekocloud/i, "Neko Cloud"],
    [/liangxin/i, "良心云"],
    [/seele/i, "Seele Cloud"],
    [/hinetlove/i, "Seele Cloud"],
    [/zznot/i, "ZZNot"],
    [/tag/i, "TAG"]
  ];
  return knownNames.find(([pattern]) => pattern.test(host))?.[1] ?? host.replace(/^api\./, "");
}

function detectAirportNameFromHeaders(headers?: Headers): string | null {
  if (!headers) return null;

  for (const key of ["profile-title", "profile-web-title", "subscription-title", "x-subscription-title"]) {
    const value = cleanAirportName(headers.get(key));
    if (value) return value;
  }

  return cleanAirportName(parseContentDispositionFilename(headers.get("content-disposition")));
}

function parseContentDispositionFilename(value: string | null): string | null {
  if (!value) return null;

  const encodedMatch = value.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')?([^;]+)/i);
  if (encodedMatch) return safeDecodeURIComponent(trimHeaderValue(encodedMatch[1]));

  const filenameMatch = value.match(/filename\s*=\s*([^;]+)/i);
  if (filenameMatch) return trimHeaderValue(filenameMatch[1]);

  return null;
}

function trimHeaderValue(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function cleanAirportName(value: string | null): string | null {
  const cleaned = value?.replace(/\.(yaml|yml|txt|conf)$/i, "").trim();
  if (!cleaned || cleaned.length > 60) return null;
  return cleaned;
}

function safeHostname(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "未知机场";
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function escapeCode(value: string): string {
  return value.replace(/[`\\]/g, "\\$&");
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatDate(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 10);
}

function formatExpireMinutes(timestampSeconds: number | null): string {
  if (!timestampSeconds) return "长期有效";
  return formatDurationUntil(timestampSeconds * 1000);
}

function formatResetDay(resetDay: number | null): string {
  if (!resetDay || resetDay < 1 || resetDay > 31) return "未知";
  return `每月 ${resetDay} 日`;
}

function formatResetInfoLine(userInfo: SubscriptionUserInfo): string {
  if (userInfo.resetDay && userInfo.resetDay >= 1 && userInfo.resetDay <= 31) {
    const nextResetAt = estimateNextMonthlyResetAt(userInfo.resetDay);
    return nextResetAt
      ? `🔁 流量重置: 预计还有 ${formatDaysUntil(nextResetAt * 1000)}（${formatResetDay(userInfo.resetDay)}）`
      : `🔁 流量重置: ${formatResetDay(userInfo.resetDay)}`;
  }
  if (userInfo.resetEstimated && userInfo.nextResetAt) {
    return `🔁 预计重置: 还有 ${formatDaysUntil(userInfo.nextResetAt * 1000)}`;
  }
  if (userInfo.expire) {
    const nextResetAt = estimateNextMonthlyResetAt(new Date(userInfo.expire * 1000).getUTCDate());
    if (nextResetAt) return `🔁 流量重置: 订阅未提供（按到期日估算：还有 ${formatDaysUntil(nextResetAt * 1000)}）`;
  }
  return "🔁 流量重置: 未知";
}

function estimateNextMonthlyResetAt(day: number): number | null {
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  const now = new Date();
  for (let offset = 0; offset < 12; offset += 1) {
    const candidateMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const timestamp = timestampFromUtcDate(candidateMonth.getUTCFullYear(), candidateMonth.getUTCMonth() + 1, day);
    if (timestamp && timestamp * 1000 > Date.now()) return timestamp;
  }
  return null;
}

function formatDateTime(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function formatIsoDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date).replaceAll("/", "-");
}

function isSnapshotStale(value: string): boolean {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp > SNAPSHOT_STALE_MS;
}

function formatDaysUntil(timestampMs: number): string {
  const days = Math.max(0, Math.ceil((timestampMs - Date.now()) / (24 * 60 * 60 * 1000)));
  return days === 0 ? "今天" : `${days} 天`;
}

function formatDurationUntil(timestampMs: number): string {
  const minutes = Math.max(0, Math.ceil((timestampMs - Date.now()) / 60000));
  return formatDurationMinutes(minutes);
}

function formatDurationMinutes(totalMinutes: number): string {
  const minutes = Math.max(0, Math.ceil(totalMinutes));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainMinutes = minutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0 || days > 0) parts.push(`${hours} 小时`);
  parts.push(`${remainMinutes} 分钟`);
  return parts.join(" ");
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function formatCounts(counts: Map<string, number>): string {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(" / ");
}

function formatRegionCounts(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${regionFlag(name)} ${name} ${count}`.trim())
    .join(" / ");
}

function regionFlag(name: string): string {
  const flags: Record<string, string> = {
    香港: "🇭🇰",
    台湾: "🇹🇼",
    日本: "🇯🇵",
    新加坡: "🇸🇬",
    美国: "🇺🇸",
    韩国: "🇰🇷",
    英国: "🇬🇧",
    德国: "🇩🇪",
    法国: "🇫🇷"
  };
  return flags[name] ?? "";
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripYamlQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/https?:\/\/[^\s]+/g, "[masked-url]");
  return "未知错误";
}

function webAppHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>订阅查询</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --line: #d8dde5;
      --text: #17202a;
      --muted: #667085;
      --primary: #176b87;
      --primary-dark: #0f5268;
      --danger: #b42318;
      --ok: #047857;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font: 15px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(1040px, calc(100% - 32px));
      margin: 0 auto;
      padding: 28px 0 36px;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: end;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0;
      font-size: 26px;
      line-height: 1.2;
      font-weight: 750;
      letter-spacing: 0;
    }
    .status {
      min-height: 24px;
      color: var(--muted);
      text-align: right;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(280px, .85fr);
      gap: 16px;
      align-items: start;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 16px;
      line-height: 1.3;
      letter-spacing: 0;
    }
    label {
      display: block;
      color: var(--muted);
      font-size: 13px;
      margin: 12px 0 6px;
    }
    input, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--text);
      background: #fff;
      padding: 10px 11px;
      font: inherit;
    }
    textarea {
      min-height: 112px;
      resize: vertical;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text);
      margin: 12px 0;
    }
    .check input {
      width: 16px;
      height: 16px;
    }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    button {
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 9px 13px;
      min-height: 38px;
      cursor: pointer;
      font: inherit;
      background: #eef2f6;
      color: var(--text);
    }
    button.primary {
      background: var(--primary);
      color: #fff;
    }
    button.primary:hover { background: var(--primary-dark); }
    button.danger {
      color: var(--danger);
      background: #fff5f5;
      border-color: #ffd0d0;
    }
    button:disabled {
      cursor: wait;
      opacity: .72;
    }
    .result {
      margin-top: 16px;
      display: grid;
      gap: 10px;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px;
      min-height: 74px;
    }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 4px;
    }
    .metric strong {
      display: block;
      overflow-wrap: anywhere;
    }
    .saved-list {
      display: grid;
      gap: 9px;
    }
    .saved-item {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px;
    }
    .saved-title {
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .saved-meta {
      color: var(--muted);
      font-size: 12px;
      margin: 3px 0 9px;
    }
    .saved-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .empty {
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 6px;
      padding: 16px;
      text-align: center;
    }
    .ok { color: var(--ok); }
    .error { color: var(--danger); }
    @media (max-width: 760px) {
      main { width: min(100% - 20px, 1040px); padding-top: 18px; }
      header { display: block; }
      .status { text-align: left; margin-top: 8px; }
      .layout, .row, .metrics { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>订阅查询</h1>
      <div id="status" class="status"></div>
    </header>
    <div class="layout">
      <section>
        <h2>查询</h2>
        <form id="queryForm">
          <div class="row">
            <div>
              <label for="userId">Telegram user id</label>
              <input id="userId" name="userId" inputmode="numeric" autocomplete="username" required>
            </div>
            <div>
              <label for="webToken">Web token</label>
              <input id="webToken" name="webToken" type="password" autocomplete="current-password">
            </div>
          </div>
          <label for="subUrl">订阅链接</label>
          <textarea id="subUrl" name="subUrl" required></textarea>
          <label class="check">
            <input id="saveSub" type="checkbox" checked>
            <span>保存到这个用户的订阅列表</span>
          </label>
          <div class="actions">
            <button class="primary" type="submit">查询</button>
            <button id="loadSaved" type="button">刷新列表</button>
          </div>
        </form>
        <div id="result" class="result"></div>
      </section>
      <section>
        <h2>保存列表</h2>
        <div id="savedList" class="saved-list"></div>
      </section>
    </div>
  </main>
  <script>
    const userId = document.getElementById("userId");
    const webToken = document.getElementById("webToken");
    const subUrl = document.getElementById("subUrl");
    const saveSub = document.getElementById("saveSub");
    const statusEl = document.getElementById("status");
    const resultEl = document.getElementById("result");
    const savedListEl = document.getElementById("savedList");
    const queryForm = document.getElementById("queryForm");
    const loadSaved = document.getElementById("loadSaved");

    userId.value = localStorage.getItem("tgSubUserId") || "";
    webToken.value = localStorage.getItem("tgSubWebToken") || "";

    function setBusy(busy) {
      for (const button of document.querySelectorAll("button")) button.disabled = busy;
    }

    function setStatus(text, type) {
      statusEl.textContent = text || "";
      statusEl.className = "status " + (type || "");
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, function (char) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
      });
    }

    async function api(path, data) {
      localStorage.setItem("tgSubUserId", userId.value.trim());
      localStorage.setItem("tgSubWebToken", webToken.value);
      const response = await fetch(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-web-token": webToken.value
        },
        body: JSON.stringify(Object.assign({ user_id: userId.value.trim() }, data || {}))
      });
      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || "请求失败");
      }
      return payload;
    }

    function renderResult(payload) {
      if (payload.node) {
        const node = payload.node;
        resultEl.innerHTML = node.ok
          ? '<div class="metric"><span>节点</span><strong>' + escapeHtml(node.name) + '</strong><div>' + escapeHtml(node.protocol) + ' / ' + escapeHtml(node.region) + '</div></div>'
          : '<div class="empty">节点解析失败</div>';
        return;
      }

      const result = payload.result;
      if (!result) {
        resultEl.innerHTML = "";
        return;
      }

      const traffic = result.traffic;
      resultEl.innerHTML =
        '<div class="metrics">' +
        metric("机场名称", result.airportName) +
        metric("格式", result.sourceType) +
        metric("已用/总量", traffic ? traffic.used + " / " + traffic.total : "订阅未提供") +
        metric("剩余流量", traffic ? traffic.remaining : "未知") +
        metric("过期时间", traffic ? traffic.expireDate + "（" + traffic.expireIn + "）" : "未知") +
        metric("流量重置", traffic ? traffic.reset : "未知") +
        metric("节点", result.nodes.usable + " / " + result.nodes.total) +
        metric("协议", result.nodes.protocols) +
        '</div>' +
        '<div class="metric"><span>国家/地区</span><strong>' + escapeHtml(result.nodes.regions) + '</strong></div>';
    }

    function metric(label, value) {
      return '<div class="metric"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>';
    }

    function renderSaved(items) {
      if (!items || items.length === 0) {
        savedListEl.innerHTML = '<div class="empty">暂无保存订阅</div>';
        return;
      }
      savedListEl.innerHTML = items.map(function (item) {
        return '<div class="saved-item">' +
          '<div class="saved-title">' + escapeHtml(item.name) + '</div>' +
          '<div class="saved-meta">' + escapeHtml(item.kind) + ' / 更新 ' + escapeHtml(String(item.updatedAt || "").slice(0, 10)) + '</div>' +
          '<div class="saved-actions">' +
          '<button type="button" data-query="' + escapeHtml(item.id) + '">查询</button>' +
          (item.kind === "subscription" ? '<button type="button" data-refresh="' + escapeHtml(item.id) + '">手动刷新</button>' : '') +
          '<button class="danger" type="button" data-delete="' + escapeHtml(item.id) + '">删除</button>' +
          '</div>' +
          '</div>';
      }).join("");
    }

    async function refreshSaved() {
      if (!userId.value.trim()) return;
      const payload = await api("/web/saved");
      renderSaved(payload.subscriptions);
    }

    queryForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      setBusy(true);
      setStatus("查询中...");
      try {
        const payload = await api("/web/query", { url: subUrl.value, save: saveSub.checked });
        renderResult(payload);
        renderSaved(payload.subscriptions);
        setStatus(payload.saved ? "已查询并保存" : "已查询", "ok");
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        setBusy(false);
      }
    });

    loadSaved.addEventListener("click", async function () {
      setBusy(true);
      setStatus("读取中...");
      try {
        await refreshSaved();
        setStatus("列表已刷新", "ok");
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        setBusy(false);
      }
    });

    savedListEl.addEventListener("click", async function (event) {
      const button = event.target.closest("button");
      if (!button) return;
      const queryId = button.getAttribute("data-query");
      const refreshId = button.getAttribute("data-refresh");
      const deleteId = button.getAttribute("data-delete");
      setBusy(true);
      setStatus(queryId ? "查询中..." : refreshId ? "手动刷新中..." : "删除中...");
      try {
        const payload = await api(queryId || refreshId ? "/web/query-saved" : "/web/delete-saved", { id: queryId || refreshId || deleteId, refresh: Boolean(refreshId) });
        renderResult(payload);
        renderSaved(payload.subscriptions);
        setStatus(queryId ? "查询完成" : refreshId ? "刷新完成" : "已删除", "ok");
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        setBusy(false);
      }
    });

    refreshSaved().catch(function () {});
  </script>
</body>
</html>`;
}

function webAdminHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>订阅管理后台</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --line: #d8dde5;
      --text: #17202a;
      --muted: #667085;
      --primary: #176b87;
      --primary-dark: #0f5268;
      --danger: #b42318;
      --ok: #047857;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font: 15px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(1120px, calc(100% - 32px));
      margin: 0 auto;
      padding: 28px 0 36px;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: end;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0;
      font-size: 26px;
      line-height: 1.2;
      font-weight: 750;
      letter-spacing: 0;
    }
    a { color: var(--primary); text-decoration: none; }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    label {
      display: block;
      color: var(--muted);
      font-size: 13px;
      margin: 0 0 6px;
    }
    input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--text);
      background: #fff;
      padding: 10px 11px;
      font: inherit;
    }
    button {
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 9px 13px;
      min-height: 38px;
      cursor: pointer;
      font: inherit;
      background: var(--primary);
      color: #fff;
    }
    button:hover { background: var(--primary-dark); }
    button:disabled {
      cursor: wait;
      opacity: .72;
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(180px, .8fr) minmax(180px, .8fr) auto;
      gap: 12px;
      align-items: end;
    }
    .status {
      min-height: 24px;
      color: var(--muted);
      text-align: right;
    }
    .ok { color: var(--ok); }
    .error { color: var(--danger); }
    .summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .metric, .user {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 12px;
      background: #fff;
    }
    .metric span, .meta {
      color: var(--muted);
      font-size: 12px;
    }
    .metric strong {
      display: block;
      font-size: 20px;
      margin-top: 3px;
    }
    .users {
      display: grid;
      gap: 10px;
    }
    .user-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: start;
      margin-bottom: 10px;
    }
    .user-id {
      font-weight: 750;
      overflow-wrap: anywhere;
    }
    .labels {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 4px;
    }
    .label {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .subs {
      display: grid;
      gap: 8px;
    }
    .sub {
      border-top: 1px solid var(--line);
      padding-top: 8px;
    }
    .sub-title {
      font-weight: 650;
      overflow-wrap: anywhere;
    }
    .url {
      margin-top: 4px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .empty {
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 6px;
      padding: 16px;
      text-align: center;
    }
    @media (max-width: 760px) {
      main { width: min(100% - 20px, 1120px); padding-top: 18px; }
      header { display: block; }
      .status { text-align: left; margin-top: 8px; }
      .toolbar, .summary { grid-template-columns: 1fr; }
      .user-head { display: block; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>订阅管理后台</h1>
        <div class="meta"><a href="/">返回查询页</a></div>
      </div>
      <div id="status" class="status"></div>
    </header>
    <section>
      <div class="toolbar">
        <div>
          <label for="adminName">管理员账号</label>
          <input id="adminName" autocomplete="username" required>
        </div>
        <div>
          <label for="webToken">密码</label>
          <input id="webToken" type="password" autocomplete="current-password" required>
        </div>
        <button id="loadUsers" type="button">加载后台</button>
      </div>
    </section>
    <section>
      <div id="summary" class="summary"></div>
      <div id="users" class="users"></div>
    </section>
  </main>
  <script>
    const adminName = document.getElementById("adminName");
    const webToken = document.getElementById("webToken");
    const loadUsers = document.getElementById("loadUsers");
    const statusEl = document.getElementById("status");
    const summaryEl = document.getElementById("summary");
    const usersEl = document.getElementById("users");

    adminName.value = localStorage.getItem("tgSubAdminName") || "imzwr";
    webToken.value = localStorage.getItem("tgSubWebToken") || "";

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, function (char) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
      });
    }

    function setStatus(text, type) {
      statusEl.textContent = text || "";
      statusEl.className = "status " + (type || "");
    }

    async function loadAdminUsers() {
      localStorage.setItem("tgSubAdminName", adminName.value.trim());
      localStorage.setItem("tgSubWebToken", webToken.value);
      loadUsers.disabled = true;
      setStatus("加载中...");
      try {
        const response = await fetch("/web/admin/users", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-web-token": webToken.value
          },
          body: JSON.stringify({ admin: adminName.value.trim() })
        });
        const payload = await response.json();
        if (!response.ok || payload.ok === false) throw new Error(payload.error || "请求失败");
        renderAdmin(payload.users || []);
        setStatus("已加载", "ok");
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        loadUsers.disabled = false;
      }
    }

    function renderAdmin(users) {
      const totalSubs = users.reduce(function (sum, user) { return sum + user.subscriptionCount; }, 0);
      const activeUsers = users.filter(function (user) { return user.subscriptionCount > 0; }).length;
      summaryEl.innerHTML =
        metric("用户数", users.length) +
        metric("有保存订阅的用户", activeUsers) +
        metric("保存项总数", totalSubs);

      if (users.length === 0) {
        usersEl.innerHTML = '<div class="empty">暂无用户</div>';
        return;
      }

      usersEl.innerHTML = users.map(renderUser).join("");
    }

    function metric(label, value) {
      return '<div class="metric"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>';
    }

    function renderUser(user) {
      const labels = (user.labels || []).map(function (label) {
        return '<span class="label">' + escapeHtml(label) + '</span>';
      }).join("");
      const subs = user.subscriptions.length === 0
        ? '<div class="empty">没有保存订阅</div>'
        : '<div class="subs">' + user.subscriptions.map(renderSub).join("") + '</div>';
      return '<div class="user">' +
        '<div class="user-head">' +
        '<div><div class="user-id">' + escapeHtml(user.userId) + '</div><div class="labels">' + labels + '</div></div>' +
        '<div class="meta">' + escapeHtml(user.subscriptionCount) + ' 个保存项</div>' +
        '</div>' +
        subs +
        '</div>';
    }

    function renderSub(item) {
      return '<div class="sub">' +
        '<div class="sub-title">' + escapeHtml(item.name) + '</div>' +
        '<div class="meta">' + escapeHtml(item.kind) + ' / 创建 ' + escapeHtml(String(item.createdAt || "").slice(0, 10)) + ' / 更新 ' + escapeHtml(String(item.updatedAt || "").slice(0, 10)) + '</div>' +
        '<div class="url">' + escapeHtml(item.url) + '</div>' +
        '</div>';
    }

    loadUsers.addEventListener("click", loadAdminUsers);
  </script>
</body>
</html>`;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
