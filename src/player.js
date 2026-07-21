/* ============================================================
   プレイヤー: 移動・射撃・入力（キーボード/マウス）・ポインタロック
   ============================================================ */
import { THREE, S, $, camera, renderer, RT, UP, player, weapon, keys, clearKeys,
  MAG_SIZE, EYE_H, CROUCH_H, currentBounds, obstacles, pvp, sightCal } from "./state.js";
import { simulate2D, solveOptimalSpin } from "./physics.js";
import { sndClick, sndShot, sndReload, audio } from "./sound.js";
import { spawnBB, resolveHipAimPoint } from "./bb.js";
import { gun, gunCorrected, MUZZLE_LOCAL, MUZZLE_LOCAL_MODEL, muzzleInGunLocal,
  AIM_PX_X, AIM_PX_Y } from "./gun.js";

export const LEAN_MAX_ROLL = 12*Math.PI/180;   // 最大ロール角
export const LEAN_MAX_OFFSET = 0.4;            // 最大横オフセット(m)

/* ============================================================
   プレイヤー更新
   ============================================================ */
export function updatePlayer(dt){
  // リーン(のぞきこみ): Q=左, E=右。目標値へ平滑補間
  const leanTarget = (S.mode==="edit")? 0 : (keys["KeyE"]?1:0) - (keys["KeyQ"]?1:0);
  player.lean += (leanTarget-player.lean)*Math.min(1,dt*10);

  if (S.mode==="edit"){
    // クリエイティブ飛行（マイクラ風）: Space上昇 / Shift下降・重力なし・障害物すり抜け
    let fx=0, fz=0;
    if (keys["KeyW"]) fz-=1;
    if (keys["KeyS"]) fz+=1;
    if (keys["KeyA"]) fx-=1;
    if (keys["KeyD"]) fx+=1;
    const len=Math.hypot(fx,fz)||1;
    fx/=len; fz/=len;
    const sin=Math.sin(player.yaw), cos=Math.cos(player.yaw);
    const fs=8;
    player.vel.set((fx*cos+fz*sin)*fs,
      ((keys["Space"]?1:0)-((keys["ShiftLeft"]||keys["ShiftRight"])?1:0))*5,
      (-fx*sin+fz*cos)*fs);
    player.pos.addScaledVector(player.vel,dt);
    {
      const b=currentBounds();
      player.pos.x=THREE.MathUtils.clamp(player.pos.x,b.xMin+0.8,b.xMax-0.8);
      player.pos.z=THREE.MathUtils.clamp(player.pos.z,b.zMin+0.8,b.zMax-0.8);
    }
    player.pos.y=THREE.MathUtils.clamp(player.pos.y,0,14);
    player.eyeH=EYE_H;
    camera.position.set(player.pos.x, player.pos.y+EYE_H, player.pos.z);
    camera.rotation.y=player.yaw;
    camera.rotation.x=player.pitch;
    return;
  }
  player.crouch = player.crouchToggle || !!keys["ControlLeft"] || !!keys["ControlRight"];
  const targetEye=player.crouch?CROUCH_H:EYE_H;
  player.eyeH += (targetEye-player.eyeH)*Math.min(1,dt*12);

  let fx=0, fz=0;
  if (keys["KeyW"]) fz-=1;
  if (keys["KeyS"]) fz+=1;
  if (keys["KeyA"]) fx-=1;
  if (keys["KeyD"]) fx+=1;
  const sprint=keys["ShiftLeft"]&&!RT.ads&&fz<0;
  const speed=(player.crouch?2.2: sprint?7.0:4.6)*(RT.ads?0.6:1);
  const len=Math.hypot(fx,fz);
  if (len>0){ fx/=len; fz/=len; }
  const sin=Math.sin(player.yaw), cos=Math.cos(player.yaw);
  const wx=(fx*cos + fz*sin)*speed;
  const wz=(-fx*sin + fz*cos)*speed;
  // 水平速度はスムーズに追従
  const k=player.grounded? Math.min(1,dt*12) : Math.min(1,dt*2.5);
  player.vel.x += (wx-player.vel.x)*k;
  player.vel.z += (wz-player.vel.z)*k;
  // 重力・ジャンプ
  player.vel.y -= 20*dt;
  if (keys["Space"]&&player.grounded){ player.vel.y=6.2; player.grounded=false; }

  player.pos.addScaledVector(player.vel,dt);

  // 境界
  {
    const b=currentBounds();
    player.pos.x=THREE.MathUtils.clamp(player.pos.x,b.xMin+0.8,b.xMax-0.8);
    player.pos.z=THREE.MathUtils.clamp(player.pos.z,b.zMin+0.8,b.zMax-0.8);
  }

  // 地面
  player.grounded=false;
  if (player.pos.y<=0){ player.pos.y=0; player.vel.y=Math.max(0,player.vel.y); player.grounded=true; }

  // 障害物（AABB、上に乗れる）
  const r=0.32;
  for (const o of obstacles){
    if (player.pos.x>o.min.x-r && player.pos.x<o.max.x+r &&
        player.pos.z>o.min.z-r && player.pos.z<o.max.z+r &&
        player.pos.y<o.max.y && player.pos.y+1.75>o.min.y){
      if (player.pos.y>=o.max.y-0.35 && player.vel.y<=0){
        player.pos.y=o.max.y; player.vel.y=0; player.grounded=true;
      } else {
        const pxMin=player.pos.x-(o.min.x-r), pxMax=(o.max.x+r)-player.pos.x;
        const pzMin=player.pos.z-(o.min.z-r), pzMax=(o.max.z+r)-player.pos.z;
        const minPen=Math.min(pxMin,pxMax,pzMin,pzMax);
        if (minPen===pxMin) player.pos.x=o.min.x-r;
        else if (minPen===pxMax) player.pos.x=o.max.x+r;
        else if (minPen===pzMin) player.pos.z=o.min.z-r;
        else player.pos.z=o.max.z+r;
      }
    }
  }

  camera.position.set(player.pos.x, player.pos.y+player.eyeH, player.pos.z);
  camera.rotation.y=player.yaw;
  camera.rotation.x=player.pitch;
  camera.rotation.z=-player.lean*LEAN_MAX_ROLL;
  // 横方向オフセット（現在向いている方向に対する右方向へ、リーン量に応じて移動）
  const leanRightX=Math.cos(player.yaw), leanRightZ=-Math.sin(player.yaw);
  camera.position.x += leanRightX*player.lean*LEAN_MAX_OFFSET;
  camera.position.z += leanRightZ*player.lean*LEAN_MAX_OFFSET;
}

