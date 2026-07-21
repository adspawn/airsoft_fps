/* ============================================================
   オンラインPVP（Node.js + Socket.io）
   物理・弾道は各クライアントでシミュレーションし、サーバーは
   ロビー（部屋の作成/参加/準備確認/開始）と、被弾報告の中継・
   キル数集計・リスポーン指示だけを行う（自己申告ヒット方式）。
   NPCはホストのクライアントのみがAI・移動・射撃を実行し、
   結果(位置・射撃)を他クライアントへ中継する「ホスト権威」方式。
   ============================================================ */
import { THREE, S, $, scene, camera, renderer, RT, UP, pvp, pvpFriendly, player, weapon,
  MAG_SIZE, bots, spawnPoints, RED_PLAYER_SPAWNS, RED_NPC_SPAWNS, BLUE_PLAYER_SPAWNS,
  BLUE_NPC_SPAWNS, ENEMY_FLAG, PLAYER_FLAG } from "./state.js";
import { spawnParticles, showMsg } from "./effects.js";
import { sndHitMe, sndShotFar } from "./sound.js";
import { spawnBB } from "./bb.js";
import { applySpread, updateAmmoHUD } from "./player.js";
import { buildBotMesh, spawnBots, DIFF_PARAMS, DIFF_NAMES, losClear, resolveBotCollision,
  pickWp, angleDelta, startDeathSequence, endDeathSequence, genVsField, genRandomVsProps,
  loadCustomMap, setBotSeek, setBotHold, yukaUpdate, syncBotFromVehicle } from "./bots.js";
import { applyMode } from "./menu.js";

const _v1=new THREE.Vector3(), _v2=new THREE.Vector3(), _v3=new THREE.Vector3(), _v4=new THREE.Vector3();

/* ============================================================
   オンラインPVP用NPC（ホスト権威）
   ============================================================ */
