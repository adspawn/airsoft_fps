/* ============================================================
   射撃練習場のターゲット（プレート・マンターゲット・空き缶）とタイムアタック
   ============================================================ */
import { THREE, S, scene, $, RT, targets, weapon, MAG_SIZE, WIND } from "./state.js";
import { spawnParticles, showMsg } from "./effects.js";
import { sndPing, sndTink, sndThock } from "./sound.js";
import { updateAmmoHUD } from "./player.js";

export const plateMat  = new THREE.MeshStandardMaterial({color:0xe8e8e8, metalness:0.85, roughness:0.35});
const plateHit  = new THREE.MeshStandardMaterial({color:0xff9d2e, metalness:0.85, roughness:0.35});
const postMat   = new THREE.MeshLambertMaterial({color:0x3a3f45});

function baseTarget(type,grp,x,z){
  const tg={type, grp, baseX:x, z, alive:true, animT:-1, respawnAt:0, mover:null,
    pivot:null, plate:null, zones:[]};
  targets.push(tg);
  return tg;
}
// 判定ゾーン（y=中心高さ, r=半径, mult=得点倍率）
function zone(y,r,mult=1){ return {off:y, r, mult, world:new THREE.Vector3()}; }

export function addPlate(x,z,{r=0.15,h=1.2,mover=null}={}){
  const grp=new THREE.Group();
  grp.position.set(x,0,z);
  const post=new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.035,h), postMat);
  post.position.y=h/2; post.castShadow=true;
  grp.add(post);
  const pivot=new THREE.Group(); pivot.position.y=h;
  const plate=new THREE.Mesh(new THREE.CylinderGeometry(r,r,0.02,28), plateMat.clone());
  plate.rotation.x=Math.PI/2; plate.position.y=r;
  plate.castShadow=true;
  pivot.add(plate);
  grp.add(pivot);
  scene.add(grp);
  const tg=baseTarget("plate",grp,x,z);
  tg.pivot=pivot; tg.plate=plate; tg.mover=mover;
  tg.zones=[zone(h+r,r)];
}

/* マンターゲット（合板シルエット、頭 = 2倍） */
const manBoardMat=new THREE.MeshLambertMaterial({color:0xcaa165});
export function addMan(x,z){
  const grp=new THREE.Group(); grp.position.set(x,0,z);
  const pivot=new THREE.Group(); grp.add(pivot);
  const post=new THREE.Mesh(new THREE.BoxGeometry(.08,.4,.03), postMat);
  post.position.y=.2; pivot.add(post);
  const torso=new THREE.Mesh(new THREE.BoxGeometry(.5,.75,.03), manBoardMat);
  torso.position.y=.78; torso.castShadow=true; pivot.add(torso);
  const neck=new THREE.Mesh(new THREE.BoxGeometry(.14,.10,.03), manBoardMat);
  neck.position.y=1.20; pivot.add(neck);
  const head=new THREE.Mesh(new THREE.CylinderGeometry(.155,.155,.03,20), manBoardMat);
  head.rotation.x=Math.PI/2; head.position.y=1.33; head.castShadow=true; pivot.add(head);
  const ring=new THREE.Mesh(new THREE.CylinderGeometry(.09,.09,.034,16),
    new THREE.MeshLambertMaterial({color:0xb33a2f}));
  ring.rotation.x=Math.PI/2; ring.position.set(0,.85,0.002); pivot.add(ring);
  scene.add(grp);
  const tg=baseTarget("man",grp,x,z);
  tg.pivot=pivot;
  tg.zones=[zone(1.33,.18,2), zone(.78,.34,1)];
}

/* 空き缶（当たると吹き飛ぶ） */
const canColors=[0xd9d9d9,0xc0392b,0x2e9e5b,0x2980b9];
export function addCan(x,y,z){
  const grp=new THREE.Group(); grp.position.set(x,y,z);
  const body=new THREE.Mesh(new THREE.CylinderGeometry(0.033,0.033,0.115,14),
    new THREE.MeshStandardMaterial({color:canColors[Math.floor(Math.random()*canColors.length)],
      metalness:0.7, roughness:0.4}));
  body.position.y=0.0575; body.castShadow=true; grp.add(body);
  const top=new THREE.Mesh(new THREE.CylinderGeometry(0.034,0.034,0.006,14),
    new THREE.MeshStandardMaterial({color:0xbfbfbf, metalness:0.9, roughness:0.3}));
  top.position.y=0.115; grp.add(top);
  scene.add(grp);
  const tg=baseTarget("can",grp,x,z);
  tg.homeY=y; tg.zones=[zone(y+0.06,0.085)];
  tg.vel=new THREE.Vector3(); tg.angVel=new THREE.Vector3(); tg.flying=false;
}

/* ============================================================
   ターゲットヒット
   ============================================================ */
