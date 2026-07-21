/* ============================================================
   対戦(NPC)モード: NPC AI・バリケード配置・フラッグ・被弾死亡演出
   （被弾死亡演出はPVPモードとも共有）
   移動はYuka(操舵行動: Arrive+障害物回避+NPC間分離)、意思決定(状態遷移・
   難易度・射撃タイミング)は自前のFSMという分担。
   ============================================================ */
import { THREE, S, scene, camera, $, RT, obstacles, VS_ARENA, EDIT_AREA, currentBounds,
  coverPoints, spawnPoints, ENEMY_FLAG, PLAYER_FLAG, crateMat, bots, player, pvp } from "./state.js";
import * as YUKA from "../libs/yuka.module.js";
import { spawnParticles, showMsg } from "./effects.js";
import { sndPing, sndShotFar, sndHitMe } from "./sound.js";
import { spawnBB } from "./bb.js";
import { applySpread } from "./player.js";
import { gunProcedural, gunCorrected } from "./gun.js";
import { flashHitmarker } from "./targets.js";

export const DIFF_PARAMS={
  weak:  {spread:3.5, react:0.9,  burst:2, cycle:5,  speed:2.2, lead:0,   engage:2.2},
  normal:{spread:1.8, react:0.5,  burst:4, cycle:9,  speed:3.2, lead:0.5, engage:3.0},
  strong:{spread:0.8, react:0.25, burst:7, cycle:14, speed:4.3, lead:1.0, engage:3.5},
};
export const DIFF_NAMES={weak:"よわい", normal:"ふつう", strong:"つよい"};
const _v1=new THREE.Vector3(), _v2=new THREE.Vector3(),
      _v3=new THREE.Vector3(), _v4=new THREE.Vector3();

/* ============================================================
   Yuka 操舵基盤
   - AABB障害物を球の列に分解して ObstacleAvoidanceBehavior に渡す
     （Yukaの回避は boundingRadius=球 前提のため。細長いベニア板は複数球で覆う）
   - NPC同士は SeparationBehavior で自然に距離を取る
   - 障害物エンティティは EntityManager に登録しない（登録するとNPCの
     「近傍」に含まれて分離挙動がカバー位置から押し出してしまうため、
     回避ビヘイビアへ配列参照で渡すだけにする）
   ============================================================ */
export const botAI = {
  manager: new YUKA.EntityManager(),
  obstacles: [],   // YUKA.GameEntity(球)の配列。参照をビヘイビアと共有するため再代入禁止
};
/* 現在の obstacles(AABB) からYuka用の球障害物を再構築。
   genVsField() がバリケードを再配置するたびに呼ばれる。
   NPCの行動範囲は対戦アリーナ内に限られるので、アリーナ外(射撃練習場側)の
   障害物は除外して回避判定のコストを抑える */
export function rebuildYukaObstacles(){
  botAI.obstacles.length=0;
  const m=6;   // アリーナ境界からのマージン
  for (const box of obstacles){
    if (box.min.y>1.5) continue;   // 高所（積み上げ上段）は地上移動の妨げにならない
    const cx=(box.max.x+box.min.x)/2, cz=(box.max.z+box.min.z)/2;
    if (cx<EDIT_AREA.xMin-m || cx>EDIT_AREA.xMax+m ||
        cz<EDIT_AREA.zMin-m || cz>EDIT_AREA.zMax+m) continue;
    const hw=(box.max.x-box.min.x)/2, hd=(box.max.z-box.min.z)/2;
    const long=Math.max(hw,hd), short=Math.min(hw,hd);
    const r=short+0.3;
    // 長軸方向に球を重なりを持たせて並べる（隙間があるとNPCが壁の中央へ突っ込む）
    const n=Math.max(1, Math.ceil((long-short)/(0.7*r))+1);
    for (let i=0;i<n;i++){
      const t = n===1 ? 0 : (i/(n-1))*2-1;   // -1..+1
      const off = t*(long-short);
      const e=new YUKA.GameEntity();
      e.position.set(hw>=hd ? cx+off : cx, 0, hw>=hd ? cz : cz+off);
      e.boundingRadius=r;
      botAI.obstacles.push(e);
    }
  }
}
/* 移動指示: 目的地(x,z)へ向けて操舵開始 */
export function setBotSeek(bot, x, z, speed){
  bot.arriveTarget.set(x, 0, z);
  bot.arrive.active=true;
  bot.vehicle.maxSpeed=speed;
}
/* 停止指示: 交戦中・死亡中はその場に留まる */
export function setBotHold(bot){
  bot.arrive.active=false;
  bot.vehicle.maxSpeed=0;
  bot.vehicle.velocity.set(0,0,0);
}
/* 全ビークルの操舵を1ステップ進める（フレームに1回、per-bot処理の後に呼ぶ） */
export function yukaUpdate(dt){
  botAI.manager.update(dt);
}
/* Yukaの計算結果をbot.posへ反映し、AABB衝突・境界クランプ(安全網)を掛けて
   押し戻した位置をビークルへ書き戻す（ズレたまま次フレームへ持ち越さない） */
