-- OPC 14 · D1 schema · 2026-08-28
-- 数据库名：appstore-free

-- 价格历史表（主键 app_id + region + date）
CREATE TABLE IF NOT EXISTS prices (
  app_id         TEXT NOT NULL,
  region         TEXT NOT NULL,        -- 'US' / 'CN' / 'JP' / 'SG'
  date           TEXT NOT NULL,        -- 'YYYY-MM-DD' UTC
  price          REAL NOT NULL,        -- 0 = 免费
  currency       TEXT NOT NULL,        -- 'USD' / 'CNY' / 'JPY' / 'SGD'
  track_name     TEXT,
  artist_name    TEXT,
  genre          TEXT,
  bundle_id      TEXT,
  track_view_url TEXT,
  artwork_url_100 TEXT,
  is_active      INTEGER DEFAULT 1,    -- 0 = app 下架 / 查不到
  crawled_at     TEXT NOT NULL,        -- ISO8601 UTC
  PRIMARY KEY (app_id, region, date)
);

CREATE INDEX IF NOT EXISTS idx_prices_region_date ON prices(region, date);
CREATE INDEX IF NOT EXISTS idx_prices_date ON prices(date);
CREATE INDEX IF NOT EXISTS idx_prices_track_name ON prices(track_name);

-- 视图：今日限免（从付费变免费）
CREATE VIEW IF NOT EXISTS today_free AS
SELECT t.*
FROM prices t
JOIN prices y
  ON t.app_id = y.app_id
 AND t.region = y.region
 AND y.date = date(t.date, '-1 day')
WHERE t.price = 0
  AND y.price > 0;

-- 视图：近 7 日限免（回看）
CREATE VIEW IF NOT EXISTS week_free AS
SELECT t.*
FROM prices t
JOIN prices y
  ON t.app_id = y.app_id
 AND t.region = y.region
 AND y.date = date(t.date, '-1 day')
WHERE t.date >= date('now', '-7 days')
  AND t.price = 0
  AND y.price > 0;
