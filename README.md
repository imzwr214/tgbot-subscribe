# TG Sub Bot

基于 Cloudflare Workers 的 Telegram 订阅查询机器人。

它可以接收订阅链接，查询流量、过期时间、节点数量和地区分布，并支持保存订阅、刷新、导出 Base64/YAML、生成短链。

## 功能

- 私人白名单访问，避免订阅链接被陌生人滥用
- 支持 Telegram Webhook
- 支持 Cloudflare KV 保存订阅和短链
- 支持读取 `subscription-userinfo` 流量头
- 支持常见 Base64 节点订阅
- 支持基础 Clash YAML 节点识别

## 准备

1. 创建 Telegram Bot，拿到 Bot Token。
2. 创建 Cloudflare KV namespace。
3. 修改 `wrangler.toml` 里的 KV namespace id。
4. 设置密钥：

```powershell
npx wrangler secret put BOT_TOKEN
```

5. 设置白名单用户 ID：

```toml
[vars]
ALLOWED_USER_IDS = "123456789"
```

多个用户用英文逗号分隔：

```toml
ALLOWED_USER_IDS = "123456789,987654321"
```

## 本地开发

```powershell
npm install
npm run check
npm run dev
```

## 部署

```powershell
npm run deploy
```

部署完成后，访问 Worker 根路径：

```text
https://你的-worker域名/
```

这个请求会自动调用 Telegram `setWebhook`，把 webhook 设置到：

```text
https://你的-worker域名/telegram/webhook
```

## Telegram 用法

- `/start` 查看提示
- `/help` 查看帮助
- `/sub` 查询已保存订阅
- 直接发送订阅链接进行查询

按钮功能：

- 刷新订阅信息
- 显示全部节点
- 导出 Base64
- 导出 YAML
- 生成短链
- 保存订阅

## 安全注意

- 不要把 `BOT_TOKEN` 写进代码或提交到 Git。
- 不要把真实订阅链接发给不可信用户。
- Worker 日志里只会输出脱敏后的错误信息。
- 建议只配置自己的 Telegram 用户 ID 到白名单。
- 如果机场屏蔽 Cloudflare Worker 出口，可以配置 `SUB_FETCH_PROXY` 为你自己控制的抓取代理地址，格式为 `https://example.com/fetch?url=订阅链接`。

## 当前限制

- 第一版只做轻量解析，不保证完整转换所有 Clash YAML 字段。
- 短链默认 30 天过期。
- 每个用户默认保存 1 条订阅。
