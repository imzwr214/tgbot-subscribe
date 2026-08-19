# Telegram 订阅查询机器人

基于 Cloudflare Workers 的私人 Telegram 订阅查询机器人，支持订阅流量查询、节点统计、保存订阅、Mihomo 配置、原始订阅导出和机场稳定性监测。

## 配置

`wrangler.toml` 里保留非敏感配置：

- `ALLOWED_USER_IDS`: 允许使用机器人的 Telegram 用户 ID，多个用逗号分隔。
- `SUB_FETCH_PROXY`: 可选订阅抓取代理地址。配置后会优先走代理，代理失败后自动 fallback 到 Worker 直连并尝试多个常见 User-Agent。
- `SUB_KV`: Cloudflare KV 命名空间绑定。
- `MONITOR_DB`: 保存机场监测目标和最近 30 天汇总样本的 D1 绑定。

敏感值必须用 Secret 设置，不要写进代码：

```powershell
npx wrangler secret put BOT_TOKEN
npx wrangler secret put SETUP_TOKEN
npx wrangler secret put DEBUG_TOKEN
npx wrangler secret put MONITOR_TOKEN
```

## 路由

- `GET /`: 只返回 `bot running`，不会自动设置 webhook。
- `GET /setup?token=xxx`: 校验 `SETUP_TOKEN` 后设置 Telegram webhook。
- `POST /telegram/webhook`: Telegram webhook 入口。
- `GET /debug/subscription?token=xxx&user_id=123&url=...`: 校验 `DEBUG_TOKEN` 和白名单用户后调试订阅解析。
- `GET /s/:id`: 仅用于兼容尚未过期的旧短链，不再生成新链接。
- `GET /m/:id`: 返回可直接导入的 Mihomo 配置；已保存机场的长期地址会跟随更新后的源地址，节点合集变化后也会动态更新。
- `GET /health`: 健康检查。

## Telegram 用法

- `/start` 或 `/help`: 查看提示；私聊会显示常驻底部菜单。
- `/sub` 或底部的“📦 我的订阅”: 查询已保存订阅。
- `/monitor`: 选择一个已保存机场，开启、暂停或查看稳定性监测。
- `/json`: 回复某条消息发送，导出被回复消息的 JSON 文件。
- 直接发送订阅链接: 查询流量、过期时间、节点数量、协议和地区。
- 直接发送节点链接: 解析单个节点。

按钮功能：

- 刷新订阅信息
- 显示全部节点 / 折叠全部节点
- 导出原始订阅
- 生成 Mihomo 配置与订阅链接
- 保存订阅
- 为已保存机场生成不会自动过期的长期 Mihomo 地址、更新机场源地址、重置泄露的长期地址
- 分页管理、重命名保存项
- 清空节点合集（二次确认）
- 按机场开启 / 暂停稳定性监测

## 机场稳定性监测

- 海创 VPS 上的 `monitor-agent/monitor_agent.py` 每 10 分钟领取用户主动开启的机场任务。
- 每个节点只请求一次 Cloudflare 204 地址，不进行下载测速。
- Worker 负责 Bot 交互和鉴权，D1 保存机场级汇总；订阅 URL 和节点凭据不会写入 D1。
- 订阅接口临时失败时会使用上一次成功快照继续测试，并在结果中单独标明订阅接口异常。
- 连续两次无可用节点才发送掉线提醒，连续两次恢复正常才发送恢复提醒。
- 探针超时或自身故障显示为“未知”，不计作机场离线。
- 每天北京时间 09:00 向开启了机场监测的用户推送健康报告。
- D1 历史保留 30 天，由同一个 Worker Cron 在日报推送后清理。

## 注意

- 导出原始订阅不是 Clash YAML 转换，只是把订阅服务器返回的原始内容发成文件。
- 机场 Mihomo 导出目前只支持包含 `proxies` 或 `proxy-providers` 的标准 Clash/Mihomo YAML；手动节点合集当前直接转换 VLESS，其他协议会明确提示并跳过。
- 未保存订阅和节点合集生成的 Mihomo 链接有效期为 30 天；已保存机场可在详情页生成不会自动过期的长期 Mihomo 地址。长期地址会在机场接口临时失败时回退到最近一次成功快照；删除保存项或手动重置地址后，旧长期地址立即失效。
- 已保存订阅默认显示本地快照，只在用户点击“手动刷新订阅”时请求上游；刷新失败不会覆盖旧快照。
- 消息格式只对订阅链接使用 `code` entity，统计内容先不用 `blockquote` entity。
- `subscription-userinfo` 里的 `reset_day` / `resetDay` 优先用于展示流量重置日；没有该字段时，如果响应头提供 `x-subscription-start-at` / `x-subscription-purchased-at` / `x-subscription-created-at` 和过期时间，会按 30 天周期显示“预计重置”，否则显示 `未知`。
- 不要提交 Bot Token、Debug Token、Setup Token 或真实私人订阅链接。
