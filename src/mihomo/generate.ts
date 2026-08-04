import { parse, stringify } from "yaml";

type MihomoConfig = Record<string, unknown>;
type MihomoGroup = Record<string, unknown>;

interface RegionDefinition {
  name: string;
  filter: string;
  icon: string;
}

const HEALTH_CHECK_URL = "https://cp.cloudflare.com/generate_204";
const HEALTH_CHECK_INTERVAL = 600;
const NOTICE_FILTER = "(?i)(剩余|流量|到期|过期|套餐|官网|重置|traffic|expire|reset)";
const ICON_BASE = "https://cdn.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color";

const REGION_DEFINITIONS: RegionDefinition[] = [
  { name: "香港节点", filter: "(?i)(香港|hong.?kong|🇭🇰|(^|[^a-z])hk([^a-z]|$))", icon: `${ICON_BASE}/Hong_Kong.png` },
  { name: "台湾节点", filter: "(?i)(台湾|台灣|taiwan|🇹🇼|(^|[^a-z])tw([^a-z]|$))", icon: `${ICON_BASE}/Taiwan.png` },
  { name: "新加坡节点", filter: "(?i)(新加坡|狮城|singapore|🇸🇬|(^|[^a-z])sg([^a-z]|$))", icon: `${ICON_BASE}/Singapore.png` },
  { name: "日本节点", filter: "(?i)(日本|东京|大阪|japan|🇯🇵|(^|[^a-z])jp([^a-z]|$))", icon: `${ICON_BASE}/Japan.png` },
  { name: "美国节点", filter: "(?i)(美国|美國|united.?states|america|🇺🇸|(^|[^a-z])(us|usa)([^a-z]|$))", icon: `${ICON_BASE}/United_States.png` },
  { name: "英国节点", filter: "(?i)(英国|英國|united.?kingdom|britain|🇬🇧|(^|[^a-z])(uk|gb)([^a-z]|$))", icon: `${ICON_BASE}/United_Kingdom.png` },
  { name: "德国节点", filter: "(?i)(德国|德國|germany|🇩🇪|(^|[^a-z])de([^a-z]|$))", icon: `${ICON_BASE}/Germany.png` },
  { name: "法国节点", filter: "(?i)(法国|法國|法属|france|🇫🇷|(^|[^a-z])fr([^a-z]|$))", icon: `${ICON_BASE}/France.png` },
  { name: "印度节点", filter: "(?i)(印度|india|🇮🇳|(^|[^a-z])in([^a-z]|$))", icon: `${ICON_BASE}/India.png` },
  { name: "印度尼西亚节点", filter: "(?i)(印度尼西亚|印尼|indonesia|🇮🇩|(^|[^a-z])id([^a-z]|$))", icon: `${ICON_BASE}/Indonesia.png` },
  { name: "澳门节点", filter: "(?i)(澳门|澳門|macao|macau|🇲🇴|(^|[^a-z])mo([^a-z]|$))", icon: `${ICON_BASE}/Macao.png` },
  { name: "菲律宾节点", filter: "(?i)(菲律宾|菲律賓|philippines|🇵🇭|(^|[^a-z])ph([^a-z]|$))", icon: `${ICON_BASE}/Philippines.png` },
  { name: "马来西亚节点", filter: "(?i)(马来西亚|馬來西亞|malaysia|🇲🇾|(^|[^a-z])my([^a-z]|$))", icon: `${ICON_BASE}/Malaysia.png` },
  { name: "泰国节点", filter: "(?i)(泰国|泰國|thailand|🇹🇭|(^|[^a-z])th([^a-z]|$))", icon: `${ICON_BASE}/Thailand.png` },
  { name: "澳大利亚节点", filter: "(?i)(澳大利亚|澳大利亞|澳洲|australia|🇦🇺|(^|[^a-z])au([^a-z]|$))", icon: `${ICON_BASE}/Australia.png` },
  { name: "韩国节点", filter: "(?i)(韩国|韓國|korea|🇰🇷|(^|[^a-z])kr([^a-z]|$))", icon: `${ICON_BASE}/Korea.png` },
  { name: "加拿大节点", filter: "(?i)(加拿大|canada|🇨🇦|(^|[^a-z])ca([^a-z]|$))", icon: `${ICON_BASE}/Canada.png` },
  { name: "阿根廷节点", filter: "(?i)(阿根廷|argentina|🇦🇷|(^|[^a-z])ar([^a-z]|$))", icon: `${ICON_BASE}/Argentina.png` },
  { name: "芬兰节点", filter: "(?i)(芬兰|芬蘭|finland|🇫🇮|(^|[^a-z])fi([^a-z]|$))", icon: `${ICON_BASE}/Finland.png` },
  { name: "土耳其节点", filter: "(?i)(土耳其|turkey|türkiye|🇹🇷|(^|[^a-z])tr([^a-z]|$))", icon: `${ICON_BASE}/Turkey.png` },
  { name: "俄罗斯节点", filter: "(?i)(俄罗斯|俄羅斯|russia|🇷🇺|(^|[^a-z])ru([^a-z]|$))", icon: `${ICON_BASE}/Russia.png` },
  { name: "埃塞俄比亚节点", filter: "(?i)(埃塞俄比亚|埃塞俄比亞|ethiopia|🇪🇹|(^|[^a-z])et([^a-z]|$))", icon: `${ICON_BASE}/Ethiopia.png` },
  { name: "乌克兰节点", filter: "(?i)(乌克兰|烏克蘭|ukraine|🇺🇦|(^|[^a-z])ua([^a-z]|$))", icon: `${ICON_BASE}/Ukraine.png` },
  { name: "埃及节点", filter: "(?i)(埃及|egypt|🇪🇬|(^|[^a-z])eg([^a-z]|$))", icon: `${ICON_BASE}/Egypt.png` }
];

