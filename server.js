/* ============================================================
   AIRSOFT FPS - リアルタイムPVP用サーバー
   Express（静的ファイル配信）+ Socket.io（ロビー・対戦の状態中継）
   物理演算・弾道シミュレーションはクライアント側のみで行い、
   サーバーは「誰がどの部屋にいるか」「誰が誰を撃破したか」を中継・集計するだけ。
   ============================================================ */
const path = require("path");
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 8377;
const RESPAWN_DELAY_MS = 3000;
const ROOM_IDLE_LIMIT_MS = 1000 * 60 * 30;   // 30分放置した空き部屋は掃除

const app = express();
app.use(express.static(__dirname));
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

/** @type {Map<string, Room>} */
const rooms = new Map();
let roomSeq = 1;

function makeRoomId() {
  return "room" + (roomSeq++);
}
function clampDiff(v) {
  return (v === "weak" || v === "strong") ? v : "normal";
}
function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    state: room.state,
    gameType: room.gameType,
    npcCount: room.npcCount, npcDiff: room.npcDiff,
    npcCountRed: room.npcCountRed, npcDiffRed: room.npcDiffRed,
    npcCountBlue: room.npcCountBlue, npcDiffBlue: room.npcDiffBlue,
    mapMode: room.mapMode,
    hostId: room.hostId,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, ready: p.ready, alive: p.alive,
      kills: p.kills, deaths: p.deaths, team: p.team,
    })),
  };
}
function roomList() {
  return [...rooms.values()]
    .filter(r => r.state === "lobby")
    .map(r => ({
      id: r.id, name: r.name, count: r.players.size,
      gameType: r.gameType, mapMode: r.mapMode,
      npcCount: r.npcCount, npcCountRed: r.npcCountRed, npcCountBlue: r.npcCountBlue,
    }));
}
function broadcastRoom(room) {
  io.to(room.id).emit("lobby:update", publicRoom(room));
}
function leaveCurrentRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  socket.leave(roomId);
  socket.data.roomId = null;
  if (!room) return;
  room.players.delete(socket.id);
  if (room.players.size === 0) {
    rooms.delete(roomId);
    return;
  }
  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
  }
  io.to(roomId).emit("player:left", { id: socket.id });
  broadcastRoom(room);
}
function pickSpawnIndex() {
  return Math.floor(Math.random() * 8);
}
// バトルロワイアル: 生存者が1人以下になったら試合終了（リスポーンなし・個人勝利）
function finishIfLastAlive(room, scores) {
  const alive = [...room.players.values()].filter(p => p.alive);
  if (alive.length > 1) return;
  const winner = alive[0] || null;
  room.state = "lobby";
  for (const p of room.players.values()) p.ready = false;
  io.to(room.id).emit("game:over", {
    winnerId: winner ? winner.id : null, winnerName: winner ? winner.name : "-",
    winnerTeam: null, scores,
  });
  broadcastRoom(room);
}
// 殲滅戦: 片方のチームの生存者(人間プレイヤー)が0人になったら試合終了（リスポーンなし・チーム勝利）
function finishIfTeamEliminated(room, scores) {
  const redAlive = [...room.players.values()].filter(p => p.team === "red" && p.alive).length;
  const blueAlive = [...room.players.values()].filter(p => p.team === "blue" && p.alive).length;
  if (redAlive > 0 && blueAlive > 0) return;
  const winnerTeam = redAlive > 0 ? "red" : blueAlive > 0 ? "blue" : null;
  room.state = "lobby";
  for (const p of room.players.values()) p.ready = false;
  io.to(room.id).emit("game:over", { winnerId: null, winnerName: null, winnerTeam, scores });
  broadcastRoom(room);
}

