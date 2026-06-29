interface Env {
  BOT_TOKEN: string;
  ADMIN_USER_IDS?: string;
  ALLOWED_USER_IDS?: string;
  DEBUG_TOKEN?: string;
  SETUP_TOKEN?: string;
  SUB_FETCH_PREFIX?: string;
  SUB_FETCH_PROXY?: string;
  SUB_KV: KVNamespace;
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
  | { kind: "node"; uri: string };

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

interface LegacySavedSubscription {
  url: string;
  updatedAt: string;
}

interface SavedSubscriptionItem {
  id: string;
  kind?: "subscription" | "node";
  name: string;
  url: string;
  airportName?: string;
  createdAt: string;
  updatedAt: string;
  lastQueryAt?: string;
}

interface ShortSubscription {
  url: string;
  format: "base64" | "yaml";
  createdBy: number;
  createdAt: string;
}

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
}

const CACHE_TTL_SECONDS = 60 * 30;
const SHORT_LINK_TTL_SECONDS = 60 * 60 * 24 * 30;
const REQUEST_TIMEOUT_MS = 8000;
const PREFERRED_UA = "clash-verge/v2.0.0";
const AUTHORIZED_USERS_KEY = "authorized_users";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/") {
        return json({ ok: true, message: "bot running" });
      }

      if (request.method === "GET" && url.pathname === "/setup") {
        return setupWebhook(request, env, url);
      }

      if (request.method === "GET" && url.pathname === "/debug/subscription") {
        return debugSubscription(url, env);
      }

      if (request.method === "GET" && url.pathname.startsWith("/s/")) {
        return exportShortLink(url.pathname.slice(3), env);
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
    { command: "query", description: "群聊查询：/query 订阅链接" },
    { command: "sub", description: "查看自己的订阅列表" },
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
  const text = (message.text ?? "").trim();
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
    return;
  }

  if (command === "/sub") {
    await sendSubscriptionList(env, message.chat.id, userId);
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

  await queryAndSend(input.url, userId, message.chat.id, env, message.message_id);
}

async function handleCallback(callback: TelegramCallbackQuery, request: Request, env: Env): Promise<void> {
  const userId = callback.from.id;
  const chatId = callback.message?.chat.id;
  const data = callback.data ?? "";
  const action = parseCallbackAction(data);
  await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id });

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

  if (action.name === "query_saved" && action.subId) {
    await querySavedSubscription(action.subId, userId, callback, env);
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
    await sendMessage(env, chatId, `已保存节点：${saved.name}\n以后发送 /sub 可以查看自己的保存列表。`);
    return;
  }

  const cached = await getCachedSubscription(env, userId, action.cacheId);
  if (!cached && action.name !== "refresh") {
    await sendMessage(env, chatId, "缓存已过期，请重新发送订阅链接或使用 /sub。");
    return;
  }

  if (action.name === "refresh") {
    const saved = await getSavedSubscriptions(env, userId);
    const subUrl = cached?.url ?? (saved.length === 1 ? saved[0].url : undefined);
    if (!subUrl) {
      await editCallbackMessage(env, callback, formatSubscriptionListText(saved), subscriptionListKeyboard(saved));
      return;
    }
    await queryAndEdit(subUrl, userId, callback, env, action.cacheId);
    return;
  }

  if (action.name === "nodes" && cached) {
    await editCallbackMessage(env, callback, formatSubscriptionWithNodesMessage(cached), actionKeyboard(true, action.cacheId));
    return;
  }

  if (action.name === "collapse_nodes" && cached) {
    await editCallbackMessage(env, callback, formatSubscriptionMessage(cached, cached.url), actionKeyboard(false, action.cacheId));
    return;
  }

  if (action.name === "export_base64" && cached) {
    await editOrSendLongCallbackText(env, callback, chatId, toBase64Subscription(cached), action.cacheId);
    return;
  }

  if (action.name === "export_yaml" && cached) {
    await sendTextDocument(env, chatId, rawSubscriptionFilename(cached), cached.raw.trim(), "原始订阅文件已生成");
    return;
  }

  if (action.name === "save" && cached) {
    const saved = await saveSubscription(env, userId, cached);
    await sendMessage(env, chatId, `已保存订阅：${saved.name}\n以后发送 /sub 可以查看自己的订阅列表。`);
    return;
  }

  if (action.name === "short_link" && cached) {
    const shortId = await createShortLink(env, userId, cached.url);
    const origin = new URL(request.url).origin;
    await editCallbackMessage(env, callback, `短链已生成：\n${origin}/s/${shortId}`, actionKeyboard(false, action.cacheId));
    return;
  }

  await sendMessage(env, chatId, "暂不支持这个操作。");
}