export function syncBotFromVehicle(bot){
  bot.pos.x=bot.vehicle.position.x;
  bot.pos.z=bot.vehicle.position.z;
  resolveBotCollision(bot);
  bot.vehicle.position.x=bot.pos.x;
  bot.vehicle.position.z=bot.pos.z;
}

let enemyFlagMesh=null, playerFlagMesh=null, lastFlagDist=-1;
export const vsProps={meshes:[], obstacles:[]};

export function buildFlag(color){
  const grp=new THREE.Group();
  const base=new THREE.Mesh(new THREE.CylinderGeometry(.3,.35,.12,14),
    new THREE.MeshLambertMaterial({color:0x333333}));
  base.position.y=.06; grp.add(base);
  const pole=new THREE.Mesh(new THREE.CylinderGeometry(.025,.025,2.3),
    new THREE.MeshLambertMaterial({color:0xcccccc}));
  pole.position.y=1.2; pole.castShadow=true; grp.add(pole);
  const flag=new THREE.Mesh(new THREE.PlaneGeometry(.8,.5),
    new THREE.MeshLambertMaterial({color, side:THREE.DoubleSide}));
  flag.position.set(.42,2.0,0); flag.castShadow=true; grp.add(flag);
  return grp;
}
function addVsProp(mesh, hw, hd, h, y0=0){
  scene.add(mesh); vsProps.meshes.push(mesh);
  const x=mesh.position.x, z=mesh.position.z;
  const o={min:new THREE.Vector3(x-hw,y0,z-hd), max:new THREE.Vector3(x+hw,y0+h,z+hd)};
  obstacles.push(o); vsProps.obstacles.push(o);
}
export function clearVsField(){
  for (const m of vsProps.meshes) scene.remove(m);
  vsProps.meshes.length=0;
  for (const o of vsProps.obstacles){
    const i=obstacles.indexOf(o); if (i>=0) obstacles.splice(i,1);
  }
  vsProps.obstacles.length=0;
  enemyFlagMesh=playerFlagMesh=null;
}
const drumColors=[0x9c4a2f,0x5a6b3c,0x3a5a8c,0x777777];
const plyMat=new THREE.MeshLambertMaterial({color:0xc9a86b});

/* ---- プロップ共通（ランダム生成・カスタムマップ・設置モードで共用） ----
   t: "ply"(ベニア板 0.9幅×1.8高 縦向き) | "drum"(ドラム缶) | "crate"(木箱)
   o: 設置角度（度, 0〜315を45刻み）。ドラム缶は円柱なので回転しても寸法は変わらない */
