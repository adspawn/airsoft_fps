/* ============================================================
   エントリーポイント: 全モジュールを読み込み、コールバック配線・
   デバッグフック登録・メインループ起動を行う
   ============================================================ */
import * as THREE from "three";
import { GLTFLoader } from "../libs/loaders/GLTFLoader.js";
import { S, RT, $, camera, renderer, scene, player, weapon, keys, obstacles,
  EDIT_AREA, FIELD, VS_ARENA, ENEMY_FLAG, PLAYER_FLAG, spawnPoints, pvp, targets, bots, MAG_SIZE,
  RED_PLAYER_SPAWNS, BLUE_PLAYER_SPAWNS, RED_NPC_SPAWNS, BLUE_NPC_SPAWNS,
  sightCal, sightCalOrbit, edit } from "./state.js";
import { simulate2D, solveOptimalSpin } from "./physics.js";
import {
  PHYS_DT, bbPool, spawnBB, killBB, stepBBs, updateTrails, registerHitHandlers,
} from "./bb.js";
import { updateParticles } from "./effects.js";
import { updateTargets, onTargetHit, startChallenge, updateChallenge } from "./targets.js";
import {
  gun, gunProcedural, GUN_ADS, GUN_HIP, loadGunModel, enterSightCal, exitSightCal, sightCalRefresh,
  applySightCalibration, loadSightCalib, currentMuzzleLocal, muzzleInGunLocal, updateOrbitCamera,
  enterOrbitView, exitOrbitView, updateGun, wireSightCalUI, muzzleMarker, MUZZLE_OFFSET,
  gunCorrected, FRONT_LOCAL, REAR_LOCAL, ADS_FOV, MUZZLE_LOCAL_MODEL, AIM_PX_X, AIM_PX_Y,
  toggleSightCalWalk, enterSightCalWalk, exitSightCalWalk, applyGunHip,
} from "./gun.js";
import { updatePlayer, tryShoot, updateAmmoHUD, wireInput } from "./player.js";
import {
  onBotHit, updateBots, updateVsRound, endMatch, onPlayerHit, updateDeathCam,
  startDeathSequence, endDeathSequence, getDeathBodyPivot, genVsField, genRandomVsProps,
  vsProps, loadCustomMap, botAI, rebuildYukaObstacles,
} from "./bots.js";
import { editPlace, editDelete, editValidAt, updateEdit, exportCustomMap, importCustomMapData,
  saveCustomMap, makeGhost, updateEditHUD, wireMapEditorUI } from "./mapEditor.js";
import {
  pvpConnect, pvpCreateRoom, pvpJoinRoom, pvpLeaveRoom, pvpRefreshRoomList, pvpStartMatch,
  updatePvpRemotes, updatePvpNetSend, onPvpPlayerHit, onPvpBotHit, updatePvpBots,
  updatePvpBotsNetSend, updatePvpBotsRemote, pvpApplyBotsState, updatePvpFlagCapture,
  getPvpMyKills, getPvpMyDeaths, wirePvpLobbyUI, renderPvpRoomView,
} from "./pvp.js";
import { applyMode, wireMenuUI } from "./menu.js";

/* ---- 銃モデル読込み ---- */
loadGunModel(GLTFLoader);

/* ---- BB弾ヒット処理の配線（bb.jsは他モジュールへ依存しないよう後から登録） ---- */
registerHitHandlers({ onBotHit, onPvpBotHit, onPlayerHit, onPvpPlayerHit, onTargetHit });

/* ---- UIイベントの配線 ---- */
wireSightCalUI();
wireMapEditorUI();
wirePvpLobbyUI();
wireMenuUI();
wireInput({
  edit, editPlace, editDelete, makeGhost, updateEditHUD, exportCustomMap,
  startChallenge, sightCalOrbit, updateOrbitCamera, applyMode, pvpConnect, renderPvpRoomView,
});

/* ============================================================
   デバッグ用フック（コンソールから状態確認可能）
   ============================================================ */
