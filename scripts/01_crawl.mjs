#!/usr/bin/env node
/**
 * 01_crawl.mjs · 抓 iTunes Search API top paid 200 (4 国) → upsert D1
 *
 * 数据源：iTunes Search API（官方免费，无需 key）
 *   https://itunes.apple.com/search?term=&country=US&media=software&entity=software&limit=200&genre=
 *
 * 4 国：US / CN / JP / SG
 * 每个 app 写一条 prices 记录：app_id + region + date（今天）
 *
 * 注：
 *   - iTunes Search API 限速 ~20 calls/min（实际更宽松，1 call/200 apps 足够）
 *   - 本地 Mac 跑用 process.cwd()，GitHub Actions 容器也用 process.cwd()
 *   - 不需要 Playwright（iTunes Search API 是 REST，无需 JS）
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const TODAY = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

// 4 国配置（DEC-002）
const REGIONS = [
  { code: 'US', name: '美国', currency: 'USD' },
  { code: 'CN', name: '中国', currency: 'CNY' },
  { code: 'JP', name: '日本', currency: 'JPY' },
  { code: 'SG', name: '新加坡', currency: 'SGD' },
];

// 抓每个国家的 top paid 200（按 popularity 排序）
const LIMIT_PER_REGION = 200;
const ITUNES_API = 'https://itunes.apple.com/search';

/**
 * 抓一个国家的 top paid N
 */
async function fetchRegion(region) {
  const url = new URL(ITUNES_API);
  url.searchParams.set('country', region.code);
  url.searchParams.set('media', 'software');
  url.searchParams.set('entity', 'software');
  url.searchParams.set('limit', String(LIMIT_PER_REGION));
  // 没有直接的 "top paid" 参数，靠 popularity 排序就是 top charts
  // 加 chart=TOP_PAID 让 API 走榜单路径
  url.searchParams.set('chart', 'TOP_PAID');

  console.log(`[crawl] ${region.code} fetching top paid ${LIMIT_PER_REGION}...`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'appstore-free/0.1 (+https://freeapp.laowe.club)' },
  });
  if (!res.ok) {
    throw new Error(`iTunes API ${region.code} HTTP ${res.status}`);
  }
  const json = await res.json();
  console.log(`[crawl] ${region.code} got ${json.resultCount} apps`);
  return json.results || [];
}

/**
 * 转成 prices 行
 */
function toRow(app, region, date) {
  return {
    app_id: String(app.trackId),
    region: region.code,
    date,
    price: app.price ?? 0,
    currency: app.currency || region.currency,
    track_name: app.trackName || '',
    artist_name: app.artistName || '',
    genre: app.primaryGenreName || '',
    bundle_id: app.bundleId || '',
    track_view_url: app.trackViewUrl || '',
    artwork_url_100: app.artworkUrl100 || '',
    is_active: 1,
    crawled_at: new Date().toISOString(),
  };
}

async function main() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });

  const allRows = [];
  for (const region of REGIONS) {
    try {
      const apps = await fetchRegion(region);
      const rows = apps.map((a) => toRow(a, region, TODAY));
      allRows.push(...rows);
      // iTunes API 限速：每次间隔 3 秒
      await new Promise((r) => setTimeout(r, 3000));
    } catch (err) {
      console.error(`[crawl] ${region.code} FAILED:`, err.message);
      // 单国失败不阻塞整轮
    }
  }

  // 写今日 raw snapshot（commit 用）
  const snapshotPath = join(DATA_DIR, `${TODAY}.json`);
  const snapshot = {
    date: TODAY,
    crawled_at: new Date().toISOString(),
    total: allRows.length,
    by_region: allRows.reduce((acc, r) => {
      acc[r.region] = (acc[r.region] || 0) + 1;
      return acc;
    }, {}),
    rows: allRows,
  };
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2));
  console.log(`[crawl] snapshot: ${snapshotPath} (${allRows.length} rows)`);

  // D1 upsert（GitHub Actions 容器里用 wrangler 调；本地 Mac 没 wrangler 就跳过）
  await upsertToD1(allRows);
}

/**
 * D1 upsert：通过 wrangler d1 execute（需要 D1_ID 环境变量）
 * 本地 Mac 没 wrangler 就 log 一行并写 SQL 文件给后续 manual 导入
 */
async function upsertToD1(rows) {
  if (!process.env.D1_DATABASE_ID) {
    console.log('[crawl] D1_DATABASE_ID not set, skipping wrangler upsert (local Mac dev)');
    // 写 SQL 文件供手动导入
    const sqlPath = join(DATA_DIR, `${TODAY}.sql`);
    const sql = rowsToSql(rows);
    await writeFile(sqlPath, sql);
    console.log(`[crawl] SQL file: ${sqlPath} (${rows.length} INSERT OR REPLACE)`);
    return;
  }

  // GitHub Actions 容器里跑 wrangler
  const { execSync } = await import('node:child_process');
  const sqlPath = join(DATA_DIR, `${TODAY}.sql`);
  await writeFile(sqlPath, rowsToSql(rows));
  console.log(`[crawl] upserting to D1 via wrangler...`);
  execSync(
    `npx wrangler d1 execute appstore-free --file=${sqlPath} --remote`,
    { stdio: 'inherit', cwd: ROOT },
  );
}

function rowsToSql(rows) {
  const escape = (v) => String(v ?? '').replace(/'/g, "''");
  return (
    rows
      .map(
        (r) =>
          `INSERT OR REPLACE INTO prices (app_id, region, date, price, currency, track_name, artist_name, genre, bundle_id, track_view_url, artwork_url_100, is_active, crawled_at) VALUES (` +
          `'${escape(r.app_id)}','${r.region}','${r.date}',${r.price},'${r.currency}','${escape(r.track_name)}','${escape(r.artist_name)}','${escape(r.genre)}','${escape(r.bundle_id)}','${escape(r.track_view_url)}','${escape(r.artwork_url_100)}',${r.is_active},'${r.crawled_at}');`,
      )
      .join('\n') + '\n'
  );
}

main().catch((err) => {
  console.error('[crawl] FATAL:', err);
  process.exit(1);
});