export const PROP_NAMES={ply:"ベニア板", drum:"ドラム缶", crate:"木箱"};
export function propDims(t,o){
  if (t==="drum") return {hw:.3, hd:.3, h:.9};
  const baseHw = t==="crate"? .55 : .45;
  const baseHd = t==="crate"? .55 : .03;
  const rad=(o||0)*Math.PI/180;
  const c=Math.abs(Math.cos(rad)), s=Math.abs(Math.sin(rad));
  return {hw: baseHw*c+baseHd*s, hd: baseHw*s+baseHd*c, h: t==="crate"?1.1:1.8};
}
export function makePropMesh(t,o){
  let m;
  if (t==="drum"){
    m=new THREE.Mesh(new THREE.CylinderGeometry(.3,.3,.9,16),
      new THREE.MeshLambertMaterial({color:drumColors[Math.floor(Math.random()*drumColors.length)]}));
  } else if (t==="crate"){
    m=new THREE.Mesh(new THREE.BoxGeometry(1.1,1.1,1.1), crateMat);
  } else {
    m=new THREE.Mesh(new THREE.BoxGeometry(.9,1.8,.05), plyMat);
  }
  m.rotation.y=(o||0)*Math.PI/180;
  m.position.y=propDims(t,o).h/2;
  m.castShadow=true; m.receiveShadow=true;
  return m;
}
/* カスタムマップ保存(localStorage) */
export const MAP_KEY="airsoft_fps_custom_map";
export function loadCustomMap(){
  try{
    const j=JSON.parse(localStorage.getItem(MAP_KEY)||"null");
    return Array.isArray(j)?j:null;
  }catch(e){ return null; }
}

/* ランダム配置データを生成（シーンには触れず、配置データ配列を返すだけ）。
   PVPホストが試合開始前に一度だけ生成してサーバー経由で全クライアントに配布し、
   同一のバリケード配置を共有するのに使う（各クライアントが個別にMath.random()すると
   プレイヤーごとにバリケード位置がズレてしまうため） */
export function genRandomVsProps(){
  const rnd=(a,b)=>a+Math.random()*(b-a);
  const placed=[];
  const list=[];
  function findSpot(hw,hd){
    for (let k=0;k<70;k++){
      const x=rnd(EDIT_AREA.xMin+2,EDIT_AREA.xMax-2), z=rnd(EDIT_AREA.zMin+4,EDIT_AREA.zMax-8);
      let ok=true;
      for (const q of placed){
        if (Math.abs(x-q.x)<q.hw+hw+1.4 && Math.abs(z-q.z)<q.hd+hd+1.4){ ok=false; break; }
      }
      if (ok) for (const o of obstacles){
        if (x>o.min.x-hw-1 && x<o.max.x+hw+1 &&
            z>o.min.z-hd-1 && z<o.max.z+hd+1){ ok=false; break; }
      }
      if (ok){ placed.push({x,z,hw,hd}); return {x,z}; }
    }
    return null;
  }
  for (const [t,n] of [["drum",14],["ply",14],["crate",14]]){
    for (let i=0;i<n;i++){
      const o=Math.random()<0.5?1:0;
      const dim=propDims(t,o);
      const p=findSpot(dim.hw,dim.hd); if (!p) continue;
      list.push({t, x:p.x, y:0, z:p.z, o});
    }
  }
  return list;
}
/* ドラム缶・ベニア板・木箱を配置。
   data省略時: カスタムマップ優先、なければランダム自動生成（シングルプレイ/対戦NPC用）
   data指定時: そのデータをそのまま配置（PVPで全クライアントの配置を揃えるため） */
export function genVsField(data){
  clearVsField();
  const placed=[];
  let list=data;
  if (!list || !list.length){
    const custom = S.vsMap==="custom" ? loadCustomMap() : null;
    if (custom && custom.length) list=custom;
    else {
      if (S.vsMap==="custom") showMsg("カスタムマップ未保存 → ランダム配置",2.5);
      list=genRandomVsProps();
    }
  }
  for (const d of list){
    const dim=propDims(d.t,d.o);
    const m=makePropMesh(d.t,d.o);
    m.position.set(d.x, (d.y||0)+dim.h/2, d.z);
    addVsProp(m,dim.hw,dim.hd,dim.h,d.y||0);
    if (!d.y) placed.push({x:d.x,z:d.z,hw:dim.hw,hd:dim.hd});
  }
  // NPCのカバーポイントを配置物の前後に再生成
  coverPoints.length=0;
  for (const q of placed){
    coverPoints.push([q.x, q.z-q.hd-0.9], [q.x, q.z+q.hd+0.9]);
  }
  coverPoints.push([VS_ARENA.cx-16,VS_ARENA.cz+5],[VS_ARENA.cx+16,VS_ARENA.cz+5],
    [VS_ARENA.cx,VS_ARENA.cz-5],[VS_ARENA.cx-15,VS_ARENA.cz-15],[VS_ARENA.cx+15,VS_ARENA.cz-15]);
  // フラッグ設置（対戦(NPC)のフラッグ戦、またはPVPのフラッグ戦のときのみ。殲滅戦・バトルロワイアルでは旗を使わない）
  if ((S.mode==="vs" && S.vsRuleset==="flag") || (S.mode==="pvp" && pvp.gameType==="flag")){
    enemyFlagMesh=buildFlag(0xd8352a);
    enemyFlagMesh.position.set(ENEMY_FLAG.x,0,ENEMY_FLAG.z);
    scene.add(enemyFlagMesh); vsProps.meshes.push(enemyFlagMesh);
    playerFlagMesh=buildFlag(0x2a6fd8);
    playerFlagMesh.position.set(PLAYER_FLAG.x,0,PLAYER_FLAG.z);
    scene.add(playerFlagMesh); vsProps.meshes.push(playerFlagMesh);
  }
  // バリケード配置が変わったのでYukaの回避用障害物も作り直す
  rebuildYukaObstacles();
}

