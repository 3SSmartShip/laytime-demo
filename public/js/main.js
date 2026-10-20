// App shell: session, organisation picker, routing, voyage list, admin and account screens.
(function(){
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const money=(v,c)=>`${esc(c||'USD')} ${Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const when=s=>s?new Date(s).toLocaleString([], {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'–';
let me=null,tenants=[];
const can=k=>!!(me&&me.perms&&me.perms[k]);
const isSuper=()=>me&&me.role==='superadmin';

function show(view){['viewList','viewEditor','viewAdmin','viewAccount'].forEach(v=>$(v).hidden=v!==view);
  $('navVoyages').classList.toggle('on',view==='viewList'||view==='viewEditor');$('navAdmin').classList.toggle('on',view==='viewAdmin');$('navAccount').classList.toggle('on',view==='viewAccount')}
function msg(el,text,ok){el.textContent=text;el.className='msg '+(ok?'ok':'bad')}
function arm(btn,label,fn){
  if(!btn.dataset.arm){btn.dataset.arm='1';const old=btn.textContent;btn.textContent=label;setTimeout(()=>{if(btn.dataset.arm){delete btn.dataset.arm;btn.textContent=old}},3000);return}
  delete btn.dataset.arm;fn();
}

// ---------- session ----------
async function boot(){
  try{({user:me}=await Api.get('/api/auth/me'))}catch(e){return}
  if(me.role==='external'){location.replace('/portal.html');return}
  $('who').textContent=`${me.name||me.loginId} · ${me.loginId}`;
  drawAccount();
  const forced=me.mustChangePassword&&me.signedInWith!=='otp';
  $('pwBanner').hidden=!forced;
  $('navAdmin').hidden=!(isSuper()||can('users')||can('audit'));
  const editing=can('voyages_edit');
  $('btnNewVoyage').hidden=!editing;$('btnNewSample').hidden=!editing;
  if(forced){$('orgName').textContent=me.tenantName||'';location.hash='#/account';route();return}
  if(isSuper()){
    const r=await Api.get('/api/admin/tenants');tenants=r.tenants;
    const pick=$('tenantPick');pick.hidden=false;
    pick.innerHTML='<option value="">Choose organisation…</option>'+tenants.map(t=>`<option value="${t.id}">${esc(t.name)}${t.active?'':' (disabled)'}</option>`).join('');
    if(Api.getTenant()&&tenants.some(t=>t.id===Api.getTenant()))pick.value=Api.getTenant();else Api.setTenant(null);
    $('orgName').textContent='Platform admin';
  }else{$('orgName').textContent=me.tenantName||'';Api.setTenant(null)}
  route();
}
$('tenantPick').addEventListener('change',async e=>{
  if(Editor.isDirty())await Editor.flush();
  Api.setTenant(e.target.value);
  if(location.hash==='#/admin'){loadUsers();loadAudit();return}
  location.hash='#/voyages';route();
});
$('btnLogout').onclick=async()=>{try{await Editor.flush()}catch(e){}await Api.post('/api/auth/logout');location.href='/login.html'};

// ---------- routing ----------
window.addEventListener('hashchange',route);
async function route(){
  if(me&&me.mustChangePassword&&me.signedInWith!=='otp'&&location.hash!=='#/account'){location.hash='#/account';return}
  const h=location.hash||'#/voyages';
  if(!h.startsWith('#/voyage/'))Editor.stop();
  if(h.startsWith('#/voyage/'))return openVoyage(h.slice(9));
  if(h==='#/admin')return showAdmin();
  if(h==='#/account')return show('viewAccount');
  return showList();
}
const needTenant=()=>isSuper()&&!Api.getTenant();

// ---------- list ----------
let searchTimer=null;
$('listSearch').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(loadList,250)});
async function showList(){show('viewList');loadList()}
async function loadList(){
  const T=$('listTable');$('listMsg').textContent='';
  if(needTenant()){T.innerHTML='<tbody><tr><td class="empty">Choose an organisation at the top to see its voyages.</td></tr></tbody>';return}
  try{
    const q=$('listSearch').value.trim();
    const {voyages}=await Api.get('/api/voyages'+(q?`?q=${encodeURIComponent(q)}`:''));
    if(!voyages.length){T.innerHTML=`<tbody><tr><td class="empty">${q?'No voyages match that search.':can('voyages_edit')?'No voyages yet. Start one with "New voyage", or load the example to see how it works.':'No voyages yet.'}</td></tr></tbody>`;return}
    const amounts=can('amounts'),edit=can('voyages_edit');
    T.innerHTML=`<thead><tr><th>Vessel</th><th>Charterers</th><th>Ports</th><th>Status</th>${amounts?'<th class="r">Result</th>':''}<th>Last saved</th>${edit?'<th></th>':''}</tr></thead><tbody>`+voyages.map(v=>{
      const s=v.summary||{},ports=(s.ports||[]).map(p=>esc(p.name||'?')).join(' → ');
      const res=!s.complete?'<span class="warn">Incomplete</span>':s.net>0.005?`<span class="pill pd">DEM</span> ${money(s.net,s.currency)}`:s.net<-0.005?`<span class="pill pok">DES</span> ${money(s.net,s.currency)}`:'–';
      return `<tr data-id="${v.id}"><td><strong>${esc(v.vessel||'Untitled voyage')}</strong></td><td>${esc(v.charterers||'–')}</td><td>${ports||'–'}</td><td><span class="status ${v.status}">${v.status}</span></td>${amounts?`<td class="m r">${res}</td>`:''}<td class="hint">${when(v.updatedAt)}${v.updatedBy?' · '+esc(v.updatedBy):''}</td>
        ${edit?`<td><div class="row-actions"><button type="button" data-dup="${v.id}">Duplicate</button><button type="button" data-del="${v.id}">Delete</button></div></td>`:''}</tr>`}).join('')+'</tbody>';
    T.querySelectorAll('tr[data-id]').forEach(tr=>tr.onclick=e=>{if(e.target.closest('button'))return;location.hash='#/voyage/'+tr.dataset.id});
    T.querySelectorAll('[data-dup]').forEach(b=>b.onclick=async()=>{try{const {voyage}=await Api.post(`/api/voyages/${b.dataset.dup}/duplicate`);location.hash='#/voyage/'+voyage.id}catch(e){$('listMsg').textContent=e.message}});
    T.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>arm(b,'Confirm delete',async()=>{try{await Api.del(`/api/voyages/${b.dataset.del}`);loadList()}catch(e){$('listMsg').textContent=e.message;b.textContent='Delete'}}));
  }catch(e){$('listMsg').textContent=e.message}
}
async function newVoyage(sample){
  if(needTenant()){$('listMsg').textContent='Choose an organisation first.';return}
  try{const {voyage}=await Api.post('/api/voyages',sample?{sample:true}:{});location.hash='#/voyage/'+voyage.id}catch(e){$('listMsg').textContent=e.message}
}
$('btnNewVoyage').onclick=()=>newVoyage(false);
$('btnNewSample').onclick=()=>newVoyage(true);

// ---------- editor ----------
async function openVoyage(id){
  if(needTenant()){location.hash='#/voyages';return}
  // Without rates and amounts the calculator has nothing to show: open the SOF view instead.
  if(!can('amounts')){location.href='/portal.html#/voyage/'+encodeURIComponent(id);return}
  try{const {voyage}=await Api.get('/api/voyages/'+encodeURIComponent(id));show('viewEditor');Editor.open(voyage,me.perms);window.scrollTo(0,0)}
  catch(e){location.hash='#/voyages';setTimeout(()=>{$('listMsg').textContent=e.message},50)}
}

// ---------- admin ----------
async function showAdmin(){
  if(!(isSuper()||can('users')||can('audit'))){location.hash='#/voyages';return}
  show('viewAdmin');
  $('tenantsPanel').hidden=!isSuper();
  $('permsPanel').hidden=!isSuper();
  $('usersPanel').hidden=!(isSuper()||can('users'));
  $('auditPanel').hidden=!(isSuper()||can('audit'));
  if(isSuper()){loadTenants();loadPerms()}
  if(isSuper()||can('users'))loadUsers();
  if(isSuper()||can('audit'))loadAudit();
}
async function loadTenants(){
  const {tenants:t}=await Api.get('/api/admin/tenants');tenants=t;
  $('tenantTable').innerHTML=`<thead><tr><th>Organisation</th><th class="r">Users</th><th class="r">Voyages</th><th>Status</th><th></th></tr></thead><tbody>`+t.map(x=>`<tr><td>${esc(x.name)}</td><td class="m r">${x.users}</td><td class="m r">${x.voyages}</td><td><span class="status ${x.active?'final':'draft'}">${x.active?'active':'disabled'}</span></td>
    <td><div class="row-actions"><button type="button" data-open="${x.id}">Open</button><button type="button" data-mods="${x.id}">Modules</button><button type="button" data-tog="${x.id}" data-on="${x.active}">${x.active?'Disable':'Enable'}</button></div></td></tr>`).join('')+'</tbody>';
  $('tenantTable').querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>{Api.setTenant(b.dataset.open);$('tenantPick').value=b.dataset.open;loadUsers();loadAudit()});
  $('tenantTable').querySelectorAll('[data-mods]').forEach(b=>b.onclick=()=>{$('permScope').value=b.dataset.mods;loadPerms();$('permsPanel').scrollIntoView({block:'start'})});
  $('tenantTable').querySelectorAll('[data-tog]').forEach(b=>b.onclick=()=>arm(b,'Confirm',async()=>{await Api.patch(`/api/admin/tenants/${b.dataset.tog}`,{active:b.dataset.on!=='true'});loadTenants()}));
  const pick=$('tenantPick'),cur=pick.value;
  pick.innerHTML='<option value="">Choose organisation…</option>'+t.map(x=>`<option value="${x.id}">${esc(x.name)}${x.active?'':' (disabled)'}</option>`).join('');pick.value=cur;
  const ps=$('permScope'),pcur=ps.value;
  ps.innerHTML='<option value="default">Default for all organisations</option>'+t.map(x=>`<option value="${x.id}">${esc(x.name)} only</option>`).join('');
  ps.value=[...ps.options].some(o=>o.value===pcur)?pcur:'default';
}
$('tenantForm').addEventListener('submit',async e=>{
  e.preventDefault();const m=$('tenantMsg');
  try{
    const pw=$('tnAdminPw').value,nm=$('tnAdminName').value.trim();
    const r=await Api.post('/api/admin/tenants',{name:$('tnName').value.trim(),adminName:nm,adminLoginId:$('tnAdminLogin').value.trim(),adminEmail:$('tnAdminEmail').value.trim(),adminPassword:pw});
    const tenant=r.tenant;Api.showCredentials($('tenantCreds'),{title:`First admin of ${tenant.name}`,name:nm,loginId:r.adminLoginId,password:pw});
    msg(m,`Created ${tenant.name}.`,true);e.target.reset();$('tnAdminLogin').dataset.auto='1';$('tnAdminPw').value=Api.tempPassword();loadTenants();
  }catch(err){msg(m,err.message);if(err.body&&err.body.suggestion)$('tnAdminLogin').value=err.body.suggestion}
});

// ---------- roles and modules ----------
let permData=null;
$('permScope').addEventListener('change',loadPerms);
$('permReset').onclick=function(){arm(this,'Confirm reset',async()=>{try{permData=await Api.del(`/api/admin/permissions?scope=${$('permScope').value}`);drawPerms();msg($('permMsg'),'This organisation now follows the defaults.',true)}catch(e){msg($('permMsg'),e.message)}})};
async function loadPerms(){
  try{permData=await Api.get(`/api/admin/permissions?scope=${$('permScope').value}`);drawPerms()}catch(e){msg($('permMsg'),e.message)}
}
function drawPerms(){
  const d=permData,scope=$('permScope').value;
  $('permReset').hidden=scope==='default';
  const groups=[];d.roles.forEach(r=>{const g=groups[groups.length-1];if(g&&g.name===r.group)g.n++;else groups.push({name:r.group,n:1})});
  const label=Object.fromEntries(d.modules.map(m=>[m.key,m.label]));
  $('permTable').innerHTML=`<thead><tr><th class="mod" rowspan="2">Module</th>${groups.map(g=>`<th class="grp" colspan="${g.n}">${esc(g.name)}</th>`).join('')}</tr>
    <tr>${d.roles.map(r=>`<th>${esc(r.label)}</th>`).join('')}</tr></thead><tbody>`+d.modules.map(m=>`<tr><td class="mod"><strong>${esc(m.label)}</strong><span class="hint">${esc(m.desc)}</span></td>`+d.roles.map(r=>{
      const c=d.cells[r.key][m.key];
      if(!c.applies)return '<td class="na" title="Does not apply to this role">–</td>';
      const missing=c.blocked?m.requires.filter(q=>{const x=d.cells[r.key][q];return x&&x.applies&&!x.value}).map(q=>label[q]):[];
      return `<td class="${c.source==='organisation'?'over':''}${c.blocked?' blocked':''}"><input type="checkbox" data-role="${r.key}" data-mod="${m.key}"${c.value?' checked':''} aria-label="${esc(m.label)} for ${esc(r.label)}">${c.blocked?`<span class="why">needs ${esc(missing.join(', ')||'another module')}</span>`:''}</td>`}).join('')+'</tr>').join('')+'</tbody>';
  $('permTable').querySelectorAll('input[data-role]').forEach(cb=>cb.onchange=async()=>{
    const c=d.cells[cb.dataset.role][cb.dataset.mod];
    // For one organisation, choosing the same as the default removes the override.
    const enabled=scope!=='default'&&cb.checked===c.inherited?null:cb.checked;
    try{permData=await Api.put(`/api/admin/permissions?scope=${scope}`,{role:cb.dataset.role,module:cb.dataset.mod,enabled});drawPerms();msg($('permMsg'),'Saved.',true)}
    catch(e){cb.checked=!cb.checked;msg($('permMsg'),e.message)}
  });
}

// ---------- users ----------
let editingUser=null;
async function loadUsers(){
  const T=$('userTable');
  if(needTenant()){T.innerHTML='<tbody><tr><td class="empty">Choose or open an organisation to manage its users.</td></tr></tbody>';$('usersFor').textContent='';$('userForm').hidden=true;return}
  $('userForm').hidden=false;
  $('usersFor').textContent=isSuper()?(tenants.find(t=>t.id===Api.getTenant())||{}).name||'':me.tenantName||'';
  try{
    const {users}=await Api.get('/api/admin/users');
    T.innerHTML=`<thead><tr><th>Name</th><th>Login ID</th><th>Mobile / email</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>`+users.map(u=>{
      const contact=editingUser===u.id?`<div class="stack"><input id="eu-mobile" type="tel" value="${esc(u.mobile||'')}" placeholder="Mobile"><input id="eu-email" type="email" value="${esc(u.email||'')}" placeholder="Email"><div class="row-actions"><button type="button" class="primary" data-savec="${u.id}">Save</button><button type="button" data-cancelc>Cancel</button></div></div>`
        :`${u.mobile?`<div class="m">${esc(u.mobile)}</div>`:''}${u.email?`<div class="hint">${esc(u.email)}</div>`:''}${!u.mobile&&!u.email?'<span class="hint">–</span>':''}`;
      return `<tr><td>${esc(u.name)}</td><td class="m">${esc(u.loginId)}</td><td>${contact}</td>
      <td><select data-role="${u.id}"${u.id===me.id?' disabled':''}><option value="member"${u.role==='member'?' selected':''}>Member</option><option value="admin"${u.role==='admin'?' selected':''}>Admin</option></select></td>
      <td><span class="status ${u.active?'final':'draft'}">${u.active?'active':'disabled'}</span>${u.mustChangePassword?' <span class="hint">temp password</span>':''}</td><td class="hint">${when(u.lastLoginAt)}</td>
      <td><div class="row-actions"><button type="button" data-editc="${u.id}">Edit contact</button><button type="button" data-reset="${u.id}">Reset password</button>${u.id===me.id?'':`<button type="button" data-act="${u.id}" data-on="${u.active}">${u.active?'Disable':'Enable'}</button>`}</div></td></tr>`}).join('')+'</tbody>';
    T.querySelectorAll('[data-role]').forEach(s=>s.onchange=async()=>{try{await Api.patch(`/api/admin/users/${s.dataset.role}`,{role:s.value});msg($('userMsg'),'Role updated.',true)}catch(e){msg($('userMsg'),e.message);loadUsers()}});
    T.querySelectorAll('[data-act]').forEach(b=>b.onclick=()=>arm(b,'Confirm',async()=>{try{await Api.patch(`/api/admin/users/${b.dataset.act}`,{active:b.dataset.on!=='true'});loadUsers()}catch(e){msg($('userMsg'),e.message);loadUsers()}}));
    T.querySelectorAll('[data-editc]').forEach(b=>b.onclick=()=>{editingUser=b.dataset.editc;loadUsers()});
    T.querySelectorAll('[data-cancelc]').forEach(b=>b.onclick=()=>{editingUser=null;loadUsers()});
    T.querySelectorAll('[data-savec]').forEach(b=>b.onclick=async()=>{
      try{await Api.patch(`/api/admin/users/${b.dataset.savec}`,{mobile:$('eu-mobile').value.trim(),email:$('eu-email').value.trim()});editingUser=null;msg($('userMsg'),'Contact details saved.',true);loadUsers()}
      catch(e){msg($('userMsg'),e.message)}});
    T.querySelectorAll('[data-reset]').forEach(b=>b.onclick=()=>arm(b,'Confirm reset',async()=>{
      const pw=Api.tempPassword();
      try{const {user}=await Api.patch(`/api/admin/users/${b.dataset.reset}`,{password:pw});msg($('userMsg'),'Password reset.',true);Api.showCredentials($('userCreds'),{title:'New temporary password',name:user.name,loginId:user.loginId,password:pw});loadUsers()}catch(e){msg($('userMsg'),e.message)}
    }));
  }catch(e){T.innerHTML=`<tbody><tr><td class="empty">${esc(e.message)}</td></tr></tbody>`}
}
$('uPw').value=Api.tempPassword();$('tnAdminPw').value=Api.tempPassword();
Api.linkLogin($('uLogin'),$('uName'));Api.linkLogin($('tnAdminLogin'),$('tnAdminName'));
$('userForm').addEventListener('submit',async e=>{
  e.preventDefault();const m=$('userMsg');
  try{const pw=$('uPw').value;const {user}=await Api.post('/api/admin/users',{name:$('uName').value.trim(),loginId:$('uLogin').value.trim(),email:$('uEmail').value.trim(),mobile:$('uMobile').value.trim(),role:$('uRole').value,password:pw});
    msg(m,`Added ${user.name}.`,true);Api.showCredentials($('userCreds'),{title:'New user',name:user.name,loginId:user.loginId,password:pw});
    e.target.reset();$('uLogin').dataset.auto='1';$('uPw').value=Api.tempPassword();loadUsers();if(isSuper()||can('audit'))loadAudit()}
  catch(err){msg(m,err.message);if(err.body&&err.body.suggestion)$('uLogin').value=err.body.suggestion}
});
async function loadAudit(){
  const T=$('auditTable');
  if(needTenant()){T.innerHTML='';return}
  try{
    const {entries}=await Api.get('/api/admin/audit');
    const label={login:'Signed in with password',login_otp:'Signed in with a code',voyage_created:'Created voyage',voyage_deleted:'Deleted voyage',voyage_final:'Marked voyage final',voyage_draft:'Moved voyage to draft',user_created:'Added user',user_updated:'Changed user',password_changed:'Changed own password',tenant_created:'Organisation created',tenant_updated:'Organisation changed',permission_changed:'Changed module access',permissions_reset:'Reset module access',mobile_verified:'Confirmed mobile number',email_verified:'Confirmed email'};
    T.innerHTML=entries.length?`<thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>`+entries.map(a=>`<tr><td class="hint">${when(a.at)}</td><td>${esc(a.user_name||a.user_email||'–')}</td><td>${esc(label[a.action]||a.action.replace(/_/g,' '))}${a.vessel?' · '+esc(a.vessel):a.detail&&a.detail.vessel?' · '+esc(a.detail.vessel):a.detail&&a.detail.module?` · ${esc(a.detail.module)} for ${esc(a.detail.role)}: ${a.detail.enabled===null?'default':a.detail.enabled?'on':'off'}`:''}</td></tr>`).join('')+'</tbody>':'<tbody><tr><td class="empty">No activity yet.</td></tr></tbody>';
  }catch(e){T.innerHTML=''}
}

// ---------- account ----------
function drawAccount(){
  $('acctInfo').innerHTML=`<dt>Login ID</dt><dd>${esc(me.loginId)}</dd><dt>Name</dt><dd>${esc(me.name||'–')}</dd><dt>Organisation</dt><dd>${esc(me.tenantName||(isSuper()?'Platform admin':'–'))}</dd>`;
  Api.contacts($('acctContacts'),me);
  // After signing in with a code, a password can be set without the old one.
  $('pwCurRow').hidden=me.signedInWith==='otp';
}
$('pwForm').addEventListener('submit',async e=>{
  e.preventDefault();const m=$('pwMsg');
  try{await Api.post('/api/auth/password',{current:$('pwCur').value,next:$('pwNew').value});msg(m,'Password changed.',true);e.target.reset();$('pwBanner').hidden=true;
    if(me.mustChangePassword){me.mustChangePassword=false;history.replaceState(null,'','#/voyages');boot()}}
  catch(err){msg(m,err.message)}
});

boot();
})();
