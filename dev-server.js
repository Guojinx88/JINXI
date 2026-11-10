/**
 * 本地开发服务器（仅用于本机预览 / 测试，不部署到 Vercel）
 *
 *   node dev-server.js
 *
 * 作用：
 *   1. 托管 public/ 下的静态页面
 *   2. 把 /api/data 交给 api/data.js 处理（和线上同一份代码）
 *   3. 没有配置 Upstash 时，用 data/mock-redis.json 假装成 Redis，
 *      所以不注册 Upstash 也能先在电脑上把功能跑通
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 4321);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const MOCK_DIR = path.join(ROOT, 'data');
const MOCK_FILE = path.join(MOCK_DIR, 'mock-redis.json');

/* ---------- 读取 .env ---------- */
(function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) return;
    const value = m[2].replace(/^['"]|['"]$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = value;
  });
})();

const USE_MOCK = !process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN;
if (USE_MOCK) {
  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${PORT}/mock-redis`;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'local-mock-token';
}

if (!fs.existsSync(MOCK_DIR)) fs.mkdirSync(MOCK_DIR, { recursive: true });

function mockRead() {
  try { return JSON.parse(fs.readFileSync(MOCK_FILE, 'utf8')); } catch (e) { return {}; }
}

function mockWrite(obj) {
  fs.writeFileSync(MOCK_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

/* ---------- 工具 ---------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 5e6) reject(new Error('body 过大')); });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function wrapRes(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

const handler = require('./api/data.js');

/* ---------- 服务器 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);
  wrapRes(res);

  // 假的 Redis REST 接口
  if (pathname.startsWith('/mock-redis/')) {
    const [, , action, ...rest] = pathname.split('/');
    const key = rest.join('/');
    const store = mockRead();

    if (action === 'get') {
      return res.json({ result: Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null });
    }
    if (action === 'set') {
      store[key] = await readBody(req);
      mockWrite(store);
      return res.json({ result: 'OK' });
    }
    res.statusCode = 404;
    return res.json({ error: 'mock redis: unknown action' });
  }

  // 业务 API
  if (pathname === '/api/data') {
    try {
      if (req.method === 'POST') {
        req.body = await readBody(req);
      }
      await handler(req, res);
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, error: String(err && err.message || err) });
    }
    return;
  }

  // 静态文件
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('404 Not Found');
  }
  res.setHeader('Content-Type', MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  门店收支表 本地预览： http://127.0.0.1:${PORT}\n`);
  console.log(USE_MOCK
    ? '  数据存储：本地模拟 Redis（data/mock-redis.json）\n  想连真实 Upstash：复制 .env.example 为 .env 并填入 URL / Token\n'
    : '  数据存储：Upstash Redis（来自 .env）\n');
});