export function buildBotMesh(){
  const g=new THREE.Group();
  const green=new THREE.MeshLambertMaterial({color:0x4a5d3a});
  const dark =new THREE.MeshLambertMaterial({color:0x33402c});
  const skin =new THREE.MeshLambertMaterial({color:0xc8a67f});
  const black=new THREE.MeshLambertMaterial({color:0x222222});
  const mk=(geo,mat,x,y,z)=>{const m=new THREE.Mesh(geo,mat);
    m.position.set(x,y,z); m.castShadow=true; g.add(m); return m;};
  mk(new THREE.BoxGeometry(.3,.8,.22), dark, 0,.4,0);       // 脚
  mk(new THREE.BoxGeometry(.42,.55,.26), green, 0,1.07,0);  // 胴
  mk(new THREE.SphereGeometry(.14,10,8), skin, 0,1.5,0);    // 頭
  mk(new THREE.BoxGeometry(.34,.09,.30), green, 0,1.62,0);  // 帽子
  mk(new THREE.BoxGeometry(.05,.09,.55), black, .13,1.25,-.25); // 銃
  return g;
}

/* ---- 被弾死亡演出: プレイヤーが倒れながら三人称視点へカメラが引いていく ---- */
const DEATH_FALL_TIME=0.9, DEATH_PULL_TIME=1.6;
let deathT=0, deathBodyPivot=null;
const _deathStartCamPos=new THREE.Vector3(), _deathBodyPos=new THREE.Vector3(),
      _deathBack=new THREE.Vector3(), _deathTarget=new THREE.Vector3(), _deathLook=new THREE.Vector3();
function ensureDeathBody(){
  if (deathBodyPivot) return;
  deathBodyPivot=new THREE.Group();
  deathBodyPivot.add(buildBotMesh());
  deathBodyPivot.visible=false;
  scene.add(deathBodyPivot);
}
export function getDeathBodyPivot(){ return deathBodyPivot; }
export function startDeathSequence(){
  ensureDeathBody();
  RT.dying=true; deathT=0;
  deathBodyPivot.position.set(player.pos.x, player.pos.y, player.pos.z);
  deathBodyPivot.rotation.set(0, player.yaw, 0);
  deathBodyPivot.visible=true;
  gunProcedural.visible=false;
  if (gunCorrected) gunCorrected.visible=false;
  _deathStartCamPos.copy(camera.position);
}
export function endDeathSequence(){
  RT.dying=false;
  if (deathBodyPivot) deathBodyPivot.visible=false;
  gunProcedural.visible = !gunCorrected;
  if (gunCorrected) gunCorrected.visible=true;
}
export function updateDeathCam(dt){
  deathT+=dt;
  const fallP=Math.min(1, deathT/DEATH_FALL_TIME);
  deathBodyPivot.rotation.x=fallP*fallP*1.45;   // 加速しながら前のめりに崩れ落ちる
  const pullP=Math.min(1, deathT/DEATH_PULL_TIME);
  const eased=1-Math.pow(1-pullP,3);
  _deathBodyPos.set(deathBodyPivot.position.x, 0.6, deathBodyPivot.position.z);
  _deathBack.set(Math.sin(player.yaw), 0, Math.cos(player.yaw)).multiplyScalar(3.4);
  _deathTarget.copy(_deathBodyPos).add(_deathBack).add(new THREE.Vector3(0,2.1,0));
  camera.position.lerpVectors(_deathStartCamPos, _deathTarget, eased);
  _deathLook.copy(_deathBodyPos).y -= fallP*0.3;
  camera.lookAt(_deathLook);
}

