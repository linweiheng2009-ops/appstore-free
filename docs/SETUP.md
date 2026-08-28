# OPC 14 · Cloudflare + GitHub 配置指南（实操版）

> ✅ = 已跑通 · ⏳ = 等恒哥手动（OAuth scope 不够）

## ✅ 已完成（wrangler OAuth 跑通）

```bash
# 0. wrangler 装好 + 已登录
wrangler --version
# 4.127.0
wrangler whoami
# Linweiheng2009@gmail.com's Account | b88feee7c5750eb9f9ab5a5c1c02fe53

# 1. D1 数据库创建 ✅
wrangler d1 create appstore-free
# → database_id: 407161a3-7f21-4246-b208-f0df54779250

# 2. schema.sql 部署 ✅
wrangler d1 execute appstore-free --file=./schema.sql --remote
# → 1 table (prices) + 2 views (today_free, week_free)

# 3. 第一次入库 ✅
export D1_DATABASE_ID=407161a3-7f21-4246-b208-f0df54779250
node scripts/01_crawl.mjs
# → 396 rows (US 99 / CN 98 / JP 99 / SG 100)

# 4. 检测脚本 ✅
node scripts/02_detect.mjs
# → today_free.json: 0 真限免（正常，第一天没昨日可对比）

# 5. Worker 部署 ✅
wrangler deploy
# → appstore-free.linweiheng2009.workers.dev
# → Version ID: 8df3eba1-7af8-4638-82c7-04d262f7c9f7

# 6. Worker route 添加 ✅
# 在 wrangler.jsonc 加 routes 配置：
#   freeapp.laowe.club/* (zone: laowe.club)
# → 重新 deploy 后路由生效（DNS 记录还要手动加）
```

---

## ⏳ 恒哥手动 3 步（5 分钟内搞定）

### 步骤 1 · 加 CNAME（30 秒）

Cloudflare dashboard → laowe.club → DNS → Records → Add record

| 字段 | 值 |
|---|---|
| Type | **CNAME** |
| Name | **freeapp** |
| Target | **appstore-free.linweiheng2009.workers.dev** |
| Proxy status | **Proxied**（橙色云朵） |

DNS 改完通常 30 秒内全球生效。验证：

```bash
dig @1.1.1.1 freeapp.laowe.club +short
# 应该返回 Cloudflare Anycast IPs（类似 104.21.x.x / 172.67.x.x）
```

### 步骤 2 · 创建 Cloudflare API Token（1 分钟）

Cloudflare dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template

权限检查清单：
- ✅ Account → Workers Scripts: Edit
- ✅ Account → D1: Edit

→ Create → Copy token（**只显示一次**）

### 步骤 3 · 配 GitHub Secrets（1 分钟）

仓库 `https://github.com/linweiheng2009-ops/appstore-free` → Settings → Secrets and variables → Actions → New repository secret

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 第 2 步的 token |
| `CLOUDFLARE_ACCOUNT_ID` | `b88feee7c5750eb9f9ab5a5c1c02fe53` |
| `D1_DATABASE_ID` | `407161a3-7f21-4246-b208-f0df54779250` |

---

## ⏳ 然后（恒哥或等自动）

### 第一次 cron 触发

GitHub repo → Actions → "Daily AppStore Crawl + Detect" → Run workflow

OR 等 UTC 00:00 / SGT 08:00 自动跑。

### 第二天（2026-08-29 SGT 08:00）开始有真限免

- 今天只入库（baseline 396 行）
- 明天跑完才有昨日 vs 今日对比
- 网站访问 `https://freeapp.laowe.club/` 应该能看到首批真限免卡片

---

## 🔍 验证清单

跑完后做这几条 sanity check：

- [ ] `https://freeapp.laowe.club/` 显示前端（蓝主题，标题"AppStore 限免监测 BETA"）
- [ ] stats 显示 "0 真限免"（今天，明天才有）
- [ ] 切换国家 Tab（🇺🇸 🇨🇳 🇯🇵🇸🇬）能切换（每个 tab 显示 0）
- [ ] GitHub Actions → 看到 workflow 跑成功（绿勾）
- [ ] 24 小时后 stats 显示 > 0 真限免

---

## 故障排查

| 现象 | 原因 | 修法 |
|---|---|---|
| freeapp.laowe.club 不解析 | CNAME 没加 | 重做步骤 1 |
| Worker 报 1003/1004 | DNS 解析到 CF 但没命中 Worker | 等 5 分钟首次 SSL 证书签发 |
| GitHub Actions 失败 "Authentication error [code: 10000]" | API token 错 | 重做步骤 2 |
| GitHub Actions 失败 "Database not found" | D1_DATABASE_ID secret 错 | 检查步骤 3 |
| GitHub Actions 失败 "table prices doesn't exist" | schema 没部署 | 本地跑 `wrangler d1 execute appstore-free --file=./schema.sql --remote` |