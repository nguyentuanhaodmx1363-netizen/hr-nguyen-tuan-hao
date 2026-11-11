const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.JWT_SECRET;
if (process.env.NODE_ENV === 'production' && (!SECRET || SECRET.length < 32)) {
  throw new Error('JWT_SECRET phải được cấu hình và có ít nhất 32 ký tự trong môi trường production.');
}
if (!process.env.DATABASE_URL) {
  throw new Error('Thiếu DATABASE_URL. Hãy tạo PostgreSQL và thêm connection string vào biến môi trường.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const schema = `
CREATE TABLE IF NOT EXISTS users (
 id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('manager','employee')),
 active INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS branches (id BIGSERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS daily_stats (
 id BIGSERIAL PRIMARY KEY, employee_id BIGINT NOT NULL REFERENCES users(id), work_date DATE NOT NULL,
 customers INTEGER NOT NULL DEFAULT 0, successful INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, branch TEXT NOT NULL DEFAULT 'Chưa phân cửa hàng',
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(employee_id, work_date)
);
CREATE TABLE IF NOT EXISTS manual_sales (
 id BIGSERIAL PRIMARY KEY, employee_id BIGINT NOT NULL REFERENCES users(id), sale_date DATE NOT NULL,
 model TEXT NOT NULL DEFAULT '', price BIGINT NOT NULL, branch TEXT NOT NULL DEFAULT 'Chưa phân cửa hàng', stock_source TEXT NOT NULL DEFAULT 'Trong kho',
 condition_type TEXT NOT NULL DEFAULT '99%', insurance INTEGER NOT NULL DEFAULT 0,
 insurance_revenue BIGINT NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'confirmed',
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS accessory_sales (
 id BIGSERIAL PRIMARY KEY, employee_id BIGINT NOT NULL REFERENCES users(id), sale_date DATE NOT NULL,
 branch TEXT NOT NULL, item_name TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1,
 amount BIGINT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_accessory_sales_date_employee ON accessory_sales(sale_date,employee_id);
CREATE TABLE IF NOT EXISTS kiot_sales (
 id BIGSERIAL PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, sale_date DATE NOT NULL,
 employee_name TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', price BIGINT NOT NULL DEFAULT 0,
 quantity INTEGER NOT NULL DEFAULT 1, branch TEXT NOT NULL DEFAULT '', raw_json TEXT NOT NULL DEFAULT '{}',
 imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS kiot_pay_classification (
 kiot_id BIGINT PRIMARY KEY REFERENCES kiot_sales(id) ON DELETE CASCADE,
 category TEXT NOT NULL CHECK(category IN ('large','accessory','tradein','insurance','exclude')),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payroll_staff (
 employee_name TEXT PRIMARY KEY, hire_date DATE, base_salary BIGINT NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_log (
 id BIGSERIAL PRIMARY KEY, actor_id BIGINT REFERENCES users(id), action TEXT NOT NULL,
 entity TEXT NOT NULL, entity_id BIGINT, detail TEXT NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS kpis (
 id BIGSERIAL PRIMARY KEY, employee_id BIGINT NOT NULL REFERENCES users(id), month TEXT NOT NULL,
 machine_target INTEGER NOT NULL DEFAULT 0, insurance_target INTEGER NOT NULL DEFAULT 0,
 UNIQUE(employee_id, month)
);
CREATE TABLE IF NOT EXISTS branch_kpis (
 id BIGSERIAL PRIMARY KEY, branch TEXT NOT NULL REFERENCES branches(name) ON UPDATE CASCADE, month TEXT NOT NULL,
 machine_target INTEGER NOT NULL DEFAULT 0, insurance_target INTEGER NOT NULL DEFAULT 0,
 UNIQUE(branch, month)
);
ALTER TABLE branch_kpis ADD COLUMN IF NOT EXISTS revenue_target NUMERIC(18,0) NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_manual_sales_date ON manual_sales(sale_date);
CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(work_date);
CREATE INDEX IF NOT EXISTS idx_kiot_sales_date ON kiot_sales(sale_date);
ALTER TABLE manual_sales ADD COLUMN IF NOT EXISTS branch TEXT NOT NULL DEFAULT 'Chưa phân cửa hàng';
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS branch TEXT NOT NULL DEFAULT 'Chưa phân cửa hàng';
CREATE INDEX IF NOT EXISTS idx_manual_sales_branch_date ON manual_sales(branch,sale_date);
CREATE INDEX IF NOT EXISTS idx_daily_stats_branch_date ON daily_stats(branch,work_date);
`;

const q = (text, params = []) => pool.query(text, params);
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const insuranceFee = price => price < 10000000 ? 799000 : price < 20000000 ? 999000 : 1499000;
const ownScope = (req, employeeId) => req.user.role === 'manager' || Number(employeeId) === Number(req.user.id);
async function log(actor, action, entity, id, detail = {}) {
  await q('INSERT INTO audit_log(actor_id,action,entity,entity_id,detail) VALUES($1,$2,$3,$4,$5)',
    [actor, action, entity, id, JSON.stringify(detail)]);
}

app.set('trust proxy', 1); // Render reverse proxy
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

const auth = wrap(async (req, res, next) => {
  const token = req.cookies.rz_session || (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'Vui lòng đăng nhập' });
  try {
    const payload = jwt.verify(token, SECRET || 'local-development-secret-change-before-deploy');
    const result = await q('SELECT id,username,display_name,role,active FROM users WHERE id=$1', [payload.id]);
    const user = result.rows[0];
    if (!user || !user.active) return res.status(401).json({ error: 'Tài khoản không hoạt động' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Phiên đăng nhập hết hạn' });
  }
});
const manager = (req, res, next) => req.user.role === 'manager' ? next() : res.status(403).json({ error: 'Bạn không có quyền thực hiện' });

app.get('/api/health', wrap(async (req, res) => {
  await q('SELECT 1');
  res.json({ ok: true, database: 'connected' });
}));

app.post('/api/setup', wrap(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const n = Number((await client.query('SELECT COUNT(*) AS n FROM users')).rows[0].n);
    if (n) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Hệ thống đã được khởi tạo' }); }
    const { username, password, displayName } = req.body;
    if (!username || !password || password.length < 10) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Tên đăng nhập bắt buộc; mật khẩu tối thiểu 10 ký tự' });
    }
    const result = await client.query(
      'INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id',
      [username, displayName || 'Quản lý', bcrypt.hashSync(password, 12), 'manager']);
    await client.query('COMMIT');
    res.json({ ok: true, id: result.rows[0].id });
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));
app.get('/api/setup-status', wrap(async (req, res) => {
  const r = await q('SELECT COUNT(*) AS n FROM users');
  res.json({ initialized: Number(r.rows[0].n) > 0 });
}));
app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body;
  const r = await q('SELECT * FROM users WHERE username=$1 AND active=1', [username || '']);
  const u = r.rows[0];
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
  const token = jwt.sign({ id: u.id }, SECRET || 'local-development-secret-change-before-deploy', { expiresIn: '12h' });
  res.cookie('rz_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 12 * 3600 * 1000 });
  res.json({ id: u.id, username: u.username, name: u.display_name, role: u.role });
}));
app.post('/api/logout', (req, res) => { res.clearCookie('rz_session'); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json(req.user));

app.get('/api/users', auth, wrap(async (req, res) => {
  const r = await q("SELECT id,username,display_name,role,active FROM users WHERE role='employee' ORDER BY display_name");
  res.json(req.user.role === 'manager' ? r.rows : r.rows.filter(x => Number(x.id) === Number(req.user.id)));
}));
app.post('/api/users', auth, manager, wrap(async (req, res) => {
  const { username, displayName, password } = req.body;
  if (!username || !displayName || !password || password.length < 8) return res.status(400).json({ error: 'Cần tên đăng nhập, tên hiển thị và mật khẩu tối thiểu 8 ký tự' });
  try {
    const r = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$2,$3,'employee') RETURNING id",
      [username, displayName, bcrypt.hashSync(password, 12)]);
    await log(req.user.id, 'create', 'user', r.rows[0].id, { username, displayName });
    res.json({ id: r.rows[0].id });
  } catch (e) { if (e.code === '23505') return res.status(400).json({ error: 'Tên đăng nhập đã tồn tại' }); throw e; }
}));

app.get('/api/managers', auth, manager, wrap(async (req, res) => {
  const r = await q("SELECT id,username,display_name,role,active,created_at FROM users WHERE role='manager' ORDER BY id");
  res.json(r.rows);
}));
app.post('/api/managers', auth, manager, wrap(async (req, res) => {
  const { username, displayName, password } = req.body;
  if (!username || !displayName || !password || password.length < 10)
    return res.status(400).json({ error: 'Cần tên đăng nhập, tên hiển thị và mật khẩu tối thiểu 10 ký tự' });
  try {
    const r = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$2,$3,'manager') RETURNING id",
      [username.trim(), displayName.trim(), bcrypt.hashSync(password, 12)]);
    await log(req.user.id, 'create', 'manager', r.rows[0].id, { username });
    res.json({ id: r.rows[0].id });
  } catch (e) { if (e.code === '23505') return res.status(400).json({ error: 'Tên đăng nhập đã tồn tại' }); throw e; }
}));
// Public password changes require the existing password; no active session is needed.
const passwordPublicLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });
app.post('/api/password/change-public', passwordPublicLimit, wrap(async (req, res) => {
  const { username, currentPassword, newPassword } = req.body || {};
  if (!username || !currentPassword || typeof newPassword !== 'string' || newPassword.length < 10 || newPassword.length > 128)
    return res.status(400).json({ error: 'Vui lòng nhập đủ thông tin, mật khẩu mới từ 10–128 ký tự' });
  const result = await q('SELECT id,password_hash FROM users WHERE username=$1 AND active=true', [username]);
  const user = result.rows[0];
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu hiện tại không đúng' });
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(newPassword, 12), user.id]);
  await log(user.id, 'change_password_public', 'user', user.id, {});
  res.json({ ok: true });
}));
// Recovery is disabled unless a strong private code is explicitly set in Render environment.
app.post('/api/password/recover', passwordPublicLimit, wrap(async (req, res) => {
  const { username, recoveryCode, newPassword } = req.body || {};
  const configured = process.env.MANAGER_RECOVERY_CODE || '';
  if (configured.length < 20) return res.status(503).json({ error: 'Chưa thiết lập mã khôi phục. Vui lòng liên hệ quản trị hệ thống.' });
  if (!username || typeof recoveryCode !== 'string' || typeof newPassword !== 'string' || newPassword.length < 10 || newPassword.length > 128)
    return res.status(400).json({ error: 'Thông tin khôi phục không hợp lệ' });
  const a = crypto.createHash('sha256').update(recoveryCode).digest();
  const b = crypto.createHash('sha256').update(configured).digest();
  if (!crypto.timingSafeEqual(a,b)) return res.status(401).json({ error: 'Thông tin khôi phục không hợp lệ' });
  const result = await q("SELECT id FROM users WHERE username=$1 AND role='manager' AND active=true", [username]);
  if (!result.rows[0]) return res.status(401).json({ error: 'Thông tin khôi phục không hợp lệ' });
  const id = result.rows[0].id;
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(newPassword,12), id]);
  await log(id, 'recover_password', 'user', id, {});
  res.json({ ok: true });
}));
app.post('/api/password', auth, wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 10)
    return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 10 ký tự' });
  const r = await q('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!r.rows[0] || !bcrypt.compareSync(currentPassword, r.rows[0].password_hash))
    return res.status(400).json({ error: 'Mật khẩu hiện tại không chính xác' });
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(newPassword, 12), req.user.id]);
  await log(req.user.id, 'change_password', 'user', req.user.id, {});
  res.json({ ok: true });
}));

app.patch('/api/users/:id', auth, manager, wrap(async (req, res) => {
  const { active, password, displayName } = req.body; const id = Number(req.params.id);
  if (active !== undefined) await q("UPDATE users SET active=$1 WHERE id=$2 AND role='employee'", [active ? 1 : 0, id]);
  if (password) { if (!(await q("SELECT 1 FROM users WHERE id=$1 AND role='employee'",[id])).rowCount) return res.status(404).json({error:'Không tìm thấy nhân viên'}); if (password.length < 8) return res.status(400).json({ error: 'Mật khẩu tối thiểu 8 ký tự' }); await q('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(password, 12), id]); }
  if (displayName) await q("UPDATE users SET display_name=$1 WHERE id=$2 AND role='employee'", [displayName, id]);
  await log(req.user.id, 'update', 'user', id, req.body); res.json({ ok: true });
}));


// Quản trị an toàn: vô hiệu hóa tài khoản, không xóa lịch sử doanh thu.
app.patch('/api/managers/:id', auth, manager, wrap(async (req,res)=>{
  const id=Number(req.params.id), {active,displayName}=req.body;
  if(!Number.isSafeInteger(id)||id<1) return res.status(400).json({error:'ID không hợp lệ'});
  if(active!==undefined && Number(req.user.id)===id && !active) return res.status(400).json({error:'Không thể tự khóa tài khoản đang đăng nhập'});
  const existing=(await q("SELECT id,active FROM users WHERE id=$1 AND role='manager'",[id])).rows[0];
  if(!existing) return res.status(404).json({error:'Không tìm thấy quản lý'});
  if(active===false && existing.active){const n=(await q("SELECT COUNT(*)::int n FROM users WHERE role='manager' AND active=1")).rows[0].n;if(n<=1)return res.status(400).json({error:'Phải còn ít nhất một quản lý đang hoạt động'});}
  if(displayName!==undefined && !String(displayName).trim()) return res.status(400).json({error:'Tên quản lý không được để trống'});
  if(active!==undefined) await q("UPDATE users SET active=$1 WHERE id=$2 AND role='manager'",[active?1:0,id]);
  if(displayName!==undefined) await q("UPDATE users SET display_name=$1 WHERE id=$2 AND role='manager'",[String(displayName).trim(),id]);
  await log(req.user.id,'update','manager',id,{active,displayName});res.json({ok:true});
}));
app.get('/api/branches/admin',auth,manager,wrap(async(req,res)=>{const r=await q('SELECT id,name,active FROM branches ORDER BY name');res.json(r.rows)}));
app.patch('/api/branches/:id',auth,manager,wrap(async(req,res)=>{
  const id=Number(req.params.id),name=req.body.name===undefined?undefined:String(req.body.name).trim(),active=req.body.active;
  if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'ID không hợp lệ'});
  if(name!==undefined&&(!name||name.length>80))return res.status(400).json({error:'Tên chi nhánh không hợp lệ'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const old=(await client.query('SELECT name,active FROM branches WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!old){await client.query('ROLLBACK');return res.status(404).json({error:'Không tìm thấy chi nhánh'});}
    if(name!==undefined&&name!==old.name){
      await client.query('UPDATE branches SET name=$1 WHERE id=$2',[name,id]);
      for(const table of ['manual_sales','daily_stats','kiot_sales']) await client.query(`UPDATE ${table} SET branch=$1 WHERE branch=$2`,[name,old.name]);
    }
    if(active!==undefined)await client.query('UPDATE branches SET active=$1 WHERE id=$2',[active?1:0,id]);
    await client.query('COMMIT');await log(req.user.id,'update','branch',id,{oldName:old.name,name,active});res.json({ok:true});
  }catch(e){await client.query('ROLLBACK');if(e.code==='23505')return res.status(400).json({error:'Tên chi nhánh đã tồn tại'});throw e;}finally{client.release()}
}));
app.delete('/api/kpi/:id',auth,manager,wrap(async(req,res)=>{
  const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'ID không hợp lệ'});
  const r=await q('DELETE FROM kpis WHERE id=$1 RETURNING *',[id]);if(!r.rowCount)return res.status(404).json({error:'Không tìm thấy KPI'});
  await log(req.user.id,'delete','kpi',id,r.rows[0]);res.json({ok:true});
}));
app.delete('/api/branch-kpi/:id',auth,manager,wrap(async(req,res)=>{
  const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'ID không hợp lệ'});
  const r=await q('DELETE FROM branch_kpis WHERE id=$1 RETURNING *',[id]);if(!r.rowCount)return res.status(404).json({error:'Không tìm thấy KPI cửa hàng'});
  await log(req.user.id,'delete','branch_kpi',id,r.rows[0]);res.json({ok:true});
}));

// Accessory-only sales are deliberately separate from machine sales and never count as dropped insurance.
app.post('/api/accessory-sales',auth,wrap(async(req,res)=>{
 const eid=Number(req.body.employeeId||req.user.id),date=String(req.body.saleDate||''),branch=String(req.body.branch||'').trim();
 const item=String(req.body.itemName||'').trim(),qty=Number(req.body.quantity),amount=Number(req.body.amount);
 if(!ownScope(req,eid))return res.status(403).json({error:'Không thể nhập đơn của nhân viên khác'});
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!item||item.length>150||!Number.isSafeInteger(qty)||qty<1||qty>1000||!Number.isSafeInteger(amount)||amount<0||amount>10000000000)return res.status(400).json({error:'Thông tin phụ kiện không hợp lệ'});
 if(!(await q('SELECT 1 FROM branches WHERE name=$1 AND active=1',[branch])).rowCount)return res.status(400).json({error:'Chi nhánh không hợp lệ'});
 const r=await q('INSERT INTO accessory_sales(employee_id,sale_date,branch,item_name,quantity,amount) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[eid,date,branch,item,qty,amount]);
 await log(req.user.id,'create','accessory_sale',r.rows[0].id,{date,item,qty,amount});res.json({id:r.rows[0].id});
}));
app.get('/api/accessory-sales',auth,wrap(async(req,res)=>{
 const from=String(req.query.from||'2000-01-01'),to=String(req.query.to||'2999-12-31');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to))return res.status(400).json({error:'Ngày không hợp lệ'});
 const target=req.user.role==='manager'&&req.query.employeeId ? Number(req.query.employeeId) : req.user.role==='manager' ? null : req.user.id;
 if(req.query.employeeId&&req.user.role==='manager'&&(!Number.isSafeInteger(target)||target<1))return res.status(400).json({error:'Nhân viên không hợp lệ'});
 const args=[from,to],scope=target?' AND a.employee_id=$3':'';if(scope)args.push(target);
 const r=await q(`SELECT a.id,a.sale_date::text AS sale_date,a.branch,a.item_name,a.quantity,a.amount,u.display_name AS employee_name FROM accessory_sales a JOIN users u ON u.id=a.employee_id WHERE a.sale_date BETWEEN $1 AND $2${scope} ORDER BY a.sale_date DESC,a.id DESC`,args);res.json(r.rows);
}));
// Provisional commission from manual entries only. NOT a KiotViet payroll statement.
app.get('/api/my-commission',auth,wrap(async(req,res)=>{
 const from=String(req.query.from||''),to=String(req.query.to||'');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)return res.status(400).json({error:'Khoảng ngày không hợp lệ'});
 const target=req.user.role==='manager'&&req.query.employeeId ? Number(req.query.employeeId) : req.user.id;
 if(!Number.isSafeInteger(target)||target<1)return res.status(400).json({error:'Nhân viên không hợp lệ'});
 if(req.user.role==='manager'&&req.query.employeeId&&!(await q("SELECT 1 FROM users WHERE id=$1 AND role='employee'",[target])).rowCount)return res.status(404).json({error:'Không tìm thấy nhân viên'});
 const sales=(await q(`SELECT sale_date::text AS day,COUNT(*)::int AS machines,COALESCE(SUM(insurance),0)::int AS insured,COALESCE(SUM(insurance_revenue),0)::bigint AS insurance_revenue FROM manual_sales WHERE employee_id=$1 AND sale_date BETWEEN $2 AND $3 GROUP BY sale_date`,[target,from,to])).rows;
 const accessories=(await q(`SELECT sale_date::text AS day,COALESCE(SUM(CASE WHEN amount>0 THEN quantity ELSE 0 END),0)::int AS accessories FROM accessory_sales WHERE employee_id=$1 AND sale_date BETWEEN $2 AND $3 GROUP BY sale_date`,[target,from,to])).rows;
 // Month-based insurance commission rate; query only current month when called for the monthly forecast.
 const month=to.slice(0,7),monthStart=month+'-01',monthEnd=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
 const monthly=(await q('SELECT COUNT(*)::int AS machines,COALESCE(SUM(insurance),0)::int AS insured FROM manual_sales WHERE employee_id=$1 AND sale_date BETWEEN $2 AND $3',[target,monthStart,monthEnd])).rows[0];
 const rate=Number(monthly.machines)>0&&Number(monthly.insured)/Number(monthly.machines)>=.65?.10:.08;
 const days=[...new Set([...sales.map(x=>x.day),...accessories.map(x=>x.day)])].sort().reverse().map(date=>{
 const s=sales.find(x=>x.day===date)||{},a=accessories.find(x=>x.day===date)||{};
 const machines=Number(s.machines||0),insured=Number(s.insured||0),accessoryCount=Number(a.accessories||0);
 const machineCommission=machines*30000,insuranceCommission=Math.round(Number(s.insurance_revenue||0)*rate),accessoryCommission=accessoryCount*15000;
 return {date,machines,insured,accessories:accessoryCount,machineCommission,insuranceCommission,accessoryCommission,total:machineCommission+insuranceCommission+accessoryCommission};
 });res.json({source:'manual',insuranceRate:rate,total:days.reduce((n,x)=>n+x.total,0),days});
}));
app.post('/api/daily-stats', auth, wrap(async (req, res) => {
  const { employeeId, workDate, customers, successful, failed, branch } = req.body; const eid = Number(employeeId || req.user.id);
  const branchName=String(branch||'').trim(); if(!branchName || !(await q('SELECT 1 FROM branches WHERE name=$1 AND active=1',[branchName])).rowCount) return res.status(400).json({error:'Vui lòng chọn chi nhánh hợp lệ trong danh sách.'});
  if (!ownScope(req, eid)) return res.status(403).json({ error: 'Không thể nhập dữ liệu người khác' });
  const c = Number(customers), s = Number(successful), f = Number(failed);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate || '') || ![c, s, f].every(Number.isInteger) || c < 0 || s < 0 || f < 0 || s + f > c)
    return res.status(400).json({ error: 'Dữ liệu khách không hợp lệ. Thành công + thất bại không được vượt tổng khách.' });
  await q(`INSERT INTO daily_stats(employee_id,work_date,customers,successful,failed,branch) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(employee_id,work_date) DO UPDATE SET customers=EXCLUDED.customers,successful=EXCLUDED.successful,failed=EXCLUDED.failed,branch=EXCLUDED.branch,updated_at=CURRENT_TIMESTAMP`, [eid, workDate, c, s, f, branchName]);
  await log(req.user.id, 'upsert', 'daily_stats', null, { employeeId: eid, workDate, c, s, f }); res.json({ ok: true });
}));

app.post('/api/sales', auth, wrap(async (req, res) => {
  const { employeeId, saleDate, model, price, branch, stockSource, conditionType, insurance, note } = req.body;
  const branchName=String(branch||'').trim(); if(!branchName || !(await q('SELECT 1 FROM branches WHERE name=$1 AND active=1',[branchName])).rowCount) return res.status(400).json({error:'Vui lòng chọn chi nhánh hợp lệ trong danh sách.'});
  const eid = Number(employeeId || req.user.id), p = Number(price), ins = insurance === true || insurance === 1 || insurance === 'true';
  if (!ownScope(req, eid)) return res.status(403).json({ error: 'Không thể nhập đơn cho nhân viên khác' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(saleDate || '') || !Number.isFinite(p) || p <= 0) return res.status(400).json({ error: 'Ngày bán hoặc giá máy không hợp lệ' });
  const fee = ins ? insuranceFee(p) : 0;
  const r = await q(`INSERT INTO manual_sales(employee_id,sale_date,model,price,branch,stock_source,condition_type,insurance,insurance_revenue,note)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [eid, saleDate, model || '', Math.round(p), branchName, stockSource || 'Trong kho', conditionType || '99%', ins ? 1 : 0, fee, note || '']);
  await log(req.user.id, 'create', 'manual_sale', r.rows[0].id, { saleDate, price: p, insurance: ins }); res.json({ id: r.rows[0].id, insuranceRevenue: fee });
}));
app.get('/api/sales', auth, wrap(async (req, res) => {
  const { from, to, employeeId } = req.query;
  let sql = 'SELECT s.*,u.display_name employee_name FROM manual_sales s JOIN users u ON u.id=s.employee_id WHERE s.sale_date BETWEEN $1 AND $2';
  const args = [from || '2000-01-01', to || '2999-12-31'];
  if (req.user.role !== 'manager') { sql += ' AND s.employee_id=$3'; args.push(req.user.id); }
  else if (employeeId) { sql += ' AND s.employee_id=$3'; args.push(Number(employeeId)); }
  sql += ' ORDER BY s.sale_date DESC,s.id DESC';
  const r = await q(sql, args); res.json(r.rows);
}));
app.patch('/api/sales/:id', auth, wrap(async (req, res) => {
  const r = await q('SELECT * FROM manual_sales WHERE id=$1', [Number(req.params.id)]); const row = r.rows[0];
  if (!row) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (req.user.role !== 'manager' && Number(row.employee_id) !== Number(req.user.id)) return res.status(403).json({ error: 'Không có quyền' });
  const isManager = req.user.role === 'manager';
  const price = isManager && req.body.price !== undefined ? Number(req.body.price) : Number(row.price);
  if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ error: 'Giá bán không hợp lệ' });
  const ins = req.body.insurance === undefined ? !!row.insurance : (req.body.insurance === true || req.body.insurance === 1 || req.body.insurance === 'true');
  const fee = ins ? insuranceFee(price) : 0;
  const saleDate = isManager && req.body.saleDate ? req.body.saleDate : row.sale_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(saleDate))) return res.status(400).json({ error: 'Ngày bán không hợp lệ' });
  const newBranch = isManager && req.body.branch !== undefined ? String(req.body.branch).trim() : row.branch;
  if (!(await q('SELECT 1 FROM branches WHERE name=$1 AND active=1',[newBranch])).rowCount) return res.status(400).json({error:'Vui lòng chọn chi nhánh hợp lệ trong danh sách.'});
  const values = [saleDate, isManager && req.body.model !== undefined ? String(req.body.model) : row.model, price,
    newBranch,
    isManager && req.body.stockSource !== undefined ? String(req.body.stockSource) : row.stock_source,
    isManager && req.body.conditionType !== undefined ? String(req.body.conditionType) : row.condition_type,
    ins ? 1 : 0, fee, req.body.note === undefined ? row.note : String(req.body.note), row.id];
  await q(`UPDATE manual_sales SET sale_date=$1,model=$2,price=$3,branch=$4,stock_source=$5,condition_type=$6,insurance=$7,insurance_revenue=$8,note=$9,updated_at=CURRENT_TIMESTAMP WHERE id=$10`, values);
  await log(req.user.id, 'update', 'manual_sale', row.id, { before: row, after: req.body }); res.json({ ok: true, insuranceRevenue: fee });
}));
app.delete('/api/sales/:id', auth, manager, wrap(async (req, res) => {
  const id = Number(req.params.id); const r = await q('DELETE FROM manual_sales WHERE id=$1 RETURNING id,employee_id,sale_date,model,price', [id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  await log(req.user.id, 'delete', 'manual_sale', id, r.rows[0]); res.json({ ok: true });
}));
app.get('/api/daily-stats', auth, wrap(async (req, res) => {
  const from = req.query.from || '2000-01-01', to = req.query.to || '2999-12-31';
  const args = [from, to]; let where = 'd.work_date BETWEEN $1 AND $2';
  if (req.user.role !== 'manager') { where += ' AND d.employee_id=$3'; args.push(req.user.id); }
  const rows = await q(`SELECT d.*,u.display_name employee_name FROM daily_stats d JOIN users u ON u.id=d.employee_id WHERE ${where} ORDER BY d.work_date DESC,d.id DESC`, args);
  res.json(rows.rows);
}));
app.patch('/api/daily-stats/:id', auth, manager, wrap(async (req, res) => {
  const id = Number(req.params.id), { workDate, branch, customers, successful, failed } = req.body;
  const r = await q('SELECT * FROM daily_stats WHERE id=$1', [id]); if (!r.rows[0]) return res.status(404).json({ error: 'Không tìm thấy thống kê' });
  const old = r.rows[0], c = Number(customers ?? old.customers), ok = Number(successful ?? old.successful), no = Number(failed ?? old.failed), date = workDate || old.work_date, newBranch=String(branch ?? old.branch).trim();
  if (!(await q('SELECT 1 FROM branches WHERE name=$1 AND active=1',[newBranch])).rowCount) return res.status(400).json({error:'Vui lòng chọn chi nhánh hợp lệ trong danh sách.'});
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || ![c,ok,no].every(Number.isInteger) || c<0 || ok<0 || no<0 || ok+no>c) return res.status(400).json({ error: 'Ngày hoặc số liệu khách không hợp lệ' });
  await q('UPDATE daily_stats SET work_date=$1,branch=$2,customers=$3,successful=$4,failed=$5,updated_at=CURRENT_TIMESTAMP WHERE id=$6', [date, newBranch, c, ok, no, id]);
  await log(req.user.id,'update','daily_stats',id,{before:old,after:req.body}); res.json({ok:true});
}));
app.delete('/api/daily-stats/:id', auth, manager, wrap(async (req, res) => {
  const id=Number(req.params.id), r=await q('DELETE FROM daily_stats WHERE id=$1 RETURNING *',[id]);
  if(!r.rows[0]) return res.status(404).json({error:'Không tìm thấy thống kê'});
  await log(req.user.id,'delete','daily_stats',id,r.rows[0]); res.json({ok:true});
}));

app.post('/api/kpi', auth, manager, wrap(async (req, res) => {
  const { employeeId, month, machineTarget, insuranceTarget } = req.body;
  await q(`INSERT INTO kpis(employee_id,month,machine_target,insurance_target) VALUES($1,$2,$3,$4)
    ON CONFLICT(employee_id,month) DO UPDATE SET machine_target=EXCLUDED.machine_target,insurance_target=EXCLUDED.insurance_target`,
    [Number(employeeId), month, Number(machineTarget) || 0, Number(insuranceTarget) || 0]);
  await log(req.user.id, 'upsert', 'kpi', null, req.body); res.json({ ok: true });
}));
app.get('/api/kpi', auth, wrap(async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  let sql = 'SELECT k.*,u.display_name FROM kpis k JOIN users u ON u.id=k.employee_id WHERE k.month=$1'; const args = [month];
  if (req.user.role !== 'manager') { sql += ' AND k.employee_id=$2'; args.push(req.user.id); }
  const r = await q(sql, args); res.json(r.rows);
}));
app.post('/api/branch-kpi', auth, manager, wrap(async (req,res)=>{
  const branch=String(req.body.branch||'').trim(), month=String(req.body.month||'');
  const machineTarget=Math.max(0,Number(req.body.machineTarget)||0), insuranceTarget=Math.max(0,Number(req.body.insuranceTarget)||0), revenueTarget=Number(req.body.revenueTarget);
  if(!Number.isSafeInteger(revenueTarget)||revenueTarget<0) return res.status(400).json({error:'KPI doanh thu phải là số nguyên không âm.'});
  if(!branch || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({error:'Vui lòng chọn chi nhánh và tháng hợp lệ.'});
  if(!(await q('SELECT 1 FROM branches WHERE name=$1 AND active=1',[branch])).rowCount) return res.status(400).json({error:'Chi nhánh không hợp lệ.'});
  await q(`INSERT INTO branch_kpis(branch,month,machine_target,insurance_target,revenue_target) VALUES($1,$2,$3,$4,$5) ON CONFLICT(branch,month) DO UPDATE SET machine_target=EXCLUDED.machine_target,insurance_target=EXCLUDED.insurance_target,revenue_target=EXCLUDED.revenue_target`,[branch,month,machineTarget,insuranceTarget,revenueTarget]);
  await log(req.user.id,'upsert','branch_kpi',null,req.body); res.json({ok:true});
}));
app.get('/api/branch-kpi', auth, manager, wrap(async (req,res)=>{
  const month=req.query.month||new Date().toISOString().slice(0,7);
  const r=await q('SELECT * FROM branch_kpis WHERE month=$1 ORDER BY branch',[month]); res.json(r.rows);
}));

const uploadDir = path.join('/tmp', 'renewzone-uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/api/kiot/import', auth, manager, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Chưa chọn file CSV' });
  let client;
  try {
    let content = fs.readFileSync(req.file.path);
    if (content[0] === 0xFF && content[1] === 0xFE) content = content.toString('utf16le').slice(1);
    else content = content.toString('utf8').replace(/^\uFEFF/, '');
    const lines = content.split(/\r?\n/).filter(line => line.trim().length);

    if (lines.length < 2) return res.status(400).json({ error: 'CSV không có dữ liệu' });
    const delimiter = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' :
      ((lines[0].match(/\t/g) || []).length > (lines[0].match(/,/g) || []).length ? '\t' : ',');
    const parseLine = line => { let out = [], cur = '', quoted = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (ch === '"' && line[i + 1] === '"' && quoted) { cur += '"'; i++; } else if (ch === '"') quoted = !quoted; else if (ch === delimiter && !quoted) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
    const norm = value => String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ');
    const headers = parseLine(lines[0]).map(norm);
    const pick = (row, names) => { const wanted = names.map(norm); const i = headers.findIndex(h => wanted.includes(h)); return i >= 0 ? (row[i] || '').trim() : ''; };
    client = await pool.connect(); await client.query('BEGIN'); let imported = 0;
    for (let i = 1; i < lines.length; i++) {
      const row = parseLine(lines[i]);
      const invoiceId = pick(row, ['mã hóa đơn', 'ma hoa don', 'mã đơn hàng', 'ma don hang', 'invoice code', 'order code', 'id']) || `CSV-${Date.now()}`;
      // KiotViet exports may contain several product rows for one invoice; keep each row distinct.
      const id = `${invoiceId}-ROW-${i}`;
      const dateRaw = pick(row, ['ngày bán', 'ngay ban', 'ngày tạo', 'ngay tao', 'date']);
      const d = dateRaw.match(/([\d]{4})[-/]([\d]{1,2})[-/]([\d]{1,2})/) || dateRaw.match(/([\d]{1,2})[-/]([\d]{1,2})[-/]([\d]{4})/);
      if (!d) continue;
      const date = d[1].length === 4 ? `${d[1]}-${String(d[2]).padStart(2, '0')}-${String(d[3]).padStart(2, '0')}` : `${d[3]}-${String(d[2]).padStart(2, '0')}-${String(d[1]).padStart(2, '0')}`;
      const price = Number(pick(row, ['giá bán', 'gia ban', 'thành tiền', 'thanh tien', 'total', 'price', 'tong thanh toan', 'tong tien hang', 'doanh thu']).replace(/[^\d.-]/g, '')) || 0;
      const qty = Number(pick(row, ['số lượng', 'so luong', 'quantity'])) || 1;
      await client.query(`INSERT INTO kiot_sales(external_id,sale_date,employee_name,model,price,quantity,branch,raw_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(external_id) DO UPDATE SET sale_date=EXCLUDED.sale_date,
        employee_name=EXCLUDED.employee_name,model=EXCLUDED.model,price=EXCLUDED.price,quantity=EXCLUDED.quantity,
        branch=EXCLUDED.branch,raw_json=EXCLUDED.raw_json`, [id, date, pick(row, ['người bán', 'nguoi ban', 'nhân viên', 'nhan vien', 'seller', 'ten nguoi ban']),
        pick(row, ['tên hàng', 'ten hang', 'sản phẩm', 'san pham', 'product', 'ten san pham']), price, qty,
        pick(row, ['chi nhánh', 'chi nhanh', 'branch', 'ten chi nhanh']), JSON.stringify(row)]);
      imported++;
    }
    await client.query('COMMIT'); res.json({ ok: true, imported });
  } catch (e) {
    if (client) await client.query('ROLLBACK');
    res.status(400).json({ error: 'Không đọc được CSV. Hãy kiểm tra định dạng file xuất từ KiotViet.' });
  } finally {
    if (client) client.release();
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
}));
app.get('/api/branches', auth, wrap(async (req,res)=>{ const r=await q('SELECT name FROM branches WHERE active=1 ORDER BY name'); res.json(r.rows.map(x=>x.name)); }));
app.post('/api/branches', auth, manager, wrap(async (req,res)=>{ const name=String(req.body.name||'').trim(); if(!name || name.length>80) return res.status(400).json({error:'Tên chi nhánh không hợp lệ (tối đa 80 ký tự)'}); try { const r=await q('INSERT INTO branches(name) VALUES($1) RETURNING id,name',[name]); await log(req.user.id,'create','branch',r.rows[0].id,{name}); res.json(r.rows[0]); } catch(e) { if(e.code==='23505') return res.status(400).json({error:'Chi nhánh này đã tồn tại'}); throw e; } }));
app.get('/api/kiot/branches', auth, manager, wrap(async (req, res) => {
  const r = await q("SELECT DISTINCT branch FROM kiot_sales WHERE branch<>'' ORDER BY branch");
  res.json(r.rows.map(x => x.branch));
}));
app.get('/api/kiot/sales', auth, manager, wrap(async (req, res) => {
  const r = await q('SELECT * FROM kiot_sales WHERE sale_date BETWEEN $1 AND $2 ORDER BY sale_date DESC', [req.query.from || '2000-01-01', req.query.to || '2999-12-31']);
  res.json(r.rows);
}));

app.get('/api/dashboard', auth, wrap(async (req, res) => {
  const from = req.query.from || new Date().toISOString().slice(0, 10), to = req.query.to || from;
  const compareFrom = req.query.compareFrom, compareTo = req.query.compareTo;
  const empFilter = req.user.role === 'manager' ? (req.query.employeeId ? Number(req.query.employeeId) : null) : Number(req.user.id);
  const empSql = empFilter ? ' AND employee_id=$3' : '';
  const branch = String(req.query.branch || '');
  const branchSqlSales = branch ? ` AND branch=$${empFilter ? 4 : 3}` : '';
  const args = [from, to, ...(empFilter ? [empFilter] : []), ...(branch ? [branch] : [])];
  const salesR = await q(`SELECT employee_id,COUNT(*) machines,SUM(price) machine_revenue,SUM(insurance) insured,
    SUM(insurance_revenue) insurance_revenue,SUM(CASE WHEN insurance=0 THEN 1 ELSE 0 END) dropped,
    SUM(CASE WHEN stock_source='Trong kho' THEN 1 ELSE 0 END) in_stock,
    SUM(CASE WHEN stock_source='Máy ngoài' THEN 1 ELSE 0 END) outside_stock,
    SUM(CASE WHEN condition_type='Thanh lý' THEN 1 ELSE 0 END) liquidation,
    SUM(CASE WHEN condition_type='New siêu' THEN 1 ELSE 0 END) new_super,
    SUM(CASE WHEN condition_type='99%' THEN 1 ELSE 0 END) grade99
    FROM manual_sales WHERE sale_date BETWEEN $1 AND $2${empSql}${branchSqlSales} GROUP BY employee_id`, args);
  const statsR = await q(`SELECT employee_id,SUM(customers) customers,SUM(successful) successful,SUM(failed) failed
    FROM daily_stats WHERE work_date BETWEEN $1 AND $2${empSql}${branch ? ` AND branch=$${empFilter ? 4 : 3}` : ''} GROUP BY employee_id`, args);
  const kiotR = req.user.role === 'manager' ? await q('SELECT employee_name,COUNT(*) rows_count,SUM(quantity) machines,SUM(price) revenue FROM kiot_sales WHERE sale_date BETWEEN $1 AND $2 GROUP BY employee_name', [from, to]) : { rows: [] };
  const usersR = req.user.role === 'manager' ? await q("SELECT id,display_name FROM users WHERE role='employee' AND active=1 ORDER BY display_name") : await q("SELECT id,display_name FROM users WHERE id=$1 AND active=1",[req.user.id]);
  const users = usersR.rows.filter(u => !empFilter || Number(u.id) === Number(empFilter));
  const enrich = list => users.map(u => {
    const s = list.find(x => Number(x.employee_id) === Number(u.id)) || {};
    const st = statsR.rows.find(x => Number(x.employee_id) === Number(u.id)) || {};
    const machines = Number(s.machines || 0), insured = Number(s.insured || 0), customers = Number(st.customers || 0), successful = Number(st.successful || 0);
    return { employeeId: Number(u.id), name: u.display_name, machines, machineRevenue: Number(s.machine_revenue || 0), insured,
      insuranceRevenue: Number(s.insurance_revenue || 0), dropped: Number(s.dropped || 0), insuranceRate: machines ? insured / machines * 100 : 0,
      dropRate: machines ? Number(s.dropped || 0) / machines * 100 : 0, customers, successful, failed: Number(st.failed || 0),
      closeRate: customers ? successful / customers * 100 : 0, inStock: Number(s.in_stock || 0), outsideStock: Number(s.outside_stock || 0),
      liquidation: Number(s.liquidation || 0), newSuper: Number(s.new_super || 0), grade99: Number(s.grade99 || 0) };
  });
  const rows = enrich(salesR.rows);
  const keys = ['machines','machineRevenue','insured','insuranceRevenue','dropped','customers','successful','failed','inStock','outsideStock','liquidation','newSuper','grade99'];
  const total = rows.reduce((a, r) => { for (const k of keys) a[k] += r[k]; return a; }, Object.fromEntries(keys.map(k => [k, 0])));
  total.insuranceRate = total.machines ? total.insured / total.machines * 100 : 0;
  total.dropRate = total.machines ? total.dropped / total.machines * 100 : 0;
  total.closeRate = total.customers ? total.successful / total.customers * 100 : 0;
  let comparison = null;
  if (compareFrom && compareTo) {
    const cArgs = [compareFrom, compareTo, ...(empFilter ? [empFilter] : []), ...(branch ? [branch] : [])];
    const cmR = await q(`SELECT COUNT(*) machines,SUM(price) "machineRevenue",SUM(insurance) insured,SUM(insurance_revenue) "insuranceRevenue" FROM manual_sales WHERE sale_date BETWEEN $1 AND $2${empSql}${branchSqlSales}`, cArgs);
    const csR = await q(`SELECT SUM(customers) customers,SUM(successful) successful,SUM(failed) failed FROM daily_stats WHERE work_date BETWEEN $1 AND $2${empSql}${branch ? ` AND branch=$${empFilter ? 4 : 3}` : ''}`, cArgs);
    const cm = cmR.rows[0], cs = csR.rows[0];
    comparison = { machines: Number(cm.machines || 0), machineRevenue: Number(cm.machineRevenue || 0), insured: Number(cm.insured || 0), insuranceRevenue: Number(cm.insuranceRevenue || 0), customers: Number(cs.customers || 0), successful: Number(cs.successful || 0), failed: Number(cs.failed || 0) };
    comparison.insuranceRate = comparison.machines ? comparison.insured / comparison.machines * 100 : 0;
    comparison.closeRate = comparison.customers ? comparison.successful / comparison.customers * 100 : 0;
  }
  const kiotTotalsR = req.user.role === 'manager' ? await q('SELECT COUNT(*) orders,COALESCE(SUM(quantity),0) machines,COALESCE(SUM(price),0) revenue FROM kiot_sales WHERE sale_date BETWEEN $1 AND $2 AND ($3 = \'\' OR branch=$3)', [from, to, branch]) : {rows:[{orders:0,machines:0,revenue:0}]};
  const kt = kiotTotalsR.rows[0];
  const month = req.query.month || to.slice(0, 7);
  const kpiSql = `SELECT k.*,u.display_name FROM kpis k JOIN users u ON u.id=k.employee_id WHERE k.month=$1${empFilter ? ' AND k.employee_id=$2' : ''}`;
  const kpiRows = (await q(kpiSql, empFilter ? [month, empFilter] : [month])).rows;
  const actualSql = `SELECT employee_id,COUNT(*) machines,SUM(insurance) insured FROM manual_sales WHERE sale_date >= $1 AND sale_date < $2${empFilter ? ' AND employee_id=$3' : ''} GROUP BY employee_id`;
  const [yy, mm] = month.split('-').map(Number); const nextMonth = `${mm === 12 ? yy + 1 : yy}-${String(mm === 12 ? 1 : mm + 1).padStart(2, '0')}-01`;
  const monthActual = (await q(actualSql, empFilter ? [`${month}-01`, nextMonth, empFilter] : [`${month}-01`, nextMonth])).rows;
  const now = new Date(); const monthDays = new Date(yy, mm, 0).getDate(); const elapsed = month === now.toISOString().slice(0, 7) ? now.getDate() : monthDays;
  const kpiProgress = kpiRows.map(k => {
    const a = monthActual.find(x => Number(x.employee_id) === Number(k.employee_id)) || {};
    const machines = Number(a.machines || 0), insured = Number(a.insured || 0);
    return { employeeId: Number(k.employee_id), name: k.display_name, machineTarget: Number(k.machine_target), insuranceTarget: Number(k.insurance_target), machines, insured,
      machineProgress: k.machine_target ? machines / Number(k.machine_target) * 100 : 0, insuranceProgress: k.insurance_target ? insured / Number(k.insurance_target) * 100 : 0,
      machineForecast: elapsed ? machines / elapsed * monthDays : 0, insuranceForecast: elapsed ? insured / elapsed * monthDays : 0, month };
  });
  const trendArgs=[from,to,...(empFilter?[empFilter]:[]),...(branch?[branch]:[])]; const trendEmp=empFilter?' AND employee_id=$3':''; const trendBranch=branch?` AND branch=$${empFilter?4:3}`:'';
  const trendSales=(await q(`SELECT sale_date::text AS "day",COUNT(*) machines,COALESCE(SUM(price),0) machine_revenue,COALESCE(SUM(insurance_revenue),0) insurance_revenue FROM manual_sales WHERE sale_date BETWEEN $1 AND $2${trendEmp}${trendBranch} GROUP BY sale_date ORDER BY sale_date`,trendArgs)).rows;
  const trendCustomers=(await q(`SELECT work_date::text AS "day",COALESCE(SUM(customers),0) customers,COALESCE(SUM(successful),0) successful FROM daily_stats WHERE work_date BETWEEN $1 AND $2${trendEmp}${trendBranch} GROUP BY work_date`,trendArgs)).rows;
  const trendMap=new Map(); for(const x of trendSales) trendMap.set(x.day,{date:x.day,machines:Number(x.machines),machineRevenue:Number(x.machine_revenue),insuranceRevenue:Number(x.insurance_revenue),customers:0,successful:0});
  for(const x of trendCustomers){const v=trendMap.get(x.day)||{date:x.day,machines:0,machineRevenue:0,insuranceRevenue:0,customers:0,successful:0};v.customers=Number(x.customers);v.successful=Number(x.successful);trendMap.set(x.day,v)}
  const branchSales=(await q(`SELECT branch,COUNT(*) machines,COALESCE(SUM(price),0) machine_revenue,COALESCE(SUM(insurance),0) insured,COALESCE(SUM(insurance_revenue),0) insurance_revenue,COUNT(*) FILTER (WHERE stock_source='Trong kho') in_stock,COUNT(*) FILTER (WHERE stock_source='Máy ngoài') outside_stock FROM manual_sales WHERE sale_date BETWEEN $1 AND $2${empSql}${branchSqlSales} GROUP BY branch`,[from,to,...(empFilter?[empFilter]:[]),...(branch?[branch]:[])])).rows;
  const branchStats=(await q(`SELECT branch,COALESCE(SUM(customers),0) customers,COALESCE(SUM(successful),0) successful,COALESCE(SUM(failed),0) failed FROM daily_stats WHERE work_date BETWEEN $1 AND $2${empSql}${branch ? ` AND branch=$${empFilter?4:3}` : ''} GROUP BY branch`,[from,to,...(empFilter?[empFilter]:[]),...(branch?[branch]:[])])).rows;
  const branchMap=new Map(); for(const x of branchSales)branchMap.set(x.branch,{branch:x.branch,machines:Number(x.machines),machineRevenue:Number(x.machine_revenue),insured:Number(x.insured),insuranceRevenue:Number(x.insurance_revenue),inStock:Number(x.in_stock),outsideStock:Number(x.outside_stock),customers:0,successful:0,failed:0});
  for(const x of branchStats){const v=branchMap.get(x.branch)||{branch:x.branch,machines:0,machineRevenue:0,insured:0,insuranceRevenue:0,inStock:0,outsideStock:0,customers:0,successful:0,failed:0};v.customers=Number(x.customers);v.successful=Number(x.successful);v.failed=Number(x.failed);branchMap.set(x.branch,v)}
  const branchSummary=[...branchMap.values()].map(x=>({...x,closeRate:x.customers?x.successful/x.customers*100:0,totalRevenue:x.machineRevenue+x.insuranceRevenue}));
  const branchKpiRows=req.user.role==='manager'?(await q('SELECT * FROM branch_kpis WHERE month=$1'+(branch?' AND branch=$2':''),branch?[month,branch]:[month])).rows:[];
  const branchMonthActual=(await q(`SELECT branch,COUNT(*) machines,COALESCE(SUM(insurance),0) insured,COALESCE(SUM(price),0)+COALESCE(SUM(insurance_revenue),0) revenue FROM manual_sales WHERE sale_date >= $1 AND sale_date < $2${branch?' AND branch=$3':''} GROUP BY branch`,branch?[`${month}-01`,nextMonth,branch]:[`${month}-01`,nextMonth])).rows;
  const branchKpiProgress=branchKpiRows.map(k=>{const a=branchMonthActual.find(x=>x.branch===k.branch)||{};const machines=Number(a.machines||0),insured=Number(a.insured||0),revenue=Number(a.revenue||0),revenueTarget=Number(k.revenue_target||0);return {branch:k.branch,revenue,revenueTarget,revenueProgress:revenueTarget?revenue/revenueTarget*100:0,revenueForecast:elapsed?revenue/elapsed*monthDays:0,machineTarget:Number(k.machine_target),insuranceTarget:Number(k.insurance_target),machines,insured,machineProgress:k.machine_target?machines/Number(k.machine_target)*100:0,insuranceProgress:k.insurance_target?insured/Number(k.insurance_target)*100:0,machineForecast:elapsed?machines/elapsed*monthDays:0,insuranceForecast:elapsed?insured/elapsed*monthDays:0,month};});
  total.totalRevenue=total.machineRevenue+total.insuranceRevenue;
  res.json({ from, to, total, employees: rows, trend:[...trendMap.values()].sort((a,b)=>a.date.localeCompare(b.date)), branchSummary, branchKpiProgress, kiot: { orders: Number(kt.orders || 0), machines: Number(kt.machines || 0), revenue: Number(kt.revenue || 0) }, kiotByEmployee: kiotR.rows, comparison, kpiProgress });
}));

app.get('/api/reconcile', auth, manager, wrap(async (req, res) => {
  const from = req.query.from || new Date().toISOString().slice(0, 10), to = req.query.to || from;
  const kiot = (await q('SELECT employee_name,COUNT(*) orders,SUM(quantity) machines,SUM(price) revenue FROM kiot_sales WHERE sale_date BETWEEN $1 AND $2 GROUP BY employee_name', [from, to])).rows;
  const manual = (await q('SELECT u.display_name employee_name,COUNT(*) orders,SUM(s.price) revenue FROM manual_sales s JOIN users u ON u.id=s.employee_id WHERE s.sale_date BETWEEN $1 AND $2 GROUP BY u.display_name', [from, to])).rows;
  const kMachines = Number((await q('SELECT COALESCE(SUM(quantity),0) n FROM kiot_sales WHERE sale_date BETWEEN $1 AND $2', [from, to])).rows[0].n);
  const mMachines = Number((await q('SELECT COUNT(*) n FROM manual_sales WHERE sale_date BETWEEN $1 AND $2', [from, to])).rows[0].n);
  const kiotRevenue = Number((await q('SELECT COALESCE(SUM(price),0) n FROM kiot_sales WHERE sale_date BETWEEN $1 AND $2', [from, to])).rows[0].n);
  const manualRevenue = Number((await q('SELECT COALESCE(SUM(price),0) n FROM manual_sales WHERE sale_date BETWEEN $1 AND $2', [from, to])).rows[0].n);
  res.json({ from, to, kiot, manual, kiotMachines: kMachines, manualMachines: mMachines, difference: mMachines - kMachines, kiotRevenue, manualRevenue });
}));

// Bảng lương thưởng KiotViet: chỉ tính những dòng đã được quản lý phân loại.
const payCats = ['large','accessory','tradein','insurance','exclude'];
app.get('/api/payroll/items', auth, manager, wrap(async(req,res)=>{
 const month=String(req.query.month||'');
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return res.status(400).json({error:'Tháng không hợp lệ'});
 const branch=String(req.query.branch||'');
 const r=await q(`SELECT k.id,k.sale_date::text AS sale_date,k.external_id,k.employee_name,k.model,k.price,k.quantity,k.branch,c.category
 FROM kiot_sales k LEFT JOIN kiot_pay_classification c ON c.kiot_id=k.id
 WHERE to_char(k.sale_date,'YYYY-MM')=$1 AND ($2='' OR k.branch=$2)
 ORDER BY k.sale_date DESC,k.id DESC LIMIT 3000`,[month,branch]);
 res.json(r.rows);
}));
app.post('/api/payroll/classify',auth,manager,wrap(async(req,res)=>{
 const id=Number(req.body.id), category=String(req.body.category||'');
 if(!Number.isSafeInteger(id)||id<=0||(!payCats.includes(category)&&category!==''))return res.status(400).json({error:'Dữ liệu phân loại không hợp lệ'});
 if(category==='')await q('DELETE FROM kiot_pay_classification WHERE kiot_id=$1',[id]);
 else {const r=await q(`INSERT INTO kiot_pay_classification(kiot_id,category) SELECT id,$2 FROM kiot_sales WHERE id=$1 ON CONFLICT(kiot_id) DO UPDATE SET category=EXCLUDED.category,updated_at=CURRENT_TIMESTAMP RETURNING kiot_id`,[id,category]);if(!r.rowCount)return res.status(404).json({error:'Không tìm thấy dòng Kiot'});}
 await log(req.user.id,'classify','kiot_pay',id,{category});res.json({ok:true});
}));
app.get('/api/payroll/staff',auth,manager,wrap(async(req,res)=>{
 const r=await q(`SELECT names.employee_name,ps.hire_date::text AS hire_date,COALESCE(ps.base_salary,0) base_salary
 FROM (SELECT DISTINCT employee_name FROM kiot_sales WHERE trim(employee_name)<>'' UNION SELECT employee_name FROM payroll_staff) names
 LEFT JOIN payroll_staff ps ON ps.employee_name=names.employee_name ORDER BY names.employee_name`);
 res.json(r.rows);
}));
app.post('/api/payroll/staff',auth,manager,wrap(async(req,res)=>{
 const name=String(req.body.employeeName||'').trim(),date=String(req.body.hireDate||''),base=Number(req.body.baseSalary||0);
 if(!name||name.length>200||date&&!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isSafeInteger(base)||base<0)return res.status(400).json({error:'Thông tin nhân viên không hợp lệ'});
 await q(`INSERT INTO payroll_staff(employee_name,hire_date,base_salary) VALUES($1,$2,$3)
 ON CONFLICT(employee_name) DO UPDATE SET hire_date=EXCLUDED.hire_date,base_salary=EXCLUDED.base_salary,updated_at=CURRENT_TIMESTAMP`,[name,date||null,base]);
 await log(req.user.id,'upsert','payroll_staff',null,{name,date,base});res.json({ok:true});
}));
app.get('/api/payroll/report',auth,manager,wrap(async(req,res)=>{
 const month=String(req.query.month||''),branch=String(req.query.branch||'');
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return res.status(400).json({error:'Tháng không hợp lệ'});
 const rows=(await q(`SELECT k.employee_name,k.quantity,k.price,c.category
 FROM kiot_sales k LEFT JOIN kiot_pay_classification c ON c.kiot_id=k.id
 WHERE to_char(k.sale_date,'YYYY-MM')=$1 AND ($2='' OR k.branch=$2)`,[month,branch])).rows;
 const staff=(await q('SELECT employee_name,hire_date::text AS hire_date,base_salary FROM payroll_staff')).rows;
 const map=new Map(staff.map(x=>[x.employee_name,x]));
 const out=new Map();
 for(const r of rows){const name=String(r.employee_name||'').trim();if(!name)continue;
 if(!out.has(name))out.set(name,{name,large:0,accessory:0,tradein:0,insurance:0,insuranceRevenue:0,unclassified:0,invalid:0});
 const x=out.get(name),qty=Number(r.quantity),price=Number(r.price);
 if(!r.category){x.unclassified++;continue;}
 if(r.category==='exclude')continue;
 if(!Number.isFinite(qty)||qty<=0||!Number.isInteger(qty)||!Number.isFinite(price)||price<0){x.invalid++;continue;}
 x[r.category]+=qty;
 if(r.category==='insurance')x.insuranceRevenue+=price;
 }
 const result=[...out.values()].map(x=>{
 const st=map.get(x.name),hire=st?.hire_date||null;
 // Chỉ xét đủ 1 tháng khi ngày bắt đầu làm <= ngày đầu tháng trước (nguyên tháng lịch).
 const [y,m]=month.split('-').map(Number);const threshold=new Date(Date.UTC(y,m-2,1)).toISOString().slice(0,10);
 const eligible=!!hire&&hire<=threshold;
 const rate=x.large>0&&x.insurance/x.large>=0.65?0.10:0.08;
 const ratio=x.large>0?x.insurance/x.large*100:null;
 const bonus=eligible&&ratio!==null&&ratio>=80?2000000:0;
 const commission=x.large*30000+x.accessory*15000+x.tradein*10000;
 const insuranceCommission=Math.round(x.insuranceRevenue*rate);
 const baseSalary=Number(st?.base_salary||0);
 return {...x,ratio,rate,eligible,hireDate:hire,baseSalary,commission,insuranceCommission,bonus,total:baseSalary+commission+insuranceCommission+bonus,complete:x.unclassified===0&&x.invalid===0&&!!hire&&(x.large>0||x.insurance===0)};
 });
 res.json({month,branch,rows:result,unclassified:result.reduce((s,x)=>s+x.unclassified,0),note:'Bảng tạm tính. Cần phân loại đủ dòng Kiot, kiểm tra doanh thu bảo hiểm và ngày vào làm trước khi chốt lương.'});
}));

app.get('/api/audit', auth, manager, wrap(async (req, res) => {
  const r = await q('SELECT a.*,u.display_name FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 200'); res.json(r.rows);
}));
app.get('/api/export/sales.csv', auth, manager, wrap(async (req, res) => {
  const from = req.query.from || '2000-01-01', to = req.query.to || '2999-12-31';
  const rows = (await q('SELECT s.*,u.display_name FROM manual_sales s JOIN users u ON u.id=s.employee_id WHERE s.sale_date BETWEEN $1 AND $2 ORDER BY s.sale_date', [from, to])).rows;
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = ['Ngày,Nhân viên,Mẫu máy,Giá bán,Nguồn máy,Phân loại,Bảo hiểm,Doanh thu bảo hiểm,Ghi chú', ...rows.map(r => [r.sale_date, r.display_name, r.model, r.price, r.stock_source, r.condition_type, r.insurance ? 'Có' : 'Không', r.insurance_revenue, r.note].map(esc).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename=renewzone-sales.csv'); res.send('\uFEFF' + csv);
}));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error('Request error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Máy chủ gặp lỗi. Vui lòng thử lại hoặc liên hệ quản lý.' });
});

async function start() {
  await pool.query(schema);
  await q(`INSERT INTO branches(name) VALUES ('Kha Vạn Cân'),('Dương Quảng Hàm') ON CONFLICT(name) DO NOTHING`);
  if (process.env.ADMIN_PASSWORD) {
    const n = Number((await q('SELECT COUNT(*) AS n FROM users')).rows[0].n);
    if (!n) await q('INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$2,$3,$4)',
      [process.env.ADMIN_USERNAME || 'admin', 'Quản lý', bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12), 'manager']);
  }
  app.listen(PORT, () => console.log(`RenewZone running on ${PORT}`));
}
start().catch(err => { console.error('Không khởi động được RenewZone:', err); process.exit(1); });