io.on("connection", (socket) => {
  socket.data.name = "プレイヤー";

  socket.on("lobby:setName", (name) => {
    if (typeof name === "string" && name.trim()) {
      socket.data.name = name.trim().slice(0, 16);
    }
  });

  socket.on("lobby:list", (ack) => {
    if (typeof ack === "function") ack(roomList());
  });

  socket.on("lobby:create", (opts = {}, ack) => {
    const { name, gameType, npcCount, npcDiff, npcCountRed, npcDiffRed,
            npcCountBlue, npcDiffBlue, mapMode } = opts || {};
    leaveCurrentRoom(socket);
    const room = {
      id: makeRoomId(),
      name: (typeof name === "string" && name.trim()) ? name.trim().slice(0, 24) : "ルーム",
      hostId: socket.id,
      state: "lobby",
      gameType: (gameType === "elim" || gameType === "flag") ? gameType : "br",
      npcCount: Math.min(8, Math.max(0, parseInt(npcCount, 10) || 0)),
      npcDiff: clampDiff(npcDiff),
      npcCountRed: Math.min(8, Math.max(0, parseInt(npcCountRed, 10) || 0)),
      npcDiffRed: clampDiff(npcDiffRed),
      npcCountBlue: Math.min(8, Math.max(0, parseInt(npcCountBlue, 10) || 0)),
      npcDiffBlue: clampDiff(npcDiffBlue),
      mapMode: mapMode === "custom" ? "custom" : "random",
      players: new Map(),
      lastActivity: Date.now(),
    };
    room.players.set(socket.id, {
      id: socket.id, name: socket.data.name, ready: false, alive: true, kills: 0, deaths: 0, team: null,
    });
    rooms.set(room.id, room);
    socket.join(room.id);
    socket.data.roomId = room.id;
    if (typeof ack === "function") ack({ ok: true, room: publicRoom(room) });
  });

  socket.on("lobby:join", ({ roomId } = {}, ack) => {
    const room = rooms.get(roomId);
    if (!room || room.state !== "lobby") {
      if (typeof ack === "function") ack({ ok: false, error: "部屋が見つかりません" });
      return;
    }
    if (room.players.size >= 16) {
      if (typeof ack === "function") ack({ ok: false, error: "満員です" });
      return;
    }
    leaveCurrentRoom(socket);
    room.players.set(socket.id, {
      id: socket.id, name: socket.data.name, ready: false, alive: true, kills: 0, deaths: 0, team: null,
    });
    socket.join(room.id);
    socket.data.roomId = room.id;
    room.lastActivity = Date.now();
    if (typeof ack === "function") ack({ ok: true, room: publicRoom(room) });
    broadcastRoom(room);
  });

  socket.on("lobby:leave", () => leaveCurrentRoom(socket));

  socket.on("lobby:ready", (ready) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.ready = !!ready;
    broadcastRoom(room);
  });

  socket.on("lobby:start", ({ mapData } = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostId !== socket.id || room.state !== "lobby") return;
    // 1人からでも開始可能（NPC相手の練習用途など）。全員準備完了のみ必須（ホスト自身は除く）
    for (const p of room.players.values()) {
      if (!p.ready && p.id !== room.hostId) return;
    }
    room.state = "playing";
    room.mapData = Array.isArray(mapData) ? mapData : [];
    const teamed = room.gameType === "elim" || room.gameType === "flag";
    const spawnCounters = { red: 0, blue: 0, ffa: 0 };
    let i = 0;
    const players = [];
    for (const p of room.players.values()) {
      p.alive = true; p.kills = 0; p.deaths = 0;
      p.team = teamed ? (i % 2 === 0 ? "red" : "blue") : null;
      i++;
      const spawnIndex = teamed ? (spawnCounters[p.team]++ % 8) : (spawnCounters.ffa++ % 8);
      players.push({ id: p.id, name: p.name, team: p.team, spawnIndex });
    }
    io.to(room.id).emit("game:start", {
      players, gameType: room.gameType, hostId: room.hostId, mapData: room.mapData,
      npcCount: room.npcCount, npcDiff: room.npcDiff,
      npcCountRed: room.npcCountRed, npcDiffRed: room.npcDiffRed,
      npcCountBlue: room.npcCountBlue, npcDiffBlue: room.npcDiffBlue,
    });
  });

  socket.on("game:state", (state) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== "playing") return;
    socket.to(room.id).volatile.emit("game:state", { id: socket.id, ...state });
  });

  socket.on("game:shot", (shot) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== "playing") return;
    socket.to(room.id).emit("game:shot", { id: socket.id, ...shot });
  });

  // ホスト権威のNPC(BOT)の位置・射撃をルーム内へ中継（ホストのみ送信可）
  socket.on("game:bots", (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== "playing" || room.hostId !== socket.id) return;
    socket.to(room.id).volatile.emit("game:bots", data);
  });
  socket.on("game:botShot", (shot) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== "playing" || room.hostId !== socket.id) return;
    socket.to(room.id).emit("game:botShot", shot);
  });

  // クライアントは「自分が撃たれた」ことを自己申告する（被害者側で命中判定するため）
  socket.on("game:hit", ({ shooterId } = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== "playing") return;
    const target = room.players.get(socket.id);
    const isBotShooter = typeof shooterId === "string" && shooterId.startsWith("bot:");
    const shooter = isBotShooter ? null : room.players.get(shooterId);
    if (!target || !target.alive || shooterId === socket.id) return;
    if (!isBotShooter && !shooter) return;
    if (shooter && room.gameType !== "br" && shooter.team === target.team) return;   // 味方撃ちは無効
    target.alive = false;
    target.deaths++;
    if (shooter) shooter.kills++;
    const scores = [...room.players.values()].map(p => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths }));
    io.to(room.id).emit("game:killed", {
      targetId: socket.id, shooterId, shooterName: shooter ? shooter.name : "NPC", targetName: target.name, scores,
    });
    if (room.gameType === "br") { finishIfLastAlive(room, scores); return; }
    if (room.gameType === "elim") { finishIfTeamEliminated(room, scores); return; }
    // フラッグ戦: 旗を奪われるまで戦闘継続のためリスポーンする
    const targetId = socket.id;
    setTimeout(() => {
      if (!rooms.has(room.id) || room.state !== "playing") return;
      const t = room.players.get(targetId);
      if (!t) return;
      t.alive = true;
      io.to(room.id).emit("game:respawn", { id: targetId, spawnIndex: pickSpawnIndex() });
    }, RESPAWN_DELAY_MS);
  });

  // ホストがNPCの撃破を報告（NPC自身はroom.playersに存在しないクライアントを持たないため、
  // 唯一の権威であるホストが第三者として報告する）。勝敗には影響せずキル数の記録のみ行う
  socket.on("game:botHit", ({ botId, shooterId } = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== "playing" || room.hostId !== socket.id) return;
    const shooter = room.players.get(shooterId);
    if (!shooter) return;
    shooter.kills++;
    const scores = [...room.players.values()].map(p => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths }));
    io.to(room.id).emit("game:killed", {
      targetId: botId, shooterId, shooterName: shooter.name, targetName: "NPC", scores,
    });
  });

  // フラッグ戦: 敵陣の旗に到達したことをクライアントが自己申告し、そのチームの勝利で試合終了
  socket.on("game:flagCapture", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== "playing" || room.gameType !== "flag") return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive || !p.team) return;
    const scores = [...room.players.values()].map(x => ({ id: x.id, name: x.name, kills: x.kills, deaths: x.deaths }));
    room.state = "lobby";
    for (const x of room.players.values()) x.ready = false;
    io.to(room.id).emit("game:over", { winnerId: p.id, winnerName: p.name, winnerTeam: p.team, scores });
    broadcastRoom(room);
  });

  // フラッグ戦: NPC(ホスト権威)が敵陣の旗に到達した場合はホストが代理報告し、そのチームの勝利で試合終了
  socket.on("game:botFlagCapture", ({ team } = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== "playing" || room.hostId !== socket.id || room.gameType !== "flag") return;
    if (team !== "red" && team !== "blue") return;
    const scores = [...room.players.values()].map(x => ({ id: x.id, name: x.name, kills: x.kills, deaths: x.deaths }));
    room.state = "lobby";
    for (const x of room.players.values()) x.ready = false;
    io.to(room.id).emit("game:over", { winnerId: null, winnerName: "NPC", winnerTeam: team, scores });
    broadcastRoom(room);
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
  });
});

// 放置部屋の定期掃除
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.players.size === 0 || now - (room.lastActivity || 0) > ROOM_IDLE_LIMIT_MS) {
      rooms.delete(id);
    }
  }
}, 60000);

httpServer.listen(PORT, () => {
  console.log(`AIRSOFT FPS server listening on http://localhost:${PORT}`);
});
