const G = JSON.parse(document.getElementById('graph-data').textContent);
const IMG = JSON.parse(document.getElementById('img-data').textContent);

const NW = 208, COLW = 296, ROWH = 112, IMGH = 117;
const HEIGHT = { screen: 176, email: 176, system: 46, decision: 46, outcome: 46 };
const BAND_PAD_TOP = 104, BAND_PAD_BOTTOM = 46, PADX = 72;
const nh = n => HEIGHT[n.kind] || 46;

/* ---------- layout: stack the journeys as horizontal bands ---------- */
const bands = {};
let yCursor = 0;
for (const j of G.journeys) {
  const rows = Math.max(...j.nodes.map(n=>n.row)) + 1;
  const inner = rows*ROWH + 60;
  bands[j.id] = { top: yCursor, height: BAND_PAD_TOP + inner + BAND_PAD_BOTTOM, contentTop: yCursor + BAND_PAD_TOP };
  yCursor += bands[j.id].height;
}
const WORLD = {
  w: PADX*2 + Math.max(...G.journeys.map(j=>Math.max(...j.nodes.map(n=>n.col))+1))*COLW - (COLW-NW),
  h: yCursor
};
const journeyOf = {}; const nodesById = {};
for (const j of G.journeys) for (const n of j.nodes) { journeyOf[n.id] = j; nodesById[n.id] = n; }
const edgeById = {}; for (const j of G.journeys) for (const e of j.edges) edgeById[e.id] = e;
const pos = n => ({ x: PADX + n.col*COLW, y: bands[journeyOf[n.id].id].contentTop + n.row*ROWH });

/* ---------- state ---------- */
let focusId = G.journeys[0].id;
let selected = null;
let lastPick = {};                 // journeyId -> node id the user clicked
const scenario = {};               // journeyId -> {controlId: value}
for (const j of G.journeys) scenario[j.id] = Object.fromEntries(j.controls.map(c=>[c.id, c.options[0].value]));

const matches = (e, s) => !e.when || Object.entries(e.when).every(([k,vals]) => vals.includes(s[k]));
function walk(j, s){
  const seq = [j.start], edges = [], nodes = new Set([j.start]);
  let cur = j.start, guard = 0;
  while (guard++ < 80) {
    const e = j.edges.find(x=>x.from===cur && matches(x,s)); if (!e) break;
    edges.push(e.id); nodes.add(e.to); seq.push(e.to); cur = e.to;
    if (nodesById[cur].terminal) break;
  }
  return { seq, edges:new Set(edges), nodes, end: cur };
}
const pathOf = j => walk(j, scenario[j.id]);

function combos(j){
  let out = [{}];
  for (const c of j.controls) { const next=[]; for (const p of out) for (const o of c.options) next.push({...p,[c.id]:o.value}); out = next; }
  return out;
}
/* pick the scenario closest to the current one that runs through this node or edge */
function activateThrough(j, nodeId, edgeId){
  const cur = scenario[j.id];
  let best = null, bestCost = 1e9;
  for (const s of combos(j)) {
    const w = walk(j, s);
    const hit = edgeId ? w.edges.has(edgeId) : w.nodes.has(nodeId);
    if (!hit) continue;
    const cost = j.controls.reduce((a,c)=>a + (s[c.id]===cur[c.id] ? 0 : 1), 0);
    if (cost < bestCost) { best = s; bestCost = cost; if (!cost) break; }
  }
  if (best) { scenario[j.id] = best; return true; }
  return false;
}

/* ---------- helpers ---------- */
const svgNS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs={}, ...kids) => { const n = document.createElementNS(svgNS, tag); for (const [k,v] of Object.entries(attrs)) n.setAttribute(k, v); for (const k of kids) n.append(k); return n; };
const h = (tag, attrs={}, ...kids) => { const n = document.createElement(tag); for (const [k,v] of Object.entries(attrs)) { if (k==='on') for (const [ev,fn] of Object.entries(v)) n.addEventListener(ev,fn); else if (k==='html') n.innerHTML=v; else n.setAttribute(k,v);} for (const k of kids) n.append(k); return n; };
const imgFor = n => (n.imgBy && n.imgBy[scenario[journeyOf[n.id].id][n.imgByControl||'product']]) || n.img;
const kindWord = n => n.kind==='email' ? 'Email' : n.kind==='screen' ? 'Page' : n.kind==='system' ? 'Behind the scenes' : n.kind==='decision' ? 'Choice' : 'Ending';

