import type { VercelRequest, VercelResponse } from "@vercel/node";

const REQUEST_TIMEOUT_MS = 12000;
const FORWARDED_RESPONSE_HEADERS = [
  "subscription-userinfo",
  "x-subscription-start-at",
  "x-subscription-purchased-at",
  "x-subscription-created-at",
  "profile-title",
  "profile-web-title",
  "subscription-title",
  "x-subscription-title",
  "content-disposition"
];

const SUBSCRIPTION_HEADERS = [
  {
    "User-Agent": "clash-verge/v2.0.0",
    Accept: "text/plain, application/octet-stream, application/yaml, text/yaml, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache"
  },
  {
    "User-Agent": "FlClash/0.8.86",
    Accept: "text/plain, application/octet-stream, application/yaml, text/yaml, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache"
  },
  {
    "User-Agent": "ClashforWindows/0.20.39",
    Accept: "text/plain, application/octet-stream, application/yaml, text/yaml, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache"
  },
  {
    "User-Agent": "Shadowrocket/1993 CFNetwork/1496.0.7 Darwin/23.5.0",
    Accept: "text/plain, application/octet-stream, application/yaml, text/yaml, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache"
  }
];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const target = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  if (!target || !isAllowedHttpUrl(target)) {
    res.status(400).send("Missing or invalid url");
    return;
  }

  const forceUa = Array.isArray(req.query.ua) ? req.query.ua[0] : req.query.ua;
  const headersList = forceUa
    ? [
        {
          "User-Agent": forceUa,
          Accept: "text/plain, application/octet-stream, application/yaml, text/yaml, */*",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          "Cache-Control": "no-cache",
          Pragma: "no-cache"
        }
      ]
    : SUBSCRIPTION_HEADERS;

  let lastStatus = 0;
  let lastMessage = "Subscription fetch failed";

  for (const headers of headersList) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(target, {
        signal: controller.signal,
        headers,
        redirect: "follow"
      });

      lastStatus = response.status;
      if (!response.ok) {
        lastMessage = `Upstream returned ${response.status}`;
        continue;
      }

      const body = await response.text();
      res.setHeader("Content-Type", response.headers.get("content-type") ?? "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      forwardResponseHeaders(response.headers, res);
      res.setHeader("x-selected-user-agent", String(headers["User-Agent"]));

      res.status(200).send(body);
      return;
    } catch (error) {
      lastMessage = error instanceof Error && error.name === "AbortError" ? "Upstream timeout" : "Proxy fetch failed";
    } finally {
      clearTimeout(timeout);
    }
  }

  res.status(lastStatus && lastStatus < 500 ? lastStatus : 502).send(lastMessage);
}

function isAllowedHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function forwardResponseHeaders(headers: Headers, res: VercelResponse) {
  for (const key of FORWARDED_RESPONSE_HEADERS) {
    const value = headers.get(key);
    if (value) res.setHeader(key, value);
  }
}