const CUSTOM_RULE_PROVIDERS: Record<string, MihomoConfig> = {
  TGSub_ADBlock: {
    type: "http",
    behavior: "domain",
    format: "mrs",
    interval: 86400,
    url: "https://cdn.jsdelivr.net/gh/217heidai/adblockfilters@main/rules/adblockmihomolite.mrs",
    path: "./ruleset/tgsub-adblock.mrs"
  },
  TGSub_SogouInput: {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url: "https://ruleset.skk.moe/Clash/non_ip/sogouinput.txt",
    path: "./ruleset/tgsub-sogouinput.txt"
  },
  TGSub_StaticResources: {
    type: "http",
    behavior: "domain",
    format: "text",
    interval: 86400,
    url: "https://ruleset.skk.moe/Clash/domainset/cdn.txt",
    path: "./ruleset/tgsub-static-resources.txt"
  },
  TGSub_CDNResources: {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url: "https://ruleset.skk.moe/Clash/non_ip/cdn.txt",
    path: "./ruleset/tgsub-cdn-resources.txt"
  },
  TGSub_TikTok: ruleProvider("https://cdn.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/TikTok.list", "tgsub-tiktok.list"),
  TGSub_EHentai: ruleProvider("https://cdn.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/EHentai.list", "tgsub-ehentai.list"),
  TGSub_SteamFix: ruleProvider("https://cdn.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/SteamFix.list", "tgsub-steam-fix.list"),
  TGSub_GoogleFCM: ruleProvider("https://cdn.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/FirebaseCloudMessaging.list", "tgsub-google-fcm.list"),
  TGSub_AdditionalFilter: ruleProvider("https://cdn.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/AdditionalFilter.list", "tgsub-additional-filter.list"),
  TGSub_AdditionalCDNResources: ruleProvider("https://cdn.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/AdditionalCDNResources.list", "tgsub-additional-cdn-resources.list"),
  TGSub_Crypto: ruleProvider("https://cdn.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/Crypto.list", "tgsub-crypto.list"),
  TGSub_Weibo: ruleProvider("https://cdn.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/Weibo.list", "tgsub-weibo.list")
};

