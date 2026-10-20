// SOF reason codes and their default treatment under common charter party practice.
// p: 100 = time counts, 50 = half time, 0 = not to count.  od: true = also stops demurrage.
// Each voyage can override these in its "CP treatment" table to match its own clauses.
(function(root,factory){
  if(typeof module!=='undefined')module.exports=factory();else root.Codes=factory();
})(typeof window!=='undefined'?window:this,function(){
  const MILESTONES=[
    {code:'ARRIVED',label:'Vessel arrived',field:'arrived'},
    {code:'NOR_TENDERED',label:'NOR tendered',field:'nor'},
    {code:'NOR_ACCEPTED',label:'NOR accepted',field:'norAcc'},
    {code:'TIME_COUNTS',label:'Laytime commences (time to count from)',field:'commenceOv'},
    {code:'BERTHED',label:'Vessel berthed / all fast',field:'berthed'},
    {code:'COMMENCED',label:'Commenced loading / discharge',field:'commenced'},
    {code:'COMPLETED',label:'Completed loading / discharge',field:'completed'},
    {code:'SAILED',label:'Vessel sailed',field:'sailed'},
    {code:'ETC',label:'Estimated completion (ETC)',field:'etc'},
  ];
  const STOPPAGES=[
    {code:'RAIN',label:'Rain / bad weather',group:'Weather',p:0,od:false},
    {code:'SWELL',label:'Swell / high wind',group:'Weather',p:0,od:false},
    {code:'HUMIDITY',label:'High humidity',group:'Weather',p:0,od:false},
    {code:'SHIFT_BERTH',label:'Shifting berth / anchorage to berth',group:'Vessel movement',p:0,od:false},
    {code:'SHIFT_HATCH',label:'Loader / crane shifting between hatches',group:'Operations',p:0,od:false},
    {code:'DRAFT_SURVEY',label:'Draft survey',group:'Operations',p:0,od:false},
    {code:'SHIP_GEAR',label:"Ship's gear / crane breakdown",group:'Vessel',p:0,od:true},
    {code:'SHIP_HOLDS',label:'Holds not ready / hold cleaning',group:'Vessel',p:0,od:true},
    {code:'SHIP_PURPOSE',label:"Ship's purpose (bunkering, crew change, repairs)",group:'Vessel',p:0,od:true},
    {code:'SHORE_EQUIP',label:'Shore crane / loader breakdown',group:'Terminal',p:100,od:false},
    {code:'AWAIT_CARGO',label:'Awaiting cargo / trucks / wagons',group:'Terminal',p:100,od:false},
    {code:'LABOUR',label:'Stevedore / labour shortage',group:'Stevedore',p:100,od:false},
    {code:'AWAIT_BERTH',label:'Waiting for berth (congestion)',group:'Port',p:100,od:false},
    {code:'AWAIT_TIDE',label:'Awaiting tide / daylight',group:'Port',p:100,od:false},
    {code:'FORMALITIES',label:'Customs / free pratique / formalities',group:'Port',p:100,od:false},
    {code:'STRIKE',label:'Strike / stoppage of labour',group:'Port',p:0,od:false},
    {code:'OTHER_NTC',label:'Other – not to count',group:'Other',p:0,od:false},
    {code:'OTHER_HALF',label:'Other – half time',group:'Other',p:50,od:false},
  ];
  const BY_CODE={};MILESTONES.forEach(m=>BY_CODE[m.code]={...m,kind:'milestone'});STOPPAGES.forEach(s=>BY_CODE[s.code]={...s,kind:'stoppage'});
  const PARTY_ROLES={owner:'Owners',charterer:'Charterers',broker:'Broker',agent:'Port agent',master:'Master / vessel',stevedore:'Stevedore',terminal:'Terminal',surveyor:'Surveyor'};
  // Which roles may record which events (tenant users can record all).
  const CAN_RECORD={
    agent:'*', master:'*',
    stevedore:['COMMENCED','COMPLETED','ETC','RAIN','SWELL','HUMIDITY','SHIFT_HATCH','SHIP_GEAR','SHORE_EQUIP','AWAIT_CARGO','LABOUR','STRIKE','OTHER_NTC','OTHER_HALF'],
    terminal:['BERTHED','COMMENCED','COMPLETED','ETC','SHORE_EQUIP','AWAIT_CARGO','AWAIT_BERTH','AWAIT_TIDE','RAIN','SWELL','OTHER_NTC'],
    surveyor:['DRAFT_SURVEY','OTHER_NTC'],
    owner:[],charterer:[],broker:[],
  };
  function canRecord(party,code){const r=CAN_RECORD[party];return r==='*'||(Array.isArray(r)&&r.includes(code))}
  function rule(V,code){const o=(V&&V.codeRules&&V.codeRules[code])||null;const d=BY_CODE[code]||{p:0,od:false};return o?{p:+o.p,od:!!o.od}:{p:d.p,od:!!d.od}}
  // Guess a code from free text (used for pasted lines and the built-in document reader).
  function guess(text){
    const t=String(text||'').toLowerCase();
    if(/\b(ship'?s?|vessel'?s?)\b.*\b(crane|gear|derrick|winch)\b.*\b(break ?down|failure|defect|repair)/.test(t)||/\bbreak ?down\b.*\b(ship'?s?|vessel'?s?)\b/.test(t))return 'SHIP_GEAR';
    if(/\b(shore|terminal|port)\b.*\b(crane|loader|unloader|conveyor|grab)\b|\b(loader|conveyor|unloader)\b.*\bbreak ?down/.test(t))return 'SHORE_EQUIP';
    if(/\bhumid/.test(t))return 'HUMIDITY';
    if(/\b(rain|drizzle|shower|weather|storm)/.test(t))return 'RAIN';
    if(/\b(swell|wind)\b/.test(t))return 'SWELL';
    if(/\b(loader|crane|grab)\b.*\bshift|shift\w*\b.*\bhatch/.test(t))return 'SHIFT_HATCH';
    if(/\bshift|steaming|pilot on board|unmoor/.test(t))return 'SHIFT_BERTH';
    if(/\bdraft\b|\bdraught\b/.test(t))return 'DRAFT_SURVEY';
    if(/\bhold\b.*\b(clean|inspect|not ready|reject)/.test(t))return 'SHIP_HOLDS';
    if(/\bbunker|crew change|ship'?s purpose/.test(t))return 'SHIP_PURPOSE';
    if(/\b(await\w*|waiting|shortage of|no)\b.*\b(cargo|truck|wagon|rake|barge)/.test(t))return 'AWAIT_CARGO';
    if(/\b(labour|gang|stevedore)/.test(t))return 'LABOUR';
    if(/\b(berth|congestion)\b/.test(t))return 'AWAIT_BERTH';
    if(/\btide|daylight/.test(t))return 'AWAIT_TIDE';
    if(/\bcustoms|pratique|immigration|formalit/.test(t))return 'FORMALITIES';
    if(/\bstrike|bandh|hartal/.test(t))return 'STRIKE';
    if(/\bhalf\b|50 ?%/.test(t))return 'OTHER_HALF';
    return 'OTHER_NTC';
  }
  function guessMilestone(text){
    const t=String(text||'').toLowerCase();
    if(/\bnor\b.*\baccept/.test(t))return 'NOR_ACCEPTED';
    if(/\bnor\b.*\b(tender|served|given)|notice of readiness/.test(t))return 'NOR_TENDERED';
    if(/\b(laytime|time)\b.*\b(commence|start|count)/.test(t))return 'TIME_COUNTS';
    if(/\b(commenced|started|began)\b.*\b(load|disch|cargo)/.test(t))return 'COMMENCED';
    if(/\bcompleted\b.*\b(load|disch|cargo)|\b(load|disch)\w* completed/.test(t))return 'COMPLETED';
    if(/\ball fast|\bberthed|alongside/.test(t))return 'BERTHED';
    if(/\b(arrived|eosp|end of sea passage|anchored|dropped anchor)/.test(t))return 'ARRIVED';
    if(/\b(sailed|cosp|dropped outward pilot|departed)/.test(t))return 'SAILED';
    return null;
  }
  return{MILESTONES,STOPPAGES,BY_CODE,PARTY_ROLES,CAN_RECORD,canRecord,rule,guess,guessMilestone};
});
