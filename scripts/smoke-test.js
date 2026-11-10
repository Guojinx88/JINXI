/**
 * 冒烟测试：用本机 Edge 的无头模式打开页面，模拟"记一笔 / 删除"，
 * 确认前端 → /api/data → 存储 → 回显 这条链路是通的。
 *
 * 用法：
 *   1. 先启动本地服务      node dev-server.js
 *   2. 再另开一个终端跑      node scripts/smoke-test.js
 *
 * 依赖：Node 22+（自带 WebSocket）、本机安装 Edge 或 Chrome。
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4321/';
const CDP_PORT = Number(process.env.CDP_PORT || 9333);

const CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

const browserPath = CANDIDATES.find((p) => fs.existsSync(p));
if (!browserPath) {
  console.error('找不到 Edge / Chrome，可通过 EDGE_PATH 环境变量指定');
  process.exit(1);
}

const profileDir = path.join(os.tmpdir(), 'store-book-smoke-' + Date.now());

const child = spawn(browserPath, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profileDir}`,
  '--window-size=1360,2000',
  APP_URL,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPageTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { /* 浏览器还没起来 */ }
    await sleep(200);
  }
  throw new Error('等不到浏览器的调试端口');
}

(async () => {
  const target = await getPageTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('连接 CDP 失败'));
  });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    }
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  // 等首屏同步完成
  for (let i = 0; i < 60; i++) {
    const pill = await evaluate(`(document.getElementById('sync-pill')||{}).textContent||''`);
    if (pill && pill.indexOf('已同步') >= 0) break;
    await sleep(250);
  }

  const node = process.version;
  console.log('浏览器已连接，Node ' + node);

  const before = await evaluate(`document.querySelectorAll('#tbody-flow tr').length`);
  const stamp = 'smoke-' + Date.now();

  const addResult = await evaluate(`(async () => {
    window.confirm = () => true;
    document.getElementById('f-date').value = '2026-11-10';
    document.getElementById('f-type').value = '收入';
    document.getElementById('f-type').dispatchEvent(new Event('change'));
    document.getElementById('f-category').value = '商品销售';
    document.getElementById('f-note').value = ${JSON.stringify(stamp)};
    document.getElementById('f-amount').value = '99.5';
    document.getElementById('f-person').value = '测试';
    document.getElementById('btn-add').click();
    await new Promise(r => setTimeout(r, 1200));
    const data = await fetch('/api/data?t=' + Date.now()).then(r => r.json());
    return {
      rows: document.querySelectorAll('#tbody-flow tr').length,
      saved: data.records.some(r => r.note === ${JSON.stringify(stamp)}),
      pill: document.getElementById('sync-pill').textContent,
      income: document.getElementById('s-income').textContent,
    };
  })()`, true);

  if (!addResult.saved) throw new Error('新增记录没有写进服务端：' + JSON.stringify(addResult));
  if (addResult.rows !== before + 1) throw new Error('新增后表格行数不对：' + JSON.stringify(addResult));
  console.log('✓ 新增记录：表格 ' + before + ' → ' + addResult.rows + ' 行，状态「' + addResult.pill + '」，收入合计 ' + addResult.income);

  const delResult = await evaluate(`(async () => {
    window.confirm = () => true;
    const rows = [...document.querySelectorAll('#tbody-flow tr')];
    const target = rows.find(tr => tr.textContent.includes(${JSON.stringify(stamp)}));
    target.querySelector('.del-btn').click();
    await new Promise(r => setTimeout(r, 1200));
    const data = await fetch('/api/data?t=' + Date.now()).then(r => r.json());
    return {
      rows: document.querySelectorAll('#tbody-flow tr').length,
      stillThere: data.records.some(r => r.note === ${JSON.stringify(stamp)}),
    };
  })()`, true);

  if (delResult.stillThere) throw new Error('删除后服务端仍有该记录');
  if (delResult.rows !== before) throw new Error('删除后行数没有回到原值：' + JSON.stringify(delResult));
  console.log('✓ 删除记录：回到 ' + delResult.rows + ' 行，服务端已同步');

  // 汇总表自检：每日汇总的行数应等于流水里出现过的日期数
  const daily = await evaluate(`(async () => {
    const data = await fetch('/api/data?t=' + Date.now()).then(r => r.json());
    const dates = new Set(data.records.map(r => r.date));
    const rows = [...document.querySelectorAll('#tbody-daily tr')].filter(tr => !tr.querySelector('.empty'));
    return { dates: dates.size, rows: rows.length, last: (rows[rows.length-1]||{}).textContent || '' };
  })()`, true);
  if (daily.rows !== daily.dates) {
    throw new Error(`每日汇总行数(${daily.rows}) ≠ 记录里的日期数(${daily.dates})`);
  }
  console.log(`✓ 每日汇总：${daily.rows} 天，行数与流水日期一致`);

  console.log('\n冒烟测试通过 ✅');
  ws.close();
  child.kill();
  process.exit(0);
})().catch(async (err) => {
  console.error('\n冒烟测试失败 ❌\n' + (err && err.stack || err));
  try { child.kill(); } catch (e) {}
  process.exit(1);
});