const CUSTOM_RULES = [
  "DST-PORT,22,SSH",
  "RULE-SET,TGSub_ADBlock,广告拦截",
  "RULE-SET,TGSub_AdditionalFilter,广告拦截",
  "DOMAIN-SUFFIX,nodeseek.com,Nodeseek",
  "DOMAIN-SUFFIX,seek.li,Nodeseek",
  "DOMAIN-KEYWORD,nodeseek,Nodeseek",
  "DOMAIN-KEYWORD,emby,Emby",
  "RULE-SET,TGSub_SogouInput,搜狗输入法",
  "DOMAIN-SUFFIX,truthsocial.com,Truth Social",
  "RULE-SET,TGSub_StaticResources,静态资源",
  "RULE-SET,TGSub_CDNResources,静态资源",
  "RULE-SET,TGSub_AdditionalCDNResources,静态资源",
  "RULE-SET,TGSub_Crypto,加密货币",
  "RULE-SET,TGSub_EHentai,E-Hentai",
  "RULE-SET,TGSub_TikTok,TikTok",
  "RULE-SET,TGSub_SteamFix,直连",
  "RULE-SET,TGSub_GoogleFCM,直连",
  "RULE-SET,TGSub_Weibo,新浪微博",
  "GEOSITE,youtube,YouTube",
  "GEOSITE,telegram,Telegram",
  "GEOSITE,google-play@cn,直连",
  "GEOSITE,microsoft@cn,直连",
  "GEOSITE,apple,苹果服务",
  "GEOSITE,microsoft,微软服务",
  "GEOSITE,google,谷歌服务",
  "GEOSITE,netflix,Netflix",
  "GEOSITE,spotify,Spotify",
  "GEOSITE,bahamut,巴哈姆特",
  "GEOSITE,bilibili,哔哩哔哩",
  "GEOSITE,pikpak,PikPak网盘",
  "GEOSITE,twitter,Twitter",
  "GEOSITE,category-ai-!cn,AI服务",
  "GEOSITE,gfw,选择代理",
  "GEOSITE,cn,直连",
  "GEOSITE,private,直连",
  "GEOIP,netflix,Netflix,no-resolve",
  "GEOIP,telegram,Telegram,no-resolve",
  "GEOIP,cn,直连",
  "GEOIP,private,直连"
];

export class MihomoExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MihomoExportError";
  }
}