let hitInfoTimer=null;
export function flashHitmarker(text){
  $("hitmarker").classList.remove("show"); void $("hitmarker").offsetWidth;
  $("hitmarker").classList.add("show");
  $("hitinfo").textContent=text;
  $("hitinfo").classList.add("show");
  clearTimeout(hitInfoTimer);
  hitInfoTimer=setTimeout(()=>$("hitinfo").classList.remove("show"),900);
}
/* 着弾表示（射撃練習のみ）: 自分の撃ったBBが着弾した距離と、そのときの残存エネルギー。
   初速時のエネルギーと比べてどれだけ減衰したかが分かるよう到達エネルギーもJで出す */
const IMPACT_LABELS={target:"命中", ground:"着弾", obstacle:"命中(障害物)", stall:"失速"};
export function onImpact({dist, energy, speed, kind}){
  if (S.mode!=="range") return;
  $("impactDist").textContent = dist.toFixed(1)+"m";
  $("impactEnergy").textContent = energy.toFixed(3)+" J";
  $("impactSpeed").textContent = speed.toFixed(0)+" m/s";
  $("impactKind").textContent = IMPACT_LABELS[kind]||kind;
  const el=$("impactRow");
  el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
}
export function onTargetHit(tg, bb, zn){
  tg.alive=false;
  const dist=bb.pos.distanceTo(bb.start);
  let pts, label="";
  if (tg.type==="can"){
    // 缶は小さいので距離×3点、BBの運動量で吹き飛ぶ
    pts=Math.max(5,Math.round(dist*3));
    label="空き缶！";
    tg.flying=true;
    tg.vel.copy(bb.vel).multiplyScalar(0.02);
    tg.vel.y=Math.max(tg.vel.y,1.4+Math.random());
    tg.angVel.set((Math.random()*2-1)*16,0,(Math.random()*2-1)*16);
    tg.respawnAt=RT.gNow+3;
    sndTink(dist);
  } else {
    const mult=(tg.mover?2:1)*zn.mult;
    pts=Math.max(1,Math.round(dist))*mult;
    if (zn.mult>1) label="ヘッドショット×2";
    else if (tg.mover) label="ムーバー×2";
    tg.animT=0; tg.respawnAt=RT.gNow+2.4;
    if (tg.plate){ tg.plate.material=plateHit; sndPing(dist); }
    else sndThock(dist);
  }
  S.score+=pts; S.hits++;
  spawnParticles(bb.pos, tg.type==="plate"?0xffe9a8:0xd8c9a0, 6, 1.6);
  const impactE=0.5*(S.massG*1e-3)*bb.vel.lengthSq();
  flashHitmarker(`+${pts}${label?" "+label:""}　${dist.toFixed(1)}m / ${impactE.toFixed(2)}J`);
  updateScoreHUD();
}
export function updateScoreHUD(){
  $("score").textContent=S.score;
  $("acc").textContent=S.shots? Math.round(100*S.hits/S.shots)+"%" : "—";
}
/* ============================================================
   吹き流し（ウインドソック）
   風向と風速を視覚的に示す射撃場の設備。
   - 筒は風下（風が吹いていく向き）へなびく
   - 風が弱いほど垂れ下がり、規定風速で水平になる（実物と同じ挙動）
   - 風速に応じて揺らぎ（フラッター）が強くなる
   ============================================================ */
