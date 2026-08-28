# OPC 14 · Cloudflare + GitHub 配置指南

> 恒哥手动执行的步骤，按顺序来。

## 1. Cloudflare D1 数据库

### 创建
```bash
# 本地 Mac 装 wrangler（一次性）
npm install -g wrangler@latest

# 登录 Cloudflare（弹浏览器授权）
wrangler login

# 进项目目录
cd ~/.openclaw/workspace/projects/appstore-free

# 创建 D1 数据库
wrangler d1 create appstore-free
# → 输出：
#   database_name = "appstore-free"
#   database_id   = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### 把 database_id 填进 wrangler.jsonc
把 `TBD_AFTER_WRANGLER_D1_CREATE` 替换成上面输出的 UUID。

### 部署 schema
```bash
wrangler d1 execute appstore-free --file=./schema.sql --remote
# 应该输出 "Executed commands successfully"
```

## 2. Cloudflare API Token

Cloudflare dashboard → My Profile → API Tokens → Create Token → Edit Cloudflare Workers template

权限：
- Account → Workers Scripts: Edit
- Account → D1: Edit

复制 token 备用（只显示一次）。

## 3. Cloudflare Account ID

Cloudflare dashboard → Workers & Pages → 右侧栏底部 → "Account ID"

## 4. GitHub Secrets

仓库 `linweiheng2009-ops/appstore-free` → Settings → Secrets and variables → Actions → New repository secret

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 第 2 步的 token |
| `CLOUDFLARE_ACCOUNT_ID` | 第 3 步的 Account ID |
| `D1_DATABASE_ID` | 第 1 步的 database_id UUID |

## 5. Cloudflare Workers 部署

由于这是仓库 push 自动部署模式（跟 OPC 09 一样）：

### 选项 A：Cloudflare Dashboard 直接 Connect to Git
1. Cloudflare dashboard → Workers & Pages → Create application → Pages → Connect to Git
2. 选 `linweiheng2009-ops/appstore-free`
3. Build settings:
   - Build command: 留空（前端是纯静态）
   - Build output directory: `public`
4. Save and Deploy
5. 第一次部署会跑 build（空 build 也行），拿到 `*.linweiheng2009.workers.dev` URL

### 选项 B：用 wrangler 部署 Workers（推荐）
```bash
wrangler deploy
# 输出 deploy URL
```

## 6. 绑定自定义域 freeapp.laowe.club

Workers → appstore-free → Settings → Triggers → Custom Domains → Add Custom Domain

输入 `freeapp.laowe.club`，Cloudflare 会自动配 DNS（需要 laowe.club 在 Cloudflare 上）。

## 7. 第一次 cron 跑

GitHub Actions → 选 `Daily AppStore Crawl + Detect` workflow → Run workflow

或等 UTC 00:00 = SGT 08:00 自动跑。

第一次跑只入库（无昨日可对比 → 没限免数据）。
**第二次跑（明天 SGT 08:00）开始有真限免数据。**

## 8. 验证

部署完成后访问：

- `https://freeapp.laowe.club/` ← 主域
- `https://appstore-free.linweiheng2009.workers.dev/` ← CF 子域（同站）

应该看到：
- 第一次访问：今日限免列表空，stats 显示 "0 真限免"
- 第二天开始：可能出现真限免（价格从 >0 变 0 的 app）

## 故障排查

| 现象 | 原因 | 修法 |
|---|---|---|
| Wrangler "Authentication error [code: 10000]" | API token 错 / 权限不够 | 重做第 2 步 |
| D1 execute "no such table" | schema 没部署 | 重跑第 1 步最后那条命令 |
| GitHub Actions 失败 "Database not found" | D1_DATABASE_ID secret 没配 | 补第 4 步 |
| 前端 404 | 部署路径错 | wrangler.jsonc 里 `assets.directory` 应该是 `./public` |
| 数据空 | 第一天没昨日可对比 | 等第二天 cron 跑 |
