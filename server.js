/* ============================================================
   FieldOps  ›  Monday-synced backend  (email + password accounts)
   - Jobs come from the CCH + Private maintenance boards (3 groups)
   - People sign up with email + password; accounts are stored in a
     private Monday board; an admin approves them and sets which
     contractor they are. Operatives then see only their own jobs.
   - Your Monday token stays on the server.
   ============================================================ */
const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits:{ fileSize: 25*1024*1024 } });

const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
const API = 'https://api.monday.com/v2';
if (!MONDAY_TOKEN) { console.error('FATAL: MONDAY_TOKEN env var is not set.'); process.exit(1); }

/* ---------- which boards / columns ---------- */
const BOARDS = [
  { id: process.env.CCH_BOARD_ID     || '1652227316', name: 'CCH',     contractor: process.env.CCH_CONTRACTOR     || 'dropdown_mkwxqwz2' },
  { id: process.env.PRIVATE_BOARD_ID || '1733859650', name: 'Private', contractor: process.env.PRIVATE_CONTRACTOR || 'dropdown_mkznxc22' },
];
const COL = { address:'dropdown__1', visit:'dup__of_date_of_invoice__1', status:'dup__of_payment_status__1',
              desc:'long_text__1', jobtype:'type__1', evidence:'dup__of_files__1', invoice:'upload_file__1' };
const WANT_GROUPS = ['Outstanding Calls','Visit Booked','Works in Progress'];
const IMG = /\.(jpe?g|png|gif|webp|heic|heif|bmp)(\?|$)/i;

/* ---------- timezone handling for Monday date columns ----------
   Monday stores date-column times in UTC and shows them in the account's
   timezone. The app's users type local time, so we convert both ways. */