/* ============================================================
   射撃
   ============================================================ */
const _dir=new THREE.Vector3(), _right=new THREE.Vector3(), _spawn=new THREE.Vector3(),
      _up2=new THREE.Vector3(), _leanUp=new THREE.Vector3(),
      _camDir=new THREE.Vector3(), _aimPt=new THREE.Vector3();
/* 円錐拡散をdirに適用 */
export function applySpread(dir,deg){
  const sp=deg*Math.PI/180;
  _right.crossVectors(dir,UP).normalize();
  _up2.crossVectors(_right,dir);
  dir.addScaledVector(_right,(Math.random()*2-1)*sp)
     .addScaledVector(_up2,(Math.random()*2-1)*sp).normalize();
}
export function tryShoot(){
  if ((!RT.locked && !sightCal.active) || S.mode==="edit" || weapon.reloading || weapon.cooldown>0) return;
  if (!sightCal.active){
    if (weapon.mag<=0){ sndClick(1000,.15); startReload(); return; }   // 弾切れ→オートリロード
    weapon.mag--; S.shots++;
  }
  weapon.cooldown = weapon.mode==="FULL"? 1/S.cycle : 0.09;

  // BB弾はマズル先端（実測値+微調整オフセット）から発射。読込み前はプロシージャル銃の暫定位置。
  // 発射方向は始点(マズル)に依存する場合があるので、方向を決める前にマズルを確定させる
  if (gunCorrected && MUZZLE_LOCAL_MODEL) _spawn.copy(muzzleInGunLocal()).applyMatrix4(gun.matrixWorld);
  else _spawn.copy(MUZZLE_LOCAL).applyMatrix4(gun.matrixWorld);

  if ((RT.ads||sightCal.active) && (AIM_PX_X||AIM_PX_Y)){
    // ADS/サイト調整: 照準方向のズレ(ゼロイン調整)をそのまま適用（従来どおり）
    const ndcX=(2*AIM_PX_X)/innerWidth, ndcY=-(2*AIM_PX_Y)/innerHeight;
    _dir.set(ndcX,ndcY,0.5).unproject(camera).sub(camera.position).normalize();
  } else if (!RT.ads && !sightCal.active){
    // 腰だめ撃ち: Raycast動的ゼロイン。カメラ中心のレイが最初に当たる点(着弾点)を求め、
    // マズルからその点へ向けて発射する（マズルの左右オフセットによる視差を補正し、
    // クロスヘアどおりに着弾させる）
    camera.getWorldDirection(_camDir);
    resolveHipAimPoint(camera.position, _camDir, _aimPt);
    _dir.subVectors(_aimPt, _spawn).normalize();
  } else {
    // ADS/サイト調整で照準ズレ無し: カメラ正面へ
    camera.getWorldDirection(_dir);
  }
  // 拡散（ADS・静止・しゃがみで向上）
  const moving=player.vel.length()>0.5;
  applySpread(_dir,(RT.ads?0.10:0.45)*(moving?1.8:1)*(player.crouch?0.7:1));
  // リーン中は銃が傾いている分だけホップアップの回転軸も傾け、弾道が斜めに揚力を受けるようにする
  _leanUp.copy(UP);
  if (player.lean) _leanUp.applyAxisAngle(_dir, player.lean*LEAN_MAX_ROLL);
  spawnBB(_spawn,_dir,S.v0,S.spinRps,"player",null,_leanUp, S.mode==="pvp"?pvp.myTeam:null);

  if (S.mode==="pvp" && pvp.inMatch && pvp.socket){
    pvp.socket.emit("game:shot", {
      origin:{x:_spawn.x,y:_spawn.y,z:_spawn.z}, dir:{x:_dir.x,y:_dir.y,z:_dir.z},
      v0:S.v0, spinRps:S.spinRps,
    });
  }

  weapon.kick=1;
  player.pitch += 0.0009+Math.random()*0.0006;
  sndShot();
  if (!sightCal.active) updateAmmoHUD();
}
export function startReload(){
  if (weapon.reloading || weapon.mag===MAG_SIZE) return;
  weapon.reloading=true; weapon.reloadT=1.6;
  $("reloadMsg").textContent="リロード中…";
  sndReload();
}
export function updateAmmoHUD(){
  $("ammo").innerHTML=`${weapon.mag} <span class="res">/ ∞</span>`;
}

