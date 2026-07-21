/* ============================================================
   BB弾（弾道物理・衝突判定・跳弾）
   命中時の処理（NPC/プレイヤー/PVP/ターゲットへのダメージ適用）は、
   このモジュールが他モジュールへ依存しないよう setHitHandlers() で
   後から登録するコールバック経由で行う（main.js が全モジュール読込み後に配線する）。
   ============================================================ */
import { THREE, S, scene, obstacles, RT, UP, bots, pvp, pvpFriendly, player, targets } from "./state.js";
import { ENV, KMAG, SPIN_FRIC, cdLoth, cdMorrison } from "./physics.js";
import { spawnParticles } from "./effects.js";

export const PHYS_DT = 1e-3;   // ゲーム用サブステップ（参照実装は1e-4、精度差<0.1%）
export const MAX_BB = 80, TRAIL_N = 14;
const BOT_SPHERES=[[1.5,0.20],[1.05,0.32],[0.45,0.30]];   // [中心高さ, 半径]

const bbGeo = new THREE.SphereGeometry(0.013, 8, 6);
const bbMatWhite  = new THREE.MeshBasicMaterial({color:0xffffff});
const bbMatTracer = new THREE.MeshBasicMaterial({color:0x66ff88});
const bbMatEnemy  = new THREE.MeshBasicMaterial({color:0xff5a5a});
export const bbPool=[];

for(let i=0;i<MAX_BB;i++){
  const mesh=new THREE.Mesh(bbGeo, bbMatWhite);
  mesh.visible=false; scene.add(mesh);
  const trailPos=new Float32Array(TRAIL_N*3);
  const trailGeo=new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPos,3));
  const trail=new THREE.Line(trailGeo,
    new THREE.LineBasicMaterial({color:0x9dffb0, transparent:true, opacity:.35,
      blending:THREE.AdditiveBlending, depthWrite:false}));
  trail.visible=false; trail.frustumCulled=false; scene.add(trail);
  bbPool.push({
    alive:false, mesh, trail, trailPos, trailLen:0,
    pos:new THREE.Vector3(), prev:new THREE.Vector3(), vel:new THREE.Vector3(),
    axis:new THREE.Vector3(), w:0, t:0, start:new THREE.Vector3(),
  });
}

export function spawnBB(origin, dir, v0, spinRps, owner="player", shooterId=null, upRef=UP, shooterTeam=null){
  const bb = bbPool.find(b=>!b.alive) || bbPool[0];
  bb.alive=true; bb.t=0; bb.owner=owner; bb.shooterId=shooterId; bb.shooterTeam=shooterTeam; bb.bounces=0;
  bb.pos.copy(origin); bb.prev.copy(origin); bb.start.copy(origin);
  bb.vel.copy(dir).multiplyScalar(v0);
  // バックスピン軸 = 射撃方向×銃の上方向 → ω×v が揚力。
  // 通常は上方向=世界の上(UP)で水平軸・垂直揚力になるが、
  // リーン(銃の傾き)時はupRefがその分傾いた向きになり、揚力も斜めになる（弾道が斜めに曲がる）
  bb.axis.crossVectors(dir, upRef).normalize();
  if (bb.axis.lengthSq()<1e-6) bb.axis.set(1,0,0);
  bb.w = 2*Math.PI*spinRps;
  if (owner==="bot" || owner==="pvpEnemy"){
    bb.mesh.material = bbMatEnemy;
    bb.trail.material.color.setHex(0xff8a8a);
    bb.trail.material.opacity = .4;
  } else {
    bb.mesh.material = S.tracer? bbMatTracer : bbMatWhite;
    bb.trail.material.color.setHex(0x9dffb0);
    bb.trail.material.opacity = S.tracer? .5 : .22;
  }
  bb.mesh.visible=true; bb.trail.visible=true;
  bb.trailLen=0;
  for(let i=0;i<TRAIL_N;i++) bb.trailPos.set([origin.x,origin.y,origin.z], i*3);
  bb.trail.geometry.attributes.position.needsUpdate=true;
}
export function killBB(bb){ bb.alive=false; bb.mesh.visible=false; bb.trail.visible=false; }

