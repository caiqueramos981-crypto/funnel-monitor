require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const DATA_FILE = path.join(__dirname, 'data.json');

// ─── In-memory store ───────────────────────────────────────────────────────────

const FUNNEL_STEPS = [
  'quiz',
  'resultado',
  'vendas',
  'checkout',
  'upsell',
  'obrigado'
];

const STEP_LABELS = {
  quiz:      'Página do Quiz',
  resultado: 'Resultado do Quiz',
  vendas:    'Página de Vendas',
  checkout:  'Checkout',
  upsell:    'Upsell Pós-compra',
  obrigado:  'Página de Obrigado'
};

// sessions: Map<sessionId, { page, funnel, country, city, ts, lastSeen }>
const sessions = new Map();

// hourly buckets: Map<"YYYY-MM-DD HH", Map<step, Set<sessionId>>>
const hourlyBuckets = new Map();

// daily stats: Map<"YYYY-MM-DD", { steps: {step: count}, sales: [] }>
let dailyStats = {};

// sales feed (last 50)
const salesFeed = [];

// Load persisted data
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (raw.dailyStats) dailyStats = raw.dailyStats;
      if (raw.salesFeed) salesFeed.push(...raw.salesFeed.slice(-50));
      console.log('[boot] Loaded persisted data.');
    }
  } catch (e) {
    console.warn('[boot] Could not load data.json:', e.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ dailyStats, salesFeed: salesFeed.slice(-50) }, null, 2));
  } catch (e) {
    console.warn('[save] Could not write data.json:', e.message);
  }
}

loadData();
setInterval(saveData, 5 * 60 * 1000); // every 5 min

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function hourKey() {
  const now = new Date();
  return `${now.toISOString().slice(0, 10)} ${String(now.getUTCHours()).padStart(2, '0')}`;
}

function ensureDay(day) {
  if (!dailyStats[day]) {
    dailyStats[day] = { steps: {}, countries: {}, sales: [] };
    FUNNEL_STEPS.forEach(s => { dailyStats[day].steps[s] = 0; });
  }
}

function ensureHour(hk) {
  if (!hourlyBuckets.has(hk)) {
    const m = new Map();
    FUNNEL_STEPS.forEach(s => m.set(s, new Set()));
    hourlyBuckets.set(hk, m);
  }
}

function cleanOldSessions() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [sid, s] of sessions) {
    if (s.lastSeen < cutoff) sessions.delete(sid);
  }
}
setInterval(cleanOldSessions, 60 * 1000);

function cleanOldHours() {
  const cutoffHour = new Date(Date.now() - 13 * 60 * 60 * 1000);
  const cutoffKey = `${cutoffHour.toISOString().slice(0, 10)} ${String(cutoffHour.getUTCHours()).padStart(2, '0')}`;
  for (const k of hourlyBuckets.keys()) {
    if (k < cutoffKey) hourlyBuckets.delete(k);
  }
}
setInterval(cleanOldHours, 60 * 60 * 1000);

// ─── CORS ─────────────────────────────────────────────────────────────────────

app.use(cors({
  origin: true,
  credentials: true
}));


