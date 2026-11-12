const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const XLSX = require('xlsx');
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
CREATE TABLE IF NOT EXISTS kiot_invoice_lines (
 invoice_code TEXT NOT NULL, line_key TEXT NOT NULL, sale_date DATE NOT NULL, employee_name TEXT NOT NULL, branch TEXT NOT NULL, product_code TEXT NOT NULL DEFAULT '', product_name TEXT NOT NULL DEFAULT '', category TEXT NOT NULL, quantity NUMERIC(12,2) NOT NULL DEFAULT 0, amount BIGINT NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT '', raw_json JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(invoice_code,line_key)
);
CREATE INDEX IF NOT EXISTS idx_kiot_invoice_lines_date ON kiot_invoice_lines(sale_date);
CREATE TABLE IF NOT EXISTS kiot_branch_map (kiot_name TEXT PRIMARY KEY, branch TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS kiot_employee_map (
 kiot_name TEXT PRIMARY KEY, employee_id BIGINT NOT NULL REFERENCES users(id),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS kiot_pay_classification (
 kiot_id BIGINT PRIMARY KEY REFERENCES kiot_sales(id) ON DELETE CASCADE,
 category TEXT NOT NULL CHECK(category IN ('large','accessory','tradein','insurance','exclude')),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS work_shifts (
 employee_id BIGINT NOT NULL REFERENCES users(id),
 work_date DATE NOT NULL,
 shift_code TEXT NOT NULL CHECK (shift_code IN ('morning','evening','full','off')),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(employee_id,work_date)
);
CREATE TABLE IF NOT EXISTS payroll_staff (
 employee_name TEXT PRIMARY KEY, hire_date DATE, base_salary BIGINT NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS manager_payroll (
 manager_id BIGINT NOT NULL REFERENCES users(id), month TEXT NOT NULL, branch TEXT NOT NULL DEFAULT '',
 standard_days NUMERIC(7,2), worked_days NUMERIC(7,2), probation BOOLEAN NOT NULL DEFAULT FALSE,
 store_score NUMERIC(6,2), operations_score NUMERIC(6,2), service_score NUMERIC(6,2),
 report_errors INTEGER, violations INTEGER, business_rate_override NUMERIC(5,2),
 note TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(manager_id, month, branch)
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
ALTER TABLE branch_kpis ADD COLUMN IF NOT EXISTS insurance_revenue_target NUMERIC(18,0) NOT NULL DEFAULT 0;
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


const RZ_SHIFT_NAMES={morning:'08:30–17:30',evening:'12:30–21:30',full:'08:30–21:30',off:'Nghỉ'};
app.get('/api/work-shifts',auth,wrap(async(req,res)=>{
 const from=String(req.query.from||''),to=String(req.query.to||'');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to||((Date.parse(to)-Date.parse(from))/86400000)>62)
  return res.status(400).json({error:'Chọn khoảng ngày hợp lệ, tối đa 63 ngày'});
 const isManager=req.user.role==='manager';
 const [employees,shifts]=await Promise.all([
  q("SELECT id,display_name FROM users WHERE role='employee' AND active=1 ORDER BY display_name"),
  isManager?q("SELECT employee_id,to_char(work_date,'YYYY-MM-DD') AS work_date,shift_code FROM work_shifts WHERE work_date BETWEEN $1 AND $2 ORDER BY work_date",[from,to]):
   q("SELECT employee_id,to_char(work_date,'YYYY-MM-DD') AS work_date,shift_code FROM work_shifts WHERE work_date BETWEEN $1 AND $2 AND employee_id=$3 ORDER BY work_date",[from,to,req.user.id])
 ]);
 res.json({employees:isManager?employees.rows:employees.rows.filter(x=>Number(x.id)===Number(req.user.id)),shifts:shifts.rows,shiftNames:RZ_SHIFT_NAMES,canEdit:isManager});
}));
app.put('/api/work-shifts',auth,manager,wrap(async(req,res)=>{
 const employeeId=Number(req.body.employeeId),date=String(req.body.date||''),shift=String(req.body.shift||'');
 if(!Number.isSafeInteger(employeeId)||employeeId<1||!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||!Object.hasOwn(RZ_SHIFT_NAMES,shift)&&shift!=='')
  return res.status(400).json({error:'Dữ liệu ca làm không hợp lệ'});
 const exists=await q("SELECT 1 FROM users WHERE id=$1 AND role='employee' AND active=1",[employeeId]);
 if(!exists.rowCount)return res.status(404).json({error:'Không tìm thấy nhân viên đang hoạt động'});
 if(shift)await q("INSERT INTO work_shifts(employee_id,work_date,shift_code) VALUES($1,$2,$3) ON CONFLICT(employee_id,work_date) DO UPDATE SET shift_code=EXCLUDED.shift_code,updated_at=NOW()",[employeeId,date,shift]);
 else await q('DELETE FROM work_shifts WHERE employee_id=$1 AND work_date=$2',[employeeId,date]);
 await log(req.user.id,'set_shift','work_shifts',employeeId,{date,shift});
 res.json({ok:true});
}));

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
 const sales=(await q(`SELECT sale_date::text AS "day",COUNT(*)::int AS machines,COALESCE(SUM(insurance),0)::int AS insured,COALESCE(SUM(insurance_revenue),0)::bigint AS insurance_revenue FROM manual_sales WHERE employee_id=$1 AND sale_date BETWEEN $2 AND $3 GROUP BY sale_date`,[target,from,to])).rows;
 const accessories=(await q(`SELECT sale_date::text AS "day",COALESCE(SUM(CASE WHEN amount>0 THEN quantity ELSE 0 END),0)::int AS accessories FROM accessory_sales WHERE employee_id=$1 AND sale_date BETWEEN $2 AND $3 GROUP BY sale_date`,[target,from,to])).rows;
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
  const machineTarget=Math.max(0,Number(req.body.machineTarget)||0), insuranceTarget=Math.max(0,Number(req.body.insuranceTarget)||0), revenueTarget=Number(req.body.revenueTarget), insuranceRevenueTarget=Number(req.body.insuranceRevenueTarget);
  if(!Number.isSafeInteger(insuranceRevenueTarget)||insuranceRevenueTarget<0) return res.status(400).json({error:'KPI doanh thu bảo hiểm phải là số nguyên không âm.'});
  if(!Number.isSafeInteger(revenueTarget)||revenueTarget<0) return res.status(400).json({error:'KPI doanh thu phải là số nguyên không âm.'});
  if(!branch || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({error:'Vui lòng chọn chi nhánh và tháng hợp lệ.'});
  if(!(await q('SELECT 1 FROM branches WHERE name=$1 AND active=1',[branch])).rowCount) return res.status(400).json({error:'Chi nhánh không hợp lệ.'});
  await q(`INSERT INTO branch_kpis(branch,month,machine_target,insurance_target,revenue_target,insurance_revenue_target) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(branch,month) DO UPDATE SET machine_target=EXCLUDED.machine_target,insurance_target=EXCLUDED.insurance_target,revenue_target=EXCLUDED.revenue_target,insurance_revenue_target=EXCLUDED.insurance_revenue_target`,[branch,month,machineTarget,insuranceTarget,revenueTarget,insuranceRevenueTarget]);
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
// Import actual KiotViet invoice-detail XLSX: each row is a product line, not a new invoice.
const kiotNorm = v => String(v ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').replace(/\s+/g,' ');
function kiotCategory(group,code,name){
 const g=kiotNorm(group), c=kiotNorm(code), n=kiotNorm(name);
 if(g.includes('goi bao hanh') || (g.includes('bao hanh') && !g.includes('linh kien')) || c.startsWith('bh') || n.includes('goi bao hanh'))return 'insurance';
 if(g.includes('phu kien'))return 'accessory';
 // MacBook and iPad are counted as sold devices, even when KiotViet groups them under 'SẢN PHẨM KHÁC'.
 if(g.includes('macbook') || g.includes('ipad') || /\b(macbook|ipad)\b/.test(n))return 'machine';
 if((g.includes('may') || g.includes('iphone') || g.includes('newseal') || g.includes('like new') || g.includes('thanh ly')) && !g.includes('sua chua'))return 'machine';
 return 'other'; // Review rather than invent a machine/insurance classification.
}
function kiotRowsFromXlsx(file){
 const book=XLSX.readFile(file,{cellDates:true,raw:true});
 const sheet=book.Sheets[book.SheetNames[0]];
 if(!sheet)throw Error('File Excel không có trang dữ liệu');
 const rows=XLSX.utils.sheet_to_json(sheet,{defval:'',raw:true});
 if(!rows.length)throw Error('File Excel không có dòng hàng');
 const keys=Object.keys(rows[0]);
 const key=(n)=>keys.find(k=>kiotNorm(k)===kiotNorm(n));
 for(const col of ['Mã hóa đơn','Thời gian','Người bán','Nhóm hàng','Mã hàng','Tên hàng','Số lượng','Thành tiền','Trạng thái'])if(!key(col))throw Error('Thiếu cột KiotViet: '+col);
 const get=(r,n)=>r[key(n)];
 const duplicates=new Map();let ignored=0;
 const parsed=[];
 for(const r of rows){
  const invoice=String(get(r,'Mã hóa đơn')||'').trim();if(!invoice){ignored++;continue}
  const rawDate=get(r,'Thời gian');let d=rawDate instanceof Date?rawDate:new Date(rawDate);
  if(!Number.isFinite(d.getTime())){ignored++;continue}
  const date=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const productCode=String(get(r,'Mã hàng')||'').trim(),productName=String(get(r,'Tên hàng')||'').trim();
  const imei=String(get(r,'IMEI')||'').trim();
  const qty=Number(get(r,'Số lượng')||0),amount=Math.round(Number(get(r,'Thành tiền')||0));
  const base=[productCode,imei,qty,amount,productName].join('|');
  const dupKey=invoice+'|'+base;const occurrence=(duplicates.get(dupKey)||0)+1;duplicates.set(dupKey,occurrence);
  parsed.push({invoice,lineKey:require('crypto').createHash('sha256').update(base+'|'+occurrence).digest('hex'),date,
   employee:String(get(r,'Người bán')||'').trim(),branch:String(get(r,'Chi nhánh')||'').trim(),productCode,productName,
   category:kiotCategory(get(r,'Nhóm hàng'),productCode,productName),qty,amount,status:String(get(r,'Trạng thái')||'').trim(),raw:r});
 }
 return {rows:parsed,ignored};
}
app.post('/api/kiot/xlsx-preview',auth,manager,upload.single('file'),wrap(async(req,res)=>{
 if(!req.file)return res.status(400).json({error:'Chưa chọn Excel'});
 try{
  const {rows,ignored}=kiotRowsFromXlsx(req.file.path);const valid=rows.filter(r=>kiotNorm(r.status)==='hoan thanh');
  const byCategory={};for(const r of valid){if(!byCategory[r.category])byCategory[r.category]={rows:0,qty:0,revenue:0};byCategory[r.category].rows++;byCategory[r.category].qty+=r.qty;byCategory[r.category].revenue+=r.amount}
  res.json({rows:rows.length,ignored,invoices:new Set(rows.map(r=>r.invoice)).size,valid:valid.length,byCategory,excluded:rows.length-valid.length,employees:[...new Set(rows.map(r=>r.employee))].filter(Boolean).sort()});
 }finally{fs.unlinkSync(req.file.path)}
}));
app.post('/api/kiot/xlsx-import',auth,manager,upload.single('file'),wrap(async(req,res)=>{
 if(!req.file)return res.status(400).json({error:'Chưa chọn Excel'});
 let client;
 try{
  const {rows,ignored}=kiotRowsFromXlsx(req.file.path);
  client=await pool.connect();await client.query('BEGIN');let inserted=0,updated=0;
  for(const r of rows){
   const exists=await client.query('SELECT 1 FROM kiot_invoice_lines WHERE invoice_code=$1 AND line_key=$2',[r.invoice,r.lineKey]);
   await client.query(`INSERT INTO kiot_invoice_lines(invoice_code,line_key,sale_date,employee_name,branch,product_code,product_name,category,quantity,amount,status,raw_json)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
   ON CONFLICT(invoice_code,line_key) DO UPDATE SET sale_date=EXCLUDED.sale_date,employee_name=EXCLUDED.employee_name,branch=EXCLUDED.branch,product_name=EXCLUDED.product_name,category=EXCLUDED.category,quantity=EXCLUDED.quantity,amount=EXCLUDED.amount,status=EXCLUDED.status,raw_json=EXCLUDED.raw_json,updated_at=NOW()`,
   [r.invoice,r.lineKey,r.date,r.employee,r.branch,r.productCode,r.productName,r.category,r.qty,r.amount,r.status,JSON.stringify(r.raw)]);
   if(exists.rowCount)updated++;else inserted++;
  }
  await client.query('COMMIT');res.json({ok:true,inserted,updated,ignored,total:rows.length});
 }catch(e){if(client)await client.query('ROLLBACK');throw e}
 finally{if(client)client.release();fs.unlinkSync(req.file.path)}
}));
// KiotViet employee mapping is manager-controlled; unmatched sellers remain visible for review.
app.get('/api/kiot/branch-mapping',auth,manager,wrap(async(req,res)=>{
 const [names,mappings,branches]=await Promise.all([
  q("SELECT DISTINCT employee_name AS name FROM kiot_invoice_lines WHERE employee_name<>'' ORDER BY employee_name"),
  q('SELECT kiot_name,branch FROM kiot_branch_map'),
  q('SELECT name FROM branches WHERE active=1 ORDER BY name')
 ]);
 res.json({names:names.rows.map(x=>x.name),mappings:mappings.rows,branches:branches.rows.map(x=>x.name),defaultBranch:'Dương Quảng Hàm'});
}));
app.post('/api/kiot/branch-mapping',auth,manager,wrap(async(req,res)=>{
 const name=String(req.body.kiotName||'').trim(),branch=String(req.body.branch||'').trim();
 if(!name||!branch)return res.status(400).json({error:'Thiếu tên nhân viên hoặc chi nhánh'});
 const exists=await q('SELECT 1 FROM branches WHERE name=$1 AND active=1',[branch]);
 if(!exists.rowCount)return res.status(400).json({error:'Chi nhánh chưa được tạo hoặc không hoạt động'});
 await q('INSERT INTO kiot_branch_map(kiot_name,branch) VALUES($1,$2) ON CONFLICT(kiot_name) DO UPDATE SET branch=EXCLUDED.branch,updated_at=NOW()',[name,branch]);
 res.json({ok:true});
}));
app.get('/api/kiot/employee-mapping',auth,manager,wrap(async(req,res)=>{
 const [names,users,mappings]=await Promise.all([
  q("SELECT DISTINCT employee_name AS name FROM kiot_invoice_lines WHERE employee_name<>'' ORDER BY employee_name"),
  q("SELECT id,display_name FROM users WHERE role='employee' AND active=1 ORDER BY display_name"),
  q('SELECT kiot_name,employee_id FROM kiot_employee_map')]);
 res.json({names:names.rows.map(x=>x.name),users:users.rows,mappings:mappings.rows});
}));
app.post('/api/kiot/employee-mapping',auth,manager,wrap(async(req,res)=>{
 const name=String(req.body.kiotName||'').trim(),id=Number(req.body.employeeId);
 if(!name||name.length>150)return res.status(400).json({error:'Tên KiotViet không hợp lệ'});
 if(!id){await q('DELETE FROM kiot_employee_map WHERE kiot_name=$1',[name]);return res.json({ok:true})}
 const u=await q("SELECT id FROM users WHERE id=$1 AND role='employee' AND active=1",[id]);
 if(!u.rowCount)return res.status(400).json({error:'Tài khoản nhân viên không hợp lệ'});
 await q('INSERT INTO kiot_employee_map(kiot_name,employee_id) VALUES($1,$2) ON CONFLICT(kiot_name) DO UPDATE SET employee_id=EXCLUDED.employee_id,updated_at=NOW()',[name,id]);
 res.json({ok:true});
}));
// KiotViet exports both shops as "Chi nhánh trung tâm". Determine the real shop by seller.
// Unknown sellers are explicitly unassigned, never silently credited to a shop.
const RZ_KIOT_BRANCH_SQL = `COALESCE((SELECT bm.branch FROM kiot_branch_map bm WHERE lower(trim(bm.kiot_name))=lower(trim(l.employee_name)) LIMIT 1),'Dương Quảng Hàm')`;
async function rzKiotAggregate(from,to,branch='',employeeId=null){
 // Keep date alias unambiguous and classify the exported central branch by seller.
 // The inner query computes branch once, avoiding repeated CASE expressions in GROUP BY.
 const result=await q(`
  SELECT sale_day AS "day",branch,employee_name,employee_id,category,
         SUM(quantity)::float AS qty,SUM(amount)::bigint AS revenue,
         COUNT(DISTINCT invoice_code)::int AS invoices
  FROM (
    SELECT l.sale_date::text AS sale_day,
           ${RZ_KIOT_BRANCH_SQL} AS branch,
           l.employee_name,m.employee_id,
           CASE WHEN l.category='other' AND (lower(l.product_name) LIKE 'macbook%' OR lower(l.product_name) LIKE 'ipad%')
                THEN 'machine' ELSE l.category END AS category,
           l.quantity,l.amount,l.invoice_code
    FROM kiot_invoice_lines AS l
    LEFT JOIN kiot_employee_map AS m ON m.kiot_name=l.employee_name
    WHERE l.sale_date BETWEEN $1 AND $2
      AND lower(trim(l.status)) IN ('hoàn thành','hoan thanh')
  ) AS sales
  WHERE ($3::text='' OR branch=$3::text)
    AND ($4::bigint IS NULL OR employee_id=$4::bigint)
  GROUP BY sale_day,branch,employee_name,employee_id,category
 `,[from,to,branch,employeeId]);
 return result.rows;
}
function rzSummarizeKiot(lines){
 const t={machines:0,machineRevenue:0,insured:0,insuranceRevenue:0,accessoryRevenue:0,accessories:0,dropped:0,customers:0,successful:0,failed:0,inStock:0,outsideStock:0,liquidation:0,newSuper:0,grade99:0};
 for(const x of lines){const n=Number(x.qty||0),v=Number(x.revenue||0);
  if(x.category==='machine'){t.machines+=n;t.machineRevenue+=v}
  if(x.category==='insurance'&&v>0){t.insured+=n;t.insuranceRevenue+=v}
  if(x.category==='accessory'&&v>0){t.accessories+=n;t.accessoryRevenue+=v}
 }
 t.insuranceRate=t.machines?t.insured/t.machines*100:0;
 t.dropRate=0;t.closeRate=0;t.totalRevenue=t.machineRevenue+t.insuranceRevenue;
 return t;
}
app.get('/api/kiot/import-summary',auth,manager,wrap(async(req,res)=>{
 const r=await q(`SELECT COUNT(*)::int lines,COUNT(DISTINCT invoice_code)::int invoices,
 MIN(sale_date)::text first_date,MAX(sale_date)::text last_date,
 COUNT(*) FILTER (WHERE category='machine')::int machine_lines,
 COUNT(*) FILTER (WHERE category='insurance')::int insurance_lines,
 COUNT(*) FILTER (WHERE category='other')::int other_lines
 FROM kiot_invoice_lines WHERE lower(trim(status)) IN ('hoàn thành','hoan thanh')`);
 const branches=await q(`SELECT ${RZ_KIOT_BRANCH_SQL} AS branch,COUNT(*)::int lines FROM kiot_invoice_lines l GROUP BY ${RZ_KIOT_BRANCH_SQL} ORDER BY branch`);
 res.json({...r.rows[0],branches:branches.rows,source:'kiot_xlsx'});
}));
app.get('/api/kiot/employee-daily',auth,wrap(async(req,res)=>{
 const from=String(req.query.from||new Date().toISOString().slice(0,10)),to=String(req.query.to||from);
 const employeeId=req.user.role==='manager'?Number(req.query.employeeId||0):Number(req.user.id);
 if(!employeeId)return res.status(400).json({error:'Chưa chọn nhân viên'});
 const lines=await rzKiotAggregate(from,to,'',employeeId),byDate=new Map();
 for(const r of lines){if(!byDate.has(r.day))byDate.set(r.day,{date:r.day,machines:0,insured:0,accessories:0,machineCommission:0,insuranceCommission:0,accessoryCommission:0,total:0,insuranceRevenue:0});
  const x=byDate.get(r.day),qty=Number(r.qty||0),amount=Number(r.revenue||0);
  if(r.category==='machine'){x.machines+=qty;x.machineCommission+=qty*30000}
  if(r.category==='insurance'&&amount>0){x.insured+=qty;x.insuranceRevenue+=amount}
  if(r.category==='accessory'&&amount>0){x.accessories+=qty;x.accessoryCommission+=qty*15000}
 }
 const days=[...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date));
 const totalMachines=days.reduce((n,x)=>n+x.machines,0),totalInsurance=days.reduce((n,x)=>n+x.insured,0);
 const rate=totalMachines&&totalInsurance/totalMachines>=0.65?.10:.08;
 for(const x of days){x.insuranceCommission=Math.round(x.insuranceRevenue*rate);x.total=x.machineCommission+x.insuranceCommission+x.accessoryCommission}
 res.json({days,total:days.reduce((n,x)=>n+x.total,0),source:'kiot_xlsx',rate});
}));
app.get('/api/kiot/lines',auth,manager,wrap(async(req,res)=>{
 const from=String(req.query.from||'2000-01-01'),to=String(req.query.to||'2999-12-31');
 const result=await q(`SELECT l.sale_date::text,l.invoice_code,l.employee_name,${RZ_KIOT_BRANCH_SQL} AS branch,l.product_name,l.quantity,l.amount,l.status
 FROM kiot_invoice_lines l WHERE l.sale_date BETWEEN $1 AND $2 ORDER BY sale_date DESC,invoice_code DESC LIMIT 500`,[from,to]);
 res.json(result.rows);
}));
app.get('/api/branches', auth, wrap(async (req,res)=>{ const r=await q('SELECT name FROM branches WHERE active=1 ORDER BY name'); res.json(r.rows.map(x=>x.name)); }));
app.post('/api/branches', auth, manager, wrap(async (req,res)=>{ const name=String(req.body.name||'').trim(); if(!name || name.length>80) return res.status(400).json({error:'Tên chi nhánh không hợp lệ (tối đa 80 ký tự)'}); try { const r=await q('INSERT INTO branches(name) VALUES($1) RETURNING id,name',[name]); await log(req.user.id,'create','branch',r.rows[0].id,{name}); res.json(r.rows[0]); } catch(e) { if(e.code==='23505') return res.status(400).json({error:'Chi nhánh này đã tồn tại'}); throw e; } }));
app.get('/api/kiot/branches', auth, manager, wrap(async (req, res) => {
  res.json(['Dương Quảng Hàm','Kha Vạn Cân','Chưa phân loại']);
}));
app.get('/api/kiot/sales', auth, manager, wrap(async (req, res) => {
  const r = await q('SELECT * FROM kiot_sales WHERE sale_date BETWEEN $1 AND $2 ORDER BY sale_date DESC', [req.query.from || '2000-01-01', req.query.to || '2999-12-31']);
  res.json(r.rows);
}));

app.get('/api/business-history',auth,manager,wrap(async(req,res)=>{
 const year=Number(req.query.year||new Date().getFullYear());
 const branch=String(req.query.branch||'');
 if(!Number.isInteger(year)||year<2000||year>2100)return res.status(400).json({error:'Năm không hợp lệ'});
 const from=year+'-01-01',to=year+'-12-31';
 const [kiot,visitors,stock]=await Promise.all([
  rzKiotAggregate(from,to,branch),
  q('SELECT to_char(work_date,\'YYYY-MM\') month,COALESCE(SUM(customers),0)::int customers,COALESCE(SUM(successful),0)::int successful FROM daily_stats WHERE work_date BETWEEN $1 AND $2 AND ($3::text=\'\' OR branch=$3) GROUP BY 1',[from,to,branch]),
  q("SELECT to_char(sale_date,'YYYY-MM') month,COUNT(*) FILTER (WHERE stock_source='Trong kho')::int in_stock,COUNT(*) FILTER (WHERE stock_source<>'Trong kho')::int outside_stock FROM manual_sales WHERE sale_date BETWEEN $1 AND $2 AND ($3::text='' OR branch=$3) GROUP BY 1",[from,to,branch])
 ]);
 const monthly=new Map();
 for(let i=1;i<=12;i++){const month=year+'-'+String(i).padStart(2,'0');monthly.set(month,{month,machines:0,machineRevenue:0,insured:0,insuranceRevenue:0,customers:0,successful:0,inStock:0,outsideStock:0})}
 for(const x of kiot){const m=String(x.day).slice(0,7),d=monthly.get(m);if(!d)continue;if(x.category==='machine'){d.machines+=Number(x.qty);d.machineRevenue+=Number(x.revenue)}if(x.category==='insurance'&&Number(x.revenue)>0){d.insured+=Number(x.qty);d.insuranceRevenue+=Number(x.revenue)}}
 for(const x of visitors.rows){const d=monthly.get(x.month);if(d){d.customers=Number(x.customers);d.successful=Number(x.successful)}}
 for(const x of stock.rows){const d=monthly.get(x.month);if(d){d.inStock=Number(x.in_stock);d.outsideStock=Number(x.outside_stock)}}
 res.json({year,branch,months:[...monthly.values()].map(d=>({...d,totalRevenue:d.machineRevenue+d.insuranceRevenue,closeRate:d.customers?d.successful/d.customers*100:null}))});
}));

app.get('/api/dashboard',auth,wrap(async(req,res)=>{
 const from=String(req.query.from||new Date().toISOString().slice(0,10));
 const to=String(req.query.to||from),branch=String(req.query.branch||'');
 const employeeId=req.user.role==='manager'?(req.query.employeeId?Number(req.query.employeeId):null):Number(req.user.id);
 const month=String(req.query.month||to.slice(0,7));
 const [lines,users,kpis,branchKpis]=await Promise.all([
  rzKiotAggregate(from,to,branch,employeeId),
  q(req.user.role==='manager'?"SELECT id,display_name FROM users WHERE role='employee' AND active=1 ORDER BY display_name":"SELECT id,display_name FROM users WHERE id=$1",req.user.role==='manager'?[]:[req.user.id]),
  q('SELECT k.*,u.display_name FROM kpis k JOIN users u ON u.id=k.employee_id WHERE k.month=$1',[month]),
  q(`SELECT * FROM branch_kpis WHERE month=$1 AND ($2='' OR branch=$2)`,[month,branch])
 ]);
 const manualFilters=[from,to];
 let manualScope='';
 if(branch){manualFilters.push(branch);manualScope+=' AND branch=$'+manualFilters.length}
 if(employeeId){manualFilters.push(employeeId);manualScope+=' AND employee_id=$'+manualFilters.length}
 const [manualDaily,manualStock,weekdayRows]=await Promise.all([
  q('SELECT COALESCE(SUM(customers),0)::int customers,COALESCE(SUM(successful),0)::int successful,COALESCE(SUM(failed),0)::int failed FROM daily_stats WHERE work_date BETWEEN $1 AND $2'+manualScope,manualFilters),
  q("SELECT COALESCE(SUM(CASE WHEN stock_source='Trong kho' THEN 1 ELSE 0 END),0)::int in_stock,COALESCE(SUM(CASE WHEN stock_source<>'Trong kho' THEN 1 ELSE 0 END),0)::int outside_stock FROM manual_sales WHERE sale_date BETWEEN $1 AND $2"+manualScope,manualFilters),
  q('SELECT EXTRACT(DOW FROM work_date)::int weekday,COUNT(DISTINCT work_date)::int days,COALESCE(SUM(customers),0)::int visitors,COALESCE(SUM(successful),0)::int successful FROM daily_stats WHERE work_date BETWEEN $1 AND $2'+manualScope+' GROUP BY EXTRACT(DOW FROM work_date) ORDER BY weekday',manualFilters)
 ]);
 const manual={...manualDaily.rows[0],inStock:manualStock.rows[0].in_stock,outsideStock:manualStock.rows[0].outside_stock};
 manual.closeRate=Number(manual.customers)?Number(manual.successful)/Number(manual.customers)*100:null;
 const weekdayVisitors=weekdayRows.rows.map(x=>({weekday:Number(x.weekday),days:Number(x.days),visitors:Number(x.visitors),successful:Number(x.successful),average:Number(x.days)?Number(x.visitors)/Number(x.days):0}));
 const total=rzSummarizeKiot(lines);
 total.customers=Number(manual.customers);total.successful=Number(manual.successful);total.failed=Number(manual.failed);total.closeRate=manual.closeRate;total.inStock=Number(manual.inStock);total.outsideStock=Number(manual.outsideStock);
 const employeeLines=lines.filter(x=>x.employee_id!=null);
 const employees=users.rows.filter(u=>!employeeId||Number(u.id)===employeeId).map(u=>{
  const t=rzSummarizeKiot(employeeLines.filter(x=>Number(x.employee_id)===Number(u.id)));
  return {employeeId:Number(u.id),name:u.display_name,...t};
 });
 const trendMap=new Map(),branchMap=new Map();
 for(const x of lines){
  if(!trendMap.has(x.day))trendMap.set(x.day,{date:x.day,machines:0,machineRevenue:0,insuranceRevenue:0,customers:0,successful:0});
  const d=trendMap.get(x.day);if(x.category==='machine'){d.machines+=Number(x.qty);d.machineRevenue+=Number(x.revenue)}
  if(x.category==='insurance'&&Number(x.revenue)>0)d.insuranceRevenue+=Number(x.revenue);
  if(!branchMap.has(x.branch))branchMap.set(x.branch,{branch:x.branch,machines:0,machineRevenue:0,insured:0,insuranceRevenue:0,inStock:0,outsideStock:0,customers:0,successful:0,failed:0});
  const b=branchMap.get(x.branch);if(x.category==='machine'){b.machines+=Number(x.qty);b.machineRevenue+=Number(x.revenue)}
  if(x.category==='insurance'&&Number(x.revenue)>0){b.insured+=Number(x.qty);b.insuranceRevenue+=Number(x.revenue)}
 }
 const branchSummary=[...branchMap.values()].map(x=>({...x,totalRevenue:x.machineRevenue+x.insuranceRevenue,closeRate:0}));
 const startMonth=month+'-01';const [year,mo]=month.split('-').map(Number);
 const endMonth=new Date(Date.UTC(year,mo,0)).toISOString().slice(0,10);
 const monthLines=await rzKiotAggregate(startMonth,endMonth,branch,employeeId);
 const now=new Date(),daysInMonth=new Date(year,mo,0).getDate();
 const elapsed=month===now.toISOString().slice(0,7)?now.getDate():daysInMonth;
 const kpiProgress=kpis.rows.filter(k=>!employeeId||Number(k.employee_id)===employeeId).map(k=>{
  const a=rzSummarizeKiot(monthLines.filter(x=>Number(x.employee_id)===Number(k.employee_id)));
  const machines=a.machines,insured=a.insured;
  return {employeeId:Number(k.employee_id),name:k.display_name,machineTarget:Number(k.machine_target),insuranceTarget:Number(k.insurance_target),machines,insured,
   machineProgress:k.machine_target?machines/Number(k.machine_target)*100:0,insuranceProgress:k.insurance_target?insured/Number(k.insurance_target)*100:0,
   machineForecast:elapsed?machines/elapsed*daysInMonth:0,insuranceForecast:elapsed?insured/elapsed*daysInMonth:0,month};
 });
 const branchKpiProgress=branchKpis.rows.map(k=>{
  const a=rzSummarizeKiot(monthLines.filter(x=>x.branch===k.branch));
  const revenue=a.totalRevenue,revenueTarget=Number(k.revenue_target||0),insuranceRevenueTarget=Number(k.insurance_revenue_target||0);
  return {branch:k.branch,revenue,revenueTarget,insuranceRevenue:a.insuranceRevenue,insuranceRevenueTarget,
   revenueProgress:revenueTarget?revenue/revenueTarget*100:0,revenueForecast:elapsed?revenue/elapsed*daysInMonth:0,
   machineTarget:Number(k.machine_target),insuranceTarget:Number(k.insurance_target),machines:a.machines,insured:a.insured,
   machineProgress:k.machine_target?a.machines/Number(k.machine_target)*100:0,
   insuranceProgress:k.insurance_target?a.insured/Number(k.insurance_target)*100:0,
   machineForecast:elapsed?a.machines/elapsed*daysInMonth:0,insuranceForecast:elapsed?a.insured/elapsed*daysInMonth:0,month};
 });
 let comparison=null;
 if(req.query.compareFrom&&req.query.compareTo){
  comparison=rzSummarizeKiot(await rzKiotAggregate(String(req.query.compareFrom),String(req.query.compareTo),branch,employeeId));
 }
 const unmapped=[...new Set(lines.filter(x=>x.employee_id==null).map(x=>x.employee_name))];
 res.json({from,to,source:'kiot_xlsx',total,employees,trend:[...trendMap.values()].sort((a,b)=>a.date.localeCompare(b.date)),branchSummary,
  branchKpiProgress,kpiProgress,comparison,unmappedEmployees:unmapped,manualMetrics:manual,weekdayVisitors,
  kiot:{orders:0,machines:total.machines,revenue:total.totalRevenue},kiotByEmployee:[]});
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
// Quản lý: lương và KPI theo chính sách RenewZone; chỉ sử dụng đơn nhân viên nhập.
function rzManagerMachineBonus(n){return n>=500?21000000:n>=450?17000000:n>=400?13000000:n>=350?9000000:n>=300?6000000:n>=250?3000000:0;}
function rzManagerInsuranceBonus(machines,insured){if(machines<280)return 0;return insured>=300?17000000:insured>=250?13000000:insured>=200?10000000:insured>=150?7000000:insured>=100?5000000:0;}
function rzManagerBusinessRate(attach,drop){
  if(attach<20||drop>50)return 0;
  // Trang 2: điều kiện 100% ghi <=25%, nhưng ghi chú yêu cầu đúng 25% không đạt.
  const levels=[[1,attach>=55&&drop<25],[.9,attach<55&&drop>=28],[.8,attach<=50&&drop<30],[.7,attach<=45&&drop<35],[.6,attach<=40&&drop<40],[.5,attach<=35&&drop<45],[.4,attach<=30&&drop<=50]];
  const hit=levels.find(([,ok])=>ok);return hit?hit[0]:null;
}
function rzManagerViolationFactor(n){return n>=4?0:n===3?.5:n===2?.7:n===1?.9:1;}
const rzMonthOk=m=>/^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const rzManagerNum=(x,max)=>x===null||x===undefined||x===''?null:(Number.isFinite(Number(x))&&Number(x)>=0&&Number(x)<=max?Number(x):NaN);
app.get('/api/manager-payroll',auth,manager,wrap(async(req,res)=>{
 const month=String(req.query.month||'');if(!rzMonthOk(month))return res.status(400).json({error:'Tháng không hợp lệ'});
 const branch=String(req.query.branch||'').trim();if(branch.length>80)return res.status(400).json({error:'Chi nhánh không hợp lệ'});
 const managerId=req.user.id;
 const config=(await q('SELECT * FROM manager_payroll WHERE manager_id=$1 AND month=$2 AND branch=$3',[managerId,month,branch])).rows[0]||null;
 const from=month+'-01',to=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
 const a=[from,to,branch];
 const kiotManager=rzSummarizeKiot(await rzKiotAggregate(from,to,branch));
 const sales={machines:kiotManager.machines,insured:kiotManager.insured,machine_revenue:kiotManager.machineRevenue,insurance_revenue:kiotManager.insuranceRevenue};
 const stats={bought:0,failed:0}; // Kiot invoice file has no non-buyers; manager must confirm rate manually.
 const machines=Number(sales.machines),insured=Number(sales.insured),bought=Number(stats.bought),failed=Number(stats.failed);
 const attachment=machines?insured/machines*100:null,drop=bought+failed?failed/(bought+failed)*100:null;
 const baseMachine=rzManagerMachineBonus(machines),baseInsurance=rzManagerInsuranceBonus(machines,insured);
 const inferred=attachment===null||drop===null?null:rzManagerBusinessRate(attachment,drop);
 const rate=config?.business_rate_override!=null?Number(config.business_rate_override)/100:inferred;
 const scores=[config?.store_score,config?.operations_score,config?.service_score];
 const scoresReady=scores.every(x=>x!==null&&x!==undefined);
 const quality=scoresReady?scores.reduce((sum,x)=>sum+Number(x),0)/3:null;
 const errors=config?.report_errors==null?null:Number(config.report_errors);
 const qualityFactor=errors!==null&&errors>=2?.7:quality===null?null:.7+.3*quality/100;
 const violations=config?.violations==null?null:Number(config.violations);
 const violationFactor=violations===null?null:rzManagerViolationFactor(violations);
 const standard=config?.standard_days==null?null:Number(config.standard_days),worked=config?.worked_days==null?null:Number(config.worked_days);
 const salary=standard>0&&worked!==null?Math.round(10000000*Math.min(worked/standard,1)):null;
 const kpi=rate!==null&&qualityFactor!==null&&violationFactor!==null?Math.round((baseMachine+baseInsurance)*rate*qualityFactor*violationFactor):null;
 const employmentFactor=config?.probation ? 0.85 : 1;
 const total=salary!==null&&kpi!==null?Math.round((salary+kpi)*employmentFactor):null;
 const warnings=[];
 if(!config||standard===null||worked===null)warnings.push('Chưa nhập công chuẩn và ngày công thực tế.');
 if(drop===null)warnings.push('Excel KiotViet không có số khách không mua: cần nhập mức hưởng kinh doanh do quản lý/BGĐ xác nhận.');
 if(inferred===null&&config?.business_rate_override==null)warnings.push('Chính sách không xác định được mức hưởng kinh doanh cho tổ hợp tỷ lệ hiện tại; cần xác nhận mức hưởng.');
 if(!scoresReady&&!(errors!==null&&errors>=2))warnings.push('Chưa có đủ 3 điểm chất lượng do BGĐ duyệt.');
 if(violations===null)warnings.push('Chưa xác nhận số biên bản trong tháng.');
 res.json({month,branch,config,metrics:{machines,insured,attachment,drop,bought,failed,machineRevenue:Number(sales.machine_revenue),insuranceRevenue:Number(sales.insurance_revenue)},calculation:{baseMachine,baseInsurance,inferredRate:inferred,rate,quality,qualityFactor,violationFactor,salary,kpi,employmentFactor,total},warnings,note:'Tạm tính theo dữ liệu Excel KiotViet; tỷ lệ rớt khách cần nhập/đối soát riêng vì Excel không ghi khách không mua.'});
}));
app.post('/api/manager-payroll',auth,manager,wrap(async(req,res)=>{
 const b=req.body||{},month=String(b.month||''),branch=String(b.branch||'').trim();
 if(!rzMonthOk(month)||branch.length>80)return res.status(400).json({error:'Tháng hoặc chi nhánh không hợp lệ'});
 const fields=['standardDays','workedDays','storeScore','operationsScore','serviceScore','reportErrors','violations','businessRateOverride'];
 const maxes=[31,31,100,100,100,1000,1000,100];
 const vals=fields.map((f,i)=>rzManagerNum(b[f],maxes[i]));
 if(vals.some(x=>Number.isNaN(x))|| (vals[0]!==null&&vals[0]<=0) ||(vals[0]!==null&&vals[1]!==null&&vals[1]>vals[0]) ||[5,6].some(i=>vals[i]!==null&&!Number.isInteger(vals[i])))return res.status(400).json({error:'Số công, điểm hoặc biên bản không hợp lệ'});
 const note=String(b.note||'').slice(0,500);
 await q(`INSERT INTO manager_payroll(manager_id,month,branch,standard_days,worked_days,probation,store_score,operations_score,service_score,report_errors,violations,business_rate_override,note)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
 ON CONFLICT(manager_id,month,branch) DO UPDATE SET standard_days=EXCLUDED.standard_days,worked_days=EXCLUDED.worked_days,probation=EXCLUDED.probation,store_score=EXCLUDED.store_score,operations_score=EXCLUDED.operations_score,service_score=EXCLUDED.service_score,report_errors=EXCLUDED.report_errors,violations=EXCLUDED.violations,business_rate_override=EXCLUDED.business_rate_override,note=EXCLUDED.note,updated_at=CURRENT_TIMESTAMP`,[req.user.id,month,branch,vals[0],vals[1],b.probation===true,vals[2],vals[3],vals[4],vals[5],vals[6],vals[7],note]);
 await log(req.user.id,'upsert','manager_payroll',null,{month,branch});res.json({ok:true});
}));

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
 FROM (SELECT display_name AS employee_name FROM users WHERE role='employee'
 UNION SELECT employee_name FROM payroll_staff) names
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
// Payroll uses imported KiotViet invoice lines, not manually entered sales.
app.get('/api/payroll/report',auth,manager,wrap(async(req,res)=>{
 const month=String(req.query.month||''),branch=String(req.query.branch||'');
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return res.status(400).json({error:'Tháng không hợp lệ'});
 const from=month+'-01'; const [year,mon]=month.split('-').map(Number);
 const to=new Date(Date.UTC(year,mon,0)).toISOString().slice(0,10);
  const sales=(await q(`SELECT COALESCE(u.display_name,l.employee_name) AS employee_name,
  COALESCE(SUM(CASE WHEN category='machine' THEN quantity ELSE 0 END),0)::int AS machines,
  COALESCE(SUM(CASE WHEN category='insurance' AND amount>0 THEN quantity ELSE 0 END),0)::int AS insurance,
  COALESCE(SUM(CASE WHEN category='insurance' THEN amount ELSE 0 END),0) AS insurance_revenue,
  COALESCE(SUM(CASE WHEN category='accessory' AND amount>0 THEN quantity ELSE 0 END),0)::int AS accessory
  FROM kiot_invoice_lines l LEFT JOIN kiot_employee_map m ON m.kiot_name=l.employee_name LEFT JOIN users u ON u.id=m.employee_id
  WHERE l.sale_date BETWEEN $1 AND $2 AND ($3='' OR ${RZ_KIOT_BRANCH_SQL}=$3)
  AND lower(trim(l.status)) IN ('hoàn thành','hoan thanh') GROUP BY COALESCE(u.display_name,l.employee_name)`,[from,to,branch])).rows;
  const accessories=[];
 const staff=(await q('SELECT employee_name,hire_date::text AS hire_date,base_salary FROM payroll_staff')).rows;
 const staffMap=new Map(staff.map(x=>[x.employee_name,x]));
 const out=new Map();
 const get=(name)=>{if(!out.has(name))out.set(name,{name,large:0,accessory:0,tradein:0,insurance:0,insuranceRevenue:0,unclassified:0,invalid:0});return out.get(name)};
 for(const r of sales){const x=get(r.employee_name);x.large+=Number(r.machines||0);x.insurance+=Number(r.insurance||0);x.insuranceRevenue+=Number(r.insurance_revenue||0);x.accessory+=Number(r.accessory||0)}
 for(const r of accessories){get(r.employee_name).accessory+=Number(r.accessory||0)}
 // Include configured staff with no sales only in all-branch view; branch-specific base salary must not be duplicated.
 if(!branch)for(const st of staff)get(st.employee_name);
 const threshold=new Date(Date.UTC(year,mon-2,1)).toISOString().slice(0,10);
 const result=[...out.values()].sort((a,b)=>a.name.localeCompare(b.name,'vi')).map(x=>{
 const st=staffMap.get(x.name),hire=st?.hire_date||null;
 const eligible=!!hire&&hire<=threshold;
 const ratio=x.large>0?x.insurance/x.large*100:null;
 const rate=x.large>0&&x.insurance/x.large>=0.65?0.10:0.08;
 const bonus=eligible&&ratio!==null&&ratio>=80?2000000:0;
 // No trade-in input exists yet; do not fabricate trade-in commission.
 const commission=x.large*30000+x.accessory*15000;
 const insuranceCommission=Math.round(x.insuranceRevenue*rate);
 const baseSalary=Number(st?.base_salary||0);
 return {...x,ratio,rate,eligible,hireDate:hire,baseSalary,commission,insuranceCommission,bonus,total:baseSalary+commission+insuranceCommission+bonus,complete:!!hire,tradeinPending:true};
 });
 res.json({month,branch,source:'kiot_xlsx',rows:result,unclassified:0,note:'Lương thưởng tạm tính từ file Excel KiotViet đã tải lên (chỉ hóa đơn Hoàn thành). Tên người bán trên KiotViet cần khớp nhân viên. Chưa tính thu mua; kiểm tra ngày vào làm, lương cơ bản và đơn hoàn/hủy trước khi chốt.'});
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