const WINDSOCK_FULL_SPEED = 12;   // この風速[m/s]で完全に水平になる
const windsocks = [];
function buildWindsock(x, z, poleH=4.2){
  const grp=new THREE.Group();
  grp.position.set(x,0,z);
  const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.06,poleH), postMat);
  pole.position.y=poleH/2; pole.castShadow=true; grp.add(pole);
  // 支柱の先端にリング（筒の口）＋そこから伸びる吹き流し本体
  const sock=new THREE.Group();
  sock.position.y=poleH;
  sock.rotation.order="YXZ";   // 先に方位(Y)、次に垂れ下がり(X)を適用したいため
  grp.add(sock);
  const ring=new THREE.Mesh(new THREE.TorusGeometry(0.28,0.035,8,18),
    new THREE.MeshLambertMaterial({color:0xdddddd}));
  ring.rotation.y=Math.PI/2; sock.add(ring);
  /* 筒はローカル+Z方向へ伸ばす（=なびく向き）。橙/白の縞を5段の円錐台で作り、
     根元(0.28m)から先端(0.13m)へ細くする */
  const segN=5, segLen=0.52;
  const matO=new THREE.MeshLambertMaterial({color:0xff7a1a, side:THREE.DoubleSide});
  const matW=new THREE.MeshLambertMaterial({color:0xf2f2f2, side:THREE.DoubleSide});
  const segs=[];
  for (let i=0;i<segN;i++){
    const r0=0.28+(0.13-0.28)*(i/segN), r1=0.28+(0.13-0.28)*((i+1)/segN);
    const m=new THREE.Mesh(new THREE.CylinderGeometry(r1,r0,segLen,14,1,true), i%2?matW:matO);
    m.rotation.x=Math.PI/2;                       // 円柱の軸(Y)を+Zへ倒す
    m.position.z=segLen*(i+0.5);
    m.castShadow=true;
    sock.add(m); segs.push(m);
  }
  scene.add(grp);
  windsocks.push({grp, sock, segs, phase:Math.random()*Math.PI*2});
  return grp;
}
buildWindsock(-15,-24);
buildWindsock( 15,-46);
export function updateWindsocks(now){
  const speed=S.windSpeed;
  const t=Math.min(1, speed/WINDSOCK_FULL_SPEED);
  // 風がある向き（=WINDベクトルの方位）へ筒を向ける。無風時は前回の向きを保つ
  const yaw = speed>0.01 ? Math.atan2(WIND.x, WIND.z) : null;
  const droop = (1-t)*Math.PI/2;   // 0=水平, π/2=真下へ垂れる
  for (const ws of windsocks){
    if (yaw!==null) ws.sock.rotation.y = yaw + Math.sin(now*1.7+ws.phase)*0.10*t;
    ws.sock.rotation.x = droop + Math.sin(now*2.3+ws.phase)*0.05*t;
    // 各節をわずかに波打たせて布らしく見せる（風が強いほど速く小さく波打つ）
    for (let i=0;i<ws.segs.length;i++){
      ws.segs[i].rotation.z = Math.sin(now*(3+speed*0.25)+ws.phase+i*0.6)*0.06*t;
    }
  }
}
export function updateTargets(dt,now){
  updateWindsocks(now);   // 吹き流しは的の生死に関係なく常に更新する
  if (S.mode!=="range") return;   // 射撃練習モード以外は非表示
  for (const tg of targets){
    if (tg.mover){
      tg.grp.position.x = tg.baseX + Math.sin(now*tg.mover.speed+tg.mover.phase)*tg.mover.amp;
    }
    for (const zn of tg.zones) zn.world.set(tg.grp.position.x, zn.off, tg.grp.position.z);
    if (tg.alive) continue;
    if (tg.type==="can"){
      if (tg.flying){
        tg.vel.y-=9.8*dt;
        tg.grp.position.addScaledVector(tg.vel,dt);
        tg.grp.rotation.x+=tg.angVel.x*dt;
        tg.grp.rotation.z+=tg.angVel.z*dt;
        if (tg.grp.position.y<=0.03){ tg.grp.position.y=0.03; tg.flying=false; }
      }
      if (now>=tg.respawnAt){
        tg.grp.position.set(tg.baseX,tg.homeY,tg.z);
        tg.grp.rotation.set(0,0,0); tg.vel.set(0,0,0);
        tg.flying=false; tg.alive=true;
      }
    } else if (tg.animT>=0){   // プレート/マン: 倒れる→起き上がり
      tg.animT+=dt;
      tg.pivot.rotation.x=Math.min(1.35, tg.animT/0.12*1.35);
      if (now>tg.respawnAt-0.3){
        const f=1-Math.max(0,(tg.respawnAt-now))/0.3;
        tg.pivot.rotation.x=1.35*(1-f);
      }
      if (now>=tg.respawnAt){
        tg.pivot.rotation.x=0; tg.alive=true; tg.animT=-1;
        if (tg.plate) tg.plate.material=plateMat;
      }
    }
  }
}

// 静的プレート
addPlate(-3,-10); addPlate(2.5,-10,{h:0.9});
addPlate(-1,-15,{h:1.35});
addPlate(4,-20); addPlate(-4.5,-20,{h:0.95});
addPlate(0,-25,{h:1.25});
addPlate(6,-30); addPlate(-6,-30,{h:1.0});
addPlate(2,-40,{r:0.18});
addPlate(-3,-50,{r:0.20,h:1.3});
addPlate(0,-60,{r:0.25,h:1.4});
addPlate(8,-15,{h:0.8}); addPlate(-8,-25,{r:0.18});
// ムーバー（横移動、得点2倍）
addPlate(0,-22,{h:1.3, mover:{amp:4,  speed:1.5, phase:0}});
addPlate(0,-35,{r:0.18, mover:{amp:6.5,speed:0.9, phase:2}});
// マンターゲット
addMan(7,-18); addMan(-7,-22); addMan(3,-35); addMan(-2,-45);

/* ============================================================
   タイムアタック
   ============================================================ */
export function startChallenge(){
  S.challenge.active=true; S.challenge.tLeft=60;
  S.score=0; S.shots=0; S.hits=0;
  weapon.mag=MAG_SIZE; weapon.reloading=false;
  updateScoreHUD(); updateAmmoHUD();
  showMsg("タイムアタック開始！ 60秒",1.5);
}
export function updateChallenge(dt){
  if (!S.challenge.active) return;
  S.challenge.tLeft-=dt;
  if (S.challenge.tLeft<=0){
    S.challenge.active=false;
    $("timer").textContent="";
    showMsg(`終了！ スコア ${S.score}　命中率 ${S.shots?Math.round(100*S.hits/S.shots):0}%`,4);
  } else {
    $("timer").textContent="⏱ "+Math.ceil(S.challenge.tLeft)+"s";
  }
}
