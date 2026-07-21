/* ============================================================
   パーティクル & 画面中央メッセージ
   ============================================================ */
import { THREE, scene, $ } from "./state.js";

const sparkTex=(()=> {
  const c=document.createElement("canvas"); c.width=c.height=32;
  const g=c.getContext("2d");
  const rg=g.createRadialGradient(16,16,0,16,16,16);
  rg.addColorStop(0,"rgba(255,255,255,1)"); rg.addColorStop(1,"rgba(255,255,255,0)");
  g.fillStyle=rg; g.fillRect(0,0,32,32);
  return new THREE.CanvasTexture(c);
})();
const particles=[];
for(let i=0;i<100;i++){
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({
    map:sparkTex, transparent:true, depthWrite:false}));
  sp.visible=false; sp.scale.set(.1,.1,1); scene.add(sp);
  particles.push({sp, vel:new THREE.Vector3(), life:0});
}
export function spawnParticles(pos,color,n,speed){
  let c=0;
  for(const p of particles){
    if (p.life>0) continue;
    p.life=.4+Math.random()*.25;
    p.sp.material.color.setHex(color);
    p.sp.material.opacity=1;
    p.sp.position.copy(pos);
    p.vel.set((Math.random()-.5)*2,(Math.random()*.9),(Math.random()-.5)*2)
      .normalize().multiplyScalar(speed*(.5+Math.random()));
    p.sp.visible=true;
    if(++c>=n) break;
  }
}
export function updateParticles(dt){
  for(const p of particles){
    if (p.life<=0) continue;
    p.life-=dt;
    if (p.life<=0){ p.sp.visible=false; continue; }
    p.vel.y-=6*dt;
    p.sp.position.addScaledVector(p.vel,dt);
    p.sp.material.opacity=Math.min(1,p.life*3);
  }
}

let msgTimer=null;
export function showMsg(text,dur=1.6){
  $("centerMsg").textContent=text;
  $("centerMsg").classList.add("show");
  clearTimeout(msgTimer);
  msgTimer=setTimeout(()=>$("centerMsg").classList.remove("show"),dur*1000);
}