async function queryAndSend(subUrl: string, userId: number, chatId: number, env: Env, replyToMessageId?: number): Promise<void> {
  try {
    const result = await fetchAndParseSubscription(subUrl, env);
    const cacheId = createCacheId();
    await cacheSubscription(env, userId, { url: subUrl, updatedAt: new Date().toISOString(), ...result }, cacheId);
    await sendFormattedMessage(env, chatId, formatSubscriptionMessage(result, subUrl), actionKeyboard(false, cacheId), replyToMessageId);
  } catch (error) {
    await sendMessage(env, chatId, `订阅查询失败：${safeError(error)}`, undefined, replyToMessageId);
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

async function queryAndEdit(subUrl: string, userId: number, callback: TelegramCallbackQuery, env: Env, existingCacheId?: string): Promise<void> {
  try {
    const result = await fetchAndParseSubscription(subUrl, env);
    const cacheId = existingCacheId ?? createCacheId();
    await cacheSubscription(env, userId, { url: subUrl, updatedAt: new Date().toISOString(), ...result }, cacheId);
    await editCallbackMessage(env, callback, formatSubscriptionMessage(result, subUrl), actionKeyboard(false, cacheId));
  } catch (error) {
    await editCallbackMessage(env, callback, `订阅查询失败：${safeError(error)}`, actionKeyboard(false, existingCacheId));
  }
}

async function sendSubscriptionList(env: Env, chatId: number, userId: number): Promise<void> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  await sendMessage(env, chatId, formatSubscriptionListText(subscriptions), subscriptionListKeyboard(subscriptions));
}

function formatSubscriptionListText(subscriptions: SavedSubscriptionItem[]): string {
  if (subscriptions.length === 0) {
    return "还没有保存订阅或节点。请先发送链接，查询成功后点击保存。";
  }

  const lines = ["你的保存列表："];
  for (const [index, item] of subscriptions.entries()) {
    const updatedAt = item.updatedAt.slice(0, 10);
    const kindLabel = savedItemKind(item) === "node" ? "节点" : "订阅";
    lines.push(`${index + 1}. [${kindLabel}] ${item.name}（更新：${updatedAt}）`);
  }
  return lines.join("\n");
}

function subscriptionListKeyboard(subscriptions: SavedSubscriptionItem[]) {
  if (subscriptions.length === 0) return undefined;

  return {
    inline_keyboard: subscriptions.map((item, index) => [
      { text: `查询 ${index + 1}`, callback_data: `query_saved:${item.id}` },
      { text: `删除 ${index + 1}`, callback_data: `delete_saved:${item.id}` }
    ])
  };
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
    await editCallbackMessage(env, callback, formatSingleNodeMessage(item.url));
    return;
  }

  try {
    const result = await fetchAndParseSubscription(item.url, env);
    const cacheId = createCacheId();
    await cacheSubscription(env, userId, { url: item.url, updatedAt: new Date().toISOString(), ...result }, cacheId);
    await touchSavedSubscriptionLastQueryAt(env, userId, subId);
    await editCallbackMessage(env, callback, formatSubscriptionMessage(result, item.url), actionKeyboard(false, cacheId));
  } catch (error) {
    await editCallbackMessage(env, callback, `订阅查询失败：${safeError(error)}`, subscriptionListKeyboard(subscriptions));
  }
}

