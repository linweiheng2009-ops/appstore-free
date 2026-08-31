/**
 * E2E 前端测试（Playwright）
 *
 * 关键设计：测试在隔离的 fixture 上跑 —— 把 public/ 复制到 /tmp/afc-fixture-XXX/，
 * 合成数据只写到 fixture 里。public/data/ 永不被污染，源数据在 CI / 本地都安全。
 *
 * 跑法：
 *   1. 安装：npm i -g playwright && npx playwright install chromium
 *   2. 编辑下方 PLAYWRIGHT_PATH 指向你的全局 playwright（其他机器改成各自的路径）
 *   3. npm test
 */

import { chromium } from '/Users/linweiheng/.npm-global/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');
const PUBLIC = join(PROJECT, 'public');

// ── 1. 准备 fixture：拷贝 public/ → /tmp/afc-fixture-XXXX ─────────────────
const FIXTURE = await mkdtemp(join(tmpdir(), 'afc-fixture-'));
await cp(PUBLIC, FIXTURE, { recursive: true });
console.log('[fixture]', FIXTURE, '（public/ 的隔离副本）');

// ── 2. 合成数据（3 今日 + 1 昨日 + 1 翻转去重测试）─────────────────────
const mk = (id, region, name, genre, price, currency, date, platform = 'ios') => ({
  app_id: id, region, platform, track_name: name, artist_name: 'Test Dev', genre,
  price: 0, currency, previous_price: price, previous_currency: currency,
  track_view_url: 'https://apps.apple.com/app/id' + id,
  artwork_url_100: 'https://picsum.photos/seed/' + id + '/100',
  bundle_id: 'com.test.' + id, date, free_date: date,
});
const us1 = mk('1', 'US', 'US Photo Pro', 'Photo & Video', 4.99, 'USD', '2026-08-28', 'ios');
const cn1 = mk('2', 'CN', '中文笔记',     'Utilities',      6,    'CNY', '2026-08-28', 'ios');
const jp1 = mk('3', 'JP', 'JP Game X',   'Games',          1200, 'JPY', '2026-08-28', 'ios');
const y1  = mk('4', 'SG', 'SG Yesterday', 'Games',         2.99, 'SGD', '2026-08-27', 'ios');
const us1dup = { ...us1, free_date: '2026-08-26' }; // 同 iOS app 翻转两次 → 7 日视图去重
const mac1 = mk('5', 'US', 'Pro Mac App', 'Developer Tools', 19.99, 'USD', '2026-08-28', 'mac');
const mac2 = mk('7', 'JP', 'Mac Yesterday', 'Games',         980, 'JPY', '2026-08-27', 'mac');

await writeFile(join(FIXTURE, 'data', 'today_free.json'), JSON.stringify({
  date: '2026-08-28', detected_at: '2026-08-28T00:10:00Z', method: 'test',
  total: 4,
  by_region: { US: 2, CN: 1, JP: 1, SG: 0 },
  by_platform: { ios: 3, mac: 1 },
  apps: [us1, cn1, jp1, mac1],
}, null, 2));
await writeFile(join(FIXTURE, 'data', 'week_free.json'), JSON.stringify({
  generated_at: '2026-08-28T00:10:00Z',
  window: { start: '2026-08-22', end: '2026-08-28' },
  total: 7,
  by_region: { US: 3, CN: 1, JP: 2, SG: 1 },
  by_platform: { ios: 5, mac: 2 },
  apps: [us1, cn1, jp1, y1, us1dup, mac1, mac2],
}, null, 2));

// 热门付费 APP fixture：3 个高价的 iOS 付费 app（仅前段需要渲染时序稳定）
await writeFile(join(FIXTURE, 'data', 'popular.json'), JSON.stringify({
  date: '2026-08-28', generated_at: '2026-08-28T00:10:00Z', source: 'test fixture',
  total: 3,
  apps: [
    { app_id: 'P1', region: 'US', currency: 'USD', price: 59.99, track_name: 'Expensive Pro', artist_name: 'Big Co', genre: 'Productivity', track_view_url: 'https://apps.apple.com/app/idP1', artwork_url_100: 'https://picsum.photos/seed/P1/100' },
    { app_id: 'P2', region: 'CN', currency: 'CNY', price: 198,   track_name: '高价工具',     artist_name: '本地工作室', genre: '工具',     track_view_url: 'https://apps.apple.com/app/idP2', artwork_url_100: 'https://picsum.photos/seed/P2/100' },
    { app_id: 'P3', region: 'JP', currency: 'JPY', price: 4800,   track_name: 'JP Premium',   artist_name: 'JP Studio', genre: 'Games',     track_view_url: 'https://apps.apple.com/app/idP3', artwork_url_100: 'https://picsum.photos/seed/P3/100' },
  ],
}, null, 2));

