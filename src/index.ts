interface Env {
  BOT_TOKEN: string;
  ALLOWED_USER_IDS: string;
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

interface SavedSubscription {
  url: string;
  updatedAt: string;
}

interface ShortSubscription {
  url: string;
  format: "base64" | "yaml";
  createdBy: number;
  createdAt: string;
}

interface TelegramMessageEntity {
  type: "code";
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
}

const CACHE_TTL_SECONDS = 60 * 30;
const SHORT_LINK_TTL_SECONDS = 60 * 60 * 24 * 30;
const REQUEST_TIMEOUT_MS = 8000;
const PREFERRED_UA = "clash-verge/v2.0.0";

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
  return json({ ok: result.ok === true, webhook: webhookUrl, description: result.description ?? "" });
}

async function debugSubscription(url: URL, env: Env): Promise<Response> {
  if (!env.DEBUG_TOKEN || url.searchParams.get("token") !== env.DEBUG_TOKEN) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const userId = Number(url.searchParams.get("user_id") ?? "");
  const targetUrl = url.searchParams.get("url");
  if (!userId || !isAllowedUser(userId, env)) {
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
  if (!userId || !isAllowedUser(userId, env)) {
    await sendMessage(env, message.chat.id, "未授权用户，已拒绝访问。");
    return;
  }

  const text = (message.text ?? "").trim();
  const command = text.split(/\s+/)[0]?.replace(/@[A-Za-z0-9_]+$/, "") ?? "";
  if (command === "/start" || command === "/help") {
    await sendMessage(env, message.chat.id, helpText(), mainKeyboard());
    return;
  }

  if (command === "/sub") {
    const saved = await getSavedSubscription(env, userId);
    if (!saved) {
      await sendMessage(env, message.chat.id, "还没有保存订阅。请先发送订阅链接，然后点击“保存订阅”。");
      return;
    }
    await queryAndSend(saved.url, userId, message.chat.id, env);
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
    await sendFormattedMessage(env, message.chat.id, formatSingleNodeMessage(input.uri), undefined, message.message_id);
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

  if (!isAllowedUser(userId, env)) {
    await sendMessage(env, chatId, "未授权用户，已拒绝访问。");
    return;
  }

  const cached = await getCachedSubscription(env, userId, action.cacheId);
  if (!cached && action.name !== "refresh") {
    await sendMessage(env, chatId, "缓存已过期，请重新发送订阅链接或使用 /sub。");
    return;
  }

  if (action.name === "refresh") {
    const saved = await getSavedSubscription(env, userId);
    const subUrl = cached?.url ?? saved?.url;
    if (!subUrl) {
      await sendMessage(env, chatId, "没有可刷新的订阅，请先发送订阅链接。");
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
    await saveSubscription(env, userId, cached.url);
    await sendMessage(env, chatId, "已保存当前订阅。以后发送 /sub 可直接查询。");
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
      const result: ParsedSubscription = {
        raw,
        userInfo: parseSubscriptionUserInfo(response.headers.get("subscription-userinfo")),
        nodes: parsed.nodes,
        sourceType: parsed.sourceType,
        airportName: detectAirportName(url, raw)
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

function parseSubscriptionUserInfo(value: string | null): SubscriptionUserInfo | null {
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
  if (upload === 0 && download === 0 && total === 0 && expire === null && resetDay === null) return null;
  return { upload, download, total, expire, resetDay };
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
  if (cached.sourceType === "yaml") return "subscription.yaml";
  if (cached.sourceType === "base64") return "subscription-base64.txt";
  return "subscription.txt";
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

function formatSubscriptionMessage(result: ParsedSubscription, subUrl: string): FormattedText {
  const usableNodes = getUsableNodes(result.nodes);
  const protocols = countBy(usableNodes.map((node) => node.protocol));
  const regions = countBy(usableNodes.map((node) => node.region));
  const message = createFormattedText();

  appendLine(message, "📊 订阅查询结果");
  appendLine(message, `📋 机场名称: ${result.airportName}`);
  appendLine(message, `📦 格式: ${result.sourceType}`);
  appendLine(message, "🔗 订阅链接:");
  appendCodeLine(message, subUrl);
  appendLine(message);

  if (result.userInfo) {
    const used = result.userInfo.upload + result.userInfo.download;
    appendTextBlock(message, [
      `📈 已用/总量: ${formatBytes(used)} / ${formatBytes(result.userInfo.total)}`,
      `🟢 剩余流量: ${result.userInfo.total > 0 ? formatBytes(Math.max(result.userInfo.total - used, 0)) : "未知"}`,
      `⏳ 过期时间: ${result.userInfo.expire ? formatDate(result.userInfo.expire) : "长期有效"}`,
      `⌛ 剩余时间: ${formatExpireMinutes(result.userInfo.expire)}`,
      `🔁 流量重置: ${formatResetDay(result.userInfo.resetDay)}`
    ]);
  } else {
    appendTextBlock(message, ["📈 流量详情: 订阅未提供流量头"]);
  }

  appendTextBlock(message, [
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
  appendTextBlock(message, ["节点列表:", ...formatNodeListLines(cached.nodes)]);
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
  appendTextBlock(message, [
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

function appendCodeLine(message: FormattedText, value: string): void {
  const offset = message.text.length;
  message.text += `${value}\n`;
  message.entities.push({ type: "code", offset, length: value.length });
}

function appendTextBlock(message: FormattedText, lines: string[]): void {
  const block = lines.join("\n");
  message.text += `${block}\n`;
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

async function getSavedSubscription(env: Env, userId: number): Promise<SavedSubscription | null> {
  return env.SUB_KV.get(`user:${userId}:subscription`, "json");
}

async function saveSubscription(env: Env, userId: number, url: string): Promise<void> {
  await env.SUB_KV.put(`user:${userId}:subscription`, JSON.stringify({ url, updatedAt: new Date().toISOString() }));
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

function createCacheId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function parseCallbackAction(data: string): CallbackAction {
  const [name, cacheId] = data.split(":", 2);
  return { name, cacheId: cacheId && /^[a-f0-9]{12}$/i.test(cacheId) ? cacheId : undefined };
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

function isAllowedUser(userId: number, env: Env): boolean {
  const ids = env.ALLOWED_USER_IDS.split(",").map((item) => item.trim()).filter(Boolean);
  return ids.length > 0 && ids.includes(String(userId));
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

function detectAirportName(url: string, raw: string): string {
  const yamlName = raw.match(/^\s*(?:profile|airport|subscription)?\s*name\s*:\s*['"]?([^'"\n]+)['"]?\s*$/im)?.[1]?.trim();
  if (yamlName && yamlName.length <= 40) return yamlName;

  const host = safeHostname(url);
  const knownNames: Array<[RegExp, string]> = [
    [/nekocloud/i, "Neko Cloud"],
    [/liangxin/i, "良心云"],
    [/zznot/i, "ZZNot"],
    [/tag/i, "TAG"]
  ];
  return knownNames.find(([pattern]) => pattern.test(host))?.[1] ?? host.replace(/^api\./, "");
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
