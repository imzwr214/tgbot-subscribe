# Telegram 订阅查询机器人

基于 Cloudflare Workers 的私人 Telegram 订阅查询机器人，支持订阅流量查询、节点统计、保存订阅、Mihomo 配置和原始订阅导出。

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
- `GET /s/:id`: 仅用于兼容尚未过期的旧短链，不再生成新链接。
- `GET /m/:id`: 返回可直接导入的 Mihomo 配置；节点合集变化后会动态更新。
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
- 导出原始订阅
- 生成 Mihomo 配置与订阅链接
- 保存订阅
- 分页管理、重命名保存项
- 清空节点合集（二次确认）

## 注意

- 导出原始订阅不是 Clash YAML 转换，只是把订阅服务器返回的原始内容发成文件。
- 机场 Mihomo 导出目前只支持包含 `proxies` 或 `proxy-providers` 的标准 Clash/Mihomo YAML；手动节点合集当前直接转换 VLESS，其他协议会明确提示并跳过。
- 新生成的 Mihomo 订阅链接有效期为 30 天，链接本身包含节点访问凭据，请勿公开分享。
- 已保存订阅默认显示本地快照，只在用户点击“手动刷新订阅”时请求上游；刷新失败不会覆盖旧快照。
- 消息格式只对订阅链接使用 `code` entity，统计内容先不用 `blockquote` entity。
- `subscription-userinfo` 里的 `reset_day` / `resetDay` 优先用于展示流量重置日；没有该字段时，如果响应头提供 `x-subscription-start-at` / `x-subscription-purchased-at` / `x-subscription-created-at` 和过期时间，会按 30 天周期显示“预计重置”，否则显示 `未知`。
- 不要提交 Bot Token、Debug Token、Setup Token 或真实私人订阅链接。