window.__game={S, weapon, player, bbPool, targets, bots, spawnBB, simulate2D, solveOptimalSpin,
  THREE, camera, killBB, applyMode, updateBots, updateTargets, updateVsRound, vsProps,
  gun, gunProcedural, edit, editPlace, editDelete, editValidAt, loadCustomMap, GUN_ADS, scene,
  keys, updatePlayer, updateEdit,
  sightCal, enterSightCal, exitSightCal, sightCalRefresh, applySightCalibration,
  loadSightCalib, muzzleMarker, muzzleInGunLocal, MUZZLE_OFFSET, currentMuzzleLocal, tryShoot,
  sightCalOrbit, enterOrbitView, exitOrbitView, updateOrbitCamera,
  toggleSightCalWalk, enterSightCalWalk, exitSightCalWalk, applyGunHip, GUN_HIP,
  get FRONT_LOCAL(){return FRONT_LOCAL;}, get REAR_LOCAL(){return REAR_LOCAL;},
  get gunCorrected(){return gunCorrected;}, get ADS_FOV(){return ADS_FOV;},
  get MUZZLE_LOCAL_MODEL(){return MUZZLE_LOCAL_MODEL;},
  get AIM_PX_X(){return AIM_PX_X;}, get AIM_PX_Y(){return AIM_PX_Y;},
  EDIT_AREA, FIELD, exportCustomMap, importCustomMapData, saveCustomMap,
  onBotHit, endMatch, ENEMY_FLAG, PLAYER_FLAG,
  stepN:(n)=>{ for(let i=0;i<n;i++) stepBBs(PHYS_DT); },
  setNow:(t)=>{ RT.gNow=t; },
  setLocked:(v)=>{ RT.locked=v; }, setAds:(v)=>{ RT.ads=v; }, get ads(){return RT.ads;}, get locked(){return RT.locked;},
  get dying(){return RT.dying;}, startDeathSequence, endDeathSequence, updateDeathCam,
  get deathBodyPivot(){return getDeathBodyPivot();}, VS_ARENA, onPlayerHit,
  pvp, pvpConnect, pvpCreateRoom, pvpJoinRoom, pvpLeaveRoom, pvpRefreshRoomList,
  pvpStartMatch, updatePvpRemotes, updatePvpNetSend, spawnPoints, obstacles,
  updatePvpBots, updatePvpBotsNetSend, updatePvpBotsRemote, pvpApplyBotsState,
  genRandomVsProps, genVsField, onPvpBotHit, updatePvpFlagCapture, botAI, rebuildYukaObstacles,
  RED_PLAYER_SPAWNS, BLUE_PLAYER_SPAWNS, RED_NPC_SPAWNS, BLUE_NPC_SPAWNS,
  get pvpMyKills(){return getPvpMyKills();}, get pvpMyDeaths(){return getPvpMyDeaths();}};

/* ============================================================
   メインループ
   ============================================================ */
const clock=new THREE.Clock();
function loop(){
  requestAnimationFrame(loop);
  const dt=Math.min(clock.getDelta(),0.05);
  const now=performance.now()/1000;
  RT.gNow=now;

  if (sightCal.active){
    if (sightCal.walk){
      updatePlayer(dt);   // WASD移動サブモード（腰だめ描写で保持位置を確認）
      updateGun(dt);
    } else {
      updateOrbitCamera();
    }
    weapon.cooldown=Math.max(0,weapon.cooldown-dt);
    if (RT.firing && weapon.mode==="FULL") tryShoot();
    RT.physAcc+=dt;
    let nc=0;
    while (RT.physAcc>=PHYS_DT && nc<120){ stepBBs(PHYS_DT); RT.physAcc-=PHYS_DT; nc++; }
    updateTrails();
    updateParticles(dt);
    renderer.render(scene,camera);
    return;
  }

  if (RT.dying){
    updateDeathCam(dt);
    updatePvpRemotes(dt);   // 自分が倒れている間も他プレイヤーの見た目は更新し続ける
    updatePvpBotsRemote(dt);
    RT.physAcc+=dt;
    let nd=0;
    while (RT.physAcc>=PHYS_DT && nd<120){ stepBBs(PHYS_DT); RT.physAcc-=PHYS_DT; nd++; }
    updateTrails();
    updateParticles(dt);
    renderer.render(scene,camera);
    return;
  }

  if (RT.locked){
    updatePlayer(dt);
    updateGun(dt);
    // 射撃
    weapon.cooldown=Math.max(0,weapon.cooldown-dt);
    if (RT.firing && weapon.mode==="FULL") tryShoot();
    if (weapon.reloading){
      weapon.reloadT-=dt;
      if (weapon.reloadT<=0){
        weapon.reloading=false; weapon.mag=MAG_SIZE;
        $("reloadMsg").textContent=""; updateAmmoHUD();
      }
    }
    updateChallenge(dt);
    updateBots(dt,now);
    updateVsRound(dt,now);
    updatePvpRemotes(dt);
    updatePvpNetSend(now);
    updatePvpBots(dt,now);
    updatePvpBotsNetSend(now);
    updatePvpBotsRemote(dt);
    updatePvpFlagCapture(dt);
  }
  updateEdit();

  // ターゲット位置更新（ムーバー追従）→ BB物理（固定サブステップ）
  updateTargets(dt,now);
  RT.physAcc+=dt;
  let n=0;
  while (RT.physAcc>=PHYS_DT && n<120){ stepBBs(PHYS_DT); RT.physAcc-=PHYS_DT; n++; }
  updateTrails();
  updateParticles(dt);

  renderer.render(scene,camera);
}
loop();

addEventListener("resize",()=>{
  camera.aspect=innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);
});