function edgePath(e){
  const a = nodesById[e.from], b = nodesById[e.to], pa = pos(a), pb = pos(b);
  const ax = pa.x + NW, ay = pa.y + nh(a)/2, bx = pb.x, by = pb.y + nh(b)/2;
  if (bx >= ax - 4) { const dx = Math.max(40,(bx-ax)/2); return `M${ax},${ay} C${ax+dx},${ay} ${bx-dx},${by} ${bx},${by}`; }
  const sy = pa.y + nh(a), ty = pb.y + nh(b), mid = Math.max(sy,ty) + 38;
  return `M${pa.x+NW/2},${sy} C${pa.x+NW/2},${mid} ${pb.x+NW/2},${mid} ${pb.x+NW/2},${ty}`;
}
function edgeMid(e){
  const a = nodesById[e.from], b = nodesById[e.to], pa = pos(a), pb = pos(b);
  if (pb.x >= pa.x + NW - 4) return { x:(pa.x+NW+pb.x)/2, y:(pa.y+nh(a)/2 + pb.y+nh(b)/2)/2 - 8 };
  return { x:(pa.x+pb.x+NW)/2, y: Math.max(pa.y+nh(a), pb.y+nh(b)) + 30 };
}

/* ---------- render ---------- */
const canvas = document.getElementById('canvas');
const svg = el('svg',{class:'graph',id:'svg'});
canvas.append(svg);
const view = { x:-20, y:-10, w:0, h:0 };

function buildStatic(){
  const defs = el('defs');
  for (const [id,cls] of [['arr','arrow-base'],['arr-a','arrow-active']]) {
    const m = el('marker',{id,class:cls,viewBox:'0 0 10 10',refX:'9',refY:'5',markerWidth:'7',markerHeight:'7',orient:'auto-start-reverse'});
    m.append(el('path',{d:'M0,0 L10,5 L0,10 z'})); defs.append(m);
  }
  const clip = el('clipPath',{id:'imgclip'}); clip.append(el('rect',{x:0,y:0,width:NW-2,height:IMGH,rx:7})); defs.append(clip);
  svg.append(defs);

  const gBands = el('g'), gE = el('g'), gL = el('g'), gN = el('g');
  G.journeys.forEach((j,i)=>{
    const b = bands[j.id];
    gBands.append(el("rect",{class:"band",id:'band-'+j.id,x:-4000,y:b.top,width:WORLD.w+8000,height:b.height}));
    gBands.append(el('line',{class:'band-line',x1:-4000,y1:b.top,x2:WORLD.w+8000,y2:b.top}));
    // A thick accent bar beside the title marks the journey in focus, so the
    // white band reads as "the one you are looking at" rather than a style.
    gBands.append(el('rect',{class:'band-mark',id:'mark-'+j.id,x:PADX-24,y:b.top+14,width:9,height:48,rx:3}));
    const t = el('text',{class:'band-title',id:'title-'+j.id,x:PADX,y:b.top+34},j.label);
    const s = el('text',{class:'band-sub',x:PADX,y:b.top+52},j.sub);
    gBands.append(t,s);
    j.columns.forEach((c,ci)=>{ if(c) gBands.append(el('text',{class:'col-label',x:PADX + ci*COLW,y:b.contentTop-12},c)); });

    for (const e of j.edges) {
      const d = edgePath(e);
      gE.append(el('path',{class:'edge',id:'e-'+e.id,d,'marker-end':'url(#arr)'}));
      const hit = el('path',{class:'edge-hit',d,id:'eh-'+e.id}); hit.dataset.edge = e.id; gE.append(hit);
      if (e.label) { const m = edgeMid(e); gL.append(el('text',{class:'edge-label',id:'el-'+e.id,x:m.x,y:m.y,'text-anchor':'middle'},e.label)); }
    }
    for (const n of j.nodes) {
      const p = pos(n), H = nh(n);
      const g = el('g',{class:'node '+n.kind+(n.outcome?' outcome-'+n.outcome:''),id:'n-'+n.id,transform:`translate(${p.x},${p.y})`,tabindex:'0'});
      g.dataset.node = n.id;
      g.append(el('rect',{class:'box',width:NW,height:H}));
      if ((n.kind==='screen'||n.kind==='email') && IMG[imgFor(n)]) {
        const gi = el('g',{transform:'translate(1,1)','clip-path':'url(#imgclip)'});
        const im = el('image',{id:'img-'+n.id,width:NW-2,height:IMGH,preserveAspectRatio:'xMidYMin slice'});
        im.setAttribute('href',IMG[imgFor(n)]); gi.append(im); g.append(gi);
        g.append(el('rect',{class:'frame',x:1,y:1,width:NW-2,height:IMGH,rx:7}));
        g.append(el('text',{class:'cap',x:12,y:IMGH+22}, n.kind==='email' ? '✉ Email' : (n.outcome ? 'Ends here' : 'Page')));
        g.append(el('text',{class:'ttl',x:12,y:IMGH+42},n.label));
        if (n.outcome) g.append(el('circle',{cx:NW-16,cy:IMGH+18,r:5,fill:`var(--${n.outcome})`}));
      } else {
        g.append(el('text',{class:'ttl',x:NW/2,y:H/2+4,'text-anchor':'middle'},n.label));
      }
      gN.append(g);
    }
  });
  svg.append(gBands,gE,gL,gN);
}