export function generateMihomoSubscription(raw: string): string {
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch {
    throw new MihomoExportError("订阅不是有效的 Clash/Mihomo YAML");
  }

  if (!isRecord(parsed)) {
    throw new MihomoExportError("订阅不是标准 Clash/Mihomo YAML 配置");
  }

  const config: MihomoConfig = { ...parsed };
  const proxyNames = recordArray(config.proxies)
    .map((proxy) => typeof proxy.name === "string" ? proxy.name.trim() : "")
    .filter(Boolean);
  const proxyProviders = isRecord(config["proxy-providers"]) ? config["proxy-providers"] : {};
  if (proxyNames.length === 0 && Object.keys(proxyProviders).length === 0) {
    throw new MihomoExportError("当前订阅没有可用的 Mihomo proxies 或 proxy-providers");
  }

  config["geodata-mode"] = true;
  config["geox-url"] = {
    geoip: "https://cdn.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geoip.dat",
    geosite: "https://cdn.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geosite.dat",
    mmdb: "https://cdn.jsdelivr.net/gh/Loyalsoldier/geoip@release/Country.mmdb",
    asn: "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/GeoLite2-ASN.mmdb",
    ...recordValue(config["geox-url"])
  };

  const sourceSniffer = recordValue(config.sniffer);
  config.sniffer = {
    enable: true,
    "override-destination": false,
    "force-dns-mapping": true,
    "skip-domain": ["Mijia Cloud", "dlg.io.mi.com", "+.push.apple.com"],
    ...sourceSniffer,
    sniff: {
      TLS: { ports: [443, 8443] },
      HTTP: { ports: [80, 8080, 8880] },
      QUIC: { ports: [443, 8443] },
      ...recordValue(sourceSniffer.sniff)
    }
  };

  const sourceDns = recordValue(config.dns);
  const mergedDns = {
    enable: true,
    ipv6: true,
    "prefer-h3": true,
    "enhanced-mode": "fake-ip",
    "default-nameserver": ["119.29.29.29", "223.5.5.5"],
    nameserver: ["system", "223.5.5.5", "119.29.29.29", "180.184.1.1"],
    fallback: [
      "quic://dns0.eu",
      "https://dns.cloudflare.com/dns-query",
      "https://dns.sb/dns-query",
      "tcp://208.67.222.222",
      "tcp://8.26.56.2"
    ],
    "proxy-server-nameserver": ["https://dns.alidns.com/dns-query", "tls://dot.pub"],
    ...sourceDns
  };
  config.dns = {
    ...mergedDns,
    enable: true,
    ipv6: true,
    "fake-ip-filter": uniqueStrings([
      "geosite:private",
      "geosite:connectivity-check",
      "geosite:cn",
      "Mijia Cloud",
      "dlg.io.mi.com",
      "localhost.ptlogin2.qq.com",
      "*.icloud.com",
      "*.stun.*.*",
      "*.stun.*.*.*",
      ...stringArray(sourceDns["fake-ip-filter"])
    ])
  };

  config["rule-providers"] = {
    ...recordValue(config["rule-providers"]),
    ...CUSTOM_RULE_PROVIDERS
  };

  const sourceGroups = recordArray(config["proxy-groups"]);
  const generatedGroups = buildProxyGroups();
  const generatedNames = new Set(generatedGroups.map(groupName).filter(Boolean));
  generatedNames.add("GLOBAL");
  const preservedGroups = sourceGroups.filter((group) => {
    const name = groupName(group);
    return name && !generatedNames.has(name);
  });
  const allGroups = [...generatedGroups, ...preservedGroups];
  const globalGroup = buildGlobalGroup(allGroups);
  config["proxy-groups"] = [...allGroups, globalGroup];

  const sourceRules = stringArray(config.rules).filter((rule) => !/^\s*(MATCH|FINAL),/i.test(rule));
  config.rules = [...CUSTOM_RULES, ...sourceRules, "MATCH,选择代理"];

  return `${stringify(config, { indent: 2, lineWidth: 0 }).trimEnd()}\n`;
}

export function generateClashNodeSubscription(nodeUris: string[]): string {
  const normalizedUris = nodeUris.map((uri) => uri.trim()).filter(Boolean);
  const inlineProxies = normalizedUris
    .map((uri, index) => toMihomoVlessProxy(uri, index))
    .filter((proxy): proxy is MihomoConfig => proxy !== null);
  ensureUniqueProxyNames(inlineProxies);
  if (inlineProxies.length === 0) throw new MihomoExportError("节点合集没有可导出的 VLESS 节点");
  if (inlineProxies.length !== normalizedUris.length) {
    throw new MihomoExportError("Clash / Koipy 节点合集目前只支持 VLESS 节点");
  }
  return `${stringify({ proxies: inlineProxies }, { indent: 2, lineWidth: 0 }).trimEnd()}\n`;
}

