// Laytime engine — pure functions, no DOM. Times are "port local" ms (stored as UTC).
const H=3600000, DAY=86400000;
const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const PRESETS={'SHINC':null,'SHEX':[0,'00:00',1,'00:00'],'SATPM SHEX':[6,'12:00',1,'08:00'],'SSHEX':[6,'00:00',1,'00:00'],'FHEX':[5,'00:00',6,'00:00']};
const TERM_LABEL={'SHINC':'SHINC','SHEX':'SHEX EIU','SATPM SHEX':'SAFSHEX EIU','SSHEX':'SSHEX EIU','FHEX':'FHEX EIU','Custom':'per C/P'};

const num=v=>{const n=parseFloat(String(v??'').replace(/,/g,''));return isFinite(n)?n:0};
const pad=n=>String(n).padStart(2,'0');
function parseDT(s){if(!s)return NaN;const[d,t]=String(s).split('T');const[y,m,dd]=d.split('-').map(Number);if(!y||!m||!dd)return NaN;const[hh,mi]=(t||'00:00').split(':').map(Number);return Date.UTC(y,m-1,dd,hh||0,mi||0)}
function toInput(ms){return isFinite(ms)?new Date(ms).toISOString().slice(0,16):''}
const tmin=s=>{if(!s)return 0;const[h,m]=String(s).split(':').map(Number);return (h||0)*60+(m||0)};
function fmtDate(ms){const d=new Date(ms);return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth()+1)}.${d.getUTCFullYear()}`}
function fmtDT(ms){if(!isFinite(ms))return '–';const d=new Date(ms);return `${fmtDate(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`}
function hhmm(ms,isEnd){const d=new Date(ms);if(isEnd&&d.getUTCHours()===0&&d.getUTCMinutes()===0)return '24:00';return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`}
function splitDur(h){let m=Math.round(Math.abs(h)*60);const d=Math.floor(m/1440);m-=d*1440;const hh=Math.floor(m/60);return{d,h:hh,m:m-hh*60,neg:h<0}}
function fmtDur(h){const x=splitDur(h);return `${x.neg?'−':''}${pad(x.d)}d ${pad(x.h)}h ${pad(x.m)}m`}
function fmtLong(h){const x=splitDur(h);return `${pad(x.d)} Days - ${pad(x.h)} Hrs - ${pad(x.m)} Mins`}
function fmtHM(h){const m=Math.round(h*60);return `${pad(Math.floor(m/60))}:${pad(m%60)}`}
function fmtDHM(h){const x=splitDur(h);return `${pad(x.d)}:${pad(x.h)}:${pad(x.m)}`}

function allowedHours(p){
  if(p.mode==='fixed')return num(p.fixedHours);
  return num(p.rate)>0?num(p.qty)/num(p.rate)*24:0;
}

// Parse pasted SOF lines into exceptions.
function parseSOF(text){
  const out=[],bad=[];
  const dRe=/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/;
  String(text).split(/\r?\n/).forEach(line=>{
    const raw=line.trim(); if(!raw)return;
    let rest=raw; const toks=[];
    // pull up to two date-time tokens
    for(let k=0;k<2;k++){
      const m=rest.match(/^(?:[\s\t,;|–—-]*)(?:(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4})[\sT,]*)?(\d{1,2}):?(\d{2})(?:\s*(?:hrs|hr|h))?(?![\d.\/])/i);
      if(!m)break;
      toks.push({date:m[1]||null,h:+m[2],mi:+m[3]});
      rest=rest.slice(m[0].length);
    }
    if(toks.length<2||!toks[0].date){bad.push(raw);return}
    const dm=toks[0].date.match(dRe);let y=+dm[3];if(y<100)y+=2000;
    const f=Date.UTC(y,+dm[2]-1,+dm[1],toks[0].h,toks[0].mi);
    let t;
    if(toks[1].date){const d2=toks[1].date.match(dRe);let y2=+d2[3];if(y2<100)y2+=2000;t=Date.UTC(y2,+d2[2]-1,+d2[1],toks[1].h,toks[1].mi)}
    else{t=Date.UTC(y,+dm[2]-1,+dm[1],toks[1].h,toks[1].mi);if(t<=f)t+=DAY}
    let desc=rest.replace(/^[\s\t,;|–—-]+/,'').trim();
    let p=0;
    if(/\b(50\s*%|half(\s*time)?)\b/i.test(desc))p=50;
    const od=/\b(breakdown of vessel|vessel'?s? (gear|crane)|ship'?s? (gear|crane)|stops? demurrage)\b/i.test(desc);
    desc=desc.replace(/^NTC\s*[-–:]\s*/i,'');
    if(!isFinite(f)||!isFinite(t)||t<=f){bad.push(raw);return}
    out.push({f:toInput(f),t:toInput(t),d:desc||'Not to count',p,od});
  });
  return{rows:out,bad};
}