app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth middleware ───────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  if (token === ADMIN_PASSWORD) return next();
  const q = req.query.token;
  if (q === ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /track — pageview events from snippet.js
app.post('/track', (req, res) => {
  const {
  sessionId,
  page,
  funnel = 'default',
  country,
  city,
  referrer,
  timestamp
} = req.body;

if (!sessionId || !page) return res.status(400).json({ error: 'Missing fields' });

  const step = FUNNEL_STEPS.includes(page) ? page : null;
  const now = Date.now();
  const day = todayKey();
  const hk = hourKey();

  // Update session
  sessions.set(sessionId, { page, funnel, country: country || 'XX', city: city || '', lastSeen: now });

  if (step) {
    ensureDay(day);
    ensureHour(hk);

    // Daily unique sessions per step
    const sid_key = `${day}:${step}:${sessionId}`;
    if (!dailyStats[day][`_seen_${step}`]) dailyStats[day][`_seen_${step}`] = new Set();
    if (!dailyStats[day][`_seen_${step}`].has(sessionId)) {
      dailyStats[day][`_seen_${step}`].add(sessionId);
      dailyStats[day].steps[step]++;
    }

    // Country count
    if (!dailyStats[day].countries) dailyStats[day].countries = {};
    const c = country || 'XX';
    dailyStats[day].countries[c] = (dailyStats[day].countries[c] || 0) + 1;

    // Hourly bucket
    hourlyBuckets.get(hk).get(step).add(sessionId);
  }

  broadcastStats();
  res.json({ ok: true });
});

// POST /webhook/mundpay — payment confirmed
app.post('/webhook/mundpay', (req, res) => {
  const { event, order_id, product_id, amount, customer } = req.body;
  if (event !== 'payment.approved') return res.json({ ok: true, ignored: true });

  const day = todayKey();
  ensureDay(day);

  const sale = {
    id: order_id,
    product_id,
    amount: parseFloat(amount) || 0,
    customer_name: customer?.name || 'Cliente',
    country: 'BR', // Mundpay primarily BR; can be extended
    ts: Date.now()
  };

  salesFeed.push(sale);
  if (salesFeed.length > 100) salesFeed.shift();

  if (!dailyStats[day].sales) dailyStats[day].sales = [];
  dailyStats[day].sales.push(sale);

  // Also register as checkout+obrigado conversion
  const fakeSession = `mw_${order_id}`;
  ['checkout', 'obrigado'].forEach(step => {
    if (!dailyStats[day][`_seen_${step}`]) dailyStats[day][`_seen_${step}`] = new Set();
    if (!dailyStats[day][`_seen_${step}`].has(fakeSession)) {
      dailyStats[day][`_seen_${step}`].add(fakeSession);
      dailyStats[day].steps[step]++;
    }
  });

  broadcastStats({ newSale: sale });
  res.json({ ok: true });
});

// POST /webhook/lowify
app.post('/webhook/lowify', (req, res) => {

  console.log('LOWIFY WEBHOOK RECEBIDO');
  console.log(req.body);

  const data = req.body;

  // Detecta compra aprovada
  const status =
    data.status ||
    data.event ||
    data.payment_status;

  const approved =
    status === 'approved' ||
    status === 'paid' ||
    status === 'payment.approved';

  if (!approved) {
    return res.json({
      ok: true,
      ignored: true
    });
  }

  const day = todayKey();
  ensureDay(day);

  const sale = {
    id:
      data.id ||
      data.transaction_id ||
      Date.now(),

    product_id:
      data.product_name ||
      data.product ||
      'Produto',

    amount:
      parseFloat(data.amount || data.price || 0),

    customer_name:
      data.customer?.name ||
      data.name ||
      'Cliente',

    country: 'BR',
    ts: Date.now()
  };

  salesFeed.push(sale);

  if (salesFeed.length > 100) {
    salesFeed.shift();
  }

  if (!dailyStats[day].sales) {
    dailyStats[day].sales = [];
  }

  dailyStats[day].sales.push(sale);

  // registra conversão
  const fakeSession = `lw_${sale.id}`;

  ['checkout', 'obrigado'].forEach(step => {

    if (!dailyStats[day][`_seen_${step}`]) {
      dailyStats[day][`_seen_${step}`] = new Set();
    }

    if (!dailyStats[day][`_seen_${step}`].has(fakeSession)) {

      dailyStats[day][`_seen_${step}`].add(fakeSession);

      dailyStats[day].steps[step]++;

    }

  });

  broadcastStats({
    newSale: sale
  });

  res.json({
    ok: true
  });

});

// GET /api/auth — validate password
app.get('/api/auth', authMiddleware, (req, res) => {
  res.json({ ok: true });
});

// GET /api/stats — full stats for dashboard
app.get('/api/stats', authMiddleware, (req, res) => {
  res.json(buildStatsPayload());
});

// ─── Stats builder ────────────────────────────────────────────────────────────

function buildStatsPayload() {
  const day = todayKey();
  ensureDay(day);

  const ds = dailyStats[day];

  // Live sessions (active in last 5 min)
  const liveCutoff = Date.now() - 5 * 60 * 1000;
  let liveCount = 0;
  const liveByStep = {};
  FUNNEL_STEPS.forEach(s => liveByStep[s] = 0);

  for (const [, s] of sessions) {
    if (s.lastSeen >= liveCutoff) {
      liveCount++;
      if (liveByStep[s.page] !== undefined) liveByStep[s.page]++;
    }
  }

  // Funnel steps
  const funnelSteps = FUNNEL_STEPS.map((step, i) => {
    const total = ds.steps[step] || 0;
    const prev = i > 0 ? (ds.steps[FUNNEL_STEPS[i - 1]] || 0) : total;
    const conv = prev > 0 ? Math.round((total / prev) * 100) : (i === 0 ? 100 : 0);
    return {
      id: step,
      label: STEP_LABELS[step],
      total,
      live: liveByStep[step],
      conversion: conv
    };
  });

  // Countries top 10
  const countries = Object.entries(ds.countries || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([code, count]) => ({ code, count }));

  // Hourly chart (last 12h)
  const chart = buildHourlyChart();

  // Sales
  const sales = (ds.sales || []).slice(-10).reverse();
  const revenue = (ds.sales || []).reduce((a, s) => a + (s.amount || 0), 0);

  return {
    live: liveCount,
    funnelSteps,
    countries,
    chart,
    sales,
    revenue,
    totalSales: (ds.sales || []).length,
    ts: Date.now()
  };
}

function buildHourlyChart() {
  const result = [];
  const now = new Date();

  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 60 * 60 * 1000);
    const hk = `${d.toISOString().slice(0, 10)} ${String(d.getUTCHours()).padStart(2, '0')}`;
    const bucket = hourlyBuckets.get(hk);
    const entry = { hour: `${String(d.getUTCHours()).padStart(2, '0')}:00` };
    FUNNEL_STEPS.forEach(s => {
      entry[s] = bucket ? bucket.get(s).size : 0;
    });
    result.push(entry);
  }
  return result;
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

const wsClients = new Set();

wss.on('connection', (ws, req) => {
  // Simple token auth via query string
  const url = new URL(req.url, `http://localhost`);
  const token = url.searchParams.get('token');
  if (token !== ADMIN_PASSWORD) {
    ws.close(1008, 'Unauthorized');
    return;
  }
  wsClients.add(ws);
  ws.send(JSON.stringify({ type: 'stats', data: buildStatsPayload() }));
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

function broadcastStats(extra = {}) {
  if (wsClients.size === 0) return;
  const payload = JSON.stringify({ type: 'stats', data: buildStatsPayload(), ...extra });
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

// Broadcast every 10s even without events
setInterval(broadcastStats, 10 * 1000);

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[server] Funnel Monitor running on port ${PORT}`);
  console.log(`[server] Dashboard → http://localhost:${PORT}/dashboard.html`);
});

process.on('SIGTERM', () => { saveData(); process.exit(0); });
process.on('SIGINT',  () => { saveData(); process.exit(0); });
