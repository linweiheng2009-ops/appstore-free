#!/usr/bin/env node
/**
 * 01_crawl.mjs · 抓 iTunes RSS top paid (4 国 × 2 平台) → upsert D1
 *
 * 数据源：iTunes RSS JSON API（官方免费，无需 key）
 *   https://itunes.apple.com/{country}/rss/toppaidapplications/limit={N}/json
 *   https://itunes.apple.com/{country}/rss/toppaidmacapps/limit={N}/json
 *
 * 4 国：US / CN / JP / SG（DEC-002）
 * 2 平台：ios / mac（v2，2026-08-30）
 * 每个 app 写一条 prices 记录：app_id + region + platform + date（今天）
 *
 * 选 RSS API 而不是 /search 的原因：
 *   - /search 没有 chart 参数，不能拿 top paid
 *   - RSS JSON 是 Apple 官方支持的 charts 数据源
 *   - 单次拿 N 条含 price/id/bundleId/icon/genre 全字段，零额外 API
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const TODAY = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

// 4 国配置（DEC-002；TW / HK 2026-08-30 加进来 → 6 国）
const REGIONS = [
  { code: 'US', lower: 'us', name: '美国', currency: 'USD' },
  { code: 'CN', lower: 'cn', name: '中国', currency: 'CNY' },
  { code: 'JP', lower: 'jp', name: '日本', currency: 'JPY' },
  { code: 'SG', lower: 'sg', name: '新加坡', currency: 'SGD' },
  { code: 'TW', lower: 'tw', name: '台湾', currency: 'TWD' },
  { code: 'HK', lower: 'hk', name: '香港', currency: 'HKD' },
];

// 2 平台（DEC-003，iTunes RSS 端点后缀）
const PLATFORMS = [
  { code: 'ios', rss: 'toppaidapplications' },
  { code: 'mac', rss: 'toppaidmacapps' },
];

const LIMIT_PER_REGION = 100; // 单 RSS 单国上限 100（Apple 限制，详见 DONE.md）
const ITUNES_RSS = 'https://itunes.apple.com';

/**
 * 抓一个国家一个平台的 top paid N
 */
async function fetchOne(region, platform) {
  const url = `${ITUNES_RSS}/${region.lower}/rss/${platform.rss}/limit=${LIMIT_PER_REGION}/json`;
  console.log(`[crawl] ${region.code}/${platform.code} fetching ${LIMIT_PER_REGION}...`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'appstore-free/0.1 (+https://freeapp.laowe.club)' },
  });
  if (!res.ok) {
    throw new Error(`iTunes RSS ${region.code}/${platform.code} HTTP ${res.status}`);
  }
  const json = await res.json();
  const entries = json.feed?.entry || [];
  console.log(`[crawl] ${region.code}/${platform.code} got ${entries.length} apps`);
  return entries;
}

/**
 * RSS entry → prices row
 */
function toRow(entry, region, platform, date) {
  const id = entry.id?.attributes?.['im:id'] || '';
  const bundleId = entry.id?.attributes?.['im:bundleId'] || '';
  const name = entry['im:name']?.label || '';
  const artist = entry['im:artist']?.label || '';
  const genre = entry.category?.attributes?.label || '';
  const price = parseFloat(entry['im:price']?.attributes?.amount || '0');
  const currency = entry['im:price']?.attributes?.currency || region.currency;
  const icon100 =
    entry['im:image']?.find((img) => img.attributes?.height === '100')?.label ||
    entry['im:image']?.[2]?.label ||
    '';
  const viewUrl =
    entry.link?.find((l) => l.attributes?.rel === 'alternate')?.attributes?.href ||
    '';

  return {
    app_id: String(id),
    region: region.code,
    platform: platform.code,
    date,
    price,
    currency,
    track_name: name,
    artist_name: artist,
    genre,
    bundle_id: bundleId,
    track_view_url: viewUrl,
    artwork_url_100: icon100,
    is_active: 1,
    crawled_at: new Date().toISOString(),
  };
}

/**
 * iTunes Lookup 结果 → prices row（Mac seed 用的字段名跟 RSS 不一样）
 */
