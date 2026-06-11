/* ============================================================
   FieldOps  ›  Monday-synced backend (multi-board, grouped)
   - Pulls jobs from BOTH maintenance boards (CCH + Private)
   - Only the Outstanding Calls / Visit Booked / Works in Progress groups
   - Admin assigns Contractor + Scheduled Visit; operatives add photos to Evidence
   - Your Monday token stays on the server.
   ============================================================ */
const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits:{ fileSize: 25*1024*1024 } });

const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
const API = 'https://api.monday.com/v2';
if (!MONDAY_TOKEN) { console.error('FATAL: MONDAY_TOKEN env var is not set.'); process.exit(1); }

// The two boards. Only the Contractor column id differs between them.
const BOARDS = [
  { id: process.env.CCH_BOARD_ID     || '1652227316', name: 'CCH',     contractor: process.env.CCH_CONTRACTOR     || 'dropdown_mkwxqwz2' },
  { id: process.env.PRIVATE_BOARD_ID || '1733859650', name: 'Private', contractor: process.env.PRIVATE_CONTRACTOR || 'dropdown_mkznxc22' },
];
// Shared column ids (identical on both boards)
const COL = { address:'dropdown__1', visit:'dup__of_date_of_invoice__1', status:'dup__of_payment_status__1',
              desc:'long_text__1', jobtype:'type__1', evidence:'dup__of_files__1' };
// Only these groups (matched by title, since ids differ across boards)
const WANT_GROUPS = ['Outstanding Calls','Visit Booked','Works in Progress'];

const IMG = /\.(jpe?g|png|gif|webp|heic|heif|bmp)(\?|$)/i;

/* ---------- users ---------- */
function loadUsers() {
  if (process.env.USERS_JSON) {
    try { return JSON.parse(process.env.USERS_JSON); }
    catch(e){ console.error('USERS_JSON is not valid JSON:', e.message); }
  }
  try { return JSON.parse(fs.readFileSync(path.join(__dirname,'users.json'),'utf8')); }
  catch(e){ console.error('No users.json and no USERS_JSON env var:', e.message); return { admin:null, operatives:[] }; }
}
const norm = s => (s||'').trim().toLowerCase();
function authFromReq(req){
  const code = (req.get('x-passcode') || '').trim();
  if(!code) return null;
  const u = loadUsers();
  if(u.admin && code === u.admin.passcode) return { role:'admin', name:u.admin.name || 'Admin' };
  const op = (u.operatives||[]).find(o => o.passcode === code);
  if(op) return { role:'operative', name:op.name, contractorLabel:op.contractorLabel, contractorId:op.contractorId };
  return null;
}
function requireAuth(req,res,next){ const me=authFromReq(req); if(!me) return res.status(401).json({error:'Invalid passcode'}); req.me=me; next(); }
function requireAdmin(req,res,next){ if(req.me.role!=='admin') return res.status(403).json({error:'Admin only'}); next(); }

/* ---------- Monday ---------- */
async function gql(query, variables){
  const r = await fetch(API, { method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization: MONDAY_TOKEN, 'API-Version':'2024-10' },
    body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if(j.errors) throw new Error(j.errors.map(e=>e.message).join('; '));
  return j.data;
}
function itemFields(board, withAssets){
  return `id name
    ${withAssets ? 'assets { id name public_url }' : ''}
    group { id title color }
    column_values(ids:["${COL.address}","${board.contractor}","${COL.visit}","${COL.status}","${COL.desc}","${COL.jobtype}","${COL.evidence}"]) {
      id text value ... on StatusValue { label_style { color } }
    }`;
}
function parseItem(it, board, grp){
  const cv = {}; (it.column_values||[]).forEach(c => cv[c.id]=c);
  const contractor = cv[board.contractor];
  let contractorIds = []; try { contractorIds = (JSON.parse(contractor?.value||'{}').ids)||[]; } catch(e){}
  let visit = null; try { const v=JSON.parse(cv[COL.visit]?.value||'null'); if(v) visit=v.date+(v.time?(' '+v.time.slice(0,5)):''); } catch(e){}
  let evidenceIds = []; try { evidenceIds=(JSON.parse(cv[COL.evidence]?.value||'{}').files||[]).map(f=>String(f.assetId)); } catch(e){}
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
    out.photos = it.assets.filter(a=>evidenceIds.includes(String(a.id)))
      .map(a=>({ id:a.id, name:a.name, url:a.public_url, isImage: IMG.test(a.name||'') || IMG.test(a.public_url||'') }));
  }
  return out;
}

/* ---------- API ---------- */
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

app.post('/api/login', (req,res)=>{
  const me = authFromReq({ get:(h)=> h==='x-passcode' ? (req.body && req.body.passcode) : '' });
  if(!me) return res.status(401).json({error:'Invalid passcode'});
  res.json(me);
});

// contractor options per board (admin assign dropdown)
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
      // keep wanted order
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

// admin: assign contractor + scheduled visit
app.post('/api/jobs/:id/assign', requireAuth, requireAdmin, async (req,res)=>{
  try{
    const { boardId, contractorId, date, time } = req.body;
    const board = BOARDS.find(b=>b.id===String(boardId)) || BOARDS[0];
    const vals = {};
    if(contractorId) vals[board.contractor] = { ids:[Number(contractorId)] };
    if(date)         vals[COL.visit]        = { date, time: (time? (time.length===5? time+':00':time) : '09:00:00') };
    await gql(`mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$v){ id } }`,
      { b:board.id, i:req.params.id, v:JSON.stringify(vals) });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// upload a photo to the Evidence column (admin or assigned operative)
app.post('/api/jobs/:id/photo', requireAuth, upload.single('photo'), async (req,res)=>{
  try{
    if(!req.file) return res.status(400).json({error:'No file'});
    const board = BOARDS.find(b=>b.id===String(req.body.boardId)) || BOARDS[0];
    if(req.me.role==='operative'){
      const d = await gql(`query($id:[ID!]){ items(ids:$id){ column_values(ids:["${board.contractor}"]){ text } } }`, { id:[req.params.id] });
      const text = d.items[0]?.column_values[0]?.text || '';
      if(norm(text)!==norm(req.me.contractorLabel)) return res.status(403).json({error:'Not your job'});
    }
    const q = `mutation($file:File!){ add_file_to_column(item_id:${Number(req.params.id)}, column_id:"${COL.evidence}", file:$file){ id } }`;
    const form = new FormData();
    form.append('query', q);
    form.append('map', JSON.stringify({ image:'variables.file' }));
    form.append('image', new Blob([req.file.buffer], { type:req.file.mimetype || 'image/jpeg' }), req.file.originalname || 'photo.jpg');
    const r = await fetch(API + '/file', { method:'POST', headers:{ Authorization: MONDAY_TOKEN }, body: form });
    const j = await r.json();
    if(j.errors) throw new Error(j.errors.map(e=>e.message).join('; '));
    res.json({ ok:true, assetId: j.data?.add_file_to_column?.id });
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/health', (req,res)=> res.json({ ok:true, boards:BOARDS.map(b=>b.name) }));
app.listen(PORT, ()=> console.log(`FieldOps running on :${PORT}`));