export function pickWp(bot){
  const r=Math.random();
  // フラッグ戦: 一定確率で自陣フラッグへ直行、または前進側のカバーへ（殲滅戦・PVPでは旗が無いので使わない）
  if (bot && S.mode==="vs" && S.vsRuleset==="flag" && r<0.18){
    return {x:PLAYER_FLAG.x+(Math.random()*2-1)*1.5, z:PLAYER_FLAG.z-1.2+(Math.random()*2-1)};
  }
  if (bot && r<0.60){
    const ahead=coverPoints.filter(p=>p[1]>bot.pos.z+2);
    if (ahead.length){
      const p=ahead[Math.floor(Math.random()*ahead.length)];
      return {x:p[0]+(Math.random()*2-1)*1.2, z:p[1]+(Math.random()*2-1)*1.2};
    }
  }
  const p=coverPoints[Math.floor(Math.random()*coverPoints.length)];
  return {x:p[0]+(Math.random()*2-1)*1.2, z:p[1]+(Math.random()*2-1)*1.2};
}
/* opts: {team, diff, spawnSet, idOffset} — 未指定時は従来通り(対戦(NPC)シングルプレイ用) */
export function spawnBots(n, opts){
  const o=opts||{};
  const team=o.team||null, diff=o.diff||S.diff, pts=o.spawnSet||spawnPoints, idOffset=o.idOffset||0;
  for (let i=0;i<n;i++){
    const grp=buildBotMesh(); scene.add(grp);
    const sp=pts[i%pts.length];
    const bot={grp, pos:new THREE.Vector3(sp[0],0,sp[1]), yaw:0, targetYaw:0,
      state:"move", wp:null, moveT:0, timer:0, reactT:0, cooldown:0,
      burstLeft:0, pauseT:0, alive:true, fallT:0, netId:idOffset+i, team, diff};
    bot.wp=pickWp(bot);
    grp.position.copy(bot.pos);
    // Yukaビークル（操舵担当）: 障害物回避+NPC間分離+到着。姿勢・yawは自前管理
    const vehicle=new YUKA.Vehicle();
    vehicle.position.set(sp[0],0,sp[1]);
    vehicle.maxSpeed=DIFF_PARAMS[diff].speed;
    vehicle.maxForce=10;                 // 加速度上限（急旋回しすぎない程度の滑らかさ）
    vehicle.boundingRadius=0.4;
    vehicle.updateOrientation=false;     // 向きはangleDeltaで自前スムージング
    vehicle.updateNeighborhood=true;     // SeparationBehavior用の近傍更新
    vehicle.neighborhoodRadius=2.5;
    const arriveTarget=new YUKA.Vector3(bot.wp.x,0,bot.wp.z);
    const arrive=new YUKA.ArriveBehavior(arriveTarget,2,0.3);
    const avoid=new YUKA.ObstacleAvoidanceBehavior(botAI.obstacles);
    avoid.weight=3;
    const sep=new YUKA.SeparationBehavior();
    sep.weight=1.5;
    vehicle.steering.add(avoid);
    vehicle.steering.add(sep);
    vehicle.steering.add(arrive);
    bot.vehicle=vehicle; bot.arrive=arrive; bot.arriveTarget=arriveTarget;
    botAI.manager.add(vehicle);
    bots.push(bot);
  }
}
export function clearBots(){
  for (const b of bots){
    scene.remove(b.grp);
    if (b.vehicle) botAI.manager.remove(b.vehicle);
  }
  bots.length=0;
}
/* 遮蔽物チェック（銃口→ターゲット胸の直線をサンプリング）。tgt省略時はローカルプレイヤー。
   PVPでは他プレイヤー({pos,eyeH}形状のオブジェクト)も指定できる */
