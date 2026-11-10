/**
 * 用 CDP 截图（可指定宽度，模拟手机 / 电脑），并顺手报出横向溢出的元素。
 *
 *   node scripts/shot.js 390 844 preview-mobile.png
 *   node scripts/shot.js 1360 900 preview-desktop.png
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const [width = '390', height = '844', outFile = 'shot.png'] = process.argv.slice(2);
const CDP_PORT = Number(process.env.CDP_PORT || 9444);
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4321/';

const CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const browserPath = CANDIDATES.find((p) => fs.existsSync(p));
if (!browserPath) { console.error('找不到浏览器'); process.exit(1); }

const profileDir = path.join(os.tmpdir(), 'store-book-shot-' + Date.now());
const child = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
    } catch (e) {}
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('等不到调试端口');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP 连接失败')); });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: Number(width), height: Number(height), deviceScaleFactor: 2, mobile: Number(width) < 700,
  });
  await send('Page.navigate', { url: APP_URL });
  await sleep(2500);

  const info = await evaluate(`(() => {
    const de = document.documentElement;
    const wide = [...document.querySelectorAll('body *')]
      .filter(el => el.getBoundingClientRect().right > de.clientWidth + 1)
      .slice(0, 8)
      .map(el => el.tagName + (el.id ? '#' + el.id : '') + '.' + (el.className || '') + ' right=' + Math.round(el.getBoundingClientRect().right));
    return { clientWidth: de.clientWidth, scrollWidth: de.scrollWidth, wide };
  })()`);

  console.log(`视口 ${width}x${height}  文档宽 ${info.scrollWidth}px（clientWidth ${info.clientWidth}px）`);
  if (info.wide.length) console.log('横向溢出元素：\n  ' + info.wide.join('\n  '));

  const shot = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true, fromSurface: true,
  });
  fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
  console.log('已保存 ' + outFile);

  ws.close();
  child.kill();
  process.exit(0);
})().catch((err) => {
  console.error(err && err.stack || err);
  try { child.kill(); } catch (e) {}
  process.exit(1);
});