function applyView(){ svg.setAttribute('viewBox',`${view.x} ${view.y} ${view.w} ${view.h}`); }
function resize(keepScale){
  const r = canvas.getBoundingClientRect();
  svg.setAttribute('width',r.width); svg.setAttribute('height',r.height);
  if (!view.w) { const s = Math.min(r.width/(WORLD.w*0.5), 1); view.w = r.width/s; view.h = r.height/s; }
  else { const s = r.width/view.w; view.h = r.height/s; }
  applyView();
}
function zoomAt(cx, cy, factor){
  const r = canvas.getBoundingClientRect();
  const px = (cx-r.left)/r.width, py = (cy-r.top)/r.height;
  const wx = view.x + px*view.w, wy = view.y + py*view.h;
  const scale = r.width/view.w, next = Math.min(2.2, Math.max(0.18, scale*factor));
  view.w = r.width/next; view.h = r.height/next;
  view.x = wx - px*view.w; view.y = wy - py*view.h;
  applyView(); syncZoomInput();
}
function syncZoomInput(){ const r = canvas.getBoundingClientRect(); document.getElementById('zoom').value = (r.width/view.w).toFixed(2); }
function focusBand(id, hard){
  const b = bands[id], r = canvas.getBoundingClientRect();
  const scale = Math.min(r.height/(b.height+40), r.width/(WORLD.w*0.62), 1.1);
  view.w = r.width/scale; view.h = r.height/scale;
  view.y = b.top - 12;
  if (hard) view.x = -20;
  applyView(); syncZoomInput();
}
function centerOn(nodeId){
  const n = nodesById[nodeId], p = pos(n), H = nh(n), pad = 48;
  const l = view.x + pad, r = view.x + view.w - pad, t = view.y + pad, b = view.y + view.h - pad;
  if (p.x < l) view.x -= (l - p.x); else if (p.x + NW > r) view.x += (p.x + NW - r);
  if (p.y < t) view.y -= (t - p.y); else if (p.y + H > b) view.y += (p.y + H - b);
  applyView();
}

