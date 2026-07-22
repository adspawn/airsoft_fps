/* ============================================================
   オンラインPVP（PeerJS / WebRTC によるサーバーレスP2P）
   物理・弾道は各クライアントでシミュレーションする。ロビー（部屋の作成/
   参加/準備確認/開始）と、被弾報告の中継・キル数集計・リスポーン指示・
   勝敗判定は「ホスト」のブラウザがすべて権威的に処理し、他プレイヤー
   （ゲスト）とはWebRTCで直接データをやり取りする（中継サーバー不要）。
   ゲストはホストとのみ接続し（スター型トポロジー）、ゲスト間で共有すべき
   情報（他プレイヤーの位置・発射等）はホストが中継する。
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
import { p2p, p2pSetHandlers, p2pHostRoom, p2pJoinRoom, p2pSend, p2pSendToHost,
  p2pBroadcast, p2pDisconnect } from "./p2p.js";

const _v1=new THREE.Vector3(), _v2=new THREE.Vector3(), _v3=new THREE.Vector3(), _v4=new THREE.Vector3();
const RESPAWN_DELAY_MS = 3000;

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
  // 敵NPCも標的にする（バトルロワイアルは全NPCが敵同士、チーム戦は敵チームのNPCのみ）
  for (const ob of bots){
    if (ob===bot || !ob.alive || pvpFriendly(bot.team, ob.team)) continue;
    const d=Math.hypot(ob.pos.x-bot.pos.x, ob.pos.z-bot.pos.z);
    if (d<bestD){ bestD=d; best={isLocal:false, id:"bot:"+ob.netId, pos:ob.pos, vel:null, eyeH:1.5}; }
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
  p2pBroadcast("botShot", {botId, origin, dir:dv, v0:90, spinRps:140, team:bot.team});
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
        // フラッグ戦: 難易度に応じた確率(flagRush)で敵陣フラッグへ直行（赤NPC→青陣地の旗 / 青NPC→赤陣地の旗）
        const fg=pvpBotFlagGoal(bot);
        bot.wp = (fg && Math.random()<DIFF_PARAMS[bot.diff||S.diff].flagRush)
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
    // フラッグ戦: NPCが敵陣の旗に到達したらそのチームの勝利をホストが確定させる
    if (!pvpBotFlagCaptured && pvp.gameType==="flag" && bot.team){
      const fg=pvpBotFlagGoal(bot);
      if (fg && Math.hypot(bot.pos.x-fg.x, bot.pos.z-fg.z)<1.4){
        pvpBotFlagCaptured=true;
        hostHandleBotFlagCapture(bot.team);
      }
    }
  }
}
/* フラッグ戦でこのNPCが狙うべき敵陣の旗（赤チーム→ENEMY_FLAG(青陣地)、青チーム→PLAYER_FLAG(赤陣地)） */
function pvpBotFlagGoal(bot){
  if (pvp.gameType!=="flag" || !bot.team) return null;
  return bot.team==="red" ? ENEMY_FLAG : PLAYER_FLAG;
}
let pvpBotFlagCaptured=false;   // 1試合1回だけ確定させる（試合開始時にリセット）
export function onPvpBotHit(bot, shooterId){
  if (!bot.alive) return;   // 同一フレームの多重ヒットで二重処理しない
  bot.alive=false; bot.fallT=0;
  spawnParticles(bot.grp.position, 0xffffff, 5, 1.4);
  // プレイヤーによる撃破のみキル数加算・報告（NPC同士の撃ち合いはスコア対象外。
  // 倒れた状態はgame:botsの位置ブロードキャストで全員に同期される）
  if (!String(shooterId).startsWith("bot:")){
    const shooter = hostRoom && hostRoom.players.get(shooterId);
    if (shooter){
      shooter.kills++;
      const scores=hostScores();
      const payload={targetId:"bot:"+bot.netId, shooterId, shooterName:shooter.name, targetName:"NPC", scores};
      pvpOnKilled(payload);
      p2pBroadcast("killed", payload);
    }
  }
  hostCheckWin();
}
let pvpBotsLastSend=0;
export function updatePvpBotsNetSend(now){
  if (S.mode!=="pvp" || !pvp.inMatch || !pvp.iAmHost) return;
  if (now-pvpBotsLastSend<0.1) return;   // 約10Hz
  pvpBotsLastSend=now;
  p2pBroadcast("bots", bots.map(b=>({id:"bot:"+b.netId, x:b.pos.x, z:b.pos.z, yaw:b.yaw, alive:b.alive, team:b.team})));
}
export function pvpApplyBotsState(list){
  if (pvp.iAmHost) return;   // 自分がホストなら自前のbots配列が真実のソース
  const seen=new Set();
  for (const d of list){
    seen.add(d.id);
    let rb=pvp.bots.get(d.id);
    if (!rb){
      const pivot=new THREE.Group(); pivot.add(buildBotMesh(d.team||null)); scene.add(pivot);
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

/* ============================================================
   ホスト権威ロジック（旧server.jsの内容をブラウザ内へ移植）
   hostRoomはホストのタブだけが保持する「真実のソース」。
   ゲストはpvp.currentRoom（hostRoomのpublicなスナップショット）だけを見る。
   ============================================================ */
let hostRoom = null;
function clampDiff(v){ return (v==="weak"||v==="strong") ? v : "normal"; }
function hostScores(){
  return [...hostRoom.players.values()].map(p=>({id:p.id, name:p.name, kills:p.kills, deaths:p.deaths}));
}
function hostPublicRoom(){
  return {
    id: hostRoom.id, name: hostRoom.name, state: hostRoom.state, gameType: hostRoom.gameType,
    npcCount: hostRoom.npcCount, npcDiff: hostRoom.npcDiff,
    npcCountRed: hostRoom.npcCountRed, npcDiffRed: hostRoom.npcDiffRed,
    npcCountBlue: hostRoom.npcCountBlue, npcDiffBlue: hostRoom.npcDiffBlue,
    mapMode: hostRoom.mapMode, hostId: hostRoom.hostId,
    players: [...hostRoom.players.values()].map(p=>({
      id:p.id, name:p.name, ready:p.ready, alive:p.alive, kills:p.kills, deaths:p.deaths, team:p.team,
    })),
  };
}
function hostBroadcastRoom(){
  pvp.currentRoom = hostPublicRoom();
  renderPvpRoomView();
  p2pBroadcast("roomUpdate", {room: pvp.currentRoom});
}
function hostAliveHumans(team=null){
  return [...hostRoom.players.values()].filter(p=>p.alive && (!team || p.team===team));
}
/* 生存NPC数は必ず実際のbots配列から数える（別途カウンタを持って減算する方式は
   撃破処理とズレて「最後の敵がまだ立っているのに勝利」になる事故が起きるため） */
function hostAliveBots(team=null){
  return bots.filter(b=>b.alive && (!team || b.team===team)).length;
}
/* 勝利条件判定（人間NPC双方を見る。以前はNPCの生死を一切見ておらず、
   全NPCを倒しても試合が終わらないバグの原因になっていた） */
function hostCheckWin(){
  if (!hostRoom || hostRoom.state!=="playing") return;
  if (hostRoom.gameType==="br"){
    const alive=hostAliveHumans();
    // 生存人間が0人（全滅）、または1人だけになりNPCも全滅していれば試合終了
    if (alive.length===0 || (alive.length===1 && hostAliveBots()===0)){
      const winner=alive[0]||null;
      hostEndMatch({winnerId:winner?winner.id:null, winnerName:winner?winner.name:"-", winnerTeam:null});
    }
  } else if (hostRoom.gameType==="elim"){
    const redTotal = hostAliveHumans("red").length + hostAliveBots("red");
    const blueTotal = hostAliveHumans("blue").length + hostAliveBots("blue");
    if (redTotal<=0 || blueTotal<=0){
      const winnerTeam = redTotal>0 ? "red" : blueTotal>0 ? "blue" : null;
      hostEndMatch({winnerId:null, winnerName:null, winnerTeam});
    }
  }
}
function hostEndMatch({winnerId, winnerName, winnerTeam}){
  hostRoom.state="lobby";
  for (const p of hostRoom.players.values()) p.ready=false;
  const scores=hostScores();
  const payload={winnerId, winnerName, winnerTeam, scores};
  pvpOnGameOver(payload);
  p2pBroadcast("gameOver", payload);
  hostBroadcastRoom();
}
function hostHandleJoin(guestId, name){
  if (!hostRoom || hostRoom.state!=="lobby"){
    p2pSend(p2p.conns.get(guestId), "joinError", {reason: hostRoom? "試合が開始されています":"部屋がありません"});
    return;
  }
  if (hostRoom.players.size>=16){
    p2pSend(p2p.conns.get(guestId), "joinError", {reason:"満員です"});
    return;
  }
  hostRoom.players.set(guestId, {
    id:guestId, name:(typeof name==="string"&&name.trim())?name.trim().slice(0,16):"プレイヤー",
    ready:false, alive:true, kills:0, deaths:0, team:null,
  });
  hostBroadcastRoom();
}
function hostHandleLeave(guestId){
  if (!hostRoom) return;
  const wasAlive = hostRoom.players.get(guestId)?.alive;
  hostRoom.players.delete(guestId);
  p2pBroadcast("playerLeft", {id:guestId});
  if (hostRoom.state==="playing" && wasAlive) hostCheckWin();
  hostBroadcastRoom();
}
function hostHandleReady(guestId, ready){
  if (!hostRoom) return;
  const p=hostRoom.players.get(guestId);
  if (!p) return;
  p.ready=!!ready;
  hostBroadcastRoom();
}
function hostStartMatch(){
  if (!hostRoom || hostRoom.state!=="lobby") return;
  for (const p of hostRoom.players.values()){
    if (!p.ready && p.id!==hostRoom.hostId) return;
  }
  hostRoom.state="playing";
  let mapData = hostRoom.mapMode==="custom" ? (loadCustomMap()||[]) : [];
  if (hostRoom.mapMode==="custom" && !mapData.length) showMsg("カスタムマップ未保存 → ランダム配置",2.2);
  if (!mapData.length) mapData = genRandomVsProps();
  hostRoom.mapData = mapData;
  const teamed = hostRoom.gameType==="elim" || hostRoom.gameType==="flag";
  const spawnCounters={red:0, blue:0, ffa:0};
  let i=0; const players=[];
  for (const p of hostRoom.players.values()){
    p.alive=true; p.kills=0; p.deaths=0;
    p.team = teamed ? (i%2===0?"red":"blue") : null;
    i++;
    const spawnIndex = teamed ? (spawnCounters[p.team]++%8) : (spawnCounters.ffa++%8);
    players.push({id:p.id, name:p.name, team:p.team, spawnIndex});
  }
  const payload={
    players, gameType:hostRoom.gameType, hostId:hostRoom.hostId, mapData,
    npcCount:hostRoom.npcCount, npcDiff:hostRoom.npcDiff,
    npcCountRed:hostRoom.npcCountRed, npcDiffRed:hostRoom.npcDiffRed,
    npcCountBlue:hostRoom.npcCountBlue, npcDiffBlue:hostRoom.npcDiffBlue,
  };
  pvpStartMatch(payload);
  p2pBroadcast("start", payload);
}
function hostHandleHit(targetId, shooterId){
  if (!hostRoom || hostRoom.state!=="playing") return;
  const target = hostRoom.players.get(targetId);
  const isBotShooter = typeof shooterId==="string" && shooterId.startsWith("bot:");
  const shooter = isBotShooter ? null : hostRoom.players.get(shooterId);
  if (!target || !target.alive || shooterId===targetId) return;
  if (!isBotShooter && !shooter) return;
  if (shooter && hostRoom.gameType!=="br" && shooter.team===target.team) return;   // 味方撃ちは無効
  target.alive=false; target.deaths++;
  if (shooter) shooter.kills++;
  const scores=hostScores();
  const payload={targetId, shooterId, shooterName: shooter?shooter.name:"NPC", targetName:target.name, scores};
  pvpOnKilled(payload);
  p2pBroadcast("killed", payload);
  if (hostRoom.gameType==="br" || hostRoom.gameType==="elim"){ hostCheckWin(); return; }
  // フラッグ戦: 旗を奪われるまで戦闘継続のためリスポーンする
  setTimeout(()=>{
    if (!hostRoom || hostRoom.state!=="playing") return;
    const t=hostRoom.players.get(targetId);
    if (!t) return;
    t.alive=true;
    const spawnIndex=Math.floor(Math.random()*8);
    const rpayload={id:targetId, spawnIndex};
    pvpOnRespawn(rpayload);
    p2pBroadcast("respawn", rpayload);
  }, RESPAWN_DELAY_MS);
}
function hostHandleFlagCapture(playerId){
  if (!hostRoom || hostRoom.state!=="playing" || hostRoom.gameType!=="flag") return;
  const p=hostRoom.players.get(playerId);
  if (!p || !p.alive || !p.team) return;
  hostEndMatch({winnerId:p.id, winnerName:p.name, winnerTeam:p.team});
}
function hostHandleBotFlagCapture(team){
  if (!hostRoom || hostRoom.state!=="playing" || hostRoom.gameType!=="flag") return;
  if (team!=="red" && team!=="blue") return;
  hostEndMatch({winnerId:null, winnerName:"NPC", winnerTeam:team});
}

/* ============================================================
   メッセージ配線（ホスト/ゲストで受信処理を振り分ける）
   ============================================================ */
function hostOnMessage(fromId, type, payload){
  switch(type){
    case "join": hostHandleJoin(fromId, payload && payload.name); break;
    case "ready": hostHandleReady(fromId, payload && payload.ready); break;
    case "state": {
      const d={id:fromId, ...payload};
      pvpApplyRemoteState(d);
      p2pBroadcast("state", d, fromId);
      break;
    }
    case "shot": {
      const d={id:fromId, ...payload};
      pvpSpawnRemoteShot(d);
      p2pBroadcast("shot", d, fromId);
      break;
    }
    case "hit": hostHandleHit(fromId, payload && payload.shooterId); break;
    case "flagCapture": hostHandleFlagCapture(fromId); break;
  }
}
function guestOnMessage(fromId, type, payload){
  switch(type){
    case "roomUpdate": pvp.currentRoom=payload.room; renderPvpRoomView(); break;
    case "joinError":
      alert((payload&&payload.reason)||"参加に失敗しました");
      pvpLeaveRoom();
      break;
    case "start": pvpStartMatch(payload); break;
    case "state": pvpApplyRemoteState(payload); break;
    case "shot": pvpSpawnRemoteShot(payload); break;
    case "bots": pvpApplyBotsState(payload); break;
    case "botShot": pvpSpawnBotShot(payload); break;
    case "killed": pvpOnKilled(payload); break;
    case "respawn": pvpOnRespawn(payload); break;
    case "gameOver": pvpOnGameOver(payload); break;
    case "playerLeft": {
      const rp=pvp.players.get(payload.id);
      if (rp){ scene.remove(rp.pivot); pvp.players.delete(payload.id); }
      break;
    }
  }
}
p2pSetHandlers({
  onMessage:(fromId,type,payload)=>{ (pvp.iAmHost? hostOnMessage : guestOnMessage)(fromId,type,payload); },
  onGuestOpen:(conn)=>{ /* 接続確立: 参加確定はゲストからの"join"メッセージを待つ */ },
  onGuestClose:(guestId)=>{ if (pvp.iAmHost) hostHandleLeave(guestId); },
  onHostClose:()=>{
    if (!pvp.iAmHost){
      showMsg("ホストとの接続が切れました",3);
      pvp.inMatch=false;
      pvpLeaveRoom();
    }
  },
});

/* ============================================================
   ロビーUI・接続フロー
   ============================================================ */
function shareUrl(roomId){
  return location.origin+location.pathname+"?room="+encodeURIComponent(roomId);
}
function showShareUrlIfHost(){
  const isHost = pvp.currentRoom && pvp.currentRoom.hostId===pvp.myId;
  const show = isHost && !pvp.inMatch;
  $("pvpShareUrlRow").style.display = show ? "flex" : "none";
  if (show) $("pvpShareUrlInput").value = shareUrl(pvp.currentRoom.id);
}
let autoJoinTried=false;
/* ページ読み込み直後にURLの?roomパラメータを読み取り、あれば自動でホストへ接続する */
export function pvpAutoJoinFromUrl(){
  const params=new URLSearchParams(location.search);
  const roomId=params.get("room");
  if (!roomId) return;
  autoJoinTried=true;
  S.mode="pvp";
  $("menu").style.display="none";
  $("pvpLobby").classList.add("show");
  pvp.name = ($("pvpNameInput").value||"プレイヤー").trim().slice(0,16) || "プレイヤー";
  pvpJoinRoom(roomId);
}
export function pvpConnect(){
  if (!pvp.connected && !autoJoinTried) renderPvpRoomView();
}
function pvpSelDiff(id){
  const sel=$(id).querySelector(".chip.sel");
  return sel ? sel.dataset.d : "normal";
}
export async function pvpCreateRoom(){
  const btns={br:$("pvpGameTypeBr"), elim:$("pvpGameTypeElim"), flag:$("pvpGameTypeFlag")};
  const gameType=Object.keys(btns).find(k=>btns[k].classList.contains("sel"))||"br";
  const npcCount=+$("pvpNpcCountSlider").value||0;
  const npcDiff=pvpSelDiff("pvpNpcDiffChips");
  const npcCountRed=+$("pvpNpcCountRedSlider").value||0;
  const npcDiffRed=pvpSelDiff("pvpNpcDiffRedChips");
  const npcCountBlue=+$("pvpNpcCountBlueSlider").value||0;
  const npcDiffBlue=pvpSelDiff("pvpNpcDiffBlueChips");
  const mapMode=$("pvpMapCustom").classList.contains("sel")?"custom":"random";
  $("pvpConnStatus").textContent="部屋を作成中…";
  $("pvpConnStatus").className="";
  try {
    const id = await p2pHostRoom();
    pvp.iAmHost=true; pvp.myId=id; pvp.connected=true;
    hostRoom = {
      id, name: pvp.name+"の部屋", state:"lobby", gameType,
      npcCount:Math.min(8,Math.max(0,npcCount)), npcDiff:clampDiff(npcDiff),
      npcCountRed:Math.min(8,Math.max(0,npcCountRed)), npcDiffRed:clampDiff(npcDiffRed),
      npcCountBlue:Math.min(8,Math.max(0,npcCountBlue)), npcDiffBlue:clampDiff(npcDiffBlue),
      mapMode, hostId:id, players:new Map(), mapData:[],
    };
    hostRoom.players.set(id, {id, name:pvp.name, ready:false, alive:true, kills:0, deaths:0, team:null});
    $("pvpConnStatus").textContent="接続済み（自分: "+id+"）";
    $("pvpConnStatus").className="connected";
    hostBroadcastRoom();
  } catch (err){
    $("pvpConnStatus").textContent="部屋の作成に失敗しました: "+((err&&err.message)||err);
    $("pvpConnStatus").className="error";
  }
}
export async function pvpJoinRoomFromInput(){
  const raw=($("pvpJoinCodeInput").value||"").trim();
  if (!raw) return;
  let roomId=raw;
  try {
    if (raw.includes("room=")) roomId = new URL(raw, location.href).searchParams.get("room") || raw;
  } catch(e){}
  pvpJoinRoom(roomId);
}
export async function pvpJoinRoom(roomId){
  if (!roomId) return;
  $("pvpConnStatus").textContent="ホストに接続中…";
  $("pvpConnStatus").className="";
  try {
    await p2pJoinRoom(roomId);
    pvp.iAmHost=false; pvp.myId=p2p.myId; pvp.connected=true;
    $("pvpConnStatus").textContent="接続済み（自分: "+pvp.myId+"）";
    $("pvpConnStatus").className="connected";
    p2pSendToHost("join", {name:pvp.name});
  } catch (err){
    $("pvpConnStatus").textContent="接続に失敗しました: "+((err&&err.message)||err);
    $("pvpConnStatus").className="error";
  }
}
export function pvpLeaveRoom(){
  p2pDisconnect();
  pvp.connected=false; pvp.currentRoom=null; pvp.iAmHost=false; pvp.myId=null;
  hostRoom=null;
  $("pvpConnStatus").textContent="未接続";
  $("pvpConnStatus").className="";
  renderPvpRoomView();
}
export function renderPvpRoomView(){
  const inRoom=!!pvp.currentRoom;
  $("pvpSetupView").style.display = inRoom? "none":"block";
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
  showShareUrlIfHost();
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
  // 試合中にM等でポインタロックを解除した場合はロビーへ戻るが、試合自体は継続しているので
  // 「試合に戻る」を出し、準備完了/試合開始/退出は隠す（試合中に押す意味が無い操作のため）
  $("pvpResumeRow").style.display = pvp.inMatch ? "flex" : "none";
  $("pvpReadyBtn").style.display = (!pvp.inMatch && !isHost) ? "block" : "none";
  $("pvpReadyBtn").classList.toggle("active", !!(me&&me.ready));
  $("pvpReadyBtn").textContent = (me&&me.ready)? "準備OK（解除）":"準備完了";
  $("pvpStartBtn").style.display = (!pvp.inMatch && isHost) ? "block" : "none";
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
  pivot.add(buildBotMesh(p.team||null));   // チーム戦なら他プレイヤーもチームカラーで表示
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
  if (pvp.iAmHost) hostHandleHit(pvp.myId, shooterId);
  else p2pSendToHost("hit", {shooterId});
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
  if (S.mode!=="pvp" || !pvp.inMatch) return;
  if (now-pvpLastSend<0.06) return;   // 約16Hz
  pvpLastSend=now;
  const state={pos:{x:player.pos.x,y:player.pos.y,z:player.pos.z}, yaw:player.yaw, pitch:player.pitch};
  if (pvp.iAmHost) p2pBroadcast("state", {id:pvp.myId, ...state});
  else p2pSendToHost("state", state);
}
/* フラッグ戦: 敵陣の旗に到達したら自己申告してチーム勝利を確定させる */
export function updatePvpFlagCapture(dt){
  if (S.mode!=="pvp" || !pvp.inMatch || pvp.gameType!=="flag" || RT.dying || !pvp.myTeam) return;
  const enemyFlag = pvp.myTeam==="red" ? ENEMY_FLAG : PLAYER_FLAG;
  if (Math.hypot(player.pos.x-enemyFlag.x, player.pos.z-enemyFlag.z) < 1.4){
    if (pvp.iAmHost) hostHandleFlagCapture(pvp.myId);
    else p2pSendToHost("flagCapture", {});
  }
}

export function wirePvpLobbyUI(){
  $("pvpCreateBtn").addEventListener("click", pvpCreateRoom);
  $("pvpJoinBtn").addEventListener("click", pvpJoinRoomFromInput);
  $("pvpCopyUrlBtn").addEventListener("click", async ()=>{
    const url=$("pvpShareUrlInput").value;
    try {
      await navigator.clipboard.writeText(url);
      const b=$("pvpCopyUrlBtn"); const orig=b.textContent;
      b.textContent="コピーしました"; setTimeout(()=>{ b.textContent=orig; },1500);
    } catch(e){ $("pvpShareUrlInput").select(); }
  });
  $("pvpLeaveBtn").addEventListener("click", pvpLeaveRoom);
  // 試合中にMキー等でロックを解除してロビーが出た場合、試合自体は継続しているので
  // 離脱せずポインタロックを取り直すだけで元の試合に戻れる
  $("pvpResumeBtn").addEventListener("click",()=>{
    $("pvpLobby").classList.remove("show");
    renderer.domElement.requestPointerLock();
  });
  $("pvpReadyBtn").addEventListener("click",()=>{
    if (!pvp.currentRoom) return;
    const me=pvp.currentRoom.players.find(p=>p.id===pvp.myId);
    const newReady=!(me&&me.ready);
    if (pvp.iAmHost) hostHandleReady(pvp.myId, newReady);
    else p2pSendToHost("ready", {ready:newReady});
  });
  $("pvpStartBtn").addEventListener("click",()=>{
    if (!pvp.iAmHost || !pvp.currentRoom) return;
    hostStartMatch();
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
