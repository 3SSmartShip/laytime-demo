// Example voyage: MV Vishva Nidhi, taken from the client's Excel statements.
const SAMPLE_LP_SOF=`31.08.2013 08:20 08:50 Loader shifting to hatch no. 3
31.08.2013 15:25 16:05 Loader shifting to hatch no. 2
31.08.2013 21:00 22:00 Due to high humidity
01.09.2013 00:05 00:40 Loader shifting to hatch no. 4
01.09.2013 01:35 02:15 Loader shifting to hatch no. 5
01.09.2013 06:05 06:45 Loader shifting to hatch no. 1
01.09.2013 17:45 18:45 Due to high humidity
01.09.2013 22:15 22:55 Loader shifting to hatch no. 1
02.09.2013 02:05 02:40 Loader shifting to hatch no. 4
02.09.2013 10:55 11:30 Loader shifting to hatch no. 2
02.09.2013 18:05 18:45 Loader shifting to hatch no. 3
03.09.2013 01:55 02:35 Checking draft by ship
03.09.2013 02:40 03:15 Loader shifting to hatch no. 5
03.09.2013 04:15 04:50 Loader shifting to hatch no. 1`;
const SAMPLE_DP_SOF=`16.09.2013 15:00 22:30 Due to rain
17.09.2013 03:00 04:30 Due to rain
17.09.2013 06:00 07:30 Due to rain
17.09.2013 14:45 18.09.2013 03:30 Due to rain
18.09.2013 04:30 06:00 Due to rain
18.09.2013 09:15 11:30 Due to rain
18.09.2013 19:05 21:50 Due to rain
19.09.2013 00:30 04:45 Due to rain
19.09.2013 07:30 09:10 Due to rain
19.09.2013 16:30 20.09.2013 08:15 Due to continuous rain
20.09.2013 09:00 17:15 Due to rain
20.09.2013 18:05 21.09.2013 03:00 Due to continuous rain
21.09.2013 04:45 08:00 Due to rain`;
function makeSample(parseSOF){
  const base={terms:'SHINC',sDay:'0',sTime:'00:00',eDay:'1',eTime:'00:00',holidays:[],mode:'rate',fixedHours:''};
  return{
    vessel:'MV Vishva Nidhi (example)',charterers:'',owners:'',cpDate:'2013-03-06',cargo:'',currency:'USD',
    demRate:'7000',desRate:'3500',hd:true,odad:true,round4:false,calcMode:'separate',active:0,
    ports:[
      {...base,name:'Sur',op:'Loading',qty:'36010.25',rate:'12000',terms:'SHINC',
       arrived:'2013-08-30T07:00',nor:'2013-08-30T06:30',norAcc:'2013-08-31T09:20',berthed:'2013-08-31T08:30',
       commenced:'2013-08-31T09:20',completed:'2013-09-03T06:00',sailed:'2013-09-03T00:00',
       turn:'6',commenceOv:'2013-08-31T06:00',exceptions:parseSOF(SAMPLE_LP_SOF).rows},
      {...base,name:'Visakhapatnam',op:'Discharging',qty:'36010.25',rate:'6000',terms:'SATPM SHEX',sDay:'6',sTime:'12:00',eDay:'1',eTime:'08:00',
       arrived:'2013-09-13T08:05',nor:'2013-09-13T08:05',norAcc:'',berthed:'2013-09-13T10:48',
       commenced:'2013-09-13T15:15',completed:'2013-09-23T15:15',sailed:'2013-09-23T00:00',
       turn:'24',commenceOv:'2013-09-14T10:00',exceptions:parseSOF(SAMPLE_DP_SOF).rows}
    ]};
}
if(typeof module!=='undefined')module.exports={makeSample};
if(typeof window!=='undefined')window.makeSample=makeSample;