function toMihomoVlessProxy(uri: string, index: number): MihomoConfig | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "vless:") return null;

  const uuid = decodeUriPart(url.username);
  const server = url.hostname;
  const port = Number(url.port);
  if (!uuid || !server || !Number.isInteger(port) || port < 1 || port > 65535) return null;

  const query = url.searchParams;
  const security = query.get("security")?.toLowerCase() ?? "none";
  const network = query.get("type")?.toLowerCase() || "tcp";
  const sni = query.get("sni") || query.get("servername") || "";
  const host = query.get("host") || sni;
  const proxy: MihomoConfig = {
    name: decodeUriPart(url.hash.slice(1)).trim() || `VLESS ${index + 1}`,
    type: "vless",
    server,
    port,
    uuid,
    network,
    udp: true
  };

  const flow = query.get("flow");
  if (flow) proxy.flow = flow;
  const fingerprint = query.get("fp");
  if (fingerprint) proxy["client-fingerprint"] = fingerprint;
  if (security === "tls" || security === "reality") {
    proxy.tls = true;
    if (sni) proxy.servername = sni;
    const alpn = query.get("alpn")?.split(",").map((item) => item.trim()).filter(Boolean);
    if (alpn?.length) proxy.alpn = alpn;
    if (["1", "true"].includes(query.get("allowInsecure")?.toLowerCase() ?? "")) proxy["skip-cert-verify"] = true;
  }
  if (security === "reality") {
    const publicKey = query.get("pbk");
    const shortId = query.get("sid");
    if (!publicKey) return null;
    proxy["reality-opts"] = {
      "public-key": publicKey,
      ...(shortId ? { "short-id": shortId } : {})
    };
  }

  if (network === "ws") {
    proxy["ws-opts"] = {
      path: query.get("path") || "/",
      ...(host ? { headers: { Host: host } } : {})
    };
  } else if (network === "grpc") {
    const serviceName = query.get("serviceName") || query.get("service-name");
    if (serviceName) proxy["grpc-opts"] = { "grpc-service-name": serviceName };
  } else if (network === "httpupgrade") {
    proxy["http-upgrade-opts"] = {
      path: query.get("path") || "/",
      ...(host ? { headers: { Host: host } } : {})
    };
  } else if (network === "xhttp") {
    proxy["xhttp-opts"] = {
      path: query.get("path") || "/",
      ...(query.get("mode") ? { mode: query.get("mode") } : {})
    };
  }
  return proxy;
}

function decodeUriPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function ensureUniqueProxyNames(proxies: MihomoConfig[]): void {
  const counts = new Map<string, number>();
  for (const proxy of proxies) {
    const baseName = typeof proxy.name === "string" ? proxy.name : "VLESS";
    const count = (counts.get(baseName) ?? 0) + 1;
    counts.set(baseName, count);
    if (count > 1) proxy.name = `${baseName} ${count}`;
  }
}

