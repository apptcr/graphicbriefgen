/* Cloud sync client — เชื่อมหน้าเว็บกับ Google Apps Script (Code.gs)
   - ไม่ตั้งค่า = ทำงานแบบเดิม (เก็บในเครื่อง)
   - ตั้งค่าแล้ว = บันทึกลง Google Sheets โดยมีคิวสำรองในเครื่อง เน็ตหลุดก็ไม่เสียข้อมูล แล้วส่งใหม่อัตโนมัติ */
(() => {
'use strict';
const CFG = 'gfx_cloud', QUEUE = 'gfx_queue', SEED = 'gfx_seed';
const rj = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } };
const cfg = () => { const c = rj(CFG, null); return c && c.url && c.token ? c : null; };
const pad = n => String(n).padStart(2, '0');

// ---- รับค่าตั้งค่าจากลิงก์ (#cfg=...) แล้วลบออกจาก URL ----
(function fromHash() {
 if (!location.hash.startsWith('#cfg=')) return;
 try {
  const c = JSON.parse(decodeURIComponent(location.hash.slice(5)));
  if (c && /^https:\/\/script\.google\.com\//.test(c.u) && c.t) {
   localStorage.setItem(CFG, JSON.stringify({ url: c.u, token: c.t }));
   localStorage.removeItem(SEED);
  }
 } catch {}
 history.replaceState(null, '', location.pathname + location.search);
})();

// ---- สถานะ + ป้ายสถานะ ----
let state = 'idle', errMsg = '', lastOk = null;
const configListeners = [];
const pending = () => rj(QUEUE, []);
const COLORS = { local: '#94a3b8', idle: '#93c5fd', syncing: '#60a5fa', ok: '#34d399', error: '#f87171' };

function setState(s, msg) {
 state = s; errMsg = msg || '';
 if (s === 'ok') lastOk = new Date();
 paint();
}
function paint() {
 const b = document.getElementById('cloud-status');
 if (!b) return;
 const on = !!cfg();
 const n = pending().length;
 let key = on ? state : 'local', text;
 if (!on) text = 'โหมดในเครื่อง · เชื่อม Google Sheets';
 else if (key === 'syncing') text = 'กำลังซิงก์…';
 else if (key === 'ok') text = `Google Sheets · ซิงก์ ${pad(lastOk.getHours())}:${pad(lastOk.getMinutes())}` + (n ? ` · รอส่ง ${n}` : '');
 else if (key === 'error') text = `ซิงก์ไม่สำเร็จ${n ? ` · รอส่ง ${n} รายการ` : ''}`;
 else text = 'Google Sheets · รอซิงก์';
 b.innerHTML = `<i style="--c:${COLORS[key]}" class="${key === 'syncing' ? 'cl-pulse' : ''}"></i><span></span>`;
 b.lastChild.textContent = text;
 b.title = key === 'error' ? errMsg : 'ตั้งค่าการเชื่อมต่อ Google Sheets';
}

// ---- คิวคำสั่ง (outbox) ----
function enqueue(op) {
 const q = pending();
 q.push({ oid: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), ...op });
 localStorage.setItem(QUEUE, JSON.stringify(q));
 paint();
}
// นำคำสั่งที่ยังไม่ได้ส่งมาทับบนรายการจากเซิร์ฟเวอร์ เพื่อให้การแก้ไขที่ค้างอยู่ไม่หายจากหน้าจอ
function overlay(tasks) {
 const q = pending();
 if (!q.length) return tasks;
 const m = new Map(tasks.map(t => [t.id, t]));
 for (const o of q) {
  if (o.type === 'upsert' && o.task) m.set(o.task.id, o.task);
  else if (o.type === 'delete') m.delete(o.id);
 }
 return [...m.values()];
}

async function post(body) {
 const c = cfg();
 const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 25000);
 try {
  // ไม่ตั้ง Content-Type เอง = text/plain จึงไม่เกิด CORS preflight ซึ่ง Apps Script ไม่รองรับ
  const res = await fetch(c.url, { method: 'POST', body: JSON.stringify({ token: c.token, ...body }), signal: ctl.signal });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  let j;
  try { j = await res.json(); } catch { throw new Error('ตอบกลับไม่ใช่ JSON — ตรวจว่า URL ลงท้าย /exec และ Deploy ตั้งเป็น Anyone'); }
  if (!j.ok) throw new Error(j.error || 'เซิร์ฟเวอร์แจ้งข้อผิดพลาด');
  return j;
 } catch (e) {
  if (e.name === 'AbortError') throw new Error('หมดเวลาเชื่อมต่อ');
  if (e instanceof TypeError) throw new Error('เชื่อมต่อไม่ได้ — ตรวจอินเทอร์เน็ต และตรวจว่า Deploy ตั้ง Who has access เป็น Anyone');
  throw e;
 } finally { clearTimeout(to); }
}