export const RICOCHET_MIN_SPEED = 25;   // これ未満の着弾速度は跳ねずに失速して止まる
export const RICOCHET_MAX_BOUNCES = 2;
export const RICOCHET_DAMP = 0.55;      // 反射のたびに残る速度の割合（エネルギー損失）
/* 障害物の面で弾を反射させる（貫入直前のbb.prevから最短距離の面を法線とする簡易反射） */
function reflectBB(bb, o){
  const px=bb.prev.x, py=bb.prev.y, pz=bb.prev.z;
  const dx1=px-o.min.x, dx2=o.max.x-px, dy1=py-o.min.y, dy2=o.max.y-py, dz1=pz-o.min.z, dz2=o.max.z-pz;
  const m=Math.min(dx1,dx2,dy1,dy2,dz1,dz2);
  let nx=0, ny=0, nz=0;
  if (m===dx1) nx=-1; else if (m===dx2) nx=1;
  else if (m===dy1) ny=-1; else if (m===dy2) ny=1;
  else if (m===dz1) nz=-1; else nz=1;
  const vn=bb.vel.x*nx+bb.vel.y*ny+bb.vel.z*nz;
  bb.vel.x -= 2*vn*nx; bb.vel.y -= 2*vn*ny; bb.vel.z -= 2*vn*nz;
  bb.vel.multiplyScalar(RICOCHET_DAMP);
  bb.w *= 0.5;
  bb.pos.copy(bb.prev);
  bb.bounces++;
  spawnParticles(bb.pos, 0xdddddd, 3, 0.8);
}

const _acc=new THREE.Vector3(), _mag=new THREE.Vector3(), _seg=new THREE.Vector3();

/* 線分-球ヒット判定（トンネリング防止） */
function segHitSphere(p0, p1, cx, cy, cz, r){
  _seg.subVectors(p1, p0);
  const l2=_seg.lengthSq();
  let t=0;
  if (l2>0) t=THREE.MathUtils.clamp(
    ((cx-p0.x)*_seg.x+(cy-p0.y)*_seg.y+(cz-p0.z)*_seg.z)/l2, 0, 1);
  const dx=p0.x+_seg.x*t-cx, dy=p0.y+_seg.y*t-cy, dz=p0.z+_seg.z*t-cz;
  return dx*dx+dy*dy+dz*dz < r*r;
}

/* ---- 腰だめ撃ち用: カメラ中心レイの着弾点をレイキャストで求める（動的ゼロイン） ----
   マズルはカメラから左右にオフセットしているため、カメラ正面へ平行発射すると
   クロスヘア位置に着弾しない（視差）。カメラ中心から前方へレイを飛ばし、最初に当たる
   障害物/地面/的/NPCまでの距離を着弾点として、その点へマズルから向けて撃つことで
   照準どおりに飛ばす。 */
