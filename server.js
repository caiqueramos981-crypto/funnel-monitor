const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/dashboard.html');
});

const PORT = process.env.PORT || 3000;

/* ───── ENV ───── */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin123';
const LASTLINK_SECRET = process.env.LASTLINK_WEBHOOK_SECRET || '';

/* ───── STATE ───── */
const wsClients = new Set();

const heatmap = [];

const stats = {
  live: 0,

  totalSales: 0,

  revenue: 0,

  countries: {},

  sales: [],

  funnelSteps: [
    {
      id: 'quiz',
      label: 'Quiz',
      total: 100,
      live: 0,
      conversion: 100
    },

    {
      id: 'checkout',
      label: 'Checkout',
      total: 60,
      live: 0,
      conversion: 60
    }
  ]
};

/* ───── WS ───── */
wss.on('connection', (ws, req) => {

  const url = new URL(req.url, 'http://localhost');

  if (url.searchParams.get('token') !== ADMIN_TOKEN) {
    ws.close();
    return;
  }

  wsClients.add(ws);

  ws.send(JSON.stringify({
    type: 'stats',
    data: stats
  }));

  ws.on('close', () => {
    wsClients.delete(ws);
  });

});

/* ───── BROADCAST ───── */
function broadcast(obj) {

  const data = JSON.stringify(obj);

  for (const ws of wsClients) {

    if (ws.readyState === 1) {
      ws.send(data);
    }

  }

}

/* ───── AUTH ───── */
app.get('/api/auth', (req, res) => {

  const token =
    (req.headers.authorization || '')
      .replace('Bearer ', '');

  if (token !== ADMIN_TOKEN) {
    return res.sendStatus(401);
  }

  return res.json({
    ok: true
  });

});

/* ───── API ───── */
app.get('/api/stats', (req, res) => {

  res.json(stats);

});

/* ───── LASTLINK WEBHOOK ───── */
app.post('/webhook/lastlink', async (req, res) => {

  try {

    const data = req.body;

    console.log('📩 Webhook LastLink:', data);

    // Detecta status aprovado
    const status =
      data.status ||
      data.event ||
      data.payment_status;

    const approved =
      status === 'approved' ||
      status === 'paid' ||
      status === 'payment.approved' ||
      status === 'purchase_approved';

    if (!approved) {

      return res.json({
        ok: true,
        ignored: true
      });

    }

    // monta venda
    const sale = {

      id:
        data.id ||
        Date.now(),

      amount: Number(
        data.amount ||
        data.value ||
        data.purchase?.price ||
        0
      ),

      customer_name:
        data.customer?.name ||
        data.buyer?.name ||
        'Cliente',

      country:
        data.customer?.country ||
        'BR',

      source:
        data.utm?.source ||
        'LastLink',

      ts: Date.now()

    };

    // adiciona venda
    stats.sales.unshift(sale);

    // limita feed
    if (stats.sales.length > 100) {
      stats.sales.pop();
    }

    // atualiza KPIs
    stats.totalSales += 1;

    stats.revenue += sale.amount;

    // atualiza live fake
    stats.live =
      Math.floor(Math.random() * 200) + 20;

    // broadcast realtime
    broadcast({
      type: 'stats',
      data: stats,
      newSale: sale
    });

    return res.json({
      ok: true
    });

  } catch (err) {

    console.error('❌ Webhook Error:', err);

    return res.status(500).json({
      error: err.message
    });

  }

});

/* ───── HEATMAP ───── */
app.post('/api/heatmap', (req, res) => {

  heatmap.push({

    x: req.body.x || 0,

    y: req.body.y || 0,

    w: req.body.w || 1,

    h: req.body.h || 1,

    ts: Date.now()

  });

  if (heatmap.length > 2000) {
    heatmap.shift();
  }

  broadcast({
    type: 'heatmap',
    data: heatmap.slice(-200)
  });

  res.json({
    ok: true
  });

});

/* ───── MOCK LIVE DATA ───── */
setInterval(() => {

  stats.live =
    Math.floor(Math.random() * 200);

  stats.funnelSteps.forEach(step => {

    step.live =
      Math.floor(Math.random() * 100);

  });

  broadcast({
    type: 'stats',
    data: stats
  });

}, 3000);

/* ───── START ───── */
server.listen(PORT, '0.0.0.0', () => {

  console.log(`🚀 Running on ${PORT}`);

});