// Core: compute one port. ctx = {allowed, startCum, odad}
function computePort(p,ctx){
  const errs=[];
  const allowed=ctx.allowed;
  const nor=parseDT(p.nor);
  const commence=p.commenceOv?parseDT(p.commenceOv):(isFinite(nor)?nor+num(p.turn)*H:NaN);
  const end=parseDT(p.completed);
  if(!(allowed>0))errs.push('Enter quantity and rate (or a fixed laytime) to get the laytime allowed.');
  if(!isFinite(commence))errs.push('Enter NOR tendered, or the time to count from.');
  if(!isFinite(end))errs.push('Enter the time loading or discharging was completed.');
  if(isFinite(commence)&&isFinite(end)&&end<=commence)errs.push('Completion is before time starts to count. Check the time sheet.');
  if(errs.length)return{errs};

  const exs=(p.exceptions||[]).map(x=>({f:parseDT(x.f),t:parseDT(x.t),d:x.d||'Not to count',p:+x.p||0,dp:x.dp!==undefined&&x.dp!==null?+x.dp:(+x.p||0),od:!!x.od})).filter(x=>isFinite(x.f)&&isFinite(x.t)&&x.t>x.f);
  const winOn=p.terms!=='SHINC';
  const sW=(+p.sDay)*1440+tmin(p.sTime), eW=(+p.eDay)*1440+tmin(p.eTime);
  const hol=new Set(p.holidays||[]);
  const tl=TERM_LABEL[p.terms]||p.terms;
  function cal(ms){
    if(!winOn)return null;
    if(hol.has(new Date(ms).toISOString().slice(0,10)))return `Holiday – ${tl}`;
    const d=new Date(ms);
    const wm=d.getUTCDay()*1440+d.getUTCHours()*60+d.getUTCMinutes()+d.getUTCSeconds()/60;
    const inW=sW<eW?(wm>=sW&&wm<eW):(sW>eW?(wm>=sW||wm<eW):false);
    return inW?tl:null;
  }
  const pts=new Set([commence,end]);
  exs.forEach(x=>[x.f,x.t].forEach(t=>{if(t>commence&&t<end)pts.add(t)}));
  for(let day=Math.floor(commence/DAY)*DAY;day<=end;day+=DAY){
    const dow=new Date(day).getUTCDay();const c=[day];
    if(dow==p.sDay)c.push(day+tmin(p.sTime)*60000);
    if(dow==p.eDay)c.push(day+tmin(p.eTime)*60000);
    c.forEach(t=>{if(t>commence&&t<end)pts.add(t)});
  }
  const P=[...pts].sort((a,b)=>a-b);
  let cum=ctx.startCum||0,dem=0,used=0;
  let expiry=cum>=allowed-1e-9?commence:null;
  const already=expiry!==null;
  const segs=[];
  function proc(a,b){
    if(b-a<1)return;
    const mid=(a+b)/2,hrs=(b-a)/H;
    const ex=exs.filter(x=>x.f<=mid&&mid<x.t);
    const exF=ex.length?Math.min(...ex.map(x=>x.p))/100:1;
    const exD=ex.map(x=>x.d).join(' / ');
    if(expiry===null){
      const c=cal(mid);let f,d,kind;
      if(c){f=0;d=c;kind='cal'}else if(ex.length){f=exF;d=exD;kind='ex'}else{f=1;d='';kind='count'}
      if(f>0&&cum+hrs*f>allowed+1e-9){
        const need=(allowed-cum)/f,sp=a+need*H;
        segs.push({a,b:sp,d,f,kind,ph:'lay',c:need*f});used+=need*f;cum=allowed;expiry=sp;proc(sp,b);return;
      }
      segs.push({a,b,d,f,kind,ph:'lay',c:hrs*f});cum+=hrs*f;used+=hrs*f;
      if(f>0&&cum>=allowed-1e-9){cum=allowed;expiry=b}
    }else{
      let f,d,kind;
      if(ctx.odad){const od=ex.filter(x=>x.od);if(od.length){f=Math.min(...od.map(x=>x.dp))/100;d=od.map(x=>x.d).join(' / ');kind='ex'}else{f=1;d='';kind='count'}}
      else{const c=cal(mid);if(c){f=0;d=c;kind='cal'}else if(ex.length){f=exF;d=exD;kind='ex'}else{f=1;d='';kind='count'}}
      segs.push({a,b,d,f,kind,ph:'dem',c:hrs*f});dem+=hrs*f;
    }
  }
  for(let i=0;i<P.length-1;i++)proc(P[i],P[i+1]);
  // merge contiguous identical rows within the same calendar day
  const rows=[];
  segs.forEach(s=>{const l=rows[rows.length-1];
    if(l&&l.d===s.d&&l.f===s.f&&l.ph===s.ph&&Math.abs(l.b-s.a)<1&&Math.floor(l.a/DAY)===Math.floor((s.b-1)/DAY)){l.b=s.b;l.c+=s.c}else rows.push({...s})});
  // notice time row(s), split at midnight
  const pre=[];
  if(isFinite(nor)&&commence>nor){
    const lbl=p.commenceOv?'NOR tendered – time not yet counting':`As per C/P – ${num(p.turn)} hr turn time`;
    let a=nor;while(a<commence){const nb=Math.min(commence,Math.floor(a/DAY)*DAY+DAY);pre.push({a,b:nb,d:lbl,f:0,kind:'pre',ph:'pre',c:0});a=nb}
  }
  // running totals
  let cl=ctx.startCum||0,cd=0;
  const all=[...pre,...rows];
  all.forEach(r=>{if(r.ph==='lay')cl+=r.c;if(r.ph==='dem')cd+=r.c;r.cumLay=cl;r.cumDem=cd});
  const saved=expiry===null?allowed-cum:0;
  return{errs,allowed,nor,commence,end,expiry,already,used,cumAfter:cum,dem,saved,rows:all};
}

