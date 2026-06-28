# Telegram 订阅查询机器人

基于 Cloudflare Workers 的私人 Telegram 订阅查询机器人，支持订阅流量查询、节点统计、保存订阅、短链导出和原始订阅导出。

## 配置

`wrangler.toml` 里保留非敏感配置：

- `ALLOWED_USER_IDS`: 允许使用机器人的 Telegram 用户 ID，多个用逗号分隔。
- `SUB_FETCH_PROXY`: 可选订阅抓取代理地址。配置后会优先走代理，代理失败后自动 fallback 到 Worker 直连并尝试多个常见 User-Agent。
- `SUB_KV`: Cloudflare KV 命名空间绑定。

敏感值必须用 Secret 设置，不要写进代码：

```powershell
npx wrangler secret put BOT_TOKEN
npx wrangler secret put SETUP_TOKEN
npx wrangler secret put DEBUG_TOKEN
```

## 路由

- `GET /`: 只返回 `bot running`，不会自动设置 webhook。
- `GET /setup?token=xxx`: 校验 `SETUP_TOKEN` 后设置 Telegram webhook。
- `POST /telegram/webhook`: Telegram webhook 入口。
- `GET /debug/subscription?token=xxx&user_id=123&url=...`: 校验 `DEBUG_TOKEN` 和白名单用户后调试订阅解析。
- `GET /s/:id`: 短链订阅导出。
- `GET /health`: 健康检查。

## Telegram 用法

- `/start` 或 `/help`: 查看提示。
- `/sub`: 查询已保存订阅。
- `/json`: 回复某条消息发送，导出被回复消息的 JSON 文件。
- 直接发送订阅链接: 查询流量、过期时间、节点数量、协议和地区。
- 直接发送节点链接: 解析单个节点。

按钮功能：

- 刷新订阅信息
- 显示全部节点 / 折叠全部节点
- 导出 Base64
- 导出原始订阅
- 生成短链
- 保存订阅

## 注意

- 导出原始订阅不是 Clash YAML 转换，只是把订阅服务器返回的原始内容发成文件。
- 消息格式只对订阅链接使用 `code` entity，统计内容先不用 `blockquote` entity。
- `subscription-userinfo` 里的 `reset_day` / `resetDay` 只用于展示流量重置日；没有该字段时显示 `未知`。
- 不要提交 Bot Token、Debug Token、Setup Token 或真实私人订阅链接。