export function losClear(bot, tgt){
  const t=tgt||player;
  const x0=bot.pos.x, y0=bot.pos.y+1.32, z0=bot.pos.z;
  const x1=t.pos.x, y1=t.pos.y+t.eyeH-0.3, z1=t.pos.z;
  for (let i=1;i<14;i++){
    const tt=i/14, px=x0+(x1-x0)*tt, py=y0+(y1-y0)*tt, pz=z0+(z1-z0)*tt;
    for (const o of obstacles){
      if (px>o.min.x&&px<o.max.x&&py>o.min.y&&py<o.max.y&&pz>o.min.z&&pz<o.max.z)
        return false;
    }
  }
  return true;
}
export function resolveBotCollision(bot){
  const b=currentBounds();
  bot.pos.x=THREE.MathUtils.clamp(bot.pos.x,b.xMin+0.8,b.xMax-0.8);
  bot.pos.z=THREE.MathUtils.clamp(bot.pos.z,b.zMin+0.8,b.zMax-0.8);
  const r=0.4;
  for (const o of obstacles){
    if (o.min.y<1.5 &&
        bot.pos.x>o.min.x-r&&bot.pos.x<o.max.x+r&&
        bot.pos.z>o.min.z-r&&bot.pos.z<o.max.z+r){
      const a=bot.pos.x-(o.min.x-r), b=(o.max.x+r)-bot.pos.x;
      const c2=bot.pos.z-(o.min.z-r), d2=(o.max.z+r)-bot.pos.z;
      const mp=Math.min(a,b,c2,d2);
      if (mp===a) bot.pos.x=o.min.x-r;
      else if (mp===b) bot.pos.x=o.max.x+r;
      else if (mp===c2) bot.pos.z=o.min.z-r;
      else bot.pos.z=o.max.z+r;
    }
  }
}
export function angleDelta(a,b){ return ((a-b+Math.PI*3)%(Math.PI*2))-Math.PI; }

function botShoot(bot,p,distP){
  _v3.set(bot.pos.x-Math.sin(bot.yaw)*0.5, bot.pos.y+1.32, bot.pos.z-Math.cos(bot.yaw)*0.5);
  _v4.set(player.pos.x, player.pos.y+player.eyeH-0.5, player.pos.z);
  // リード射撃（強いNPCほどプレイヤーの移動を先読み）
  _v4.x += player.vel.x*(distP/85)*p.lead;
  _v4.z += player.vel.z*(distP/85)*p.lead;
  const dir=_v4.sub(_v3).normalize();
  applySpread(dir, p.spread);
  spawnBB(_v3, dir, 90, 140, "bot");
  sndShotFar(distP);
}