const HIP_MAX_AIM_DIST = 120;   // 何にも当たらない場合の既定収束距離（空撃ち等）
const HIP_MIN_AIM_DIST = 2;     // 至近すぎる収束を防ぐ下限
/* レイ vs AABB（スラブ法）。当たらなければ Infinity、当たれば入口までの距離tを返す */
function rayAABB(ox,oy,oz, dx,dy,dz, mn, mx){
  let t0=0, t1=Infinity;
  // X
  if (Math.abs(dx)<1e-8){ if (ox<mn.x||ox>mx.x) return Infinity; }
  else { let a=(mn.x-ox)/dx, b=(mx.x-ox)/dx; if(a>b){const s=a;a=b;b=s;} t0=Math.max(t0,a); t1=Math.min(t1,b); if(t0>t1) return Infinity; }
  // Y
  if (Math.abs(dy)<1e-8){ if (oy<mn.y||oy>mx.y) return Infinity; }
  else { let a=(mn.y-oy)/dy, b=(mx.y-oy)/dy; if(a>b){const s=a;a=b;b=s;} t0=Math.max(t0,a); t1=Math.min(t1,b); if(t0>t1) return Infinity; }
  // Z
  if (Math.abs(dz)<1e-8){ if (oz<mn.z||oz>mx.z) return Infinity; }
  else { let a=(mn.z-oz)/dz, b=(mx.z-oz)/dz; if(a>b){const s=a;a=b;b=s;} t0=Math.max(t0,a); t1=Math.min(t1,b); if(t0>t1) return Infinity; }
  return t0>1e-4 ? t0 : Infinity;
}
/* レイ vs 球（dirは正規化済み前提）。当たらなければ Infinity */
function raySphere(ox,oy,oz, dx,dy,dz, cx,cy,cz, r){
  const mx=ox-cx, my=oy-cy, mz=oz-cz;
  const b=mx*dx+my*dy+mz*dz;
  const c=mx*mx+my*my+mz*mz - r*r;
  if (c>0 && b>0) return Infinity;
  const disc=b*b-c;
  if (disc<0) return Infinity;
  const t=-b-Math.sqrt(disc);
  return t>1e-4 ? t : Infinity;
}
export function resolveHipAimPoint(camPos, camDir, out){
  const ox=camPos.x, oy=camPos.y, oz=camPos.z;
  const dx=camDir.x, dy=camDir.y, dz=camDir.z;
  let best = HIP_MAX_AIM_DIST;
  // 障害物（壁・木箱・バリケード・バリケード物）
  for (const o of obstacles){
    const t = rayAABB(ox,oy,oz,dx,dy,dz,o.min,o.max);
    if (t<best) best=t;
  }
  // 地面（y=0）
  if (dy<0){ const tg=-oy/dy; if (tg>0 && tg<best) best=tg; }
  // 射撃練習の的
  if (S.mode==="range"){
    for (const tg of targets){
      if (!tg.alive) continue;
      for (const zn of tg.zones){
        const t=raySphere(ox,oy,oz,dx,dy,dz, zn.world.x,zn.world.y,zn.world.z, zn.r);
        if (t<best) best=t;
      }
    }
  }
  // NPC（対戦・PVPホストのローカルbots）
  if (S.mode==="vs" || S.mode==="pvp"){
    for (const bt of bots){
      if (!bt.alive) continue;
      for (const sph of BOT_SPHERES){
        const t=raySphere(ox,oy,oz,dx,dy,dz, bt.pos.x, bt.pos.y+sph[0], bt.pos.z, sph[1]);
        if (t<best) best=t;
      }
    }
  }
  // PVP: 他プレイヤー・非ホスト側のリモートNPC
  if (S.mode==="pvp"){
    for (const rp of pvp.players.values()){
      if (!rp.alive) continue;
      for (const sph of BOT_SPHERES){
        const t=raySphere(ox,oy,oz,dx,dy,dz, rp.pos.x, rp.pos.y+sph[0], rp.pos.z, sph[1]);
        if (t<best) best=t;
      }
    }
    for (const rb of pvp.bots.values()){
      if (!rb.alive) continue;
      for (const sph of BOT_SPHERES){
        const t=raySphere(ox,oy,oz,dx,dy,dz, rb.pos.x, rb.pos.y+sph[0], rb.pos.z, sph[1]);
        if (t<best) best=t;
      }
    }
  }
  best = Math.min(HIP_MAX_AIM_DIST, Math.max(HIP_MIN_AIM_DIST, best));
  out.set(ox+dx*best, oy+dy*best, oz+dz*best);
  return out;
}

/* 被弾時のゲームロジック（NPC/プレイヤー/PVP/ターゲット）は main.js が
   全モジュール読込み後に registerHitHandlers() で配線する */
let H = {
  onBotHit:()=>{}, onPvpBotHit:()=>{}, onPlayerHit:()=>{}, onPvpPlayerHit:()=>{}, onTargetHit:()=>{},
};
export function registerHitHandlers(handlers){ Object.assign(H, handlers); }

