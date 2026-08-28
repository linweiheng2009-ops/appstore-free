#!/usr/bin/env node
/**
 * 02_detect.mjs · 检测"今日限免" + 产出 data/today_free.json
 *
 * 真限免定义：
 *   price_today = 0 AND price_yesterday > 0
 *
 * 数据来源：D1 prices 表
 * 产出：data/today_free.json（前端直接读这个）
 *       data/7day_free.json（近 7 日回看）
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
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

  const outPath = join(DATA_DIR, 'today_free.json');
  await writeFile(outPath, JSON.stringify(out, null, 2));
  console.log(`[detect] today_free.json: ${freeApps.length} 真限免 (${Object.keys(byRegion).join('/') || 'none'})`);
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