// Whole voyage
function computeVoyage(V){
  const ports=V.ports||[];
  const allowedEach=ports.map(allowedHours);
  const res=[];
  if(V.calcMode==='reversible'){
    const pool=allowedEach.reduce((a,b)=>a+b,0);
    let cum=0;
    ports.forEach((p,i)=>{const r=computePort(p,{allowed:pool,startCum:cum,odad:V.odad});r.portAllowed=allowedEach[i];r.pool=pool;if(!r.errs.length)cum=r.cumAfter;res.push(r)});
  }else{
    ports.forEach((p,i)=>{const r=computePort(p,{allowed:allowedEach[i],startCum:0,odad:V.odad});r.portAllowed=allowedEach[i];res.push(r)});
  }
  const demRate=num(V.demRate),desRate=V.hd?demRate/2:num(V.desRate);
  const rd=h=>h/24;
  res.forEach(r=>{if(r.errs.length)return;r.demDays=rd(r.dem);r.demAmt=r.demDays*demRate;r.desDays=0;r.desAmt=0});
  if(V.calcMode==='reversible'){
    const last=[...res].reverse().find(r=>!r.errs.length);
    if(last&&last.expiry===null&&res.every(r=>!r.errs.length)){last.desDays=rd(last.saved);last.desAmt=last.desDays*desRate}
    res.forEach(r=>{if(r!==last)r.saved=0});
  }else{
    res.forEach(r=>{if(r.errs.length)return;r.desDays=rd(r.saved);r.desAmt=r.desDays*desRate});
  }
  const ok=res.filter(r=>!r.errs.length);
  const totDem=ok.reduce((a,r)=>a+r.demAmt,0),totDes=ok.reduce((a,r)=>a+r.desAmt,0);
  return{res,demRate,desRate,totDem,totDes,net:totDem-totDes};
}

const Engine={computeVoyage,computePort,parseSOF,allowedHours,fmtDur,fmtLong,fmtDT,fmtDate,fmtHM,fmtDHM,hhmm,parseDT,toInput,num,tmin,TERM_LABEL,PRESETS,DOW,MON};
if(typeof module!=='undefined')module.exports=Engine;
if(typeof window!=='undefined')window.Engine=Engine;