function toRowFromLookup(item, region, date) {
  return {
    app_id: String(item.trackId || ''),
    region: region.code,
    platform: 'mac',
    date,
    price: typeof item.price === 'number' ? item.price : 0,
    currency: item.currency || region.currency,
    track_name: item.trackName || '',
    artist_name: item.artistName || '',
    genre: item.primaryGenreName || '',
    bundle_id: item.bundleId || '',
    track_view_url: item.trackViewUrl || '',
    artwork_url_100: item.artworkUrl100 || '',
    is_active: 1,
    crawled_at: new Date().toISOString(),
  };
}

/**
 * Mac seed lookup（v2）：Apple top-paid Mac 榜单已下线，备用信号源——
 * 对一份手工维护的热门 Mac app 列表（scripts/mac-seed.json），每天 4 国各查一次，
 * 单次 lookup 最多 200 个 bundle ID（一国一次 API 调用）。
 */
async function fetchMacSeed(bundleIds, region) {
  const url = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleIds)}&country=${region.lower}&entity=macSoftware`;
  console.log(`[crawl] ${region.code}/mac/seed looking up ${bundleIds.split(',').length} bundle IDs...`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'appstore-free/0.1 (+https://freeapp.laowe.club)' },
  });
  if (!res.ok) {
    throw new Error(`iTunes Lookup ${region.code}/mac HTTP ${res.status}`);
  }
  const json = await res.json();
  const results = json.results || [];
  // results[0] 可能是空的 lookup 哨兵，需要过滤掉
  const apps = results.filter((r) => r.wrapperType === 'software' && r.trackId);
  console.log(`[crawl] ${region.code}/mac/seed got ${apps.length} apps`);
  return apps;
}

async function main() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });

  const allRows = [];
  for (const region of REGIONS) {
    for (const platform of PLATFORMS) {
      try {
        const entries = await fetchOne(region, platform);
        const rows = entries.map((e) => toRow(e, region, platform, TODAY));
        allRows.push(...rows);
        // 8 个抓取之间间隔 1.5s（Apple RSS 限速宽松，但别太快）
        await new Promise((r) => setTimeout(r, 1500));
      } catch (err) {
        console.error(`[crawl] ${region.code}/${platform.code} FAILED:`, err.message);
        // 单点失败不阻塞整轮
      }
    }
  }

  // ── Mac seed lookup（v2）：4 国各查一次，每国最多 200 bundle IDs ─────
  const seedPath = join(ROOT, 'scripts', 'mac-seed.json');
  if (existsSync(seedPath)) {
    const seed = JSON.parse(await readFile(seedPath, 'utf8'));
    const bundleIds = seed.map((s) => s.bundleId).join(',');
    for (const region of REGIONS) {
      try {
        const apps = await fetchMacSeed(bundleIds, region);
        const rows = apps.map((a) => toRowFromLookup(a, region, TODAY));
        allRows.push(...rows);
        await new Promise((r) => setTimeout(r, 1200));
      } catch (err) {
        console.error(`[crawl] ${region.code}/mac/seed FAILED:`, err.message);
      }
    }
  } else {
    console.log('[crawl] scripts/mac-seed.json 不存在，跳过 Mac seed lookup');
  }

  // ── 热门免费榜（v3）：6 国 topfreeapplications RSS → popular_free.json ────
  // 不入 D1（price=0 会污染 paid→free 检测），单独存档
  const freeRowsAll = [];
  for (const region of REGIONS) {
    try {
      const url = `${ITUNES_RSS}/${region.lower}/rss/topfreeapplications/limit=100/json`;
      console.log(`[crawl] ${region.code}/topfree fetching 100...`);
      const res = await fetch(url, { headers: { 'User-Agent': 'appstore-free/0.1 (+https://freeapp.laowe.club)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const entries = json.feed?.entry || [];
      const rows = entries.map((e) => toRow(e, region, { code: 'ios' }, TODAY));
      freeRowsAll.push(...rows);
      await new Promise((r) => setTimeout(r, 1200));
    } catch (err) {
      console.error(`[crawl] ${region.code}/topfree FAILED:`, err.message);
    }
  }
  // 去重 app_id（保留首次出现 = 6 国热度最高的区域），取 top 30
  const freeSeen = new Set();
  const freeApps = [];
  for (const r of freeRowsAll) {
    if (!freeSeen.has(r.app_id)) {
      freeSeen.add(r.app_id);
      freeApps.push({
        app_id: r.app_id,
        track_name: r.track_name,
        artist_name: r.artist_name,
        genre: r.genre,
        region: r.region,
        currency: r.currency,
        track_view_url: r.track_view_url,
        artwork_url_100: r.artwork_url_100,
      });
    }
    if (freeApps.length >= 30) break;
  }
  const freeSnapshot = {
    date: TODAY,
    generated_at: new Date().toISOString(),
    source: 'iTunes RSS topfreeapplications × 6 国',
    total: freeApps.length,
    apps: freeApps,
  };
  const freePath = join(DATA_DIR, `${TODAY}.free.json`);
  await writeFile(freePath, JSON.stringify(freeSnapshot, null, 2));
  console.log(`[crawl] free popular: ${freeSnapshot.total} apps`);

  // 写今日 raw snapshot（commit 用）
  const snapshotPath = join(DATA_DIR, `${TODAY}.json`);
  const snapshot = {
    date: TODAY,
    crawled_at: new Date().toISOString(),
    source: 'iTunes RSS toppaidapplications + toppaidmacapps + iTunes Lookup (mac seed)',
    total: allRows.length,
    by_region: allRows.reduce((acc, r) => {
      acc[r.region] = (acc[r.region] || 0) + 1;
      return acc;
    }, {}),
    by_platform: allRows.reduce((acc, r) => {
      acc[r.platform] = (acc[r.platform] || 0) + 1;
      return acc;
    }, {}),
    rows: allRows,
  };
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2));
  console.log(`[crawl] snapshot: ${snapshotPath} (${allRows.length} rows)`);

  // D1 upsert
  await upsertToD1(allRows);
}

/**
 * D1 upsert：通过 wrangler d1 execute（需要 D1_DATABASE_ID 环境变量）
 * 本地 Mac 没 wrangler 就 log 一行并写 SQL 文件给后续 manual 导入
 */
async function upsertToD1(rows) {
  if (!process.env.D1_DATABASE_ID) {
    console.log('[crawl] D1_DATABASE_ID not set, skipping wrangler upsert (local Mac dev)');
    const sqlPath = join(DATA_DIR, `${TODAY}.sql`);
    const sql = rowsToSql(rows);
    await writeFile(sqlPath, sql);
    console.log(`[crawl] SQL file: ${sqlPath} (${rows.length} INSERT OR REPLACE)`);
    return;
  }

  const { execSync } = await import('node:child_process');
  const sqlPath = join(DATA_DIR, `${TODAY}.sql`);
  await writeFile(sqlPath, rowsToSql(rows));
  console.log(`[crawl] upserting to D1 via wrangler...`);
  execSync(`npx wrangler d1 execute appstore-free --file=${sqlPath} --remote`, {
    stdio: 'inherit',
    cwd: ROOT,
  });
}

function rowsToSql(rows) {
  const escape = (v) => String(v ?? '').replace(/'/g, "''");
  return (
    rows
      .map(
        (r) =>
          `INSERT OR REPLACE INTO prices (app_id, region, platform, date, price, currency, track_name, artist_name, genre, bundle_id, track_view_url, artwork_url_100, is_active, crawled_at) VALUES (` +
          `'${escape(r.app_id)}','${r.region}','${r.platform}','${r.date}',${r.price},'${r.currency}','${escape(r.track_name)}','${escape(r.artist_name)}','${escape(r.genre)}','${escape(r.bundle_id)}','${escape(r.track_view_url)}','${escape(r.artwork_url_100)}',${r.is_active},'${r.crawled_at}');`,
      )
      .join('\n') + '\n'
  );
}

main().catch((err) => {
  console.error('[crawl] FATAL:', err);
  process.exit(1);
});
