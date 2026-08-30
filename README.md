# AppStore 限免监测 (freeapp.laowe.club)

> App Store iOS 限免应用监测站 · 多源 + 价格历史路线

## 这是什么

每天跟踪 iOS App Store **真限免**（从付费变免费 → 又恢复付费），跨 4 国展示。
区别于「AppShopper」类纯 RSS 聚合：靠**价格状态变化检测**而不是「价格=0」过滤。

## 上线域

- 主：`https://freeapp.laowe.club/`
- CF 子：`https://appstore-free.linweiheng2009.workers.dev/`

## 数据源

- 主：**iTunes RSS JSON API**（`/rss/toppaidapplications/limit=N/json`，官方免费无需 key；单国上限 100 条）
- 辅：RSSHub `apple/appshopper`（验证用，待接入）
- 4 国：US / CN / JP / SG

## 技术栈

| 层 | 选型 |
|---|---|
| 抓取 | Node.js（零依赖） |
| 价格历史 | Cloudflare D1（SQLite） |
| 检测 | Node.js（SQL 对比昨日 vs 今日） |
| 前端 | 单文件 HTML（原生 JS，零依赖） |
| 部署 | Cloudflare Workers（静态资产，`public/`） |
| cron | GitHub Actions（UTC 00:00 抓取 + 检测 + 部署） |

## 开发

```bash
# 拉取
git clone https://github.com/linweiheng2009-ops/appstore-free.git
cd appstore-free

# 抓取（本地）
node scripts/01_crawl.mjs

# 检测（本地，产出 data/ + public/data/）
node scripts/02_detect.mjs

# 本地起服务（看前端，必须 serve public/）
npm run serve
# → http://localhost:8765

# E2E（Playwright；需要全局 playwright + chromium 浏览器）
npm test
```

### E2E 测试

`test/e2e.mjs` 是隔离的：把 `public/` 复制到 `/tmp/afc-fixture-XXX/`，合成数据只写到 fixture，`public/data/` 永远不会被污染，测试结束还会做一道断言检查。首次跑要装全局 playwright 浏览器：

```bash
npm i -g playwright
npx playwright install chromium
```

如果全局 playwright 不在 `/Users/linweiheng/.npm-global/lib/node_modules/playwright/index.mjs`，改 `test/e2e.mjs` 顶部的 `import` 路径。

## D1 schema

```sql
CREATE TABLE prices (
  app_id      TEXT NOT NULL,
  region      TEXT NOT NULL,    -- 'US' / 'CN' / 'JP' / 'SG'
  date        TEXT NOT NULL,    -- 'YYYY-MM-DD'
  price       REAL NOT NULL,    -- 0 = 免费
  currency    TEXT NOT NULL,    -- 'USD' / 'CNY' / 'JPY' / 'SGD'
  track_name  TEXT,
  artist_name TEXT,
  genre       TEXT,
  bundle_id   TEXT,
  track_view_url TEXT,
  artwork_url_100 TEXT,
  is_active   INTEGER DEFAULT 1,
  crawled_at  TEXT NOT NULL,
  PRIMARY KEY (app_id, region, date)
);

CREATE INDEX idx_prices_region_date ON prices(region, date);

-- "今日限免"视图：价格从付费变免费（含历史所有翻转，按 date 过滤）
CREATE VIEW today_free AS
SELECT t.* FROM prices t
JOIN prices y ON t.app_id = y.app_id AND t.region = y.region
  AND y.date = date(t.date, '-1 day')
WHERE t.price = 0
  AND y.price > 0;
```

## 上线流程

1. **每日自动**：GitHub Actions（UTC 00:00 / SGT 08:00）→ 抓取 → 检测 → commit `data/` + `public/data/` → `wrangler deploy`（需要 repo secrets：CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID）
2. **手动**：本地 `wrangler deploy`（OAuth 登录）
3. `freeapp.laowe.club` 跟 CF 子域指向同一 Worker；主域需先在 Cloudflare DNS 加 CNAME（见 `docs/SETUP.md`）

## 前端数据契约

`public/data/today_free.json`（今日）+ `public/data/week_free.json`（近 7 日，含 `free_date`；「昨日」Tab 从 7 日数据里筛）。
检测脚本两份都写：`data/` 进 git 存档，`public/data/` 随 Worker 对外提供。

## OPC 文档

`~/Documents/OPC/14_AppStore限免监测/`（PROJECT_PLAN / README / TODO / docs/DECISIONS）