/* ---------- highlight ---------- */
function highlight(){
  for (const j of G.journeys) {
    const {nodes, edges} = pathOf(j);
    for (const pre of ['band-','mark-','title-']) document.getElementById(pre+j.id).classList.toggle('focused', j.id===focusId);
    for (const n of j.nodes) {
      const g = document.getElementById('n-'+n.id);
      g.classList.toggle('active', nodes.has(n.id));
      g.classList.toggle('dim', !nodes.has(n.id));
      g.classList.toggle('selected', !!(selected && selected.type==='node' && selected.id===n.id));
      const im = document.getElementById('img-'+n.id); if (im && IMG[imgFor(n)]) im.setAttribute('href',IMG[imgFor(n)]);
    }
    for (const e of j.edges) {
      const p = document.getElementById('e-'+e.id), l = document.getElementById('el-'+e.id), on = edges.has(e.id);
      p.classList.toggle('active',on); p.classList.toggle('dim',!on); p.setAttribute('marker-end',on?'url(#arr-a)':'url(#arr)');
      if (on) p.parentNode.append(p, document.getElementById('eh-'+e.id));
      if (l) { l.classList.toggle('active',on); l.classList.toggle('dim',!on); }
    }
  }
  renderControls();
  renderScenarioPane();
}

/* ---------- side panel ---------- */
const paneS = document.getElementById('pane-scenario'), paneD = document.getElementById('pane-detail');
function showTab(which){
  document.getElementById('t-scenario').setAttribute('aria-selected', which==='scenario');
  document.getElementById('t-detail').setAttribute('aria-selected', which==='detail');
  paneS.style.display = which==='scenario' ? 'contents' : 'none';
  paneD.style.display = which==='detail' ? 'contents' : 'none';
}
document.getElementById('t-scenario').onclick = ()=>showTab('scenario');
document.getElementById('t-detail').onclick = ()=>{ if(!selected) pick(G.journeys.find(j=>j.id===focusId).start); showTab('detail'); };

