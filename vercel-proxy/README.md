# Vercel Subscription Fetch Proxy

这个小服务用于给 Cloudflare Worker Bot 提供非 Cloudflare 出口。

接口：

```text
GET /api/fetch?url=订阅链接
```

部署后，把 Cloudflare Worker 的 `SUB_FETCH_PROXY` 设置成：

```text
https://你的-vercel域名/api/fetch
```

## 部署

```powershell
npm install
npx vercel login
npx vercel --prod
```

第一次部署时选择免费 Hobby 项目即可。
