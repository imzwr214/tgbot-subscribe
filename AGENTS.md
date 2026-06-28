# Project Memory

## Workflow

- Reply in Chinese.
- Keep changes small and focused.
- Before code changes, inspect project structure and current git status.
- For this Telegram subscription bot, use this release flow by default:
  1. Edit locally.
  2. Run `npm run check`.
  3. Deploy to Cloudflare Workers with `npm run deploy`.
  4. Probe the deployed Worker, at least `/health` and `/`.
  5. Only after deployed behavior looks good, commit and push to GitHub for safekeeping.

## Project Notes

- Main Worker code lives in `src/index.ts`.
- Cloudflare config lives in `wrangler.toml`.
- The Worker binding for KV is `SUB_KV`.
- Treat Bot tokens, debug tokens, setup tokens, and real subscription URLs as sensitive. Do not paste them into chat, logs, or committed files.