/* ============================================================
   ホップアップ調整 & 弾道情報
   ============================================================ */
export function adjustHop(d){
  S.spinRps=THREE.MathUtils.clamp(S.spinRps+d,0,500);
  sndClick(320+S.spinRps,.08);
  onHopChanged();
}
let zeroCalcTimer=null;
export function onHopChanged(){
  updateHopHUD();
  clearTimeout(zeroCalcTimer);
  zeroCalcTimer=setTimeout(()=>{
    const r=simulate2D({v0:S.v0, massG:S.massG, h0:EYE_H, drag:S.drag, spinRps:S.spinRps});
    S.zeroIn=r.zeroIn; S.maxRange=r.landX;
    updateHopHUD();
  },120);
}
let optCalcTimer=null;
export function onLoadoutChanged(){
  updateHopHUD();
  clearTimeout(optCalcTimer);
  optCalcTimer=setTimeout(()=>{
    S.optimalSpin=solveOptimalSpin({v0:S.v0, massG:S.massG, h0:EYE_H, drag:S.drag});
    updateHopHUD();
  },250);
  onHopChanged();
}
export function updateHopHUD(){
  $("hopRps").textContent=S.spinRps+" rps";
  $("hopBar").style.width=(S.spinRps/500*100)+"%";
  if (S.optimalSpin!=null){
    $("hopOpt").style.display="block";
    $("hopOpt").style.left=(S.optimalSpin/500*100)+"%";
  }
  $("zeroIn").textContent = S.zeroIn? S.zeroIn.toFixed(0)+"m" : "—";
  $("maxRange").textContent = S.maxRange? S.maxRange.toFixed(0)+"m" : "—";
  $("loadLine").textContent=`${S.massG.toFixed(2)}g ｜ ${S.v0} m/s`;
  const E=0.5*S.massG*1e-3*S.v0*S.v0;
  const el=$("energyLine");
  el.textContent=E.toFixed(2)+" J"+(E>0.98?"（法定値超過！）":"");
  el.classList.toggle("illegal",E>0.98);
}