function shotEl(key, cls){
  return h('div',{class:'shot '+(cls||''),role:'button',tabindex:'0',title:'Click to enlarge',
    on:{click:()=>lightbox(key), keydown:e=>{ if(e.key==='Enter'||e.key===' '){e.preventDefault();lightbox(key);} }}},
    h('img',{src:IMG[key],alt:''}), h('span',{class:'zoomhint'},'⤢'));
}
function renderScenarioPane(){
  const j = G.journeys.find(x=>x.id===focusId);
  const {seq} = pathOf(j);
  const endNode = nodesById[seq[seq.length-1]];
  const steps = h('div',{class:'steps'});
  seq.forEach((id,idx)=>{
    const n = nodesById[id];
    const e = idx ? j.edges.find(x=>x.from===seq[idx-1] && x.to===id) : null;
    const body = h('div',{},
      h('div',{}, h('button',{class:'steplink',on:{click:()=>pick(n.id)}}, n.label), e&&e.label ? h('span',{class:'via'},' · '+e.label) : ''),
      h('div',{class:'d'}, n.kind==='system' ? n.behind : n.sees));
    if (IMG[imgFor(n)]) body.append(shotEl(imgFor(n),'mini'));
    steps.append(h('div',{class:'step'}, h('span',{class:'n'}), body));
  });
  const title = j.controls.map(c=>c.options.find(o=>o.value===scenario[j.id][c.id]).label).join(' · ');
  paneS.replaceChildren(
    h('div',{class:'side-head'}, h('div',{class:'eyebrow'}, h('span',{class:'chip'},j.label)), h('h2',{},title)),
    h('div',{class:'side-body'},
      h('div',{class:'outcome-card '+(endNode.outcome||'ok')}, h('b',{},endNode.label), endNode.sees||endNode.behind||''),
      h('div',{class:'sec'}, h('h3',{},`${seq.length} steps`), steps))
  );
}
function detailPane(item){
  const isNode = item.type==='node';
  const n = isNode ? nodesById[item.id] : null;
  const j = journeyOf[isNode ? item.id : item.from];
  const head = h('div',{class:'side-head'},
    h('div',{class:'eyebrow'}, h('span',{class:'chip'+(n&&n.outcome?' '+n.outcome:'')}, isNode?kindWord(n):'Step'), h('span',{class:'chip ghost'},j.label)),
    h('h2',{}, isNode ? n.label : `${nodesById[item.from].label} → ${nodesById[item.to].label}`));
  const body = h('div',{class:'side-body'});
  if (isNode) {
    const shots = n.imgs || (n.img ? [imgFor(n)] : []);
    if (shots.length) {
      body.append(shotEl(imgFor(n),'big'));
      if (shots.length>1) {
        const g = h('div',{class:'shots'});
        shots.forEach(k=>g.append(shotEl(k)));
        body.append(h('div',{class:'sec'},h('h3',{},'Related screens'),g));
      }
    }
    if (n.sees) body.append(h('div',{class:'sec'},h('h3',{},'What the person sees'),h('p',{},n.sees)));
    if (n.behind) body.append(h('div',{class:'sec'},h('h3',{},'What happens behind the scenes'),h('p',{},n.behind)));
    if (n.gap) body.append(h('div',{class:'outcome-card warn'},h('b',{},'Worth knowing'),n.gap));
    const outs = j.edges.filter(e=>e.from===n.id);
    if (outs.length) {
      const b = h('div',{class:'branches'});
      for (const e of outs) b.append(h('button',{class:'branch',on:{click:()=>pick(e.to,e.id)}}, h('span',{class:'to'},nodesById[e.to].label), h('span',{class:'lbl'},e.label||'')));
      body.append(h('div',{class:'sec'},h('h3',{},outs.length>1?'What can happen next':'What happens next'),b));
    }
    const ins = j.edges.filter(e=>e.to===n.id);
    if (ins.length) {
      const b = h('div',{class:'branches'});
      for (const e of ins) b.append(h('button',{class:'branch',on:{click:()=>pick(e.from,e.id)}}, h('span',{class:'to'},nodesById[e.from].label), h('span',{class:'lbl'},e.label||'')));
      body.append(h('div',{class:'sec'},h('h3',{},'Comes from'),b));
    }
    if (n.dev && n.dev.length) { const ul = h('ul'); n.dev.forEach(x=>ul.append(h('li',{},x))); body.append(h('details',{class:'dev'},h('summary',{},'For developers: where this lives in the code'),ul)); }
  } else {
    const e = edgeById[item.id];
    body.append(h('p',{}, `From “${nodesById[item.from].label}” to “${nodesById[item.to].label}”` + (e.label?` — ${e.label}.`:'.')));
    if (e.note) body.append(h('p',{},e.note));
    const b = h('div',{class:'branches'});
    b.append(h('button',{class:'branch',on:{click:()=>pick(item.to)}}, h('span',{class:'to'},nodesById[item.to].label), h('span',{class:'lbl'},'open')));
    body.append(b);
  }
  paneD.replaceChildren(head, body);
}

/* ---------- picking (click activates the path) ---------- */
function pick(nodeId, viaEdge){
  const j = journeyOf[nodeId];
  focusId = j.id; lastPick[j.id] = nodeId;
  activateThrough(j, nodeId, viaEdge);
  selected = {type:'node', id:nodeId};
  detailPane(selected); showTab('detail'); highlight(); centerOn(nodeId);
}
function pickEdge(edgeId){
  const e = edgeById[edgeId], j = journeyOf[e.from];
  focusId = j.id; activateThrough(j, null, edgeId);
  selected = {type:'edge', id:edgeId, from:e.from, to:e.to};
  detailPane(selected); showTab('detail'); highlight();
}

