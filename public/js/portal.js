// Stakeholder portal: agents, masters, stevedores, owners and charterers working on invited voyages.
(function(){
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const E=window.Engine,St=window.Statement;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const money=(v,c)=>`${esc(c||'USD')} ${Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
let me=null,panel=null,state=null,active=0;

function show(v){['viewList','viewAccount','viewVoyage'].forEach(x=>$(x).hidden=x!==v);$('navList').classList.toggle('on',v!=='viewAccount');$('navAccount').classList.toggle('on',v==='viewAccount')}

async function boot(){
  try{({user:me}=await Api.get('/api/auth/me'))}catch(e){return}
  // Organisation users come here only to open one voyage (when their role has no rates and amounts).
  const staff=me.role!=='external';
  if(staff&&!(location.hash||'').startsWith('#/voyage/')){location.replace('/');return}
  if(staff){$('navList').href='/#/voyages';$('navAccount').href='/#/account'}
  $('who').textContent=`${me.name||me.loginId} · ${me.loginId}`;
  $('acctInfo').innerHTML=`<dt>Login ID</dt><dd>${esc(me.loginId)}</dd><dt>Name</dt><dd>${esc(me.name||'–')}</dd>`;
  Api.contacts($('acctContacts'),me);
  $('pwCurRow').hidden=me.signedInWith==='otp';
  $('pwBanner').hidden=!(me.mustChangePassword&&me.signedInWith!=='otp');
  route();
}
window.addEventListener('hashchange',route);
function route(){
  if(me&&me.mustChangePassword&&me.signedInWith!=='otp'&&location.hash!=='#/account'){location.hash='#/account';return}
  const h=location.hash||'#/';
  if(panel&&!h.startsWith('#/voyage/')){panel.stop();panel=null}
  if(h.startsWith('#/voyage/')&&UUID.test(h.slice(9)))return openVoyage(h.slice(9));
  if(h==='#/account')return show('viewAccount');
  return showList();
}
$('btnLogout').onclick=async()=>{await Api.post('/api/auth/logout');location.href='/login.html'};
$('btnBackList').onclick=()=>{if(me&&me.role!=='external')location.href='/#/voyages';else location.hash='#/'};
$('btnPortalExcel').onclick=()=>{const id=(location.hash.match(/^#\/voyage\/(.+)$/)||[])[1];if(id&&UUID.test(id))Api.download(`/api/v/${id}/export.xlsx`,'laytime.xlsx').catch(()=>{})};

async function showList(){
  show('viewList');
  const {voyages}=await Api.get('/api/invites/mine');
  const T=$('pList');
  if(!voyages.length){T.innerHTML='<tbody><tr><td class="empty">You have not been added to any voyage yet. Open the invitation link you were sent.</td></tr></tbody>';return}
  T.innerHTML='<thead><tr><th>Vessel</th><th>Operator</th><th>Your role</th><th>Ports</th><th>SOF</th><th class="r">Result</th></tr></thead><tbody>'+voyages.map(v=>{
    const s=v.summary;const res=!s?'':!s.complete?'<span class="warn">In progress</span>':s.net>0.005?`<span class="pill pd">DEM</span> ${money(s.net,s.currency)}`:s.net<-0.005?`<span class="pill pok">DES</span> ${money(s.net,s.currency)}`:'–';
    return `<tr data-id="${v.id}"><td><strong>${esc(v.vessel||'Untitled voyage')}</strong></td><td>${esc(v.operator)}</td><td>${esc(v.party)}</td><td>${v.ports.map(p=>esc(p.name||'?')).join(' → ')}</td>
      <td>${v.open?`<span class="st st-open">${v.open} open</span> `:''}${v.disputed?`<span class="st st-disputed">${v.disputed} disputed</span>`:''}${!v.open&&!v.disputed?'<span class="hint">up to date</span>':''}</td><td class="m r">${res}</td></tr>`}).join('')+'</tbody>';
  T.querySelectorAll('tr[data-id]').forEach(tr=>tr.onclick=()=>{location.hash='#/voyage/'+tr.dataset.id});
}

async function openVoyage(id){
  show('viewVoyage');
  if(panel)panel.stop();
  active=0;
  panel=SofPanel.create($('pSof'),{voyageId:id,portId:()=>state?state.voyage.data.ports[active].id:null,onData:s=>{state=s;renderVoyage()}});
  try{await panel.load()}catch(e){location.hash='#/';return}
}

function renderVoyage(){
  const s=state,d=s.voyage.data;
  if(active>=d.ports.length)active=0;
  $('vTitle').textContent=d.vessel||'Voyage';
  $('vSub').textContent=[`Operator: ${s.voyage.operator}`,`You: ${s.access.partyLabel}`,d.cargo].filter(Boolean).join('  ·  ');
  $('pTabs').innerHTML=d.ports.map((p,i)=>`<button type="button" role="tab" class="tab${i===active?' on':''}" data-tab="${i}" aria-selected="${i===active}"><span class="tn">${String(i+1).padStart(2,'0')}</span><span>${esc(p.name||'Port')}</span><span class="top">${p.op==='Loading'?'LP':'DP'}</span></button>`).join('');
  $('pTabs').querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{active=+b.dataset.tab;renderVoyage();panel.render()});
  const M=Sof.applyEvents(d,s.events,{now:Sof.nowLocal(d.ports[active].tz)});
  const mp=M.ports[active];
  $('pMilestones').innerHTML=Codes.MILESTONES.map(m=>`<div><dt>${esc(m.label)}</dt><dd>${mp[m.field]?E.fmtDT(E.parseDT(mp[m.field])):'–'}</dd></div>`).join('');
  // commercial parties also see the calculation
  if(!s.access.commercial){$('pResult').hidden=true;$('pStmtPanel').hidden=true;return}
  $('pResult').hidden=false;$('pStmtPanel').hidden=false;
  let Mv=M,live=null;
  const P=s.access.perms||{};
  $('btnPortalExcel').hidden=!(P.export&&s.access.commercial);
  if(!mp.completed&&P.forecast){const f=Sof.forecast(M,active);if(f&&!f.errs){live=f;Mv=JSON.parse(JSON.stringify(M));Mv.ports[active].completed=f.now}}
  const R=E.computeVoyage(Mv),r=R.res[active],cur=d.currency||'USD';
  if(r.errs.length){$('pResult').innerHTML=`<h2>Result</h2>${r.errs.map(e=>`<div class="err">${esc(e)}</div>`).join('')}`;$('pStmt').innerHTML='';return}
  const lbl=live?(live.expiry!==null&&E.parseDT(live.now)>=live.expiry?['dem','On demurrage now',money(r.demAmt,cur)]:['even','Laytime running',`${E.fmtDur(r.portAllowed-r.used)} left`])
    :r.demAmt>0?['dem','Demurrage due to owners',money(r.demAmt,cur)]:r.desAmt>0?['des','Despatch due to charterers',money(r.desAmt,cur)]:['even','No demurrage or despatch',money(0,cur)];
  $('pResult').innerHTML=`<h2>Result · ${esc(mp.name||'')}</h2><div class="verdict ${lbl[0]}"><span class="lbl">${lbl[1]}</span><span class="amt">${lbl[2]}</span>
    <span class="det">${live&&live.expiry!==null?`laytime expires ${E.fmtDT(live.expiry)}`:''}${live&&live.etc?` · at ETC: ${live.etc.dem>0?'demurrage '+money(live.etc.demAmt,cur):'despatch '+money(live.etc.desAmt,cur)}`:''}</span></div>
    <dl class="kv"><dt>Time allowed</dt><dd>${E.fmtLong(r.portAllowed)}</dd><dt>Time used${live?' so far':''}</dt><dd>${E.fmtLong(r.used)}</dd>${r.dem>0?`<dt>On demurrage</dt><dd>${E.fmtLong(r.dem)}</dd>`:''}
    ${Sof.disputedCount(s.events)?`<dt>Disputed events</dt><dd class="bad">${Sof.disputedCount(s.events)}</dd>`:''}</dl>`;
  const L=St.portLines(Mv,R,active);
  $('pStmt').innerHTML=`<thead><tr>${St.COLS.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${L.rows.map(x=>`<tr${/^Laytime (expired|already)/.test(x[8])?' class="expiry"':''}>${x.map((c,i)=>`<td class="${i<8?'m':''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
}

$('pwForm').addEventListener('submit',async e=>{
  e.preventDefault();const m=$('pwMsg');
  try{await Api.post('/api/auth/password',{current:$('pwCur').value,next:$('pwNew').value});m.textContent='Password changed.';m.className='msg ok';e.target.reset();if(me.mustChangePassword){me.mustChangePassword=false;$('pwBanner').hidden=true;location.hash='#/'}}
  catch(err){m.textContent=err.message;m.className='msg bad'}
});

boot();
})();