// ── 3. 启动 http server（固定端口 8770，避免正则解析端口的不确定性）──────
const PORT = 8770;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', FIXTURE],
  { stdio: ['ignore', 'pipe', 'pipe'] });
const BASE = `http://localhost:${PORT}`;
// 探测 server 是否真起来了（最多 5s），避免命令行输出格式变化导致误判
for (let i = 0; i < 50; i++) {
  try {
    const r = await fetch(BASE + '/');
    if (r.ok) break;
  } catch {}
  await sleep(100);
}
console.log('[server]', BASE);

// ── 4. 测试 ────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL: ' + name); }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });

const timeTabs = await page.locator('#timeTabs .tab').allTextContents();
ok(timeTabs[0].includes('今日') && timeTabs[0].includes('4'), '今日 tab 计数=4');
ok(timeTabs.some(t => t.includes('昨日') && t.includes('2')), '昨日 tab 计数=2');
ok(timeTabs.some(t => t.includes('近 7 日') && t.includes('6')), '近7日 tab 去重后计数=6');
ok(await page.locator('#content .card').count() === 4, '今日 4 张卡片（含 mac）');
ok(await page.locator('.stat-pill').count() === 2, '2 个数据砖（去检测时间）');

// ── 平台 tabs ──
const platformTabs = await page.locator('#platformTabs .tab').allTextContents();
ok(platformTabs[0].includes('全部') && platformTabs[0].includes('4'), '平台 ALL 计数=4');
ok(platformTabs.some(t => t.includes('iOS') && t.includes('3')), 'iOS 计数=3');
ok(platformTabs.some(t => t.includes('macOS') && t.includes('1')), 'macOS 计数=1');
await page.locator('#platformTabs .tab', { hasText: 'macOS' }).click();
ok(await page.locator('#content .card').count() === 1, 'macOS 过滤后 1 张');
ok(await page.locator('.card .name').first().textContent().then(t => t.includes('Pro Mac App')), 'macOS 那张是 Pro Mac App');
await page.locator('#platformTabs .tab', { hasText: 'iOS' }).click();
ok(await page.locator('#content .card').count() === 3, 'iOS 过滤后 3 张');
await page.locator('#platformTabs .tab', { hasText: '全部' }).click();

const usCard = page.locator('.card', { hasText: 'US Photo Pro' });
ok(await usCard.locator('.badge-was').textContent().then(t => t.includes('$4.99') && t.includes('≈¥36')), 'USD $4.99 → ≈¥36');
const jpCard = page.locator('.card', { hasText: 'JP Game X' });
ok(await jpCard.locator('.badge-was').textContent().then(t => t.includes('¥1200') && t.includes('≈¥58')), 'JPY ¥1200 → ≈¥58');
const cnCard = page.locator('.card', { hasText: '中文笔记' });
ok(await cnCard.locator('.badge-was').textContent().then(t => t.includes('¥6') && !t.includes('≈')), 'CNY 不重复换算');

await page.locator('#regionTabs .tab', { hasText: '美国' }).click();
ok(await page.locator('#content .card').count() === 2, '美国 tab 过滤后 2 张（iOS US Photo + Mac Pro App）');
await page.locator('#regionTabs .tab', { hasText: '全部' }).click();
await page.locator('#regionTabs .tab', { hasText: '台湾' }).click();
ok(await page.locator('#content .card').count() === 0, '台湾 tab 过滤后 0 张（fixture 无 TW 数据）');
await page.locator('#regionTabs .tab', { hasText: '香港' }).click();
ok(await page.locator('#content .card').count() === 0, '香港 tab 过滤后 0 张（fixture 无 HK 数据）');
await page.locator('#regionTabs .tab', { hasText: '全部' }).click();
await page.locator('#filters .chip', { hasText: 'Games' }).click();
ok(await page.locator('#content .card').count() === 1, 'Games 类目过滤后 1 张');
await page.locator('#filters .chip', { hasText: '全部类目' }).click();