/* ---------- controls ---------- */
const ctl = document.getElementById('controls');
function renderControls(){
  const j = G.journeys.find(x=>x.id===focusId);
  if (ctl.dataset.j === j.id) {
    j.controls.forEach(c=>{ const s = document.getElementById('c-'+c.id); if (s) s.value = scenario[j.id][c.id]; });
    return;
  }
  ctl.dataset.j = j.id; ctl.replaceChildren();
  for (const c of j.controls) {
    const s = h('select',{id:'c-'+c.id});
    c.options.forEach(o=>s.append(h('option',{value:o.value},o.label)));
    s.value = scenario[j.id][c.id];
    s.addEventListener('change',()=>{ scenario[j.id][c.id]=s.value; selected=null; highlight(); showTab('scenario'); });
    ctl.append(h('div',{class:'ctl'},h('label',{for:'c-'+c.id},c.label),s));
  }
}
const bandBar = document.getElementById('bands');
G.journeys.forEach(j=>{
  bandBar.append(h('button',{class:'bandbtn',id:'bb-'+j.id,on:{click:()=>{ focusId=j.id; selected=null; focusBand(j.id,true); highlight(); showTab('scenario'); updateBandBtns(); }}}, j.short||j.label));
});
function updateBandBtns(){ G.journeys.forEach(j=>document.getElementById('bb-'+j.id).setAttribute('aria-pressed', j.id===focusId)); }

/* ---------- lightbox ---------- */
const lb = document.getElementById('lightbox');
function lightbox(key){
  lb.replaceChildren(
    h('div',{class:'lb-inner'}, h('img',{src:IMG[key],alt:''})),
    h('button',{class:'lb-close',title:'Close (Esc)',on:{click:closeLb}},'✕'));
  lb.hidden = false; document.body.style.overflow='hidden';
}
function closeLb(){ lb.hidden = true; document.body.style.overflow=''; }
lb.addEventListener('click', e=>{ if (e.target===lb || e.target.classList.contains('lb-inner')) closeLb(); });
addEventListener('keydown', e=>{ if (e.key==='Escape' && !lb.hidden) closeLb(); });

/* ---------- pan, zoom, click ---------- */
let drag = null;
/* The pointer is captured while dragging so a fast drag keeps panning, which
   also means pointerup is reported on the canvas rather than on whatever is
   under the cursor. So remember what was pressed on the way down. */
const hitOf = t => t && (t.closest('[data-node]') || t.closest('[data-edge]'));
canvas.addEventListener('pointerdown', e=>{
  if (e.button!==0) return;
  drag = { x:e.clientX, y:e.clientY, vx:view.x, vy:view.y, moved:0, hit:hitOf(e.target) };
  canvas.setPointerCapture(e.pointerId); canvas.classList.add('grabbing');
});
canvas.addEventListener('pointermove', e=>{
  if (!drag) return;
  const r = canvas.getBoundingClientRect(), s = r.width/view.w;
  const dx = e.clientX-drag.x, dy = e.clientY-drag.y;
  drag.moved = Math.max(drag.moved, Math.abs(dx)+Math.abs(dy));
  view.x = drag.vx - dx/s; view.y = drag.vy - dy/s; applyView();
});
function endDrag(e){
  if (!drag) return;
  const d = drag; drag = null;
  try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  canvas.classList.remove('grabbing');
  if (d.moved > 5) return;                       // a drag, not a click
  // Fall back to whatever sits under the cursor, in case the press landed on a gap.
  const t = d.hit || hitOf(document.elementFromPoint(e.clientX, e.clientY));
  if (!t) return;
  if (t.dataset.node) pick(t.dataset.node); else if (t.dataset.edge) pickEdge(t.dataset.edge);
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', e=>{ drag = null; canvas.classList.remove('grabbing'); });
canvas.addEventListener('wheel', e=>{ e.preventDefault(); zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1/1.12); }, {passive:false});
canvas.addEventListener('keydown', e=>{
  const t = e.target.closest('[data-node]');
  if (t && (e.key==='Enter'||e.key===' ')) { e.preventDefault(); pick(t.dataset.node); }
});
document.getElementById('zoom').addEventListener('input', e=>{
  const r = canvas.getBoundingClientRect(), target = +e.target.value, scale = r.width/view.w;
  zoomAt(r.left + r.width/2, r.top + r.height/2, target/scale);
});
document.getElementById('fit').addEventListener('click', ()=>focusBand(focusId,true));
addEventListener('resize', ()=>resize(true));

/* ---------- go ---------- */
buildStatic(); resize(); focusBand(focusId,true); updateBandBtns(); highlight(); showTab('scenario');
