/* ============================================================
   P2P通信層（PeerJS / WebRTC）
   シグナリングはPeerJSの無料クラウドサーバーのみを使用し、部屋作成後は
   ホスト⇔ゲスト間でブラウザ同士が直接WebRTCで接続する（スター型:
   ゲストはホストとのみ接続し、ゲスト間の中継はホストが行う）。
   このモジュールは接続の確立・維持・メッセージ送受信のみを担当し、
   ロビー/対戦のロジックは持たない（pvp.js側でonMessageハンドラとして実装）。
   ============================================================ */
export const p2p = {
  peer:null, myId:null, isHost:false, conns:new Map(), hostConn:null,
};

let onMessageCb=()=>{}, onGuestOpenCb=()=>{}, onGuestCloseCb=()=>{}, onHostCloseCb=()=>{};
export function p2pSetHandlers(h){
  if (h.onMessage) onMessageCb=h.onMessage;
  if (h.onGuestOpen) onGuestOpenCb=h.onGuestOpen;
  if (h.onGuestClose) onGuestCloseCb=h.onGuestClose;
  if (h.onHostClose) onHostCloseCb=h.onHostClose;
}

function randId(n){
  const cs="abcdefghijklmnopqrstuvwxyz0123456789";
  let s=""; for(let i=0;i<n;i++) s+=cs[Math.floor(Math.random()*cs.length)];
  return s;
}

function wireGuestConn(conn){
  conn.on("data", data=>{
    if (!data || typeof data!=="object") return;
    onMessageCb(conn.peer, data.type, data.payload);
  });
  const onGone=()=>{
    if (p2p.conns.has(conn.peer)){ p2p.conns.delete(conn.peer); onGuestCloseCb(conn.peer); }
  };
  conn.on("close", onGone);
  conn.on("error", onGone);
}
function wireHostConn(conn){
  conn.on("data", data=>{
    if (!data || typeof data!=="object") return;
    onMessageCb(conn.peer, data.type, data.payload);
  });
  conn.on("close", ()=> onHostCloseCb());
  conn.on("error", ()=> onHostCloseCb());
}

function createPeer(customId){
  return new Promise((resolve,reject)=>{
    if (typeof window.Peer==="undefined"){
      reject(new Error("PeerJSライブラリが読み込まれていません")); return;
    }
    const peer = new window.Peer(customId, {debug:0});
    let settled=false;
    peer.on("open", id=>{
      if (settled) return; settled=true;
      resolve(peer);
    });
    peer.on("error", err=>{
      if (settled) return; settled=true;
      try{ peer.destroy(); }catch(e){}
      reject(err);
    });
  });
}

/* ホストとして部屋を作成し、短い共有可能なIDを取得する（IDが衝突した場合はリトライ） */
export async function p2pHostRoom(){
  let lastErr=null;
  for (let i=0;i<6;i++){
    const id = "room-"+randId(i===0?7:9);
    try {
      const peer = await createPeer(id);
      p2p.peer=peer; p2p.myId=id; p2p.isHost=true;
      peer.on("connection", conn=>{
        conn.on("open", ()=>{ p2p.conns.set(conn.peer, conn); wireGuestConn(conn); onGuestOpenCb(conn); });
      });
      peer.on("disconnected", ()=>{ try{ peer.reconnect(); }catch(e){} });
      return id;
    } catch (err){
      lastErr=err;
      if (!err || err.type!=="unavailable-id") throw err;
    }
  }
  throw lastErr || new Error("ルーム作成に失敗しました");
}

/* ゲストとしてホストのIDへ直接接続する */
export function p2pJoinRoom(hostId){
  return new Promise((resolve,reject)=>{
    createPeer(undefined).then(peer=>{
      p2p.peer=peer; p2p.isHost=false;
      peer.on("disconnected", ()=>{ try{ peer.reconnect(); }catch(e){} });
      const conn = peer.connect(hostId, {reliable:true});
      let settled=false;
      const timer=setTimeout(()=>{
        if (!settled){ settled=true; reject(new Error("接続がタイムアウトしました")); }
      }, 15000);
      conn.on("open", ()=>{
        if (settled) return; settled=true; clearTimeout(timer);
        p2p.myId=peer.id; p2p.hostConn=conn; wireHostConn(conn);
        resolve(conn);
      });
      conn.on("error", err=>{
        if (settled) return; settled=true; clearTimeout(timer);
        reject(err);
      });
    }).catch(reject);
  });
}

export function p2pSend(conn, type, payload){
  if (!conn || conn.open===false) return;
  try { conn.send({type, payload}); } catch(e){}
}
export function p2pSendToHost(type, payload){
  if (p2p.hostConn) p2pSend(p2p.hostConn, type, payload);
}
export function p2pBroadcast(type, payload, exceptId=null){
  for (const [id,conn] of p2p.conns){
    if (id===exceptId) continue;
    p2pSend(conn, type, payload);
  }
}
export function p2pDisconnect(){
  for (const conn of p2p.conns.values()){ try{ conn.close(); }catch(e){} }
  p2p.conns.clear();
  if (p2p.hostConn){ try{ p2p.hostConn.close(); }catch(e){} p2p.hostConn=null; }
  if (p2p.peer){ try{ p2p.peer.destroy(); }catch(e){} p2p.peer=null; }
  p2p.myId=null; p2p.isHost=false;
}