export function stepBBs(dt){
  const m = S.massG*1e-3;
  const I = 0.4*m*ENV.R*ENV.R;
  const cdf = S.drag==="loth"? cdLoth : cdMorrison;
  for (const bb of bbPool){
    if (!bb.alive) continue;
    const v = bb.vel.length();
    // 並進: 抗力 + マグヌス + 重力
    const FdOverV = 0.5*cdf(v)*ENV.rho*ENV.A*v;
    _mag.crossVectors(bb.axis, bb.vel).multiplyScalar(KMAG*bb.w);
    _acc.copy(bb.vel).multiplyScalar(-FdOverV).add(_mag).divideScalar(m);
    _acc.y -= ENV.g;
    bb.vel.addScaledVector(_acc, dt);
    bb.prev.copy(bb.pos);
    bb.pos.addScaledVector(bb.vel, dt);
    // 回転減衰
    const Re = ENV.rho*v*ENV.d/ENV.eta;
    const Cf = 1.328/Math.sqrt(Re);
    bb.w = Math.max(0, bb.w - SPIN_FRIC*Cf*Math.sqrt(v*v+(ENV.c*ENV.R*bb.w)**2)*bb.w/I*dt);
    bb.t += dt;

    if (bb.t>12 || v<3){ killBB(bb); continue; }
    // 地面
    if (bb.pos.y<=0.004){
      spawnParticles(bb.pos, 0x9c8a62, 5, 1.2);
      killBB(bb); continue;
    }
    // 障害物
    let hitO=null;
    for (const o of obstacles){
      if (bb.pos.x>o.min.x && bb.pos.x<o.max.x &&
          bb.pos.y>o.min.y && bb.pos.y<o.max.y &&
          bb.pos.z>o.min.z && bb.pos.z<o.max.z){ hitO=o; break; }
    }
    if (hitO){
      if (bb.bounces<RICOCHET_MAX_BOUNCES && v>RICOCHET_MIN_SPEED){
        reflectBB(bb, hitO);
      } else {
        spawnParticles(bb.pos, 0xcccccc, 4, 1); killBB(bb);
      }
      continue;
    }

    if (bb.owner==="bot" || bb.owner==="pvpEnemy"){
      // NPC/PVP敵のBB → プレイヤー判定（頭・胸・脚の3球カプセル）。チーム戦は味方弾を無視
      let hitLocal=false;
      const friendlyToMe = bb.owner==="pvpEnemy" && pvpFriendly(bb.shooterTeam, pvp.myTeam);
      if (RT.gNow>RT.invulnUntil && (S.ricochetHit || bb.bounces===0) && !friendlyToMe){
        const px=player.pos.x, py=player.pos.y, pz=player.pos.z, eh=player.eyeH;
        if (segHitSphere(bb.prev,bb.pos,px,py+0.45,pz,0.32) ||
            segHitSphere(bb.prev,bb.pos,px,py+eh*0.65,pz,0.30) ||
            segHitSphere(bb.prev,bb.pos,px,py+eh,pz,0.22)){
          if (bb.owner==="pvpEnemy") H.onPvpPlayerHit(bb.shooterId);
          else H.onPlayerHit();
          killBB(bb); hitLocal=true;
        }
      }
      // ホストのみ: 他プレイヤーの弾が自分のNPCに当たっていないかも判定（NPCはホスト権威のため）
      if (!hitLocal && S.mode==="pvp" && pvp.iAmHost && bb.owner==="pvpEnemy" &&
          (S.ricochetHit || bb.bounces===0) && !String(bb.shooterId).startsWith("bot:")){
        let hitBot=null;
        outerH: for (const bot of bots){
          if (!bot.alive || pvpFriendly(bb.shooterTeam, bot.team)) continue;
          for (const sph of BOT_SPHERES){
            if (segHitSphere(bb.prev,bb.pos,bot.pos.x,bot.pos.y+sph[0],bot.pos.z,sph[1])){
              hitBot=bot; break outerH;
            }
          }
        }
        if (hitBot){ H.onPvpBotHit(hitBot, bb.shooterId); killBB(bb); }
      }
      continue;
    }
    if (!(S.ricochetHit || bb.bounces===0)){ continue; }
    if (S.mode==="vs"){
      // プレイヤーのBB → NPC判定
      let hitBot=null;
      outer: for (const bot of bots){
        if (!bot.alive) continue;
        for (const sph of BOT_SPHERES){
          if (segHitSphere(bb.prev,bb.pos,bot.pos.x,bot.pos.y+sph[0],bot.pos.z,sph[1])){
            hitBot=bot; break outer;
          }
        }
      }
      if (hitBot){ H.onBotHit(hitBot, bb); killBB(bb); }
    } else if (S.mode==="pvp" && pvp.iAmHost){
      // ホスト自身の弾 → 自分のNPC判定（チーム戦は自チームのNPCには当たらない）
      let hitBot=null;
      outerP: for (const bot of bots){
        if (!bot.alive || pvpFriendly(bb.shooterTeam, bot.team)) continue;
        for (const sph of BOT_SPHERES){
          if (segHitSphere(bb.prev,bb.pos,bot.pos.x,bot.pos.y+sph[0],bot.pos.z,sph[1])){
            hitBot=bot; break outerP;
          }
        }
      }
      if (hitBot){ H.onPvpBotHit(hitBot, pvp.myId); killBB(bb); }
    } else if (S.mode==="range"){
      // ターゲット（複数判定ゾーン）
      let done=false;
      for (const tg of targets){
        if (!tg.alive) continue;
        for (const zn of tg.zones){
          if (segHitSphere(bb.prev,bb.pos,zn.world.x,zn.world.y,zn.world.z,zn.r)){
            H.onTargetHit(tg, bb, zn);
            killBB(bb); done=true; break;
          }
        }
        if (done) break;
      }
    }
  }
}

export function updateTrails(){
  for (const bb of bbPool){
    if (!bb.alive) continue;
    const p=bb.trailPos;
    p.copyWithin(3,0,(TRAIL_N-1)*3);
    p[0]=bb.pos.x; p[1]=bb.pos.y; p[2]=bb.pos.z;
    bb.trailLen=Math.min(bb.trailLen+1,TRAIL_N);
    bb.trail.geometry.setDrawRange(0,bb.trailLen);
    bb.trail.geometry.attributes.position.needsUpdate=true;
    bb.mesh.position.copy(bb.pos);
  }
}
