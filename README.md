# AppStore 限免监测 (freeapp.laowe.club)

> App Store iOS 限免应用监测站 · 多源 + 价格历史路线

## 这是什么

每天跟踪 iOS App Store **真限免**（从付费变免费 → 又恢复付费），跨 4 国展示。
区别于「AppShopper」类纯 RSS 聚合：靠**价格状态变化检测**而不是「价格=0」过滤。

## 上线域

- 主：`https://freeapp.laowe.club/`
- CF 子：`https://appstore-free.linweiheng2009.workers.dev/`

## 数据源

- 主：**iTunes Search API**（官方免费，无需 key，按 ID 查实时价格）
- 辅：RSSHub `apple/appshopper`（验证用）
- 4 国：US / CN / JP / SG

## 技术栈

| 层 | 选型 |
|---|---|
| 抓取 | Node.js |
| 价格历史 | Cloudflare D1（SQLite） |
| 检测 | Node.js（SQL 对比昨日 vs 今日） |
| 前端 | 单文件 HTML + ECharts |
| 部署 | Cloudflare Workers |
| cron | GitHub Actions |

## 开发

```bash
# 拉取
git clone https://github.com/linweiheng2009-ops/appstore-free.git
cd appstore-free
npm install

# 抓取（本地）
node scripts/01_crawl.mjs

# 检测（本地）
node scripts/02_detect.mjs

# 本地起服务（看前端）
python3 -m http.server 8765
# → http://localhost:8765
```

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

-- "今日限免"视图：价格从付费变免费
CREATE VIEW today_free AS
SELECT t.* FROM prices t
JOIN prices y ON t.app_id = y.app_id AND t.region = y.region
WHERE t.date = date('now')
  AND y.date = date('now', '-1 day')
  AND t.price = 0
  AND y.price > 0;
```

## 上线流程

1. commit → push → Cloudflare Workers 自动部署
2. `freeapp.laowe.club` 跟 CF 子域指向同一 Worker，缓存导致延迟不一致（commit 后子域立即生效，主域 ~10 分钟）

## OPC 文档

`~/Documents/OPC/14_AppStore限免监测/`（PROJECT_PLAN / README / TODO / docs/DECISIONS）
