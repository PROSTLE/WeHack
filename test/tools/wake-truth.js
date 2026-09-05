// Dumps what the recogniser actually returns for every fixture, so the matcher
// can be designed against evidence rather than against a guess about what a
// speech model hears when someone says a made-up name.
const path=require('path'), fs=require('fs');
const { execFileSync } = require('child_process');
const FIX=path.join(__dirname,'..','fixtures','wake');

// Voices and phrases the matcher in wake.js was designed against. Regenerate
// with `node test/tools/wake-truth.js --make-fixtures` on a Mac (it shells out
// to `say`); the ground truth this tool prints from them is what test/wake.test.js
// asserts against, committed rather than the audio itself.
const VOICES = ['Samantha', 'Alex', 'Daniel', 'Karen'];
const PHRASES = [
  'hey nexa', 'hey nexa find my downloads',
  'next week', 'go to the next file', 'hello there',
  'send me the next slide', 'open the next folder',
];
const slug = (voice, phrase) => `${voice ? voice + '__' : ''}${phrase.replace(/\s+/g, '_')}.wav`;

if (process.argv.includes('--make-fixtures')) {
  fs.mkdirSync(FIX, { recursive: true });
  // One voice-less set at the default system voice, plus one set per named
  // voice, so the matcher is checked against more than one person's speech.
  const DEFAULT_VOICE_PHRASES = [
    'hey nexa', 'hey nexa find my tax return', 'hey nexa where are my screenshots',
    'next week', 'go to the next file', 'hello there', 'send me the next slide',
  ];
  const sets = [[null, DEFAULT_VOICE_PHRASES], ...VOICES.map((v) => [v, PHRASES])];
  for (const [voice, phrases] of sets) {
    for (const phrase of phrases) {
      const out = path.join(FIX, slug(voice, phrase));
      const args = voice ? ['-v', voice] : [];
      execFileSync('say', [...args, '-o', out, '--data-format=LEI16@16000', phrase]);
      console.log('wrote', path.relative(process.cwd(), out));
    }
  }
  process.exit(0);
}

const {app,BrowserWindow}=require('electron');
require(path.join(__dirname,'..','..','main.js'));
const wakeWindow=require(path.join(__dirname,'..','..','src','main','wake','window.js'));
const {WakeModelStore}=require('../../src/main/wake/model-store.js');

function pcm(file){
  const b=fs.readFileSync(file); let o=12,ds=null,dl=null;
  while(o+8<=b.length){const id=b.toString('ascii',o,o+4),sz=b.readUInt32LE(o+4);
    if(id==='data'){ds=o+8;dl=sz;break;} o+=8+sz+(sz%2);}
  const n=Math.floor(dl/2); const out=Buffer.alloc(n*2); b.copy(out,0,ds,ds+n*2);
  return out.toString('base64');
}

app.whenReady().then(async()=>{
  await new Promise(r=>setTimeout(r,2500));
  const store=new WakeModelStore(app.getPath('userData'));
  // The listener window is where the recogniser lives, and its policy is the
  // one that permits it. Created directly rather than via the setting, so this
  // tool works whether or not the wake word is switched on.
  wakeWindow.create();
  await new Promise(r=>setTimeout(r,2500));
  const win=wakeWindow.get();
  if(!win){ console.log('no listener window'); app.exit(2); return; }

  const files=fs.readdirSync(FIX).filter(f=>f.endsWith('.wav')).sort();
  const clips={};
  for(const f of files) clips[f]=pcm(path.join(FIX,f));

  const r=await win.webContents.executeJavaScript(`(async()=>{
    const model=await window.Vosk.createModel(${JSON.stringify(store.modelUrl)},-1);
    const clips=${JSON.stringify(clips)};
    const dec=(b64)=>{const bin=atob(b64);const a=new Float32Array(bin.length/2);
      for(let i=0;i<a.length;i++){let v=(bin.charCodeAt(i*2+1)<<8)|bin.charCodeAt(i*2);if(v>=0x8000)v-=0x10000;a[i]=v/32768;}return a;};
    const out={};
    for(const [name,b64] of Object.entries(clips)){
      const rec=new model.KaldiRecognizer(16000);
      let finals=[], partials=[];
      rec.on('result',m=>{ if(m?.result?.text) finals.push(m.result.text); });
      rec.on('partialresult',m=>{ if(m?.result?.partial) partials.push(m.result.partial); });
      const a=dec(b64);
      for(let i=0;i<a.length;i+=2048) rec.acceptWaveformFloat(a.subarray(i,i+2048),16000);
      rec.retrieveFinalResult();
      await new Promise(x=>setTimeout(x,900));
      out[name]={final:finals.join(' ').trim(), partials:[...new Set(partials)]};
      rec.remove();
    }
    model.terminate();
    return out;
  })()`);
  console.log('===TRUTH===');
  console.log(JSON.stringify(r,null,1));
  app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});