let inflight = null, rerun = false;
async function once() {
 const sent = pending().slice(0, 500);
 setState('syncing');
 try {
  const r = await post({ action: 'sync', ops: sent });
  const done = new Set(sent.map(o => o.oid));
  localStorage.setItem(QUEUE, JSON.stringify(pending().filter(o => !done.has(o.oid))));
  setState('ok');
  return r.tasks;
 } catch (e) { setState('error', e.message); return null; }
}
/** ส่งคิวที่ค้างและดึงรายการล่าสุด — คืน array ของงาน หรือ null ถ้าล้มเหลว/ไม่ได้เชื่อมต่อ */
function sync() {
 if (!cfg()) return Promise.resolve(null);
 if (inflight) { rerun = true; return inflight; }
 inflight = (async () => {
  let res = null;
  try { do { rerun = false; res = await once(); } while (rerun); }
  finally { inflight = null; }
  return res;
 })();
 return inflight;
}

// ---- หน้าต่างตั้งค่า ----
const CSS = `
.cloud-pill{display:inline-flex;align-items:center;gap:.4rem;font-family:inherit;font-weight:600;font-size:.75rem;line-height:1;color:#e0e7ff;background:#ffffff1f;border:1px solid #ffffff33;border-radius:9999px;padding:.4rem .65rem;cursor:pointer;max-width:18rem;white-space:nowrap}
.cloud-pill span{overflow:hidden;text-overflow:ellipsis}
.cloud-pill:hover{background:#ffffff33}
.cloud-pill i{width:.5rem;height:.5rem;border-radius:50%;background:var(--c);flex:none}
.cl-pulse{animation:clp 1s infinite}@keyframes clp{50%{opacity:.3}}
.cl-ov{position:fixed;inset:0;background:#0f172a80;z-index:100;display:none;align-items:center;justify-content:center;padding:1rem;font-family:'Sarabun','Noto Sans Thai',Tahoma,sans-serif}
.cl-ov.open{display:flex}
.cl-box{background:#fff;color:#1e293b;border-radius:1rem;width:100%;max-width:30rem;box-shadow:0 20px 25px #0004;overflow:hidden}
.cl-h{background:#4338ca;color:#fff;padding:1rem 1.5rem;font-weight:700}
.cl-b{padding:1.5rem;display:grid;gap:.875rem;font-size:.875rem}
.cl-b label{font-weight:600;color:#475569;display:block}
.cl-b input{display:block;width:100%;margin-top:.25rem;font:inherit;border:1px solid #cbd5e1;border-radius:.5rem;padding:.5rem .75rem;font-weight:400}
.cl-b input:focus{outline:0;box-shadow:0 0 0 2px #6366f1;border-color:transparent}
.cl-b p{margin:0;font-size:.75rem;color:#64748b}
.cl-msg{min-height:1.25rem;font-size:.8125rem;font-weight:600}
.cl-msg.err{color:#dc2626}.cl-msg.ok{color:#059669}
.cl-f{display:flex;flex-wrap:wrap;gap:.5rem;justify-content:flex-end;padding-top:.75rem;border-top:1px solid #e2e8f0}
.cl-f button{font:inherit;font-weight:600;padding:.5rem .875rem;border-radius:.5rem;border:1px solid #cbd5e1;background:#fff;color:#475569;cursor:pointer}
.cl-f button:hover{background:#f8fafc}
.cl-f .pri{background:#4f46e5;border-color:#4f46e5;color:#fff}.cl-f .pri:hover{background:#4338ca}
.cl-f .dng{color:#dc2626;margin-right:auto}
.cl-f button:disabled{opacity:.6;cursor:wait}`;

