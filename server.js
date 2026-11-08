const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 10000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false });
const ALLOWED = new Set(['ctc_hr_demo', 'ctc_hr_requests', 'nth_hr_payroll_settings', 'ctc_hr_attendance', 'nth_hr_employee_passwords']);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));

async function init(){
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL chưa được cấu hình');
  await pool.query(`CREATE TABLE IF NOT EXISTS hr_shared_state (
    state_key TEXT PRIMARY KEY,
    state_value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS hr_shared_meta (id INTEGER PRIMARY KEY CHECK (id=1), revision BIGINT NOT NULL DEFAULT 0)`);
  await pool.query('INSERT INTO hr_shared_meta(id,revision) VALUES(1,0) ON CONFLICT(id) DO NOTHING');
}
app.get('/api/health', async (_req,res)=>{
  try { await pool.query('SELECT 1'); res.json({ok:true, database:'connected'}); }
  catch(e){ res.status(503).json({ok:false}); }
});
app.get('/api/state', async (_req,res)=>{
  try {
    const [rows,meta] = await Promise.all([
      pool.query('SELECT state_key,state_value FROM hr_shared_state WHERE state_key = ANY($1)', [[...ALLOWED]]),
      pool.query('SELECT revision FROM hr_shared_meta WHERE id=1')
    ]);
    const state = {}; for (const row of rows.rows) state[row.state_key] = row.state_value;
    res.set('Cache-Control','no-store').json({state, revision:Number(meta.rows[0]?.revision || 0)});
  } catch(e){ console.error(e); res.status(500).json({error:'Không đọc được dữ liệu'}); }
});
app.put('/api/state', async (req,res)=>{
  const {key,value} = req.body || {};
  if (!ALLOWED.has(key) || typeof value !== 'string' || value.length > 900_000) return res.status(400).json({error:'Dữ liệu không hợp lệ'});
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(`INSERT INTO hr_shared_state(state_key,state_value,updated_at) VALUES($1,$2,NOW())
      ON CONFLICT(state_key) DO UPDATE SET state_value=EXCLUDED.state_value,updated_at=NOW()`,[key,value]);
    const result = await client.query('UPDATE hr_shared_meta SET revision=revision+1 WHERE id=1 RETURNING revision');
    await client.query('COMMIT');
    res.set('Cache-Control','no-store').json({ok:true,revision:Number(result.rows[0].revision)});
  } catch(e){
    if(client){try{await client.query('ROLLBACK')}catch(_){}}
    console.error('Lỗi ghi dữ liệu HR:',e);
    res.status(500).json({error:'Không lưu được dữ liệu'});
  } finally { if(client) client.release(); }
});
app.use(express.static('public'));
app.get('*', (_req,res)=>res.sendFile(require('path').join(__dirname,'public','index.html')));
init().then(()=>app.listen(port,()=>console.log(`HR server listening on ${port}`))).catch(e=>{console.error(e);process.exit(1)});