async function confirmDeleteSavedSubscription(subId: string, userId: number, callback: TelegramCallbackQuery, env: Env): Promise<void> {
  const subscriptions = await getSavedSubscriptions(env, userId);
  const item = subscriptions.find((subscription) => subscription.id === subId);
  if (!item) {
    await editCallbackMessage(env, callback, "订阅不存在或已经删除。", subscriptionListKeyboard(subscriptions));
    return;
  }

  await editCallbackMessage(env, callback, `确认删除订阅“${item.name}”？`, {
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
  await editCallbackMessage(env, callback, `已删除订阅：${item.name}\n\n${formatSubscriptionListText(nextSubscriptions)}`, subscriptionListKeyboard(nextSubscriptions));
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

function safeDocumentBasename(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function actionKeyboard(nodesExpanded = false, cacheId?: string) {
  const callback = (name: string) => cacheId ? `${name}:${cacheId}` : name;
  return {
    inline_keyboard: [
      [
        { text: "🔄 刷新订阅信息", callback_data: callback("refresh") },
        nodesExpanded
          ? { text: "📄 折叠全部节点", callback_data: callback("collapse_nodes") }
          : { text: "📄 显示全部节点", callback_data: callback("nodes") }
      ],
      [
        { text: "📥 导出Base64", callback_data: callback("export_base64") },
        { text: "📥 导出原始订阅", callback_data: callback("export_yaml") }
      ],
      [
        { text: "🔗 生成短链", callback_data: callback("short_link") },
        { text: "💾 保存订阅", callback_data: callback("save") }
      ]
    ]
  };
}

function nodeActionKeyboard(cacheId?: string) {
  return {
    inline_keyboard: [
      [{ text: "保存节点", callback_data: cacheId ? `save_node:${cacheId}` : "save_node" }]
    ]
  };
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
  return { inline_keyboard: [[{ text: "查看已保存订阅", callback_data: "refresh" }]] };
}

function helpTextV2(): string {
  return [
    "发送订阅链接，我会查询流量、过期时间和节点列表。",
    "",
    "可用命令：",
    "/whoami 查看自己的 Telegram user id",
    "/query <订阅链接> 群聊里查询订阅",
    "/sub 查看自己的订阅列表",
    "/users 管理员查看授权用户",
    "/allow <userId> 管理员授权用户",
    "/revoke <userId> 管理员取消授权用户",
    "/help 查看帮助",
    "",
    "未授权用户只能使用 /whoami。"
  ].join("\n");
}

function formatSubscriptionMessage(result: ParsedSubscription, subUrl: string): FormattedText {
  const usableNodes = getUsableNodes(result.nodes);
  const protocols = countBy(usableNodes.map((node) => node.protocol));
  const regions = countBy(usableNodes.map((node) => node.region));
  const message = createFormattedText();

  appendLine(message, "📊 订阅查询结果");
  appendAirportNameLine(message, result.airportName);
  appendLine(message, `📦 格式: ${result.sourceType}`);
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

function formatSubscriptionWithNodesMessage(cached: CachedSubscription): FormattedText {
  const message = formatSubscriptionMessage(cached, cached.url);
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
async function sendMessage(env: Env, chatId: number, text: string, replyMarkup?: unknown, replyToMessageId?: number): Promise<void> {
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4096),
    disable_web_page_preview: true,
    reply_markup: replyMarkup,
    reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined
  });
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

async function editOrSendLongCallbackText(env: Env, callback: TelegramCallbackQuery, chatId: number, text: string, cacheId?: string): Promise<void> {
  if (text.length <= 4096) {
    await editCallbackMessage(env, callback, text, actionKeyboard(false, cacheId));
    return;
  }
  await editCallbackMessage(env, callback, text.slice(0, 3900), actionKeyboard(false, cacheId));
  await sendLongText(env, chatId, text.slice(3900));
}

async function sendLongText(env: Env, chatId: number, text: string): Promise<void> {
  for (let start = 0; start < text.length; start += 3900) {
    await sendMessage(env, chatId, text.slice(start, start + 3900));
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
    updatedAt: now
  };
  subscriptions.push(item);
  await putSavedSubscriptions(env, userId, subscriptions);
  return item;
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

async function cacheSubscription(env: Env, userId: number, cached: CachedSubscription, cacheId?: string): Promise<void> {
  const body = JSON.stringify(cached);
  await env.SUB_KV.put(`cache:${userId}`, body, { expirationTtl: CACHE_TTL_SECONDS });
  if (cacheId) {
    await env.SUB_KV.put(`cache:${userId}:${cacheId}`, body, { expirationTtl: CACHE_TTL_SECONDS });
  }
}

async function getCachedNode(env: Env, userId: number, cacheId?: string): Promise<CachedNode | null> {
  if (!cacheId) return null;
  return env.SUB_KV.get(`cache:node:${userId}:${cacheId}`, "json");
}

async function cacheNode(env: Env, userId: number, cached: CachedNode, cacheId: string): Promise<void> {
  await env.SUB_KV.put(`cache:node:${userId}:${cacheId}`, JSON.stringify(cached), { expirationTtl: CACHE_TTL_SECONDS });
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
  if (["query_saved", "delete_saved", "confirm_delete_saved"].includes(name)) {
    return { name, subId: value && /^[a-f0-9]{12}$/i.test(value) ? value : undefined };
  }

  return { name, cacheId: value && /^[a-f0-9]{12}$/i.test(value) ? value : undefined };
}

async function createShortLink(env: Env, userId: number, url: string): Promise<string> {
  const shortId = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const payload: ShortSubscription = { url, format: "base64", createdBy: userId, createdAt: new Date().toISOString() };
  await env.SUB_KV.put(`short:${shortId}`, JSON.stringify(payload), { expirationTtl: SHORT_LINK_TTL_SECONDS });
  return shortId;
}

async function exportShortLink(shortId: string, env: Env): Promise<Response> {
  if (!/^[a-z0-9]{10}$/i.test(shortId)) return new Response("Invalid short link", { status: 400 });
  const short = await env.SUB_KV.get<ShortSubscription>(`short:${shortId}`, "json");
  if (!short) return new Response("Short link not found or expired", { status: 404 });

  const result = await fetchAndParseSubscription(short.url, env);
  const cached = { ...result, url: short.url, updatedAt: short.createdAt };
  const body = short.format === "yaml" ? toYamlSubscription(cached) : toBase64Subscription(cached);
  return new Response(body, {
    headers: {
      "Content-Type": short.format === "yaml" ? "text/yaml; charset=utf-8" : "text/plain; charset=utf-8",
      "Profile-Update-Interval": "24"
    }
  });
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
  const node = extractNodeUri(text);
  if (node) return { kind: "node", uri: node };

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

function extractNodeUri(text: string): string | null {
  const match = text.match(/\b(?:vless|vmess|ss|ssr|trojan|hysteria2|hy2|tuic|anytls):\/\/[^\s<>"']+/i);
  return match?.[0] ?? null;
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
    return `🔁 流量重置: ${formatResetDay(userInfo.resetDay)}`;
  }
  if (userInfo.resetEstimated && userInfo.nextResetAt) {
    return `🔁 预计重置: ${formatDateTime(userInfo.nextResetAt)}`;
  }
  if (userInfo.expire) {
    return `🔁 流量重置: 订阅未提供（按到期日估算：每月 ${new Date(userInfo.expire * 1000).getUTCDate()} 日）`;
  }
  return "🔁 流量重置: 未知";
}

function formatDateTime(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 16).replace("T", " ");
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