await page.locator('#filters .chip', { hasText: '≈¥100+' }).click();
ok(await page.locator('#content .card').count() === 1, '≈¥100+ 为 1 张（Pro Mac App $19.99 ≈ ¥144）');
await page.locator('#filters .chip', { hasText: '≈¥30–100' }).click();
ok(await page.locator('#content .card').count() === 2, '≈¥30–100 两张');
await page.locator('#filters .chip', { hasText: '全部价位' }).click();

await page.locator('#timeTabs .tab', { hasText: '昨日' }).click();
ok(await page.locator('#content .card').count() === 2, '昨日 2 张（SG + Mac Yesterday）');
ok(await page.locator('.badge-date').first().textContent().then(t => t.includes('08-27')), '日期徽章 08-27');

await page.locator('#timeTabs .tab', { hasText: '近 7 日' }).click();
ok(await page.locator('#content .card').count() === 6, '近 7 日去重后 6 张');
ok(await page.locator('.badge-date').count() === 6, '近 7 日每卡有日期徽章');

await page.locator('#timeTabs .tab', { hasText: '今日' }).click();
await page.locator('.card', { hasText: 'US Photo Pro' }).locator('.fav').click();
const favs = await page.evaluate(() => localStorage.getItem('afc:favs'));
ok(favs && favs.includes('1:US'), '收藏写入 localStorage');
await page.locator('#filters .chip', { hasText: '只看收藏' }).click();
ok(await page.locator('#content .card').count() === 1, '只看收藏 1 张');
await page.locator('.card .fav').click();
ok(await page.locator('.empty').count() === 1, '收藏清空后空态');
await page.locator('#filters .chip', { hasText: '只看收藏' }).click();

ok(await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'dark', '默认深色主题');
await page.locator('#themeBtn').click();
ok(await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'light', '切换到浅色');
await page.locator('#themeBtn').click();

const cd = await page.locator('#countdown').textContent();
ok(/^\d{2}:\d{2}:\d{2}$/.test(cd), '倒计时格式 → ' + cd);

await page.locator('.card', { hasText: '中文笔记' }).locator('.fav').click();
await page.reload({ waitUntil: 'networkidle' });
ok(await page.evaluate(() => localStorage.getItem('afc:favs')).then(s => s.includes('2:CN')), '收藏跨刷新保留');
ok(await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'dark', '主题跨刷新保留');

// 热门付费区：基线日也有内容（放最后，避免打断前面的 flow）
ok(await page.locator('#popularSection').isVisible(), '热门付费区可见');
ok(await page.locator('#popularGrid .card').count() === 3, '热门付费 3 张');
const popularBadges = await page.locator('#popularGrid .badge-popular').count();
ok(popularBadges === 3, '每张热门卡都有「热门」徽章');
const popularHasRank = await page.locator('#popularGrid .badge-rank').first().textContent();
ok(popularHasRank.includes('#1'), '热门卡有排名徽章 #1');
ok(await page.locator('#popularGrid .card').first().getAttribute('data-url').then(u => u && u.startsWith('https://apps.apple.com')), '热门卡带 App Store 链接');

await browser.close();

// ── 5. 清理（fixture + server）────────────────────────────────────────
server.kill('SIGTERM');
await rm(FIXTURE, { recursive: true, force: true });

// 安全网：跑完后断言 public/data/ 没被污染（保险，万一以后改了 fixture 路径能立刻发现）
const pubData = await readdir(join(PUBLIC, 'data'));
const polluted = pubData.find((f) => f.endsWith('.json') && f !== 'today_free.json' && f !== 'week_free.json' && f !== 'popular.json');
const todayRaw = await readFile(join(PUBLIC, 'data', 'today_free.json'), 'utf8');
const containsTestDev = todayRaw.includes('Test Dev');

if (polluted || containsTestDev) {
  console.error('\n❌ public/data/ 已被污染！这不该发生：');
  if (polluted) console.error('   异常文件:', polluted);
  if (containsTestDev) console.error('   today_free.json 包含合成数据 (Test Dev)');
  process.exit(2);
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log('✓ public/data/ 未被污染');
process.exit(fail > 0 ? 1 : 0);