let dlg;
function build() {
 if (dlg) return;
 dlg = document.createElement('div');
 dlg.className = 'cl-ov';
 dlg.innerHTML = `<div class="cl-box"><div class="cl-h">เชื่อมต่อ Google Sheets</div><div class="cl-b">
  <label>Web app URL (ลงท้ายด้วย /exec)<input id="cl-url" placeholder="https://script.google.com/macros/s/.../exec" autocomplete="off"></label>
  <label>รหัสผ่านทีม (TOKEN ที่ตั้งใน Code.gs)<input id="cl-token" type="password" autocomplete="off"></label>
  <p>ค่าเหล่านี้เก็บในเบราว์เซอร์เครื่องนี้เท่านั้น ไม่ถูกบันทึกลงใน GitHub</p>
  <div class="cl-msg" id="cl-msg"></div>
  <div class="cl-f">
   <button type="button" class="dng" id="cl-off">ตัดการเชื่อมต่อ</button>
   <button type="button" id="cl-link">คัดลอกลิงก์ให้เพื่อนร่วมทีม</button>
   <button type="button" id="cl-x">ปิด</button>
   <button type="button" class="pri" id="cl-ok">ทดสอบและบันทึก</button>
  </div></div></div>`;
 document.body.appendChild(dlg);
 const $ = id => dlg.querySelector('#' + id);
 const msg = (t, c) => { $('cl-msg').textContent = t; $('cl-msg').className = 'cl-msg ' + (c || ''); };
 const close = () => dlg.classList.remove('open');
 dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
 document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
 $('cl-x').onclick = close;

 $('cl-ok').onclick = async () => {
  const url = $('cl-url').value.trim(), token = $('cl-token').value.trim();
  if (!/^https:\/\/script\.google\.com\/.+/.test(url)) return msg('URL ต้องขึ้นต้นด้วย https://script.google.com/', 'err');
  if (!token) return msg('กรุณากรอกรหัสผ่านทีม', 'err');
  const prev = cfg();
  $('cl-ok').disabled = true; msg('กำลังทดสอบการเชื่อมต่อ…');
  localStorage.setItem(CFG, JSON.stringify({ url, token }));
  try {
   const r = await post({ action: 'sync', ops: [] });
   if (!prev || prev.url !== url) localStorage.removeItem(SEED);
   msg(`เชื่อมต่อสำเร็จ — พบ ${r.tasks.length} งานใน Sheets`, 'ok');
   setState('idle'); configListeners.forEach(f => f());
   setTimeout(close, 900);
  } catch (e) {
   prev ? localStorage.setItem(CFG, JSON.stringify(prev)) : localStorage.removeItem(CFG);
   msg(e.message, 'err');
  } finally { $('cl-ok').disabled = false; }
 };
 $('cl-off').onclick = () => {
  if (!cfg()) return msg('ยังไม่ได้เชื่อมต่อ');
  if (!confirm('ตัดการเชื่อมต่อ Google Sheets?\n(ข้อมูลใน Sheets ไม่ถูกลบ งานที่ยังไม่ได้ส่งในคิวจะถูกล้าง)')) return;
  localStorage.removeItem(CFG); localStorage.removeItem(QUEUE); localStorage.removeItem(SEED);
  setState('idle'); configListeners.forEach(f => f()); close();
 };
 $('cl-link').onclick = async () => {
  const c = cfg();
  if (!c) return msg('ต้องเชื่อมต่อให้สำเร็จก่อน', 'err');
  const link = location.origin + location.pathname + '#cfg=' + encodeURIComponent(JSON.stringify({ u: c.url, t: c.token }));
  try { await navigator.clipboard.writeText(link); msg('คัดลอกแล้ว — ลิงก์นี้มีรหัสผ่านอยู่ ส่งเฉพาะคนในทีม', 'ok'); }
  catch { prompt('คัดลอกลิงก์นี้ (มีรหัสผ่านอยู่ ส่งเฉพาะคนในทีม)', link); }
 };
}
function openSettings() {
 build();
 const c = cfg();
 dlg.querySelector('#cl-url').value = c ? c.url : '';
 dlg.querySelector('#cl-token').value = c ? c.token : '';
 dlg.querySelector('#cl-msg').textContent = '';
 dlg.classList.add('open');
}

// ---- เริ่มต้น ----
(function init() {
 const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
 const b = document.getElementById('cloud-status');
 if (b) { b.className = 'cloud-pill'; b.onclick = openSettings; }
 paint();
 window.addEventListener('online', () => { if (cfg() && pending().length) sync(); });
})();

window.Cloud = {
 configured: () => !!cfg(),
 config: cfg,
 enqueue, pending, overlay, sync, openSettings,
 onConfigChange: f => configListeners.push(f)
};
})();
