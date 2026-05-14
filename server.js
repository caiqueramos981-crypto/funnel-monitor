const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ───── STATE ───── */
const wsClients = new Set();
const heatmap = [];

const stats = {
  live: 0,
  totalSales: 0,
  revenue: 0,
  countries: [],
  funnelSteps: [
    { id:'quiz', total:100 },
    { id:'checkout', total:60 }
  ]
};

/* ───── WS ───── */
wss.on('connection', (ws, req)=>{
  const url = new URL(req.url, 'http://localhost');
  if(url.searchParams.get('token') !== 'admin123'){
    ws.close();
    return;
  }

  wsClients.add(ws);

  ws.send(JSON.stringify({
    type:'stats',
    data:stats
  }));

  ws.on('close', ()=> wsClients.delete(ws));
});

/* ───── BROADCAST ───── */
function broadcast(obj){
  const data = JSON.stringify(obj);
  for(const ws of wsClients){
    if(ws.readyState === 1){
      ws.send(data);
    }
  }
}

/* ───── STATS ───── */
app.get('/api/stats', (req,res)=>{
  res.json(stats);
});

/* ───── HEATMAP ───── */
app.post('/api/heatmap',(req,res)=>{
  const event = {
    x:req.body.x||0,
    y:req.body.y||0,
    w:req.body.w||1,
    h:req.body.h||1
  };

  heatmap.push(event);

  if(heatmap.length>2000) heatmap.shift();

  broadcast({
    type:'heatmap',
    data:heatmap.slice(-200)
  });

  res.json({ok:true});
});

/* ───── MOCK UPDATE ───── */
setInterval(()=>{
  stats.live = Math.floor(Math.random()*200);
  stats.totalSales += Math.floor(Math.random()*3);
  stats.revenue += Math.random()*50;

  broadcast({
    type:'stats',
    data:stats
  });
},3000);

/* ───── START ───── */
server.listen(PORT,()=>{
  console.log('Running on',PORT);
});