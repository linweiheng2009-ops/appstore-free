#!/usr/bin/env node
/**
 * 02_detect.mjs · 检测"今日限免" + "近 7 日限免"
 *
 * 真限免定义：
 *   price_today = 0 AND price_yesterday > 0
 *
 * 数据来源：D1 prices 表
 * 产出（data/ = git 存档，public/data/ = Worker 实际对外提供）：
 *   data/today_free.json + public/data/today_free.json（今日）
 *   data/week_free.json  + public/data/week_free.json （近 7 日，前端"昨日"也从这里筛）
 *   data/free-YYYY-MM-DD.json（当日检测存档，未来本地 fallback 拼 7 日用）
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const PUBLIC_DATA_DIR = join(ROOT, 'public', 'data');
const TODAY = new Date().toISOString().slice(0, 10);

/**
 * D1 通过 wrangler d1 execute --json 查
 * 本地 Mac 没 wrangler 就跳过 D1，从今日 snapshot JSON 推断
 */
async function queryD1(sql) {
  if (!process.env.D1_DATABASE_ID) {
    return null; // 本地 Mac dev 走 fallback
  }
  const { execSync } = await import('node:child_process');
  const out = execSync(
    `npx wrangler d1 execute appstore-free --command="${sql.replace(/"/g, '\\"')}" --json --remote`,
    { cwd: ROOT },
  ).toString();
  const parsed = JSON.parse(out);
  return parsed[0]?.results || [];
}

async function main() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });

  // 尝试从 D1 查；没有就走 fallback（用 snapshot 文件）
  let todayRows = await queryD1(
    `SELECT * FROM prices WHERE date = '${TODAY}' ORDER BY region, track_name`,
  );

  if (!todayRows) {
    console.log('[detect] D1 not available, using local snapshot fallback');
    todayRows = await loadFromSnapshot(TODAY);
  }
  if (!todayRows || todayRows.length === 0) {
    console.log(`[detect] no data for ${TODAY}, exiting`);
    return;
  }

  // 尝试查昨日（D1）
  const yesterday = dateMinus(TODAY, 1);
  let yesterdayRows = await queryD1(
    `SELECT app_id, region, price FROM prices WHERE date = '${yesterday}'`,
  );
  if (!yesterdayRows) {
    yesterdayRows = await loadFromSnapshot(yesterday);
  }

  const yesterdayMap = new Map(
    (yesterdayRows || []).map((r) => [`${r.app_id}:${r.region}`, r.price]),
  );

  // 真限免：今天 0 + 昨天 > 0
  const freeApps = [];
  for (const t of todayRows) {
    const key = `${t.app_id}:${t.region}`;
    const yPrice = yesterdayMap.get(key);
    if (t.price === 0 && yPrice != null && yPrice > 0) {
      freeApps.push({
        ...t,
        previous_price: yPrice,
        previous_currency: t.currency,
      });
    }
  }

  // 按国家分组
  const byRegion = freeApps.reduce((acc, a) => {
    acc[a.region] = acc[a.region] || [];
    acc[a.region].push(a);
    return acc;
  }, {});

  const out = {
    date: TODAY,
    detected_at: new Date().toISOString(),
    method: 'price_today=0 AND price_yesterday>0',
    total: freeApps.length,
    by_region: Object.fromEntries(
      Object.entries(byRegion).map(([k, v]) => [k, v.length]),
    ),
    apps: freeApps,
  };

  // ── 近 7 日限免（回看窗口 = 含今日的 7 个自然日）─────────────────────
  // D1 路径：等价于 week_free 视图，但额外带出 previous_price。
  // fallback：本地没有历史检测存档时，窗口里只有今天这一天。
  const weekStart = dateMinus(TODAY, 6);
  const weekRows = await queryD1(
    `SELECT t.*, y.price AS previous_price FROM prices t JOIN prices y ON t.app_id = y.app_id AND t.region = y.region AND y.date = date(t.date, '-1 day') WHERE t.date >= '${weekStart}' AND t.price = 0 AND y.price > 0 ORDER BY t.date DESC, t.region, t.track_name`,
  );
  const weekApps = weekRows
    ? weekRows.map((r) => ({ ...r, previous_currency: r.currency, free_date: r.date }))
    : freeApps.map((a) => ({ ...a, free_date: TODAY }));
  const weekByRegion = {};
  for (const a of weekApps) weekByRegion[a.region] = (weekByRegion[a.region] || 0) + 1;

  const weekOut = {
    generated_at: new Date().toISOString(),
    window: { start: weekStart, end: TODAY },
    total: weekApps.length,
    by_region: weekByRegion,
    apps: weekApps,
  };

  // ── 写盘：data/（git 存档）+ public/data/（Worker 对外）──────────────
  if (!existsSync(PUBLIC_DATA_DIR)) await mkdir(PUBLIC_DATA_DIR, { recursive: true });
  const writes = [
    [join(DATA_DIR, 'today_free.json'), out],
    [join(DATA_DIR, `free-${TODAY}.json`), out],
    [join(DATA_DIR, 'week_free.json'), weekOut],
    [join(PUBLIC_DATA_DIR, 'today_free.json'), out],
    [join(PUBLIC_DATA_DIR, 'week_free.json'), weekOut],
  ];
  for (const [path, payload] of writes) {
    await writeFile(path, JSON.stringify(payload, null, 2));
  }
  console.log(`[detect] today_free.json: ${freeApps.length} 真限免 (${Object.keys(byRegion).join('/') || 'none'})`);
  console.log(`[detect] week_free.json: ${weekApps.length} 次限免 (${weekStart} ~ ${TODAY})`);
}

async function loadFromSnapshot(date) {
  const { readFile } = await import('node:fs/promises');
  const path = join(DATA_DIR, `${date}.json`);
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return raw.rows || [];
  } catch {
    return [];
  }
}

function dateMinus(yyyymmdd, days) {
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

main().catch((err) => {
  console.error('[detect] FATAL:', err);
  process.exit(1);
});