export function updateBots(dt, now){
  if (S.mode!=="vs" || !S.vs.active) return;
  const p=DIFF_PARAMS[S.diff];
  // 1st pass: 意思決定（状態遷移・射撃・移動指示）
  for (const bot of bots){
    if (!bot.alive){
      bot.fallT+=dt;
      bot.grp.rotation.x=Math.min(1.5, bot.fallT/0.25*1.5);   // 倒れたまま復活しない
      setBotHold(bot);
      continue;
    }
    _v1.set(player.pos.x-bot.pos.x, 0, player.pos.z-bot.pos.z);
    const distP=_v1.length();
    if (bot.state==="move"){
      bot.moveT+=dt;
      const L=Math.hypot(bot.wp.x-bot.pos.x, bot.wp.z-bot.pos.z);
      if (L<0.8 || bot.moveT>7){
        bot.state="engage";
        bot.timer=p.engage*(0.7+Math.random()*0.6);
        bot.reactT=p.react*(0.6+Math.random()*0.8);
        bot.burstLeft=p.burst; bot.pauseT=0;
        setBotHold(bot);
      } else {
        setBotSeek(bot, bot.wp.x, bot.wp.z, p.speed);
        // 進行方向（回避で膨らんだ実際の速度ベクトル）を向く
        const v=bot.vehicle.velocity;
        if (v.squaredLength()>0.04) bot.targetYaw=Math.atan2(-v.x,-v.z);
      }
    } else {
      bot.timer-=dt;
      bot.targetYaw=Math.atan2(-_v1.x,-_v1.z);
      if (bot.reactT>0) bot.reactT-=dt;
      else {
        bot.cooldown-=dt;
        if (bot.pauseT>0) bot.pauseT-=dt;
        else if (bot.cooldown<=0){
          if (losClear(bot)) botShoot(bot,p,distP);
          bot.cooldown=1/p.cycle;
          if (--bot.burstLeft<=0){
            bot.burstLeft=p.burst;
            bot.pauseT=0.5+Math.random()*0.8;
          }
        }
      }
      if (bot.timer<=0){ bot.state="move"; bot.wp=pickWp(bot); bot.moveT=0; }
    }
  }
  // 2nd pass: 操舵を1ステップ進め、衝突解決した位置を反映
  yukaUpdate(dt);
  for (const bot of bots){
    if (!bot.alive) continue;
    syncBotFromVehicle(bot);
    bot.yaw += angleDelta(bot.targetYaw,bot.yaw)*Math.min(1,dt*8);
    bot.grp.position.copy(bot.pos);
    bot.grp.rotation.y=bot.yaw;
    // 自陣フラッグ奪取判定 → 敗北（フラッグ戦のみ）
    if (S.vsRuleset==="flag" && Math.hypot(bot.pos.x-PLAYER_FLAG.x, bot.pos.z-PLAYER_FLAG.z)<1.4){
      endMatch(false,"フラッグを奪われた");
      return;
    }
  }
}

export function onBotHit(bot, bb){
  bot.alive=false; bot.fallT=0;   // 復活しない
  const dist=bb.pos.distanceTo(bb.start);
  sndPing(dist);
  spawnParticles(bb.pos, 0xffffff, 5, 1.4);
  S.vs.you++;
  updateVsHUD();
  flashHitmarker(`撃破！　${dist.toFixed(1)}m`);
  if (S.vsRuleset==="elim" && bots.every(b=>!b.alive)) endMatch(true);
}
export function onPlayerHit(){
  // ヒット = 即死（ゲームオーバー）。倒れながら三人称視点へ引く演出を再生
  if (!S.vs.active) return;
  sndHitMe();
  $("dmgFlash").classList.add("show");
  setTimeout(()=>$("dmgFlash").classList.remove("show"),700);
  startDeathSequence();
  endMatch(false,"被弾");
}
export function updateVsHUD(){
  $("vsYou").textContent=S.vs.you;
  $("vsGoal").textContent = S.vsRuleset==="elim" ? ` / ${S.vsNpcCount}` : "";
  $("flagDistWrap").style.display = S.vsRuleset==="flag" ? "inline" : "none";
}
export function endMatch(win, reason){
  if (!S.vs.active) return;
  S.vs.active=false;
  const winMsg = S.vsRuleset==="elim" ? `🏆 殲滅完了！勝利！（撃破 ${S.vs.you}）`
                                       : `🏆 フラッグ奪取！勝利！（撃破 ${S.vs.you}）`;
  showMsg(win? winMsg : `敗北…（${reason}）`, 4);
  setTimeout(()=>{ if (document.pointerLockElement) document.exitPointerLock(); }, 2800);
}
/* 対戦モードの毎フレーム処理: フラッグ戦のみ旗アニメ・奪取判定・HUD距離を扱う */
export function updateVsRound(dt,now){
  if (S.mode!=="vs" || !S.vs.active || S.vsRuleset!=="flag") return;
  if (enemyFlagMesh)  enemyFlagMesh.rotation.y = Math.sin(now*2)*0.2;
  if (playerFlagMesh) playerFlagMesh.rotation.y = Math.sin(now*2+1.5)*0.2;
  const d=Math.hypot(player.pos.x-ENEMY_FLAG.x, player.pos.z-ENEMY_FLAG.z);
  const di=Math.max(0,Math.round(d));
  if (di!==lastFlagDist){ lastFlagDist=di; $("flagDist").textContent=di+"m"; }
  if (d<1.4) endMatch(true);
}