function buildProxyGroups(): MihomoGroup[] {
  const regionNames = REGION_DEFINITIONS.map((region) => region.name);
  const sharedSelectProxies = ["选择代理", ...regionNames, "手动选择", "直连"];
  const groups: MihomoGroup[] = [
    {
      name: "选择代理",
      type: "select",
      icon: `${ICON_BASE}/Proxy.png`,
      proxies: ["自动选择", "故障转移", ...regionNames, "手动选择", "DIRECT"]
    },
    {
      name: "手动选择",
      type: "select",
      icon: "https://cdn.jsdelivr.net/gh/shindgewongxj/WHATSINStash@master/icon/select.png",
      "include-all": true,
      "exclude-filter": NOTICE_FILTER,
      proxies: ["DIRECT"]
    },
    serviceGroup("静态资源", "Cloudflare.png", sharedSelectProxies),
    {
      name: "AI服务",
      type: "select",
      icon: `${ICON_BASE}/ChatGPT.png`,
      proxies: ["选择代理", "自动选择", "手动选择", "DIRECT"],
      "include-all": true,
      filter: "(?i)(ai|gpt|chatgpt|openai|claude|gemini|copilot|解锁)"
    },
    serviceGroup("加密货币", "Cryptocurrency_1.png", sharedSelectProxies),
    serviceGroup("苹果服务", "Apple_2.png", sharedSelectProxies),
    serviceGroup("谷歌服务", "Google.png", sharedSelectProxies, "https://cdn.jsdelivr.net/gh/Orz-3/mini@master/Color/Google.png"),
    serviceGroup("微软服务", "Microsoft.png", sharedSelectProxies),
    serviceGroup("YouTube", "YouTube.png", sharedSelectProxies),
    serviceGroup("Netflix", "Netflix.png", sharedSelectProxies),
    serviceGroup("TikTok", "TikTok.png", sharedSelectProxies),
    serviceGroup("Spotify", "Spotify.png", sharedSelectProxies),
    serviceGroup("Telegram", "Telegram_X.png", sharedSelectProxies),
    serviceGroup("Twitter", "Twitter.png", sharedSelectProxies),
    serviceGroup("E-Hentai", "EHentai.png", sharedSelectProxies),
    serviceGroup("PikPak网盘", "PikPak.png", sharedSelectProxies),
    serviceGroup("SSH", "Server.png", sharedSelectProxies),
    serviceGroup("Nodeseek", "Nodeseek.png", sharedSelectProxies, "https://raw.githubusercontent.com/oKafuChino/Miscellaneous/refs/heads/main/icon/nodeseek.png"),
    serviceGroup("Emby", "Emby.png", ["DIRECT", "选择代理", ...regionNames, "手动选择"]),
    serviceGroup("哔哩哔哩", "bilibili.png", ["直连", "台湾节点", "香港节点"]),
    serviceGroup("巴哈姆特", "Bahamut.png", ["台湾节点", "选择代理", "手动选择", "直连"]),
    serviceGroup("新浪微博", "Weibo.png", ["直连", ...regionNames, "选择代理", "手动选择"]),
    serviceGroup("Truth Social", "Truth_Social.png", ["美国节点", "选择代理", "手动选择"]),
    serviceGroup("搜狗输入法", "Reject.png", ["直连", "REJECT"]),
    {
      name: "自动选择",
      type: "url-test",
      url: HEALTH_CHECK_URL,
      interval: HEALTH_CHECK_INTERVAL,
      tolerance: 50,
      lazy: true,
      icon: `${ICON_BASE}/Auto.png`,
      "include-all": true,
      "exclude-filter": NOTICE_FILTER
    },
    {
      name: "故障转移",
      type: "fallback",
      url: HEALTH_CHECK_URL,
      interval: HEALTH_CHECK_INTERVAL,
      lazy: true,
      icon: `${ICON_BASE}/Available_1.png`,
      "include-all": true,
      "exclude-filter": NOTICE_FILTER
    },
    { name: "直连", type: "select", icon: `${ICON_BASE}/Direct.png`, proxies: ["DIRECT", "选择代理"] },
    { name: "广告拦截", type: "select", icon: `${ICON_BASE}/AdBlack.png`, proxies: ["REJECT", "REJECT-DROP", "直连"] }
  ];

  groups.push(...REGION_DEFINITIONS.map((region) => ({
    name: region.name,
    type: "url-test",
    url: HEALTH_CHECK_URL,
    interval: HEALTH_CHECK_INTERVAL,
    tolerance: 50,
    lazy: true,
    icon: region.icon,
    "include-all": true,
    filter: region.filter,
    "empty-fallback": "DIRECT"
  })));
  return groups;
}

function buildGlobalGroup(groups: MihomoGroup[]): MihomoGroup {
  return {
    name: "GLOBAL",
    type: "select",
    icon: `${ICON_BASE}/Global.png`,
    "include-all": true,
    proxies: uniqueStrings(groups.map(groupName).filter(Boolean))
  };
}

function serviceGroup(name: string, icon: string, proxies: string[], iconUrl?: string): MihomoGroup {
  return {
    name,
    type: "select",
    icon: iconUrl ?? `${ICON_BASE}/${icon}`,
    proxies: [...proxies]
  };
}

function ruleProvider(url: string, filename: string): MihomoConfig {
  return {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url,
    path: `./ruleset/${filename}`
  };
}

function groupName(group: MihomoGroup): string {
  return typeof group.name === "string" ? group.name.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
