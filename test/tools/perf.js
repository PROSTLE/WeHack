const path=require('path'),os=require('os'),fs=require('fs');
const {Index}=require('../../src/main/db.js');
const {ScanController}=require('../../src/main/scanners/composition.js');
const root=process.argv[2];
const dbPath=path.join("C:/Lang/NexaFiles/test",'.perf.db');
for(const s of ['','-wal','-shm']) try{fs.rmSync(dbPath+s)}catch{}
(async()=>{
  const idx=new Index(dbPath).open();
  const ctl=new ScanController(idx);
  const t0=Date.now();
  let peak=0;
  const timer=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},200);
  const scan=await ctl.start(root,()=>{});
  clearInterval(timer);
  const ms=Date.now()-t0;
  console.log('root        :',root);
  console.log('status      :',scan.status);
  console.log('files       :',scan.fileCount.toLocaleString());
  console.log('dirs        :',scan.dirCount.toLocaleString());
  console.log('bytes       :',(scan.totalBytes/1073741824).toFixed(2),'GB');
  console.log('skipped     :',scan.skippedCount.toLocaleString());
  console.log('elapsed     :',ms,'ms  =>',Math.round(scan.fileCount/(ms/1000)).toLocaleString(),'files/sec');
  console.log('peak RSS    :',(peak/1048576).toFixed(0),'MB');
  console.log('notes       :'); scan.notes.forEach(n=>console.log('   -',n));
  console.log('categories  :',JSON.stringify(idx.categoryTotals(scan.id).map(c=>[c.category,(c.bytes/1073741824).toFixed(2)+'GB'])));
  const kids=idx.childrenWithRollup(scan.id,root).slice(0,6);
  console.log('top children:'); kids.forEach(k=>console.log('   ',(k.bytes/1048576).toFixed(0).padStart(8),'MB ',k.name));
  const sum=idx.childrenWithRollup(scan.id,root).reduce((n,k)=>n+k.bytes,0);
  console.log('rollup sum == scan total :', sum===scan.totalBytes, `(${sum} vs ${scan.totalBytes})`);
  idx.close();
  for(const s of ['','-wal','-shm']) try{fs.rmSync(dbPath+s)}catch{}
})();
