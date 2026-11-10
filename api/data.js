/**
 * Vercel Serverless Function —— 前端唯一的数据入口
 *
 *   GET  /api/data                    → { ok, records, updatedAt }
 *   POST /api/data  { op: 'add',      record: {...} }   → 追加一条
 *   POST /api/data  { op: 'delete',   id: 'xxx' }       → 删除一条
 *   POST /api/data  { op: 'replace',  records: [...] }  → 整体覆盖（导入 / 清空）
 *
 * 数据只存一个 Redis Key（默认 store_records），Value 是
 * {"records":[...],"updatedAt":<毫秒时间戳>} 的 JSON 字符串。
 * Upstash Token 只存在于 Vercel 环境变量里，浏览器拿不到。
 *
 * 这里用「按条操作」而不是「整表覆盖」，是为了避免：
 * 手机打开的是旧页面 → 记一笔 → 把电脑上此间新增的记录整片覆盖掉。
 */

const DEFAULT_KEY = 'store_records';

function redisBase() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  if (!url) throw new Error('缺少环境变量 UPSTASH_REDIS_REST_URL');
  return url.replace(/\/+$/, '');
}

function redisToken() {
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!token) throw new Error('缺少环境变量 UPSTASH_REDIS_REST_TOKEN');
  return token;
}

const KEY = process.env.STORE_KEY || DEFAULT_KEY;

/** 调 Upstash REST API，返回 result 字段 */
async function redisGet() {
  const res = await fetch(`${redisBase()}/get/${encodeURIComponent(KEY)}`, {
    headers: { Authorization: `Bearer ${redisToken()}` },
    cache: 'no-store',
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error || `Redis GET 失败 (${res.status})`);
  return json.result;
}

async function redisSet(value) {
  const res = await fetch(`${redisBase()}/set/${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken()}` },
    body: value,
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error || `Redis SET 失败 (${res.status})`);
  return json.result;
}

/** 读当前状态，兼容空库 / 老格式（纯数组） */
async function readState() {
  const raw = await redisGet();
  if (!raw) return { records: [], updatedAt: 0 };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('Redis 里的数据不是合法 JSON，请到 Upstash 控制台检查 ' + KEY);
  }
  if (Array.isArray(parsed)) return { records: parsed, updatedAt: 0 };
  return {
    records: Array.isArray(parsed.records) ? parsed.records : [],
    updatedAt: Number(parsed.updatedAt) || 0,
  };
}

async function writeState(records) {
  const state = { records, updatedAt: Date.now() };
  await redisSet(JSON.stringify(state));
  return state;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function normalize(record) {
  if (!record || typeof record !== 'object') throw badRequest('record 格式不正确');
  const amount = Number(record.amount);
  if (!record.date || typeof record.date !== 'string') throw badRequest('date 格式不正确');
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('amount 必须是大于 0 的数字');
  if (record.type !== '收入' && record.type !== '支出') throw badRequest('type 必须是「收入」或「支出」');
  return {
    id: String(record.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
    date: record.date,
    type: record.type,
    category: String(record.category || ''),
    note: String(record.note || ''),
    amount: Math.round(amount * 100) / 100,
    pay: String(record.pay || ''),
    person: String(record.person || ''),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const state = await readState();
      return res.status(200).json({ ok: true, records: state.records, updatedAt: state.updatedAt });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: '只支持 GET / POST' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const op = body.op || 'replace';
    const state = await readState();
    let next = state.records;

    if (op === 'add') {
      const record = normalize(body.record);
      next = state.records.filter((r) => r.id !== record.id).concat(record);
    } else if (op === 'delete') {
      const id = String(body.id || '');
      next = state.records.filter((r) => r.id !== id);
    } else if (op === 'replace') {
      if (!Array.isArray(body.records)) {
        return res.status(400).json({ ok: false, error: 'records 必须是数组' });
      }
      // 按 id 去重，避免同一批数据重复导入
      const seen = new Set();
      next = body.records.map(normalize).filter((r) => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });
    } else {
      return res.status(400).json({ ok: false, error: '未知的 op：' + op });
    }

    const saved = await writeState(next);
    return res.status(200).json({ ok: true, records: saved.records, updatedAt: saved.updatedAt });
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    if (status >= 500) console.error('[api/data]', err);
    const message = err && err.message ? err.message : '服务器错误';
    return res.status(status).json({ ok: false, error: message });
  }
};
