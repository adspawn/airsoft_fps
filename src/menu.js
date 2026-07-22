/* ============================================================
   メインメニュー設定・モード切替（applyMode）
   ============================================================ */
import { $, S, RT, clearKeys, weapon, MAG_SIZE, EYE_H, player, targets, pvp,
  VS_ARENA, PLAYER_FLAG, RED_NPC_SPAWNS, BLUE_NPC_SPAWNS, RED_PLAYER_SPAWNS,
  updateWindVector, windDirName } from "./state.js";
import { solveOptimalSpin } from "./physics.js";
import { bbPool, killBB } from "./bb.js";
import { gun, setWeapon } from "./gun.js";
import { updateScoreHUD, plateMat } from "./targets.js";
import { enterEditMode, exitEditMode } from "./mapEditor.js";
import { updateAmmoHUD, onHopChanged, onLoadoutChanged } from "./player.js";
import { clearBots, clearVsField, genVsField, spawnBots, endDeathSequence, updateVsHUD,
  DIFF_NAMES } from "./bots.js";
import { pvpClearAvatars } from "./pvp.js";

/* 対戦(NPC)・オンラインPVP共通のルール名（両モードで同じ3ルールを使う） */
export const VS_RULE_NAMES={br:"バトルロワイアル", elim:"殲滅戦", flag:"フラッグ戦"};

/* モード適用（開始ボタンから、PVPは試合開始イベントから） */
export function applyMode(){
  clearKeys();   // モード切替時に前のモードのキー押下状態を持ち越さない
  const vs=S.mode==="vs", editing=S.mode==="edit", range=S.mode==="range", pvpMode=S.mode==="pvp";
  for (const tg of targets){
    tg.grp.visible=range;
    if (range){
      tg.alive=true; tg.animT=-1;
      if (tg.pivot) tg.pivot.rotation.x=0;
      if (tg.plate) tg.plate.material=plateMat;
      if (tg.type==="can"){
        tg.grp.position.set(tg.baseX,tg.homeY,tg.z);
        tg.grp.rotation.set(0,0,0); tg.vel.set(0,0,0); tg.flying=false;
      }
    } else {
      tg.alive=false;
    }
  }
  clearBots();
  clearVsField();
  exitEditMode();
  endDeathSequence();
  pvpClearAvatars();
  bbPool.forEach(b=>killBB(b));
  RT.firing=false; RT.ads=false;
  // リスポーン地点にリセット（対戦・マップ作成・PVPは射撃練習場と別の専用50m×50mフィールドへ）
  if (vs||editing||pvpMode) player.pos.set(VS_ARENA.cx, 0, PLAYER_FLAG.z-2);
  else player.pos.set(0,0,0);
  player.vel.set(0,0,0);
  player.yaw=0;   // yaw=0で-Z方向(敵フラッグ側)を向く
  player.pitch=0; player.crouch=false; player.crouchToggle=false;
  $("rangeBoard").style.display=range?"block":"none";
  $("vsBoard").style.display=vs?"block":"none";
  $("editBoard").style.display=editing?"block":"none";
  $("pvpBoard").style.display=pvpMode?"block":"none";
  $("ammoPanel").style.display=editing?"none":"block";
  $("hopPanel").style.display=editing?"none":"block";
  gun.visible=!editing;
  S.challenge.active=false; $("timer").textContent="";
  if (vs){
    genVsField();                       // バリケード配置（カスタム/ランダム）+ フラッグ設置（フラッグ戦のみ）
    S.vs.you=0; S.vs.active=true;
    RT.invulnUntil=performance.now()/1000+2;
    const teamed = S.vsRuleset==="elim" || S.vsRuleset==="flag";
    if (teamed){
      // オンラインPVPと同じ構成: プレイヤーは🔴赤チーム。赤=味方NPC / 青=敵NPC を陣地リングに配置
      if (S.vsNpcCountRed>0) spawnBots(S.vsNpcCountRed,
        {team:"red", diff:S.vsDiffRed, spawnSet:RED_NPC_SPAWNS, idOffset:0});
      if (S.vsNpcCountBlue>0) spawnBots(S.vsNpcCountBlue,
        {team:"blue", diff:S.vsDiffBlue, spawnSet:BLUE_NPC_SPAWNS, idOffset:S.vsNpcCountRed});
      player.pos.set(RED_PLAYER_SPAWNS[0][0], 0, RED_PLAYER_SPAWNS[0][1]);
    } else {
      spawnBots(S.vsNpcCount, {diff:S.diff});
    }
    updateVsHUD();
    const ruleName = VS_RULE_NAMES[S.vsRuleset]||S.vsRuleset;
    const npcTxt = teamed
      ? `NPC 🔴${S.vsNpcCountRed}体(${DIFF_NAMES[S.vsDiffRed]})／🔵${S.vsNpcCountBlue}体(${DIFF_NAMES[S.vsDiffBlue]})`
      : `NPC: ${DIFF_NAMES[S.diff]}×${S.vsNpcCount}`;
    $("vsInfo").textContent=`${ruleName} ｜ ${npcTxt} ｜ 被弾=即死`;
  } else if (editing){
    enterEditMode();
  } else if (pvpMode){
    genVsField(pvp.pendingMapData && pvp.pendingMapData.length ? pvp.pendingMapData : null);
    if (pvp.iAmHost){
      if (pvp.gameType==="elim" || pvp.gameType==="flag"){
        if (pvp.pendingNpcCountRed>0) spawnBots(pvp.pendingNpcCountRed,
          {team:"red", diff:pvp.pendingNpcDiffRed, spawnSet:RED_NPC_SPAWNS, idOffset:0});
        if (pvp.pendingNpcCountBlue>0) spawnBots(pvp.pendingNpcCountBlue,
          {team:"blue", diff:pvp.pendingNpcDiffBlue, spawnSet:BLUE_NPC_SPAWNS, idOffset:pvp.pendingNpcCountRed});
      } else if (pvp.pendingNpcCount>0){
        spawnBots(pvp.pendingNpcCount, {diff:pvp.pendingNpcDiff});
      }
    }
    RT.invulnUntil=performance.now()/1000+2;
  } else {
    S.score=0; S.shots=0; S.hits=0; updateScoreHUD();
  }
  weapon.mag=MAG_SIZE; weapon.reloading=false;
  $("reloadMsg").textContent=""; updateAmmoHUD();
}