/* ============================================================
   キーボード・マウス入力 / ポインタロック
   （main.js が全モジュール読込み後に wireInput() を一度だけ呼んで配線する）
   ============================================================ */
export function wireInput({ edit, editPlace, editDelete, makeGhost, updateEditHUD, exportCustomMap,
  startChallenge, sightCalOrbit, updateOrbitCamera, applyMode, pvpConnect }){

  /* Ctrl+W誤爆対策: しゃがみ(Ctrl)+前進(W)を同時に押す操作がある都合上、
     ブラウザの「タブを閉じる」ショートカットと衝突しうる。
     preventDefaultはChrome/Firefox等ではCtrl+Wに対して効かない仕様だが、
     念のため試みつつ、beforeunloadで離脱確認ダイアログを出し閉じる事故を緩和する。 */
  window.addEventListener("keydown",e=>{
    if (e.ctrlKey && (e.key==="w"||e.key==="W")) e.preventDefault();
  },{capture:true});
  window.addEventListener("beforeunload",e=>{
    e.preventDefault();
    e.returnValue="";
  });

  document.addEventListener("keydown",e=>{
    if (e.repeat) return;
    keys[e.code]=true;
    if (!RT.locked) return;
    if (S.mode==="edit"){
      if (e.code==="Digit1"){ edit.sel="ply";   makeGhost(); updateEditHUD(); }
      if (e.code==="Digit2"){ edit.sel="drum";  makeGhost(); updateEditHUD(); }
      if (e.code==="Digit3"){ edit.sel="crate"; makeGhost(); updateEditHUD(); }
      if (e.code==="KeyR"){ edit.o=(edit.o+90)%360; makeGhost(); updateEditHUD(); }
      if (e.code==="KeyF") edit.snapOn=!edit.snapOn;   // スナップ ON/OFF トグル
      if (e.code==="KeyE") exportCustomMap();
      if (e.code==="KeyI") $("mapImportInput").click();
      return;   // 以降の武器系キーは無効
    }
    if (e.code==="KeyR") startReload();
    if (e.code==="KeyB"){
      weapon.mode = weapon.mode==="SEMI"?"FULL":"SEMI";
      $("fireMode").textContent = weapon.mode==="SEMI"?"SEMI":"FULL AUTO";
      sndClick(500,.2);
    }
    if (e.code==="KeyC") player.crouchToggle=!player.crouchToggle;
    if (e.code==="BracketRight") adjustHop(+10);
    if (e.code==="BracketLeft")  adjustHop(-10);
    if (e.code==="KeyO"){
      if (S.optimalSpin!=null){ S.spinRps=Math.round(S.optimalSpin); onHopChanged(); }
    }
    if (e.code==="KeyT" && S.mode==="range") startChallenge();
  });
  document.addEventListener("keyup",e=>{ keys[e.code]=false; });

  document.addEventListener("mousedown",e=>{
    if (sightCal.active){
      if (e.target.closest("#sightCalPanel")) return;   // パネル操作は発射・視点操作に影響しない
      if (e.button===0){ RT.firing=true; if(weapon.mode==="SEMI") tryShoot(); }
      if (e.button===2 && sightCalOrbit.active) sightCalOrbit.dragging=true;
      if (e.button===2 && sightCal.walk) sightCal.walkDragging=true;   // WASD移動中は右ドラッグで視点回転
      return;
    }
    if (!RT.locked) return;
    if (S.mode==="edit"){
      if (e.button===0 && edit.ghost && edit.ghost.visible && edit.valid)
        editPlace(edit.sel, edit.gx, edit.gy, edit.gz, edit.o);
      if (e.button===2) editDelete();
      return;
    }
    if (e.button===0){ RT.firing=true; if(weapon.mode==="SEMI") tryShoot(); }
    if (e.button===2) RT.ads=true;
  });
  document.addEventListener("mouseup",e=>{
    if (e.button===0) RT.firing=false;
    if (e.button===2){ RT.ads=false; sightCalOrbit.dragging=false; sightCal.walkDragging=false; }
  });
  document.addEventListener("contextmenu",e=>e.preventDefault());
  document.addEventListener("wheel",e=>{
    if (sightCal.active && sightCalOrbit.active){
      sightCalOrbit.dist=THREE.MathUtils.clamp(sightCalOrbit.dist+e.deltaY*0.0005,0.05,3);
      updateOrbitCamera();
      return;
    }
    if (!RT.locked) return;
    if (S.mode==="edit"){
      edit.o=((edit.o + (e.deltaY<0?45:-45))%360+360)%360;
      makeGhost(); updateEditHUD();
      return;
    }
    adjustHop(e.deltaY<0? +5 : -5);
  },{passive:true});

  document.addEventListener("mousemove",e=>{
    if (sightCal.active && sightCalOrbit.dragging){
      sightCalOrbit.yaw -= e.movementX*0.006;
      sightCalOrbit.pitch = THREE.MathUtils.clamp(sightCalOrbit.pitch - e.movementY*0.006, -1.4, 1.4);
      updateOrbitCamera();
      return;
    }
    if (sightCal.active && sightCal.walkDragging){   // WASD移動中: 右ドラッグで視点回転（ポインタロック不使用）
      player.yaw   -= e.movementX*0.003;
      player.pitch = THREE.MathUtils.clamp(player.pitch - e.movementY*0.003, -Math.PI/2+.01, Math.PI/2-.01);
      return;
    }
    if (!RT.locked) return;
    const s=0.0022*S.sens*(RT.ads?0.65:1);
    player.yaw   -= e.movementX*s;
    player.pitch -= e.movementY*s;
    player.pitch = THREE.MathUtils.clamp(player.pitch, -Math.PI/2+.01, Math.PI/2-.01);
  });

  /* ポインタロック */
  $("startBtn").addEventListener("click",()=>{
    audio();
    if (S.mode==="pvp"){
      $("menu").style.display="none";
      $("pvpLobby").classList.add("show");
      pvp.name = ($("pvpNameInput").value||"プレイヤー").trim().slice(0,16) || "プレイヤー";
      if (pvp.socket) pvp.socket.emit("lobby:setName", pvp.name);
      pvpConnect();
      return;
    }
    if (S.mode!==RT.appliedMode || (S.mode==="vs" && !S.vs.active)){
      applyMode(); RT.appliedMode=S.mode;
    }
    renderer.domElement.requestPointerLock();
  });
  document.addEventListener("pointerlockchange",()=>{
    RT.locked = document.pointerLockElement===renderer.domElement;
    document.body.classList.toggle("locked",RT.locked);
    if (!RT.locked) clearKeys();   // ロック解除の理由を問わず、押しっぱなし状態を必ずクリア
    if (!RT.locked && S.mode==="pvp" && !pvp.inMatch){
      // PVP試合終了後や離脱時はロビーへ戻す（シングルプレイのメニューには出さない）
      $("pvpLobby").classList.add("show");
    }
  });
}
