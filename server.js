/* ============================================================
   FieldOps  ›  Monday-synced backend
   - Holds your Monday API token (server-side, never sent to phones)
   - Serves the operative/admin web app
   - Lets admin assign Contractor + Scheduled Visit on a job
   - Lets the assigned operative upload photos to the job's Evidence column
   ============================================================ */
const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits:{ fileSize: 25*1024*1024 } });

/* ---------- config ---------- */
const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
const BOARD_ID     = process.env.BOARD_ID || '1652227316';   // CCH - Maintenance Dashboard
const API          = 'https://api.monday.com/v2';

// Column IDs on the CCH board (from your board setup). Override via env if needed.
const COL = {
  address:   process.env.COL_ADDRESS   || 'dropdown__1',
  contractor:process.env.COL_CONTRACTOR|| 'dropdown_mkwxqwz2',
  visit:     process.env.COL_VISIT     || 'dup__of_date_of_invoice__1', // date + time
  status:    process.env.COL_STATUS    || 'dup__of_payment_status__1',  // Works Status (read-only here)
  desc:      process.env.COL_DESC      || 'long_text__1',
  jobtype:   process.env.COL_JOBTYPE   || 'type__1',
  evidence:  process.env.COL_EVIDENCE  || 'dup__of_files__1',           // Evidence (photo target)
};

if (!MONDAY_TOKEN) { console.error('FATAL: MONDAY_TOKEN env var is not set.'); process.exit(1); }

/* ---------- users ---------- */
// Loaded from users.json (see users.example.json). Hot-reloaded on each request so you
// can add operatives without restarting.
function loadUsers() {
  // Prefer the USERS_JSON env var (best for hosting — no passcodes committed to files).
  if (process.env.USERS_JSON) {
    try { return JSON.parse(process.env.USERS_JSON); }
    catch(e){ console.error('USERS_JSON is not valid JSON:', e.message); }
  }
  try { return JSON.parse(fs.readFileSync(path.join(__dirname,'users.json'),'utf8')); }
  catch(e){ console.error('No users.json and no USERS_JSON env var:', e.message); return { admin:null, operatives:[] }; }
}
function authFromReq(req){
  const code = (req.get('x-passcode') || '').trim();
  if(!code) return null;
  const u = loadUsers();
  if(u.admin && code === u.admin.passcode)
    return { role:'admin', name:u.admin.name || 'Admin' };
  const op = (u.operatives||[]).find(o => o.passcode === code);
  if(op) return { role:'operative', name:op.name, contractorId:op.contractorId, contractorLabel:op.contractorLabel };
  return null;
}
function requireAuth(req,res,next){
  const me = authFromReq(req);
  if(!me) return res.status(401).json({error:'Invalid passcode'});
  req.me = me; next();
}
function requireAdmin(req,res,next){
  if(req.me.role !== 'admin') return res.status(403).json({error:'Admin only'});
  next();
}

/* ---------- Monday helpers ---------- */
async function gql(query, variables){
  const r = await fetch(API, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization: MONDAY_TOKEN, 'API-Version':'2024-10' },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if(j.errors) throw new Error(j.errors.map(e=>e.message).join('; '));
  return j.data;
}

// Parse Monday's column_values into a flat, friendly job object
function parseItem(it){
  const cv = {}; (it.column_values||[]).forEach(c => cv[c.id] = c);
  const contractor = cv[COL.contractor];
  let contractorIds = [];
  try { contractorIds = (JSON.parse(contractor?.value || '{}').ids) || []; } catch(e){}
  let visit = null;
  try { const v = JSON.parse(cv[COL.visit]?.value || 'null'); if(v) visit = v.date + (v.time?(' '+v.time):''); } catch(e){}
  // Evidence asset ids on this job
  let evidenceIds = [];
  try { evidenceIds = (JSON.parse(cv[COL.evidence]?.value || '{}').files||[]).map(f=>String(f.assetId)); } catch(e){}
  const photos = (it.assets||[]).filter(a => evidenceIds.includes(String(a.id)))
                                .map(a => ({ id:a.id, name:a.name, url:a.public_url }));
  return {
    id: it.id,
    name: it.name,
    address: cv[COL.address]?.text || '',
    contractorLabel: contractor?.text || '',
    contractorIds,
    visit,
    status: cv[COL.status]?.text || '',
    jobType: cv[COL.jobtype]?.text || '',
    description: cv[COL.desc]?.text || '',
    photos
  };
}

