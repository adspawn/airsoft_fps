/* ============================================================
   サウンド（WebAudio 合成）
   ============================================================ */
import { ENV } from "./physics.js";

let AC=null, noiseBuf=null;
export function audio(){
  if(!AC){
    AC=new (window.AudioContext||window.webkitAudioContext)();
    noiseBuf=AC.createBuffer(1, AC.sampleRate*0.25, AC.sampleRate);
    const d=noiseBuf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=Math.random()*2-1;
  }
  if(AC.state==="suspended") AC.resume();
  return AC;
}
export function sndShot(){
  const c=audio(), t=c.currentTime;
  const n=c.createBufferSource(); n.buffer=noiseBuf;
  const bp=c.createBiquadFilter(); bp.type="bandpass"; bp.frequency.value=2400+Math.random()*400; bp.Q.value=.8;
  const g=c.createGain();
  g.gain.setValueAtTime(.4,t); g.gain.exponentialRampToValueAtTime(.001,t+.07);
  n.connect(bp).connect(g).connect(c.destination); n.start(t); n.stop(t+.09);
  const o=c.createOscillator(); o.type="square";
  o.frequency.setValueAtTime(150,t); o.frequency.exponentialRampToValueAtTime(55,t+.05);
  const g2=c.createGain();
  g2.gain.setValueAtTime(.35,t); g2.gain.exponentialRampToValueAtTime(.001,t+.06);
  o.connect(g2).connect(c.destination); o.start(t); o.stop(t+.07);
}
export function sndPing(dist){
  const c=audio();
  const t=c.currentTime + dist/ENV.snd;          // 音の伝播遅延
  const vol=Math.min(.5, 6/Math.max(6,dist));
  for (const [f,dur] of [[1900+Math.random()*250,.5],[3050,.22]]){
    const o=c.createOscillator(); o.type="triangle"; o.frequency.value=f;
    const g=c.createGain();
    g.gain.setValueAtTime(vol,t); g.gain.exponentialRampToValueAtTime(.001,t+dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t+dur+.02);
  }
}
export function sndClick(freq=700,vol=.25){
  const c=audio(), t=c.currentTime;
  const o=c.createOscillator(); o.type="square"; o.frequency.value=freq;
  const g=c.createGain();
  g.gain.setValueAtTime(vol,t); g.gain.exponentialRampToValueAtTime(.001,t+.03);
  o.connect(g).connect(c.destination); o.start(t); o.stop(t+.04);
}
const RELOAD_SFX_URL = encodeURI("assets/サブマシンガンの弾倉をセット.mp3");
let reloadBuf=null, reloadBufLoading=null;
function loadReloadBuf(){
  if (reloadBuf) return Promise.resolve(reloadBuf);
  if (reloadBufLoading) return reloadBufLoading;
  const c=audio();
  reloadBufLoading=fetch(RELOAD_SFX_URL)
    .then(r=>r.arrayBuffer())
    .then(ab=>c.decodeAudioData(ab))
    .then(buf=>{ reloadBuf=buf; reloadBufLoading=null; return buf; })
    .catch(err=>{ reloadBufLoading=null; console.warn("reload sfx load failed", err); });
  return reloadBufLoading;
}
export function sndReload(){
  const c=audio();
  loadReloadBuf().then(buf=>{
    if (!buf) return;
    const src=c.createBufferSource(); src.buffer=buf;
    const g=c.createGain(); g.gain.value=.7;
    src.connect(g).connect(c.destination);
    src.start();
  });
}
export function sndTink(dist){
  const c=audio(), t=c.currentTime + dist/ENV.snd;
  const vol=Math.min(.45, 5/Math.max(5,dist));
  for (const [f,dur] of [[3400+Math.random()*500,.16],[5200,.08]]){
    const o=c.createOscillator(); o.type="triangle"; o.frequency.value=f;
    const g=c.createGain();
    g.gain.setValueAtTime(vol,t); g.gain.exponentialRampToValueAtTime(.001,t+dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t+dur+.02);
  }
}
export function sndThock(dist){
  const c=audio(), t=c.currentTime + dist/ENV.snd;
  const vol=Math.min(.4, 5/Math.max(5,dist));
  const n=c.createBufferSource(); n.buffer=noiseBuf;
  const f=c.createBiquadFilter(); f.type="lowpass"; f.frequency.value=500;
  const g=c.createGain();
  g.gain.setValueAtTime(vol,t); g.gain.exponentialRampToValueAtTime(.001,t+.08);
  n.connect(f).connect(g).connect(c.destination); n.start(t); n.stop(t+.1);
  const o=c.createOscillator(); o.frequency.setValueAtTime(170,t);
  o.frequency.exponentialRampToValueAtTime(85,t+.07);
  const g2=c.createGain();
  g2.gain.setValueAtTime(vol*.8,t); g2.gain.exponentialRampToValueAtTime(.001,t+.08);
  o.connect(g2).connect(c.destination); o.start(t); o.stop(t+.1);
}
export function sndShotFar(dist){
  const c=audio(), t=c.currentTime + dist/ENV.snd;
  const n=c.createBufferSource(); n.buffer=noiseBuf;
  const f=c.createBiquadFilter(); f.type="lowpass"; f.frequency.value=1200;
  const g=c.createGain();
  const vol=Math.min(.22, 4/Math.max(4,dist));
  g.gain.setValueAtTime(vol,t); g.gain.exponentialRampToValueAtTime(.001,t+.09);
  n.connect(f).connect(g).connect(c.destination); n.start(t); n.stop(t+.12);
}
export function sndHitMe(){
  const c=audio(), t=c.currentTime;
  const o=c.createOscillator(); o.type="sawtooth";
  o.frequency.setValueAtTime(220,t); o.frequency.exponentialRampToValueAtTime(60,t+.15);
  const g=c.createGain();
  g.gain.setValueAtTime(.5,t); g.gain.exponentialRampToValueAtTime(.001,t+.18);
  o.connect(g).connect(c.destination); o.start(t); o.stop(t+.2);
}