const APP_TZ = process.env.APP_TZ || 'Europe/London';
const _pad = n => String(n).padStart(2,'0');
function _tzOffsetMs(tz, dateUtc){
  const dtf = new Intl.DateTimeFormat('en-GB',{ timeZone:tz, hourCycle:'h23',
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit' });
  const p = dtf.formatToParts(dateUtc).reduce((a,x)=>{ if(x.type!=='literal') a[x.type]=x.value; return a; },{});
  return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second) - dateUtc.getTime();
}
// local wall-clock (APP_TZ) -> {date,time} in UTC to send to Monday
function localToMonday(dateStr, timeStr){
  let t = timeStr || '09:00';
  if(t.length===5) t += ':00';
  const [Y,M,D] = dateStr.split('-').map(Number);
  const [h,mi,s] = t.split(':').map(Number);
  const guess = new Date(Date.UTC(Y,M-1,D,h,mi,s||0));
  const u = new Date(guess.getTime() - _tzOffsetMs(APP_TZ, guess));
  return { date:`${u.getUTCFullYear()}-${_pad(u.getUTCMonth()+1)}-${_pad(u.getUTCDate())}`,
           time:`${_pad(u.getUTCHours())}:${_pad(u.getUTCMinutes())}:${_pad(u.getUTCSeconds())}` };
}
// UTC {date,time} from Monday -> {date,time} wall-clock in APP_TZ for display
function mondayToLocal(dateStr, timeStr){
  let t = timeStr || '00:00';
  if(t.length===5) t += ':00';
  const [Y,M,D] = dateStr.split('-').map(Number);
  const [h,mi,s] = t.split(':').map(Number);
  const utc = new Date(Date.UTC(Y,M-1,D,h,mi,s||0));
  const dtf = new Intl.DateTimeFormat('en-GB',{ timeZone:APP_TZ, hourCycle:'h23',
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit' });
  const p = dtf.formatToParts(utc).reduce((a,x)=>{ if(x.type!=='literal') a[x.type]=x.value; return a; },{});
  return { date:`${p.year}-${p.month}-${p.day}`, time:`${p.hour}:${p.minute}` };
}

/* ---------- accounts (stored in the private FieldOps Users board) ---------- */
const USER_BOARD_ID = process.env.USER_BOARD_ID || '5098399575';
const UCOL = { email:'text_mm47hs8v', pass:'text_mm47skq7', role:'text_mm475fdm', contractor:'text_mm477f06', allowance:'numeric_mm4e96n0' };
// manual calendar entries (things not on the maintenance boards)
const EVENT_BOARD_ID = process.env.EVENT_BOARD_ID || '5098400789';
const ECOL = { when:'date_mm47bbpy', contractor:'text_mm47yx6m', notes:'text_mm47j8dy' };
// holiday / annual-leave requests
const HOLIDAY_BOARD_ID = process.env.HOLIDAY_BOARD_ID || '5098814403';
const HCOL = { email:'text_mm4ep9dh', start:'date_mm4e6xcj', end:'date_mm4eg3wy', days:'numeric_mm4eydmd', status:'text_mm4eb98z', notes:'text_mm4ey39z' };
// count working days (Mon–Fri) inclusive between two YYYY-MM-DD dates
function workingDays(startStr, endStr){
  const s=new Date(startStr+'T00:00:00Z'), e=new Date(endStr+'T00:00:00Z');
  if(isNaN(s)||isNaN(e)||e<s) return 0;
  let n=0; const d=new Date(s);
  while(d<=e){ const wd=d.getUTCDay(); if(wd!==0&&wd!==6) n++; d.setUTCDate(d.getUTCDate()+1); }
  return n;
}

// A built-in admin that always works, so you can log in and approve people.
// Change these by setting ADMIN_EMAIL / ADMIN_PASSWORD, or edit here.
const BOOTSTRAP_ADMIN = {
  email: (process.env.ADMIN_EMAIL || 'sam@titerra.com').toLowerCase(),
  password: process.env.ADMIN_PASSWORD || 'titerra-admin-4821',
  name: 'Sam'
};

/* ---------- login tokens (signed, no DB lookup per request) ---------- */
const AUTH_SECRET = process.env.AUTH_SECRET || 'fieldops-shared-secret-3f9b2c7a';
const DAY = 86400000;
function signToken(obj){
  const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const s = crypto.createHmac('sha256', AUTH_SECRET).update(p).digest('base64url');
  return p + '.' + s;
}
function verifyToken(t){
  if(!t) return null;
  const i = t.lastIndexOf('.'); if(i<0) return null;
  const p = t.slice(0,i), s = t.slice(i+1);
  const s2 = crypto.createHmac('sha256', AUTH_SECRET).update(p).digest('base64url');
  if(s !== s2) return null;
  try { const o = JSON.parse(Buffer.from(p,'base64url').toString()); if(o.exp && Date.now()>o.exp) return null; return o; }
  catch(e){ return null; }
}
function authFromReq(req){
  const h = req.get('authorization') || '';
  return verifyToken(h.startsWith('Bearer ') ? h.slice(7) : '');
}
function requireAuth(req,res,next){ const me=authFromReq(req); if(!me) return res.status(401).json({error:'Please sign in again'}); req.me=me; next(); }
function requireAdmin(req,res,next){ if(req.me.role!=='admin') return res.status(403).json({error:'Admin only'}); next(); }
const norm = s => (s||'').trim().toLowerCase();

/* ---------- Monday ---------- */
async function gql(query, variables){
  const r = await fetch(API, { method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization: MONDAY_TOKEN, 'API-Version':'2024-10' },
    body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if(j.errors) throw new Error(j.errors.map(e=>e.message).join('; '));
  return j.data;
}

/* ---------- account helpers (read/write the Users board) ---------- */
async function getBoardUsers(){
  const d = await gql(
    `query($b:[ID!]){ boards(ids:$b){ items_page(limit:300){ items{ id name column_values(ids:["${UCOL.email}","${UCOL.pass}","${UCOL.role}","${UCOL.contractor}","${UCOL.allowance}"]){ id text } } } } }`,
    { b:[USER_BOARD_ID] });
  return (d.boards[0].items_page.items||[]).map(it=>{
    const c={}; it.column_values.forEach(x=>c[x.id]=x.text||'');
    return { id:it.id, name:it.name, email:norm(c[UCOL.email]), hash:c[UCOL.pass]||'',
             role:(c[UCOL.role]||'pending').trim().toLowerCase(), contractor:c[UCOL.contractor]||'',
             allowance:Number(c[UCOL.allowance]||0) };
  });
}
async function createBoardUser(name,email,hash){
  const vals = { [UCOL.email]:email, [UCOL.pass]:hash, [UCOL.role]:'pending', [UCOL.contractor]:'' };
  await gql(`mutation($b:ID!,$n:String!,$v:JSON!){ create_item(board_id:$b,item_name:$n,column_values:$v){ id } }`,
    { b:USER_BOARD_ID, n:name, v:JSON.stringify(vals) });
}
async function updateBoardUser(id,fields){
  const vals={};
  if(fields.role!==undefined)       vals[UCOL.role]=fields.role;
  if(fields.contractor!==undefined) vals[UCOL.contractor]=fields.contractor;
  if(fields.passHash!==undefined)   vals[UCOL.pass]=fields.passHash;
  if(fields.allowance!==undefined)  vals[UCOL.allowance]=Number(fields.allowance)||0;
  await gql(`mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$v){ id } }`,
    { b:USER_BOARD_ID, i:id, v:JSON.stringify(vals) });
}

/* ---------- manual calendar entries ---------- */
async function getEvents(){
  const d = await gql(
    `query($b:[ID!]){ boards(ids:$b){ items_page(limit:300){ items{ id name column_values(ids:["${ECOL.when}","${ECOL.contractor}","${ECOL.notes}"]){ id text value } } } } }`,
    { b:[EVENT_BOARD_ID] });
  return (d.boards[0].items_page.items||[]).map(it=>{
    const c={}; it.column_values.forEach(x=>c[x.id]=x);
    let date=null, time=''; try{ const v=JSON.parse(c[ECOL.when]?.value||'null');
      if(v&&v.date){ if(v.time){ const loc=mondayToLocal(v.date,v.time); date=loc.date; time=loc.time; } else { date=v.date; time=''; } } }catch(e){}
    return { id:it.id, title:it.name, date, time, contractor:c[ECOL.contractor]?.text||'', notes:c[ECOL.notes]?.text||'' };
  });
}

/* ---------- jobs parsing ---------- */
function itemFields(board, withAssets){
  return `id name
    ${withAssets ? 'assets { id name public_url }' : ''}
    ${withAssets ? 'updates(limit:30){ id text_body created_at creator{ name } }' : ''}
    group { id title color }
    column_values(ids:["${COL.address}","${board.contractor}","${COL.visit}","${COL.status}","${COL.desc}","${COL.jobtype}","${COL.evidence}","${COL.invoice}"]) {
      id text value ... on StatusValue { label_style { color } }
    }`;
}
function parseItem(it, board, grp){
  const cv = {}; (it.column_values||[]).forEach(c => cv[c.id]=c);
  const contractor = cv[board.contractor];
  let contractorIds = []; try { contractorIds = (JSON.parse(contractor?.value||'{}').ids)||[]; } catch(e){}
  let visit = null; try { const v=JSON.parse(cv[COL.visit]?.value||'null');
    if(v&&v.date){ if(v.time){ const loc=mondayToLocal(v.date,v.time); visit=loc.date+' '+loc.time; } else visit=v.date; } } catch(e){}
  let evidenceIds = []; try { evidenceIds=(JSON.parse(cv[COL.evidence]?.value||'{}').files||[]).map(f=>String(f.assetId)); } catch(e){}
  let invoiceIds = []; try { invoiceIds=(JSON.parse(cv[COL.invoice]?.value||'{}').files||[]).map(f=>String(f.assetId)); } catch(e){}
  const g = grp || it.group || {};
  const out = {
    id: it.id, boardId: board.id, board: board.name,
    groupId: g.id, groupTitle: g.title, groupColor: g.color,
    name: it.name,
    address: cv[COL.address]?.text || '',
    jobType: cv[COL.jobtype]?.text || '',
    contractorLabel: contractor?.text || '',
    contractorIds,
    visit,
    status: cv[COL.status]?.text || '',
    statusColor: cv[COL.status]?.label_style?.color || '#c4c4c4',
    description: cv[COL.desc]?.text || '',
    photoCount: evidenceIds.length
  };
  if (it.assets){
    const mk=a=>({ id:a.id, name:a.name, url:a.public_url, isImage: IMG.test(a.name||'') || IMG.test(a.public_url||'') });
    out.photos   = it.assets.filter(a=>evidenceIds.includes(String(a.id))).map(mk);
    out.invoices = it.assets.filter(a=>invoiceIds.includes(String(a.id))).map(mk);
  }
  if (it.updates){
    out.notesLog = it.updates.map(u=>({ text:u.text_body||'', at:u.created_at, by:(u.creator&&u.creator.name)||'' }))
      .filter(n=>n.text.trim());
  }
  return out;
}

/* ---------- API ---------- */
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

// sign up — creates a pending account
app.post('/api/signup', async (req,res)=>{
  try{
    const { name, email, password } = req.body || {};
    const e = norm(email);
    if(!name || !e || !password) return res.status(400).json({error:'Name, email and password are required'});
    if(!/^\S+@\S+\.\S+$/.test(e)) return res.status(400).json({error:'Enter a valid email address'});
    if(String(password).length < 6) return res.status(400).json({error:'Password must be at least 6 characters'});
    if(e === BOOTSTRAP_ADMIN.email) return res.status(409).json({error:'That email is reserved'});
    const users = await getBoardUsers();
    if(users.find(u=>u.email===e)) return res.status(409).json({error:'An account with that email already exists'});
    const hash = bcrypt.hashSync(String(password), 10);
    await createBoardUser(String(name).trim(), e, hash);
    res.json({ ok:true, status:'pending' });
  }catch(err){ res.status(500).json({error:err.message}); }
});

// log in — returns a token if approved
app.post('/api/login', async (req,res)=>{
  try{
    const { email, password } = req.body || {};
    const e = norm(email);
    if(!e || !password) return res.status(400).json({error:'Email and password are required'});
    if(e === BOOTSTRAP_ADMIN.email && String(password) === BOOTSTRAP_ADMIN.password){
      const me = { role:'admin', name:BOOTSTRAP_ADMIN.name, email:e, exp:Date.now()+7*DAY };
      return res.json({ ...me, approved:true, token:signToken(me) });
    }
    const users = await getBoardUsers();
    const u = users.find(x=>x.email===e);
    if(!u || !u.hash || !bcrypt.compareSync(String(password), u.hash))
      return res.status(401).json({error:'Wrong email or password'});
    if((u.role||'pending')==='pending') return res.json({ approved:false, name:u.name });
    const me = { role:u.role, name:u.name, email:e, contractorLabel:u.contractor, allowance:u.allowance||0, exp:Date.now()+7*DAY };
    res.json({ ...me, approved:true, token:signToken(me) });
  }catch(err){ res.status(500).json({error:err.message}); }
});

// admin: list accounts
app.get('/api/users', requireAuth, requireAdmin, async (req,res)=>{
  try{
    const users = await getBoardUsers();
    res.json(users.map(u=>({ id:u.id, name:u.name, email:u.email, role:u.role, contractor:u.contractor, allowance:u.allowance })));
  }catch(err){ res.status(500).json({error:err.message}); }
});
// admin: approve / set role + contractor + holiday allowance
app.post('/api/users/:id', requireAuth, requireAdmin, async (req,res)=>{
  try{
    const { role, contractor, allowance } = req.body || {};
    const allowed = ['pending','operative','admin'];
    const fields = {};
    if(role!==undefined){ if(!allowed.includes(role)) return res.status(400).json({error:'Bad role'}); fields.role=role; }
    if(contractor!==undefined) fields.contractor=String(contractor);
    if(allowance!==undefined) fields.allowance=allowance;
    await updateBoardUser(req.params.id, fields);
    res.json({ ok:true });
  }catch(err){ res.status(500).json({error:err.message}); }
});

// admin: reset someone's password
app.post('/api/users/:id/password', requireAuth, requireAdmin, async (req,res)=>{
  try{
    const { password } = req.body || {};
    if(!password || String(password).length<6) return res.status(400).json({error:'Password must be at least 6 characters'});
    await updateBoardUser(req.params.id, { passHash: bcrypt.hashSync(String(password),10) });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({error:e.message}); }
});
// anyone: change your own password
app.post('/api/me/password', requireAuth, async (req,res)=>{
  try{
    const { currentPassword, newPassword } = req.body || {};
    if(!newPassword || String(newPassword).length<6) return res.status(400).json({error:'New password must be at least 6 characters'});
    if(req.me.email === BOOTSTRAP_ADMIN.email) return res.status(400).json({error:'The master admin password is set in the server file (server.js), not here.'});
    const users = await getBoardUsers();
    const u = users.find(x=>x.email===norm(req.me.email));
    if(!u) return res.status(404).json({error:'Account not found'});
    if(!u.hash || !bcrypt.compareSync(String(currentPassword||''), u.hash)) return res.status(401).json({error:'Your current password is wrong'});
    await updateBoardUser(u.id, { passHash: bcrypt.hashSync(String(newPassword),10) });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({error:e.message}); }
});

/* ---------- holidays ---------- */
async function getHolidays(){
  const d = await gql(
    `query($b:[ID!]){ boards(ids:$b){ items_page(limit:500){ items{ id name column_values(ids:["${HCOL.email}","${HCOL.start}","${HCOL.end}","${HCOL.days}","${HCOL.status}","${HCOL.notes}"]){ id text value } } } } }`,
    { b:[HOLIDAY_BOARD_ID] });
  const dval = v => { try{ const o=JSON.parse(v||'null'); return o&&o.date?o.date:''; }catch(e){ return ''; } };
  return (d.boards[0].items_page.items||[]).map(it=>{
    const c={}; it.column_values.forEach(x=>c[x.id]=x);
    return { id:it.id, name:it.name, email:norm(c[HCOL.email]?.text),
      start:dval(c[HCOL.start]?.value), end:dval(c[HCOL.end]?.value),
      days:Number(c[HCOL.days]?.text||0), status:(c[HCOL.status]?.text||'Pending'), notes:c[HCOL.notes]?.text||'' };
  });
}
app.get('/api/holidays', requireAuth, async (req,res)=>{
  try{
    const all = await getHolidays();
    const yr = String(new Date().getFullYear());
    const usedFor = email => all.filter(h=>h.email===norm(email) && h.status.toLowerCase()==='approved' && (h.start||'').startsWith(yr))
                                .reduce((n,h)=>n+(h.days||0),0);
    if(req.me.role==='admin'){
      const users = await getBoardUsers();
      const people = users.filter(u=>Number(u.allowance)>0).map(u=>{
        const used=usedFor(u.email); return { id:u.id, name:u.name, email:u.email, allowance:u.allowance, used, remaining:u.allowance-used };
      });
      return res.json({ role:'admin', requests: all.sort((a,b)=>(b.start||'').localeCompare(a.start||'')), people });
    }
    const mine = all.filter(h=>h.email===norm(req.me.email)).sort((a,b)=>(b.start||'').localeCompare(a.start||''));
    const allowance = Number(req.me.allowance||0), used = usedFor(req.me.email);
    res.json({ role:'employee', allowance, used, remaining:allowance-used, requests:mine });
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/holidays', requireAuth, async (req,res)=>{
  try{
    const { start, end, notes } = req.body || {};
    if(!start || !end) return res.status(400).json({error:'Start and end dates are required'});
    const days = workingDays(start, end);
    if(days < 1) return res.status(400).json({error:'That range has no working days'});
    const vals = { [HCOL.email]:req.me.email, [HCOL.start]:{date:start}, [HCOL.end]:{date:end}, [HCOL.days]:days, [HCOL.status]:'Pending', [HCOL.notes]:notes||'' };
    await gql(`mutation($b:ID!,$n:String!,$v:JSON!){ create_item(board_id:$b,item_name:$n,column_values:$v){ id } }`,
      { b:HOLIDAY_BOARD_ID, n:(req.me.name||req.me.email), v:JSON.stringify(vals) });
    res.json({ ok:true, days });
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/holidays/:id/decision', requireAuth, requireAdmin, async (req,res)=>{
  try{
    const map = { approved:'Approved', declined:'Declined', pending:'Pending' };
    const s = map[String(req.body.status||'').toLowerCase()];
    if(!s) return res.status(400).json({error:'Bad status'});
    await gql(`mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$v){ id } }`,
      { b:HOLIDAY_BOARD_ID, i:req.params.id, v:JSON.stringify({ [HCOL.status]:s }) });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.delete('/api/holidays/:id', requireAuth, async (req,res)=>{
  try{
    if(req.me.role!=='admin'){
      const all = await getHolidays(); const h = all.find(x=>x.id===String(req.params.id));
      if(!h || h.email!==norm(req.me.email)) return res.status(403).json({error:'Not your request'});
      if(h.status.toLowerCase()!=='pending') return res.status(400).json({error:'Only pending requests can be cancelled'});
    }
    await gql(`mutation($i:ID!){ delete_item(item_id:$i){ id } }`, { i:req.params.id });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// manual calendar entries
app.get('/api/events', requireAuth, async (req,res)=>{
  try{
    let events = await getEvents();
    events = events.filter(e=>e.date);
    if(req.me.role==='operative') events = events.filter(e=>norm(e.contractor)===norm(req.me.contractorLabel));
    res.json(events);
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/events', requireAuth, requireAdmin, async (req,res)=>{
  try{
    const { title, date, time, contractor, notes } = req.body || {};
    if(!title || !date) return res.status(400).json({error:'Title and date are required'});
    const vals = {
      [ECOL.when]: localToMonday(date, time),
      [ECOL.contractor]: contractor || '',
      [ECOL.notes]: notes || ''
    };
    await gql(`mutation($b:ID!,$n:String!,$v:JSON!){ create_item(board_id:$b,item_name:$n,column_values:$v){ id } }`,
      { b:EVENT_BOARD_ID, n:String(title), v:JSON.stringify(vals) });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.put('/api/events/:id', requireAuth, requireAdmin, async (req,res)=>{
  try{
    const { title, date, time, contractor, notes } = req.body || {};
    if(!title || !date) return res.status(400).json({error:'Title and date are required'});
    const vals = {
      name: String(title),
      [ECOL.when]: localToMonday(date, time),
      [ECOL.contractor]: contractor || '',
      [ECOL.notes]: notes || ''
    };
    await gql(`mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$v){ id } }`,
      { b:EVENT_BOARD_ID, i:req.params.id, v:JSON.stringify(vals) });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.delete('/api/events/:id', requireAuth, requireAdmin, async (req,res)=>{
  try{ await gql(`mutation($i:ID!){ delete_item(item_id:$i){ id } }`, { i:req.params.id }); res.json({ ok:true }); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// contractor options per board (admin)
app.get('/api/contractors', requireAuth, requireAdmin, async (req,res)=>{
  try{
    const result = {};
    for(const board of BOARDS){
      const d = await gql(`query($b:[ID!]){ boards(ids:$b){ columns(ids:["${board.contractor}"]){ settings_str } } }`, { b:[board.id] });
      const s = JSON.parse(d.boards[0].columns[0].settings_str || '{}');
      const dead = new Set(s.deactivated_labels || []);
      result[board.id] = (s.labels||[]).filter(l=>!dead.has(l.id)).map(l=>({ id:l.id, label:l.label||l.name }));
    }
    res.json(result);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// grouped jobs from both boards (only the 3 wanted groups)
app.get('/api/jobs', requireAuth, async (req,res)=>{
  try{
    const me = req.me;
    const sections = [];
    for(const board of BOARDS){
      const d = await gql(
        `query($b:[ID!]){ boards(ids:$b){ groups{ id title color items_page(limit:500){ items{ ${itemFields(board,false)} } } } } }`,
        { b:[board.id] });
      const groups = (d.boards[0].groups||[]).filter(g => WANT_GROUPS.includes(g.title));
      groups.sort((a,b)=> WANT_GROUPS.indexOf(a.title) - WANT_GROUPS.indexOf(b.title));
      for(const g of groups){
        let jobs = g.items_page.items.map(it => parseItem(it, board, g));
        if(me.role==='operative') jobs = jobs.filter(j => norm(j.contractorLabel) === norm(me.contractorLabel));
        sections.push({ boardId:board.id, board:board.name, groupId:g.id, title:g.title, color:g.color, jobs });
      }
    }
    res.json({ role: me.role, sections });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// single job with photos
app.get('/api/jobs/:id', requireAuth, async (req,res)=>{
  try{
    const board = BOARDS.find(b=>b.id===String(req.query.board)) || BOARDS[0];
    const d = await gql(`query($id:[ID!]){ items(ids:$id){ ${itemFields(board,true)} } }`, { id:[req.params.id] });
    if(!d.items.length) return res.status(404).json({error:'Not found'});
    const job = parseItem(d.items[0], board);
    if(req.me.role==='operative' && norm(job.contractorLabel)!==norm(req.me.contractorLabel))
      return res.status(403).json({error:'Not your job'});
    res.json(job);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// find a group id by title on a board (group ids differ per board)
async function groupIdByTitle(board, title){
  const d = await gql(`query($b:[ID!]){ boards(ids:$b){ groups{ id title } } }`, { b:[board.id] });
  const g = (d.boards[0].groups||[]).find(x=>x.title===title);
  return g ? g.id : null;
}

// admin: assign contractor + scheduled visit (and move into the Visit Booked section)
app.post('/api/jobs/:id/assign', requireAuth, requireAdmin, async (req,res)=>{
  try{
    const { boardId, contractorId, date, time } = req.body;
    const board = BOARDS.find(b=>b.id===String(boardId)) || BOARDS[0];
    const vals = {};
    if(contractorId) vals[board.contractor] = { ids:[Number(contractorId)] };
    if(date){
      vals[COL.visit]  = localToMonday(date, time);   // local -> UTC for Monday
      vals[COL.status] = { label:'Visit Booked' };    // set Works Status to Visit Booked
    }
    await gql(`mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$v,create_labels_if_missing:true){ id } }`,
      { b:board.id, i:req.params.id, v:JSON.stringify(vals) });
    // scheduling a visit moves the job into the "Visit Booked" group on Monday
    if(date){
      const gid = await groupIdByTitle(board, 'Visit Booked');
      if(gid) await gql(`mutation($i:ID!,$g:String!){ move_item_to_group(item_id:$i, group_id:$g){ id } }`, { i:req.params.id, g:gid });
    }
    res.json({ ok:true });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// admin: remove a job from the calendar (clear the scheduled visit, move back to Outstanding Calls)
app.post('/api/jobs/:id/unschedule', requireAuth, requireAdmin, async (req,res)=>{
  try{
    const board = BOARDS.find(b=>b.id===String(req.body.boardId)) || BOARDS[0];
    await gql(`mutation($b:ID!,$i:ID!){ change_simple_column_values(board_id:$b,item_id:$i,column_id:"${COL.visit}",value:""){ id } }`,
      { b:board.id, i:req.params.id });
    const gid = await groupIdByTitle(board, 'Outstanding Calls');
    if(gid) await gql(`mutation($i:ID!,$g:String!){ move_item_to_group(item_id:$i, group_id:$g){ id } }`, { i:req.params.id, g:gid });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// mark a job complete — sets Works Status to "Done" (admin or assigned operative)
app.post('/api/jobs/:id/complete', requireAuth, async (req,res)=>{
  try{
    const board = BOARDS.find(b=>b.id===String(req.body.boardId)) || BOARDS[0];
    if(req.me.role==='operative'){
      const d = await gql(`query($id:[ID!]){ items(ids:$id){ column_values(ids:["${board.contractor}"]){ text } } }`, { id:[req.params.id] });
      const text = d.items[0]?.column_values[0]?.text || '';
      if(norm(text)!==norm(req.me.contractorLabel)) return res.status(403).json({error:'Not your job'});
    }
    await gql(`mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$v){ id } }`,
      { b:board.id, i:req.params.id, v:JSON.stringify({ [COL.status]:{ label:'Done' } }) });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// check an operative is assigned to a job (for write actions)
async function operativeOwnsJob(me, board, itemId){
  if(me.role!=='operative') return true;
  const d = await gql(`query($id:[ID!]){ items(ids:$id){ column_values(ids:["${board.contractor}"]){ text } } }`, { id:[itemId] });
  const text = d.items[0]?.column_values[0]?.text || '';
  return norm(text)===norm(me.contractorLabel);
}
// upload a file to a given file column (used by photo + invoice)
async function uploadToColumn(itemId, columnId, file){
  const q = `mutation($file:File!){ add_file_to_column(item_id:${Number(itemId)}, column_id:"${columnId}", file:$file){ id } }`;
  const form = new FormData();
  form.append('query', q);
  form.append('map', JSON.stringify({ image:'variables.file' }));
  form.append('image', new Blob([file.buffer], { type:file.mimetype || 'application/octet-stream' }), file.originalname || 'upload');
  const r = await fetch(API + '/file', { method:'POST', headers:{ Authorization: MONDAY_TOKEN }, body: form });
  const j = await r.json();
  if(j.errors) throw new Error(j.errors.map(e=>e.message).join('; '));
  return j.data?.add_file_to_column?.id;
}

// upload a photo to the Evidence column (admin or assigned operative)
app.post('/api/jobs/:id/photo', requireAuth, upload.single('photo'), async (req,res)=>{
  try{
    if(!req.file) return res.status(400).json({error:'No file'});
    const board = BOARDS.find(b=>b.id===String(req.body.boardId)) || BOARDS[0];
    if(!(await operativeOwnsJob(req.me, board, req.params.id))) return res.status(403).json({error:'Not your job'});
    const assetId = await uploadToColumn(req.params.id, COL.evidence, req.file);
    res.json({ ok:true, assetId });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// upload an invoice to the Invoice column (admin or assigned operative)
app.post('/api/jobs/:id/invoice', requireAuth, upload.single('file'), async (req,res)=>{
  try{
    if(!req.file) return res.status(400).json({error:'No file'});
    const board = BOARDS.find(b=>b.id===String(req.body.boardId)) || BOARDS[0];
    if(!(await operativeOwnsJob(req.me, board, req.params.id))) return res.status(403).json({error:'Not your job'});
    const assetId = await uploadToColumn(req.params.id, COL.invoice, req.file);
    res.json({ ok:true, assetId });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// add a note (posted to the job's Updates feed on Monday)
app.post('/api/jobs/:id/note', requireAuth, async (req,res)=>{
  try{
    const { boardId, text } = req.body || {};
    if(!text || !String(text).trim()) return res.status(400).json({error:'Note is empty'});
    const board = BOARDS.find(b=>b.id===String(boardId)) || BOARDS[0];
    if(!(await operativeOwnsJob(req.me, board, req.params.id))) return res.status(403).json({error:'Not your job'});
    await gql(`mutation($i:ID!,$b:String!){ create_update(item_id:$i, body:$b){ id } }`, { i:req.params.id, b:String(text) });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/health', (req,res)=> res.json({ ok:true, version:'3.0-accounts', boards:BOARDS.map(b=>b.name) }));
app.listen(PORT, ()=> console.log(`FieldOps running on :${PORT}`));