const ITEM_FIELDS = `
  id name
  assets { id name public_url }
  column_values(ids:["${COL.address}","${COL.contractor}","${COL.visit}","${COL.status}","${COL.desc}","${COL.jobtype}","${COL.evidence}"]) {
    id text value
  }`;

/* ---------- API ---------- */
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

// login: validate passcode, return role + display info
app.post('/api/login', (req,res)=>{
  const me = authFromReq({ get:(h)=> h==='x-passcode' ? (req.body && req.body.passcode) : '' });
  if(!me) return res.status(401).json({error:'Invalid passcode'});
  res.json(me);
});

// contractor options (for admin assign dropdown) — read live from the board
app.get('/api/contractors', requireAuth, requireAdmin, async (req,res)=>{
  try{
    const d = await gql(`query($b:[ID!]){ boards(ids:$b){ columns(ids:["${COL.contractor}"]){ settings_str } } }`, { b:[BOARD_ID] });
    const settings = JSON.parse(d.boards[0].columns[0].settings_str || '{}');
    const labels = (settings.labels||[]).filter(l=>!l.is_deactivated).map(l=>({ id:l.id, label:l.label }));
    res.json(labels);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// list jobs — admin: all (paged); operative: only jobs assigned to their contractor
app.get('/api/jobs', requireAuth, async (req,res)=>{
  try{
    const me = req.me;
    let items = [], cursor = null, pages = 0;
    do {
      const d = await gql(
        `query($b:ID!,$cursor:String){ boards(ids:[$b]){ items_page(limit:100, cursor:$cursor){ cursor items{ ${ITEM_FIELDS} } } } }`,
        { b: BOARD_ID, cursor }
      );
      const page = d.boards[0].items_page;
      items = items.concat(page.items.map(parseItem));
      cursor = page.cursor; pages++;
    } while(cursor && pages < 30);   // safety cap (~3000 jobs)

    if(me.role === 'operative'){
      items = items.filter(j => j.contractorIds.map(String).includes(String(me.contractorId)));
    }
    res.json({ jobs: items, role: me.role });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// one job (refresh)
app.get('/api/jobs/:id', requireAuth, async (req,res)=>{
  try{
    const d = await gql(`query($id:[ID!]){ items(ids:$id){ ${ITEM_FIELDS} } }`, { id:[req.params.id] });
    if(!d.items.length) return res.status(404).json({error:'Not found'});
    const job = parseItem(d.items[0]);
    if(req.me.role==='operative' && !job.contractorIds.map(String).includes(String(req.me.contractorId)))
      return res.status(403).json({error:'Not your job'});
    res.json(job);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// admin: assign contractor + scheduled visit (date + time)
app.post('/api/jobs/:id/assign', requireAuth, requireAdmin, async (req,res)=>{
  try{
    const { contractorId, date, time } = req.body; // date "YYYY-MM-DD", time "HH:MM"
    const vals = {};
    if(contractorId) vals[COL.contractor] = { ids:[Number(contractorId)] };
    if(date)         vals[COL.visit]      = { date, time: (time? (time.length===5? time+':00':time) : '09:00:00') };
    await gql(
      `mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$v){ id } }`,
      { b:BOARD_ID, i:req.params.id, v: JSON.stringify(vals) }
    );
    res.json({ ok:true });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// upload a photo to the Evidence column of a job (admin or the assigned operative)
app.post('/api/jobs/:id/photo', requireAuth, upload.single('photo'), async (req,res)=>{
  try{
    if(!req.file) return res.status(400).json({error:'No file'});
    // operatives may only upload to their own jobs
    if(req.me.role==='operative'){
      const d = await gql(`query($id:[ID!]){ items(ids:$id){ column_values(ids:["${COL.contractor}"]){ value } } }`, { id:[req.params.id] });
      let ids=[]; try{ ids=(JSON.parse(d.items[0].column_values[0].value||'{}').ids)||[]; }catch(e){}
      if(!ids.map(String).includes(String(req.me.contractorId))) return res.status(403).json({error:'Not your job'});
    }
    // GraphQL multipart upload (Monday /file endpoint)
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

app.get('/api/health', (req,res)=> res.json({ ok:true, board:BOARD_ID }));

app.listen(PORT, ()=> console.log(`FieldOps running on :${PORT} (board ${BOARD_ID})`));