export function wireMenuUI(){
  const masses=[0.12,0.16,0.20,0.25,0.28,0.30,0.36,0.43];
  const wrap=$("massChips");
  for (const m of masses){
    const b=document.createElement("button");
    b.className="chip"+(m===S.massG?" sel":"");
    b.textContent=m.toFixed(2)+"g";
    b.addEventListener("click",()=>{
      S.massG=m;
      wrap.querySelectorAll(".chip").forEach(c=>c.classList.remove("sel"));
      b.classList.add("sel");
      updateMenuEnergy(); onLoadoutChanged();
    });
    wrap.appendChild(b);
  }
  function updateMenuEnergy(){
    const E=0.5*S.massG*1e-3*S.v0*S.v0;
    const el=$("menuEnergy");
    el.textContent=`エネルギー: ${E.toFixed(2)} J`+(E>0.98?"（⚠ 法定 0.98 J 超過）":"（法定 0.98 J 以下）");
    el.classList.toggle("illegal",E>0.98);
  }
  $("v0Slider").addEventListener("input",e=>{
    S.v0=+e.target.value;
    $("v0Val").textContent=S.v0+" m/s";
    updateMenuEnergy(); onLoadoutChanged();
  });
  $("cycleSlider").addEventListener("input",e=>{
    S.cycle=+e.target.value;
    $("cycleVal").textContent=S.cycle+" 発/秒";
  });
  $("ricochetOn").addEventListener("click",()=>{
    S.ricochetHit=true;
    $("ricochetOn").classList.add("sel"); $("ricochetOff").classList.remove("sel");
  });
  $("ricochetOff").addEventListener("click",()=>{
    S.ricochetHit=false;
    $("ricochetOff").classList.add("sel"); $("ricochetOn").classList.remove("sel");
  });
  /* 選択中のモードに関係する設定行だけを表示する
     - 射撃練習: 装備設定(BB弾重量・初速・サイクル)
     - 対戦(NPC): 対戦ルール・NPCの強さ/数・バリケード
     - マップ作成: 設定なし / オンラインPVP: 部屋作成時にロビーで設定
     - 跳弾ヒットは射撃が発生する全モードで共通表示（装備値自体は全モード共通） */
  function updateMenuRows(){
    const range=S.mode==="range", vs=S.mode==="vs";
    for (const id of ["rowMass","rowV0","rowCycle","rowWindSpeed","rowWindDir","rowWindNote"])
      $(id).style.display=range?"flex":"none";
    $("menuEnergy").style.display=range?"block":"none";
    for (const id of ["rowVsRuleset","rowVsMap"]) $(id).style.display=vs?"flex":"none";
    // オンラインPVPのロビーと同じ構成: バトルロワイアル=単一NPC設定 / チーム戦=🔴🔵個別設定
    const teamed = S.vsRuleset==="elim" || S.vsRuleset==="flag";
    for (const id of ["rowNpcCount","rowDiff"]) $(id).style.display=(vs&&!teamed)?"flex":"none";
    for (const id of ["rowVsNpcRed","rowVsNpcRedDiff","rowVsNpcBlue","rowVsNpcBlueDiff"])
      $(id).style.display=(vs&&teamed)?"flex":"none";
    // 銃の種類・跳弾ヒットは射撃が発生する全モードで共通（マップ作成のみ非表示）
    $("rowWeapon").style.display = S.mode==="edit" ? "none" : "flex";
    $("rowRicochet").style.display = S.mode==="edit" ? "none" : "flex";
  }
  const modeBtns={range:$("modeRange"), vs:$("modeVs"), edit:$("modeEdit"), pvp:$("modePvp")};
  for (const [m,btn] of Object.entries(modeBtns)){
    btn.addEventListener("click",()=>{
      S.mode=m;
      Object.values(modeBtns).forEach(b=>b.classList.remove("sel"));
      btn.classList.add("sel");
      updateMenuRows();
    });
  }
  updateMenuRows();
  $("vsMapRandom").addEventListener("click",()=>{
    S.vsMap="random";
    $("vsMapRandom").classList.add("sel"); $("vsMapCustom").classList.remove("sel");
  });
  $("vsMapCustom").addEventListener("click",()=>{
    S.vsMap="custom";
    $("vsMapCustom").classList.add("sel"); $("vsMapRandom").classList.remove("sel");
  });
  /* 風の設定（射撃練習）。値を変えたら風ベクトルとHUD表示を作り直す */
  function refreshWind(){
    updateWindVector();
    $("windSpeedVal").textContent=S.windSpeed.toFixed(1)+" m/s";
    const rel = S.windDir===0 ? "追い風" : S.windDir===180 ? "向かい風"
      : (S.windDir>0 && S.windDir<180) ? "右へ" : "左へ";
    $("windDirVal").textContent=`${windDirName(S.windDir)}（${rel}）`;
    $("windDisp").textContent = S.windSpeed>0
      ? `${windDirName(S.windDir)}へ ${S.windSpeed.toFixed(1)} m/s` : "なし";
  }
  $("windSpeedSlider").addEventListener("input",e=>{ S.windSpeed=+e.target.value; refreshWind(); });
  $("windDirSlider").addEventListener("input",e=>{ S.windDir=+e.target.value; refreshWind(); });
  refreshWind();
  $("weaponChips").addEventListener("click",e=>{
    const b=e.target.closest(".chip"); if(!b) return;
    $("weaponChips").querySelectorAll(".chip").forEach(c=>c.classList.remove("sel"));
    b.classList.add("sel");
    setWeapon(b.dataset.w);
  });
  $("diffChips").addEventListener("click",e=>{
    const b=e.target.closest(".chip"); if(!b) return;
    S.diff=b.dataset.d;
    $("diffChips").querySelectorAll(".chip").forEach(c=>c.classList.remove("sel"));
    b.classList.add("sel");
  });
  $("vsRulesetChips").addEventListener("click",e=>{
    const b=e.target.closest(".chip"); if(!b) return;
    S.vsRuleset=b.dataset.r;
    $("vsRulesetChips").querySelectorAll(".chip").forEach(c=>c.classList.remove("sel"));
    b.classList.add("sel");
    updateMenuRows();   // ルール変更でNPC設定行（単一↔🔴🔵個別）を切り替える
  });
  $("npcCountSlider").addEventListener("input",e=>{
    S.vsNpcCount=+e.target.value;
    $("npcCountVal").textContent=S.vsNpcCount+"体";
  });
  $("vsNpcCountRedSlider").addEventListener("input",e=>{
    S.vsNpcCountRed=+e.target.value;
    $("vsNpcCountRedVal").textContent=S.vsNpcCountRed+"体";
  });
  $("vsNpcCountBlueSlider").addEventListener("input",e=>{
    S.vsNpcCountBlue=+e.target.value;
    $("vsNpcCountBlueVal").textContent=S.vsNpcCountBlue+"体";
  });
  function wireVsDiffChips(id, key){
    $(id).addEventListener("click",e=>{
      const b=e.target.closest(".chip"); if(!b) return;
      S[key]=b.dataset.d;
      $(id).querySelectorAll(".chip").forEach(c=>c.classList.remove("sel"));
      b.classList.add("sel");
    });
  }
  wireVsDiffChips("vsDiffRedChips","vsDiffRed");
  wireVsDiffChips("vsDiffBlueChips","vsDiffBlue");
  updateMenuEnergy();

  /* 初回: 適正ホップを計算して自動セット */
  setTimeout(()=>{
    S.optimalSpin=solveOptimalSpin({v0:S.v0, massG:S.massG, h0:EYE_H, drag:S.drag});
    S.spinRps=Math.round(S.optimalSpin);
    onHopChanged();
  },50);
}