export function pvpNearestTarget(bot){
  let best=null, bestD=Infinity;
  if (!RT.dying && !pvpFriendly(bot.team, pvp.myTeam)){
    const d=Math.hypot(player.pos.x-bot.pos.x, player.pos.z-bot.pos.z);
    if (d<bestD){ bestD=d; best={isLocal:true, pos:player.pos, vel:player.vel, eyeH:player.eyeH}; }
  }
  for (const rp of pvp.players.values()){
    if (!rp.alive || pvpFriendly(bot.team, rp.team)) continue;
    const d=Math.hypot(rp.pos.x-bot.pos.x, rp.pos.z-bot.pos.z);
    if (d<bestD){ bestD=d; best={isLocal:false, id:rp.id, pos:rp.pos, vel:null, eyeH:1.6}; }
  }
  return best ? {target:best, dist:bestD} : null;
}
export function pvpBotShoot(bot,p,distP,target){
  _v3.set(bot.pos.x-Math.sin(bot.yaw)*0.5, bot.pos.y+1.32, bot.pos.z-Math.cos(bot.yaw)*0.5);
  _v4.set(target.pos.x, target.pos.y+target.eyeH-0.5, target.pos.z);
  if (target.vel){
    _v4.x += target.vel.x*(distP/85)*p.lead;
    _v4.z += target.vel.z*(distP/85)*p.lead;
  }
  const dir=_v4.sub(_v3).normalize();
  applySpread(dir, p.spread);
  sndShotFar(distP);
  const botId="bot:"+bot.netId;
  const origin={x:_v3.x,y:_v3.y,z:_v3.z}, dv={x:dir.x,y:dir.y,z:dir.z};
  spawnBB(_v3, dir, 90, 140, "pvpEnemy", botId, UP, bot.team);   // ホスト自身も被弾しうるのでローカルにも発射
  if (pvp.socket) pvp.socket.emit("game:botShot", {botId, origin, dir:dv, v0:90, spinRps:140, team:bot.team});
}
export function updatePvpBots(dt, now){
  if (S.mode!=="pvp" || !pvp.inMatch || !pvp.iAmHost) return;
  // 1st pass: 意思決定（状態遷移・射撃・移動指示）
  for (const bot of bots){
    const p=DIFF_PARAMS[bot.diff||S.diff];
    if (!bot.alive){
      bot.fallT+=dt;
      bot.grp.rotation.x=Math.min(1.5, bot.fallT/0.25*1.5);
      setBotHold(bot);
      continue;
    }
    const nt=pvpNearestTarget(bot);
    if (!nt){ setBotHold(bot); continue; }
    const {target, dist:distP}=nt;
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
        const v=bot.vehicle.velocity;
        if (v.squaredLength()>0.04) bot.targetYaw=Math.atan2(-v.x,-v.z);
      }
    } else {
      bot.timer-=dt;
      _v1.set(target.pos.x-bot.pos.x, 0, target.pos.z-bot.pos.z);
      bot.targetYaw=Math.atan2(-_v1.x,-_v1.z);
      if (bot.reactT>0) bot.reactT-=dt;
      else {
        bot.cooldown-=dt;
        if (bot.pauseT>0) bot.pauseT-=dt;
        else if (bot.cooldown<=0){
          if (losClear(bot, target)) pvpBotShoot(bot,p,distP,target);
          bot.cooldown=1/p.cycle;
          if (--bot.burstLeft<=0){
            bot.burstLeft=p.burst;
            bot.pauseT=0.5+Math.random()*0.8;
          }
        }
      }
      if (bot.timer<=0){
        bot.state="move"; bot.moveT=0;
        // フラッグ戦: 一定確率で敵陣フラッグへ直行（赤NPC→青陣地の旗 / 青NPC→赤陣地の旗）
        const fg=pvpBotFlagGoal(bot);
        bot.wp = (fg && Math.random()<0.25)
          ? {x:fg.x+(Math.random()*2-1)*1.5, z:fg.z+(Math.random()*2-1)*1.5}
          : pickWp(bot);
      }
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
    // フラッグ戦: NPCが敵陣の旗に到達したらそのチームの勝利をホストが報告
    if (!pvpBotFlagCaptured && pvp.gameType==="flag" && bot.team && pvp.socket){
      const fg=pvpBotFlagGoal(bot);
      if (fg && Math.hypot(bot.pos.x-fg.x, bot.pos.z-fg.z)<1.4){
        pvpBotFlagCaptured=true;
        pvp.socket.emit("game:botFlagCapture", {team:bot.team});
      }
    }
  }
}
/* フラッグ戦でこのNPCが狙うべき敵陣の旗（赤チーム→ENEMY_FLAG(青陣地)、青チーム→PLAYER_FLAG(赤陣地)） */
function pvpBotFlagGoal(bot){
  if (pvp.gameType!=="flag" || !bot.team) return null;
  return bot.team==="red" ? ENEMY_FLAG : PLAYER_FLAG;
}
let pvpBotFlagCaptured=false;   // 1試合1回だけ報告（多重emit防止。試合開始時にリセット）
export function onPvpBotHit(bot, shooterId){
  bot.alive=false; bot.fallT=0;
  spawnParticles(bot.grp.position, 0xffffff, 5, 1.4);
  if (pvp.socket) pvp.socket.emit("game:botHit", {botId:"bot:"+bot.netId, shooterId});
}
let pvpBotsLastSend=0;
export function updatePvpBotsNetSend(now){
  if (S.mode!=="pvp" || !pvp.inMatch || !pvp.iAmHost || !pvp.socket) return;
  if (now-pvpBotsLastSend<0.1) return;   // 約10Hz
  pvpBotsLastSend=now;
  pvp.socket.emit("game:bots", bots.map(b=>({id:"bot:"+b.netId, x:b.pos.x, z:b.pos.z, yaw:b.yaw, alive:b.alive, team:b.team})));
}
export function pvpApplyBotsState(list){
  if (pvp.iAmHost) return;   // 自分がホストなら自前のbots配列が真実のソース
  const seen=new Set();
  for (const d of list){
    seen.add(d.id);
    let rb=pvp.bots.get(d.id);
    if (!rb){
      const pivot=new THREE.Group(); pivot.add(buildBotMesh()); scene.add(pivot);
      pivot.position.set(d.x,0,d.z);
      rb={pivot, pos:new THREE.Vector3(d.x,0,d.z), targetPos:new THREE.Vector3(d.x,0,d.z),
          yaw:d.yaw, targetYaw:d.yaw, alive:true, fallT:-1, team:d.team||null};
      pvp.bots.set(d.id, rb);
    }
    if (!d.alive && rb.alive){ rb.alive=false; rb.fallT=0; }
    if (d.alive){ rb.targetPos.set(d.x,0,d.z); rb.targetYaw=d.yaw; }
  }
  for (const [id,rb] of pvp.bots){
    if (!seen.has(id)){ scene.remove(rb.pivot); pvp.bots.delete(id); }
  }
}
export function updatePvpBotsRemote(dt){
  if (S.mode!=="pvp" || pvp.iAmHost) return;
  for (const rb of pvp.bots.values()){
    if (!rb.alive){
      rb.fallT+=dt;
      rb.pivot.rotation.x=Math.min(1.5, rb.fallT/0.25*1.5);
    } else {
      rb.pos.lerp(rb.targetPos, Math.min(1,dt*10));
      rb.yaw += angleDelta(rb.targetYaw, rb.yaw)*Math.min(1,dt*10);
      rb.pivot.position.copy(rb.pos);
      rb.pivot.rotation.y=rb.yaw;
    }
  }
}
export function pvpClearBots(){
  for (const rb of pvp.bots.values()) scene.remove(rb.pivot);
  pvp.bots.clear();
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function makeNameSprite(name){
  const c=document.createElement("canvas"); c.width=256; c.height=64;
  const g=c.getContext("2d");
  g.fillStyle="rgba(0,0,0,.55)"; g.fillRect(0,0,256,64);
  g.font="bold 34px sans-serif"; g.textAlign="center"; g.textBaseline="middle";
  g.fillStyle="#fff"; g.fillText(String(name).slice(0,16), 128, 34);
  const tex=new THREE.CanvasTexture(c); tex.colorSpace=THREE.SRGBColorSpace;
  const spr=new THREE.Sprite(new THREE.SpriteMaterial({map:tex, depthTest:false, transparent:true}));
  spr.scale.set(1.3,0.32,1); spr.renderOrder=20;
  return spr;
}
export function pvpConnect(){
  if (pvp.socket) return;
  if (typeof io==="undefined"){
    $("pvpConnStatus").textContent="サーバーに接続できません（Node.jsサーバー(server.js)を起動してください）";
    $("pvpConnStatus").className="error";
    return;
  }
  const s = pvp.socket = io();
  s.on("connect",()=>{
    pvp.connected=true; pvp.myId=s.id;
    $("pvpConnStatus").textContent="接続済み（自分: "+pvp.myId.slice(0,6)+"）";
    $("pvpConnStatus").className="connected";
    s.emit("lobby:setName", pvp.name);
    pvpRefreshRoomList();
  });
  s.on("disconnect",()=>{
    pvp.connected=false;
    $("pvpConnStatus").textContent="切断されました。再接続を試みています…";
    $("pvpConnStatus").className="error";
    pvp.currentRoom=null; renderPvpRoomView();
  });
  s.on("lobby:update", room=>{ pvp.currentRoom=room; renderPvpRoomView(); });
  s.on("game:start", data=> pvpStartMatch(data));
  s.on("game:state", state=> pvpApplyRemoteState(state));
  s.on("game:shot", shot=> pvpSpawnRemoteShot(shot));
  s.on("game:botShot", shot=> pvpSpawnBotShot(shot));
  s.on("game:bots", list=> pvpApplyBotsState(list));
  s.on("game:killed", data=> pvpOnKilled(data));
  s.on("game:respawn", data=> pvpOnRespawn(data));
  s.on("game:over", data=> pvpOnGameOver(data));
}
export function pvpRefreshRoomList(){
  if (!pvp.socket) return;
  pvp.socket.emit("lobby:list", list=>{ pvp.roomListCache=list; renderPvpRoomList(); });
}
function renderPvpRoomList(){
  const el=$("pvpRoomList");
  if (!pvp.roomListCache.length){
    el.innerHTML=`<div id="pvpRoomListEmpty">部屋がありません。新しく作成してください</div>`;
    return;
  }
  el.innerHTML="";
  const gtNames={br:"バトルロワイアル", elim:"殲滅戦", flag:"フラッグ戦"};
  for (const r of pvp.roomListCache){
    const div=document.createElement("div");
    div.className="pvpRoomItem";
    const npcTxt = r.gameType==="br" ? (r.npcCount?"+NPC"+r.npcCount:"")
      : ((r.npcCountRed||r.npcCountBlue)?`+NPC🔴${r.npcCountRed}🔵${r.npcCountBlue}`:"");
    div.innerHTML=`<span>${escapeHtml(r.name)} <span style="color:var(--dim)">(${r.count}人${npcTxt})</span></span><b>${gtNames[r.gameType]||r.gameType}</b>`;
    div.addEventListener("click",()=> pvpJoinRoom(r.id));
    el.appendChild(div);
  }
}
function pvpSelDiff(id){
  const sel=$(id).querySelector(".chip.sel");
  return sel ? sel.dataset.d : "normal";
}
export function pvpCreateRoom(){
  if (!pvp.socket) return;
  const name=$("pvpNewRoomName").value||"ルーム";
  const btns={br:$("pvpGameTypeBr"), elim:$("pvpGameTypeElim"), flag:$("pvpGameTypeFlag")};
  const gameType=Object.keys(btns).find(k=>btns[k].classList.contains("sel"))||"br";
  const npcCount=+$("pvpNpcCountSlider").value||0;
  const npcDiff=pvpSelDiff("pvpNpcDiffChips");
  const npcCountRed=+$("pvpNpcCountRedSlider").value||0;
  const npcDiffRed=pvpSelDiff("pvpNpcDiffRedChips");
  const npcCountBlue=+$("pvpNpcCountBlueSlider").value||0;
  const npcDiffBlue=pvpSelDiff("pvpNpcDiffBlueChips");
  const mapMode=$("pvpMapCustom").classList.contains("sel")?"custom":"random";
  pvp.socket.emit("lobby:create", {
    name, gameType, npcCount, npcDiff, npcCountRed, npcDiffRed, npcCountBlue, npcDiffBlue, mapMode,
  }, res=>{
    if (res && res.ok){ pvp.currentRoom=res.room; renderPvpRoomView(); }
  });
}
export function pvpJoinRoom(roomId){
  if (!pvp.socket) return;
  pvp.socket.emit("lobby:join", {roomId}, res=>{
    if (res && res.ok){ pvp.currentRoom=res.room; renderPvpRoomView(); }
    else if (res) alert(res.error||"参加に失敗しました");
  });
}
export function pvpLeaveRoom(){
  if (pvp.socket) pvp.socket.emit("lobby:leave");
  pvp.currentRoom=null;
  renderPvpRoomView();
  pvpRefreshRoomList();
}
export function renderPvpRoomView(){
  const inRoom=!!pvp.currentRoom;
  $("pvpRoomListView").style.display = inRoom? "none":"block";
  $("pvpRoomView").style.display = inRoom? "block":"none";
  if (!inRoom) return;
  const room=pvp.currentRoom;
  const gtNames={br:"バトルロワイアル", elim:"殲滅戦", flag:"フラッグ戦"};
  const gtName = gtNames[room.gameType]||room.gameType;
  const teamed = room.gameType==="elim" || room.gameType==="flag";
  $("pvpRoomTitle").textContent = `${room.name}（${room.players.length}人）`;
  const mapName = room.mapMode==="custom" ? "カスタムマップ" : "ランダム";
  const npcTxt = teamed
    ? `NPC 🔴${room.npcCountRed}体(${DIFF_NAMES[room.npcDiffRed]||room.npcDiffRed})／🔵${room.npcCountBlue}体(${DIFF_NAMES[room.npcDiffBlue]||room.npcDiffBlue})`
    : `NPC${room.npcCount}体(${DIFF_NAMES[room.npcDiff]||room.npcDiff})`;
  $("pvpRoomSettings").textContent = `${gtName} ｜ ${npcTxt} ｜ ${mapName}`;
  const list=$("pvpPlayerList"); list.innerHTML="";
  const isHost = room.hostId===pvp.myId;
  let allReady=true;
  const teamMark={red:"🔴", blue:"🔵"};
  room.players.forEach((p,i)=>{
    const div=document.createElement("div");
    div.className="pvpPlayerItem";
    const readySpan = p.id===room.hostId
      ? `<span class="host">ホスト</span>`
      : (p.ready? `<span class="rdy">準備OK</span>` : `<span class="notrdy">準備中…</span>`);
    // チームは試合開始時に確定するが、ロビーでは参加順で仮表示（赤青交互）しておく
    const teamTxt = teamed ? (teamMark[p.team || (i%2===0?"red":"blue")]||"") : "";
    div.innerHTML=`<span>${teamTxt}${escapeHtml(p.name)}${p.id===pvp.myId?"（あなた）":""}</span>${readySpan}`;
    list.appendChild(div);
    if (p.id!==room.hostId && !p.ready) allReady=false;
  });
  const me = room.players.find(p=>p.id===pvp.myId);
  $("pvpReadyBtn").style.display = isHost? "none":"block";
  $("pvpReadyBtn").classList.toggle("active", !!(me&&me.ready));
  $("pvpReadyBtn").textContent = (me&&me.ready)? "準備OK（解除）":"準備完了";
  $("pvpStartBtn").style.display = isHost? "block":"none";
  $("pvpStartBtn").disabled = !allReady;   // 1人（ホストのみ）でも開始可能
}
/* チーム戦(殲滅戦/フラッグ戦)は自陣フラッグ周辺のリング、バトルロワイアルは従来の共通spawnPointsを使う */
function pvpSpawnPos(team, spawnIndex){
  if (pvp.gameType==="elim" || pvp.gameType==="flag"){
    const set = team==="blue" ? BLUE_PLAYER_SPAWNS : RED_PLAYER_SPAWNS;
    return set[spawnIndex%set.length];
  }
  return spawnPoints[spawnIndex%spawnPoints.length];
}
function pvpCreateRemoteAvatar(p){
  const pivot=new THREE.Group();
  pivot.add(buildBotMesh());
  const tag=makeNameSprite(p.name); tag.position.y=1.9; pivot.add(tag);
  scene.add(pivot);
  const sp=pvpSpawnPos(p.team, p.spawnIndex||0);
  pivot.position.set(sp[0],0,sp[1]);
  pvp.players.set(p.id,{
    id:p.id, name:p.name, team:p.team||null, kills:0, deaths:0, alive:true,
    pos:new THREE.Vector3(sp[0],0,sp[1]), targetPos:new THREE.Vector3(sp[0],0,sp[1]),
    yaw:0, targetYaw:0, pivot, fallT:-1,
  });
}
export function pvpClearAvatars(){
  for (const rp of pvp.players.values()) scene.remove(rp.pivot);
  pvp.players.clear();
}
function applyPvpSpawn(spawnIndex, team){
  const sp=pvpSpawnPos(team, spawnIndex);
  player.pos.set(sp[0],0,sp[1]); player.vel.set(0,0,0);
  player.yaw=0; player.pitch=0;
  weapon.mag=MAG_SIZE; weapon.reloading=false; $("reloadMsg").textContent=""; updateAmmoHUD();
  RT.invulnUntil=RT.gNow+1.5;
}
function updatePvpScoreHUD(){
  const list=$("pvpScoreList"); list.innerHTML="";
  const rows=[{id:pvp.myId, name:pvp.name+"（あなた）", kills:pvpMyKills, deaths:pvpMyDeaths}];
  for (const rp of pvp.players.values()) rows.push({id:rp.id, name:rp.name, kills:rp.kills, deaths:rp.deaths});
  rows.sort((a,b)=>b.kills-a.kills);
  for (const r of rows){
    const div=document.createElement("div");
    if (r.id===pvp.myId) div.className="me";
    div.textContent=`${r.name}: ${r.kills}キル / ${r.deaths}デス`;
    list.appendChild(div);
  }
}
let pvpMyKills=0, pvpMyDeaths=0;
export function getPvpMyKills(){ return pvpMyKills; }
export function getPvpMyDeaths(){ return pvpMyDeaths; }
function pvpUpdateScoresFromServer(scores){
  for (const s of scores){
    if (s.id===pvp.myId){ pvpMyKills=s.kills; pvpMyDeaths=s.deaths; continue; }
    const rp=pvp.players.get(s.id);
    if (rp){ rp.kills=s.kills; rp.deaths=s.deaths; }
  }
  updatePvpScoreHUD();
}
function pvpKillfeed(text){ showMsg(text, 1.8); }
const PVP_GT_NAMES={br:"バトルロワイアル", elim:"殲滅戦", flag:"フラッグ戦"};
export function pvpStartMatch({players, gameType, npcCount, npcDiff, npcCountRed, npcDiffRed,
                         npcCountBlue, npcDiffBlue, hostId, mapData}){
  pvp.inMatch=true; pvp.gameType=gameType||"br";
  pvp.iAmHost = hostId===pvp.myId;
  pvp.pendingMapData = mapData;
  pvp.pendingNpcCount = npcCount||0; pvp.pendingNpcDiff = npcDiff||"normal";
  pvp.pendingNpcCountRed = npcCountRed||0; pvp.pendingNpcDiffRed = npcDiffRed||"normal";
  pvp.pendingNpcCountBlue = npcCountBlue||0; pvp.pendingNpcDiffBlue = npcDiffBlue||"normal";
  pvpMyKills=0; pvpMyDeaths=0; pvpBotFlagCaptured=false;
  $("pvpLobby").classList.remove("show");
  S.mode="pvp";
  applyMode();
  pvpClearAvatars();
  pvpClearBots();
  let mySpawnIndex=0, myTeam=null;
  for (const p of players){
    if (p.id===pvp.myId){ mySpawnIndex=p.spawnIndex; myTeam=p.team||null; continue; }
    pvpCreateRemoteAvatar(p);
  }
  pvp.myTeam=myTeam;
  applyPvpSpawn(mySpawnIndex, myTeam);
  const teamTxt = myTeam ? `（あなた: ${myTeam==="red"?"🔴赤":"🔵青"}）` : "";
  $("pvpGoalLine").textContent = `🌐 オンラインPVP ｜ ${PVP_GT_NAMES[pvp.gameType]||pvp.gameType}${teamTxt}`;
  updatePvpScoreHUD();
  renderer.domElement.requestPointerLock();
}
function pvpApplyRemoteState({id,pos,yaw}){
  const rp=pvp.players.get(id);
  if (!rp || rp.fallT>=0) return;
  rp.targetPos.set(pos.x,pos.y,pos.z);
  rp.targetYaw=yaw;
}
function pvpSpawnRemoteShot(shot){
  if (S.mode!=="pvp" || !pvp.inMatch) return;
  const origin=new THREE.Vector3(shot.origin.x,shot.origin.y,shot.origin.z);
  const dir=new THREE.Vector3(shot.dir.x,shot.dir.y,shot.dir.z);
  const rp=pvp.players.get(shot.id);
  spawnBB(origin, dir, shot.v0, shot.spinRps, "pvpEnemy", shot.id, UP, rp?rp.team:null);
}
function pvpSpawnBotShot(shot){
  if (S.mode!=="pvp" || !pvp.inMatch || pvp.iAmHost) return;   // ホストは自前ですでに発射済み
  const origin=new THREE.Vector3(shot.origin.x,shot.origin.y,shot.origin.z);
  const dir=new THREE.Vector3(shot.dir.x,shot.dir.y,shot.dir.z);
  spawnBB(origin, dir, shot.v0, shot.spinRps, "pvpEnemy", shot.botId, UP, shot.team||null);
}
export function onPvpPlayerHit(shooterId){
  if (!pvp.inMatch || RT.dying) return;   // 死亡演出中の多重ヒットで再トリガーしないように
  sndHitMe();
  $("dmgFlash").classList.add("show");
  setTimeout(()=>$("dmgFlash").classList.remove("show"),700);
  startDeathSequence();
  if (pvp.socket) pvp.socket.emit("game:hit", {shooterId});
}
function pvpOnKilled({targetId, shooterId, shooterName, targetName, scores}){
  pvpUpdateScoresFromServer(scores);
  if (targetId===pvp.myId) pvpKillfeed(`${shooterName} にやられた…`);
  else if (shooterId===pvp.myId) pvpKillfeed(`${targetName} を撃破！`);
  else pvpKillfeed(`${shooterName} が ${targetName} を撃破`);
  const rp=pvp.players.get(targetId);
  if (rp){ rp.alive=false; rp.fallT=0; }
}
function pvpOnRespawn({id, spawnIndex}){
  if (id===pvp.myId){
    endDeathSequence();
    applyPvpSpawn(spawnIndex, pvp.myTeam);
  } else {
    const rp=pvp.players.get(id);
    if (!rp) return;
    rp.alive=true; rp.fallT=-1; rp.pivot.rotation.x=0;
    const sp=pvpSpawnPos(rp.team, spawnIndex);
    rp.pos.set(sp[0],0,sp[1]); rp.targetPos.copy(rp.pos);
    rp.pivot.position.copy(rp.pos);
  }
}
function pvpOnGameOver({winnerId, winnerName, winnerTeam, scores}){
  pvpUpdateScoresFromServer(scores);
  pvp.inMatch=false;
  let msg;
  if (winnerTeam){
    const won=winnerTeam===pvp.myTeam;
    const teamLabel=winnerTeam==="red"?"🔴赤チーム":"🔵青チーム";
    msg = won? `🏆 勝利！（${teamLabel}）` : `試合終了 — 勝利: ${teamLabel}`;
  } else {
    const won=winnerId===pvp.myId;
    msg = winnerName ? (won? `🏆 優勝！（${winnerName}）` : `試合終了 — 優勝: ${winnerName}`) : "試合終了（引き分け）";
  }
  showMsg(msg, 5);
  setTimeout(()=>{ if (document.pointerLockElement) document.exitPointerLock(); }, 3200);
}
export function updatePvpRemotes(dt){
  if (S.mode!=="pvp") return;
  for (const rp of pvp.players.values()){
    if (rp.fallT>=0){
      rp.fallT+=dt;
      rp.pivot.rotation.x=Math.min(1.45, rp.fallT/0.6*1.45);
    } else {
      rp.pos.lerp(rp.targetPos, Math.min(1,dt*10));
      rp.yaw += angleDelta(rp.targetYaw, rp.yaw)*Math.min(1,dt*10);
      rp.pivot.position.copy(rp.pos);
      rp.pivot.rotation.y=rp.yaw;
    }
  }
}
let pvpLastSend=0;
export function updatePvpNetSend(now){
  if (S.mode!=="pvp" || !pvp.inMatch || !pvp.socket) return;
  if (now-pvpLastSend<0.06) return;   // 約16Hz
  pvpLastSend=now;
  pvp.socket.emit("game:state",{
    pos:{x:player.pos.x,y:player.pos.y,z:player.pos.z}, yaw:player.yaw, pitch:player.pitch,
  });
}
/* フラッグ戦: 敵陣の旗に到達したら自己申告してチーム勝利を確定させる */
export function updatePvpFlagCapture(dt){
  if (S.mode!=="pvp" || !pvp.inMatch || pvp.gameType!=="flag" || RT.dying || !pvp.myTeam || !pvp.socket) return;
  const enemyFlag = pvp.myTeam==="red" ? ENEMY_FLAG : PLAYER_FLAG;
  if (Math.hypot(player.pos.x-enemyFlag.x, player.pos.z-enemyFlag.z) < 1.4){
    pvp.socket.emit("game:flagCapture");
  }
}

export function wirePvpLobbyUI(){
  $("pvpRefreshBtn").addEventListener("click", pvpRefreshRoomList);
  $("pvpCreateBtn").addEventListener("click", pvpCreateRoom);
  $("pvpLeaveBtn").addEventListener("click", pvpLeaveRoom);
  $("pvpReadyBtn").addEventListener("click",()=>{
    if (!pvp.currentRoom || !pvp.socket) return;
    const me=pvp.currentRoom.players.find(p=>p.id===pvp.myId);
    pvp.socket.emit("lobby:ready", !(me&&me.ready));
  });
  $("pvpStartBtn").addEventListener("click",()=>{
    if (!pvp.socket || !pvp.currentRoom) return;
    // ホストがバリケード配置を一度だけ確定し、全クライアントへ配布して同一レイアウトにする
    let mapData = pvp.currentRoom.mapMode==="custom" ? (loadCustomMap()||[]) : [];
    if (pvp.currentRoom.mapMode==="custom" && !mapData.length){
      showMsg("カスタムマップ未保存 → ランダム配置",2.2);
    }
    if (!mapData.length) mapData = genRandomVsProps();
    pvp.socket.emit("lobby:start", {mapData});
  });
  $("pvpCloseBtn").addEventListener("click",()=>{
    pvpLeaveRoom();
    $("pvpLobby").classList.remove("show");
    $("menu").style.display="flex";
  });
  function pvpSetGameType(t){
    const btns={br:$("pvpGameTypeBr"), elim:$("pvpGameTypeElim"), flag:$("pvpGameTypeFlag")};
    Object.values(btns).forEach(b=>b.classList.remove("sel"));
    btns[t].classList.add("sel");
    const teamed = t==="elim" || t==="flag";
    $("pvpNpcBrRow").style.display = teamed? "none":"flex";
    $("pvpNpcBrDiffRow").style.display = teamed? "none":"flex";
    $("pvpNpcRedRow").style.display = teamed? "flex":"none";
    $("pvpNpcRedDiffRow").style.display = teamed? "flex":"none";
    $("pvpNpcBlueRow").style.display = teamed? "flex":"none";
    $("pvpNpcBlueDiffRow").style.display = teamed? "flex":"none";
  }
  $("pvpGameTypeBr").addEventListener("click",()=>pvpSetGameType("br"));
  $("pvpGameTypeElim").addEventListener("click",()=>pvpSetGameType("elim"));
  $("pvpGameTypeFlag").addEventListener("click",()=>pvpSetGameType("flag"));
  $("pvpNpcCountSlider").addEventListener("input",e=>{
    $("pvpNpcCountVal").textContent=(+e.target.value)+"体";
  });
  $("pvpNpcCountRedSlider").addEventListener("input",e=>{
    $("pvpNpcCountRedVal").textContent=(+e.target.value)+"体";
  });
  $("pvpNpcCountBlueSlider").addEventListener("input",e=>{
    $("pvpNpcCountBlueVal").textContent=(+e.target.value)+"体";
  });
  function pvpWireDiffChips(id){
    const wrap=$(id);
    wrap.querySelectorAll(".chip").forEach(b=>{
      b.addEventListener("click",()=>{
        wrap.querySelectorAll(".chip").forEach(c=>c.classList.remove("sel"));
        b.classList.add("sel");
      });
    });
  }
  pvpWireDiffChips("pvpNpcDiffChips");
  pvpWireDiffChips("pvpNpcDiffRedChips");
  pvpWireDiffChips("pvpNpcDiffBlueChips");
  $("pvpMapRandom").addEventListener("click",()=>{
    $("pvpMapRandom").classList.add("sel"); $("pvpMapCustom").classList.remove("sel");
  });
  $("pvpMapCustom").addEventListener("click",()=>{
    $("pvpMapCustom").classList.add("sel"); $("pvpMapRandom").classList.remove("sel");
  });
}
