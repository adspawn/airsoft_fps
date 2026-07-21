/* ============================================================
   共有状態（ゲーム全体で参照される可変データ・three.jsシーン基盤）
   他のモジュールはここから必要なオブジェクト/配列をimportして「中身を書き換える」形で
   状態を共有する（オブジェクトのプロパティ変更はESモジュールのライブバインディングにより
   全モジュールへ自動反映されるため、値渡しの再代入さえ避ければ安全）。
   跨モジュールで再代入されるプリミティブ値は RT（ランタイム状態）オブジェクトにまとめてある。
   ============================================================ */
import * as THREE from "three";

export { THREE };
export const $ = id=>document.getElementById(id);

/* ============================================================
   ゲーム状態・設定
   ============================================================ */
export const S = {
  massG:0.20, v0:92, drag:"loth", tracer:true, sens:1.0, cycle:13,   // 抗力: Loth(Cd≈0.45)固定
  mode:"range", diff:"normal", vsMap:"random", vsRuleset:"flag", vsNpcCount:3,
  ricochetHit:true,   // 跳弾(壁で反射)は常に発生。これは「跳ねた後のBBがヒット判定を持つか」の設定
  spinRps:170, optimalSpin:null, zeroIn:null, maxRange:null,
  score:0, shots:0, hits:0,
  challenge:{active:false, tLeft:0},
  vs:{you:0, active:false},
};
export const MAG_SIZE = 60;
export const EYE_H = 1.6, CROUCH_H = 1.05;
export const UP = new THREE.Vector3(0,1,0);

/* 跨モジュールで再代入される実行時状態を一箇所に集約
   （ESモジュールはimportした束縛への再代入を許さないため、値そのものではなく
   このオブジェクトのプロパティを書き換える形で全モジュール間の可変プリミティブを共有する） */
export const RT = {
  gNow:0, physAcc:0, invulnUntil:0,
  locked:false, ads:false, firing:false, dying:false,
  appliedMode:null,
};

/* ============================================================
   Three.js セットアップ
   ============================================================ */
export const renderer = new THREE.WebGLRenderer({antialias:true});
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc9e8);
scene.fog = new THREE.Fog(0xa8cbe4, 70, 260);

export const camera = new THREE.PerspectiveCamera(75, innerWidth/innerHeight, 0.03, 500);
camera.rotation.order = "YXZ";
scene.add(camera);

const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x8a7a58, 0.95);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1d6, 1.7);
sun.position.set(35, 60, -15);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left=-30; sun.shadow.camera.right=30;
sun.shadow.camera.top=15; sun.shadow.camera.bottom=-75;
sun.shadow.camera.near=10; sun.shadow.camera.far=140;
sun.shadow.bias = -3e-4;
scene.add(sun);
sun.target.position.set(0,0,-35); scene.add(sun.target);

/* ---- 地面 ---- */
function groundTexture(){
  const c=document.createElement("canvas"); c.width=c.height=256;
  const g=c.getContext("2d");
  g.fillStyle="#7d8b5a"; g.fillRect(0,0,256,256);
  for(let i=0;i<2600;i++){
    const s=Math.random();
    g.fillStyle = s<0.5?"rgba(96,110,66,.5)": s<0.8?"rgba(140,150,100,.45)":"rgba(120,104,70,.4)";
    g.fillRect(Math.random()*256, Math.random()*256, 2, 2);
  }
  const t=new THREE.CanvasTexture(c);
  t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(40,40);
  t.colorSpace=THREE.SRGBColorSpace;
  return t;
}
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400,400),
  new THREE.MeshLambertMaterial({map:groundTexture()})
);
ground.rotation.x=-Math.PI/2; ground.receiveShadow=true;
scene.add(ground);

/* ---- フィールド: 90m×44m、壁と障害物 ---- */
export const FIELD = { xMin:-22, xMax:22, zMin:-85, zMax:5 };
/* 対戦/マップ作成モードは50m×50mのEDIT_AREAに、それ以外は従来のFIELDに移動範囲を制限する */
export function currentBounds(){ return (S.mode==="vs"||S.mode==="edit"||S.mode==="pvp")? EDIT_AREA : FIELD; }
export const obstacles = [];   // {min,max} AABB — プレイヤー&BB衝突用

const wallMat = new THREE.MeshLambertMaterial({color:0x6d7566});
export function addWall(x,z,w,d,h=3){
  const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d), wallMat);
  m.position.set(x,h/2,z); m.castShadow=true; m.receiveShadow=true;
  scene.add(m);
  obstacles.push({min:new THREE.Vector3(x-w/2,0,z-d/2), max:new THREE.Vector3(x+w/2,h,z+d/2)});
}
addWall(0, FIELD.zMin, 46, 1);           // 奥
addWall(0, FIELD.zMax, 46, 1);           // 手前
addWall(FIELD.xMin, -40, 1, 91);         // 左
addWall(FIELD.xMax, -40, 1, 91);         // 右

/* ---- 対戦・マップ作成専用フィールド（射撃練習場とは別の場所に50m×50m四方） ---- */
export const VS_ARENA = {cx:120, cz:0, half:25};   // 中心座標とフィールドの半幅（射撃練習場から73m離す）
addWall(VS_ARENA.cx, VS_ARENA.cz-VS_ARENA.half, VS_ARENA.half*2+2, 1);   // 奥
addWall(VS_ARENA.cx, VS_ARENA.cz+VS_ARENA.half, VS_ARENA.half*2+2, 1);   // 手前
addWall(VS_ARENA.cx-VS_ARENA.half, VS_ARENA.cz, 1, VS_ARENA.half*2+2);   // 左
addWall(VS_ARENA.cx+VS_ARENA.half, VS_ARENA.cz, 1, VS_ARENA.half*2+2);   // 右
/* 対戦・マップ作成共通のフィールド範囲（50m×50m） */
export const EDIT_AREA={xMin:VS_ARENA.cx-VS_ARENA.half, xMax:VS_ARENA.cx+VS_ARENA.half,
  zMin:VS_ARENA.cz-VS_ARENA.half, zMax:VS_ARENA.cz+VS_ARENA.half};

export const crateTex = (()=> {
  const c=document.createElement("canvas"); c.width=c.height=128;
  const g=c.getContext("2d");
  g.fillStyle="#8a6b42"; g.fillRect(0,0,128,128);
  g.strokeStyle="#6e5230"; g.lineWidth=5; g.strokeRect(4,4,120,120);
  g.beginPath(); g.moveTo(4,4); g.lineTo(124,124); g.moveTo(124,4); g.lineTo(4,124); g.stroke();
  const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; return t;
})();
export const crateMat = new THREE.MeshLambertMaterial({map:crateTex});
export function addCrate(x,z,s=1,h=null){
  h=h??s;
  const m=new THREE.Mesh(new THREE.BoxGeometry(s,h,s), crateMat);
  m.position.set(x,h/2,z); m.castShadow=true; m.receiveShadow=true;
  scene.add(m);
  obstacles.push({min:new THREE.Vector3(x-s/2,0,z-s/2), max:new THREE.Vector3(x+s/2,h,z+s/2)});
}
addCrate(-4,-4,1.1); addCrate(-4,-5.2,1.1); addCrate(-4,-4.6,1.1,2.2);
addCrate(5,-5,1.2); addCrate(6.3,-5,1.2); addCrate(5.6,-5,1.2,2.4);
addCrate(0,-7,1);
// 低いバリケード（射撃台）
const barrMat=new THREE.MeshLambertMaterial({color:0x4c5a48});
export function addBarricade(x,z,w=2.4){
  const m=new THREE.Mesh(new THREE.BoxGeometry(w,1.05,0.25), barrMat);
  m.position.set(x,0.525,z); m.castShadow=true; m.receiveShadow=true; scene.add(m);
  obstacles.push({min:new THREE.Vector3(x-w/2,0,z-0.125), max:new THREE.Vector3(x+w/2,1.05,z+0.125)});
}
addBarricade(-8,-9); addBarricade(8,-9); addBarricade(0,-12,3);

/* ---- 距離表示ライン & 看板 ---- */
function signTexture(text){
  const c=document.createElement("canvas"); c.width=256; c.height=128;
  const g=c.getContext("2d");
  g.fillStyle="#2f5d33"; g.fillRect(0,0,256,128);
  g.strokeStyle="#fff"; g.lineWidth=6; g.strokeRect(6,6,244,116);
  g.fillStyle="#fff"; g.font="bold 72px sans-serif";
  g.textAlign="center"; g.textBaseline="middle"; g.fillText(text,128,68);
  const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; return t;
}
const lineMat = new THREE.MeshBasicMaterial({color:0xffffff, transparent:true, opacity:0.35});
for (const d of [10,20,30,40,50,60,70]){
  const line=new THREE.Mesh(new THREE.PlaneGeometry(43,0.1), lineMat);
  line.rotation.x=-Math.PI/2; line.position.set(0,0.01,-d);
  scene.add(line);
  for (const sx of [-20,20]){
    const sign=new THREE.Mesh(
      new THREE.PlaneGeometry(1.6,0.8),
      new THREE.MeshLambertMaterial({map:signTexture(d+"m")}));
    sign.position.set(sx,1.6,-d);
    scene.add(sign);
    const post=new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.04,1.6),
      new THREE.MeshLambertMaterial({color:0x555555}));
    post.position.set(sx,0.8,-d); scene.add(post);
  }
}

/* ---- 対戦(NPC)・マップ作成・PVP共通の配置データ ---- */
export const coverPoints=[[-8,-11],[8,-11],[0,-14],[-14,-20],[14,-20],[-6,-28],[6,-28],
  [-16,-35],[16,-35],[0,-32],[-10,-45],[10,-45],[-4,-55],[4,-55],[0,-65],[-12,-60],[12,-60]];
export const spawnPoints=[[110,-20],[130,-20],[120,-22],[105,-15],[135,-15],[120,-15],[112,-20],[128,-20]];

/* ---- フラッグ戦: 陣地の旗座標 ---- */
export const ENEMY_FLAG={x:VS_ARENA.cx, z:VS_ARENA.cz-20};    // 敵リスポーン地点の旗（奪取で勝利）
export const PLAYER_FLAG={x:VS_ARENA.cx, z:VS_ARENA.cz+20};   // 自陣の旗（NPCに取られたら敗北）

/* ---- PVPチーム戦（殲滅戦・フラッグ戦）用のリスポーン地点 ----
   自陣フラッグを中心に、内側リング=プレイヤー用/外側リング=NPC用で分離配置し、
   プレイヤーとNPCのリスポーンが重ならないようにする。
   赤チーム=PLAYER_FLAG(自陣)、青チーム=ENEMY_FLAG(敵陣)を本拠地とする */
export function ringPoints(center,n,radius){
  const pts=[];
  for (let i=0;i<n;i++){
    const a=(i/n)*Math.PI*2;
    pts.push([center.x+Math.cos(a)*radius, center.z+Math.sin(a)*radius]);
  }
  return pts;
}
export const RED_PLAYER_SPAWNS  = ringPoints(PLAYER_FLAG, 8, 3.2);
export const RED_NPC_SPAWNS     = ringPoints(PLAYER_FLAG, 8, 5.8);
export const BLUE_PLAYER_SPAWNS = ringPoints(ENEMY_FLAG, 8, 3.2);
export const BLUE_NPC_SPAWNS    = ringPoints(ENEMY_FLAG, 8, 5.8);

/* ============================================================
   プレイヤー・武器・入力
   ============================================================ */
export const player={
  pos:new THREE.Vector3(0,0,0), vel:new THREE.Vector3(),
  yaw:0, pitch:0, grounded:true, crouch:false, crouchToggle:false, eyeH:EYE_H,
  lean:0,   // -1(左いっぱい)〜+1(右いっぱい)、平滑補間される現在のリーン量
};
export const LEAN_MAX_ROLL = 12*Math.PI/180;   // 最大ロール角
export const LEAN_MAX_OFFSET = 0.4;            // 最大横オフセット(m)
export const keys={};
export const weapon={
  mag:MAG_SIZE, mode:"SEMI", cooldown:0, reloading:false, reloadT:0,
  recoil:0, kick:0,
};
/* フォーカス喪失（Alt+英字のブラウザショートカット・Alt-Tab・DevTools起動等）で
   keyupが届かず特定キーが「押しっぱなし」のまま固まる事故を防ぐため、
   フォーカスやポインタロックを失ったタイミングで必ず全キー状態をリセットする */
export function clearKeys(){
  for (const k in keys) keys[k]=false;
  RT.firing=false;
}
window.addEventListener("blur", clearKeys);
document.addEventListener("visibilitychange", ()=>{ if (document.hidden) clearKeys(); });

/* ============================================================
   対戦(NPC)・マップ作成・PVP 共有オブジェクト
   ============================================================ */
export const bots=[];
export const targets=[];
export const edit={sel:"ply", o:0, props:[], ghost:null, flags:[], gx:0, gy:0, gz:0, valid:false, snapOn:false};

/* ============================================================
   オンラインPVP
   ============================================================ */
export const pvp = {
  socket:null, connected:false, myId:null, name:"プレイヤー",
  currentRoom:null, roomListCache:[], inMatch:false,
  gameType:"br", iAmHost:false, myTeam:null,
  players:new Map(),   // id -> {id,name,team,kills,deaths,alive,pos,targetPos,yaw,targetYaw,pivot,fallT}
  bots:new Map(),       // id("bot:N") -> {pivot,pos,targetPos,yaw,targetYaw,alive,fallT,team}（非ホスト側の描画用）
};
/* チーム戦(殲滅戦/フラッグ戦)で、撃った側と撃たれた側が同じチームか（バトルロワイアルは常にfalse=味方無し） */
export function pvpFriendly(teamA, teamB){
  return pvp.gameType!=="br" && !!teamA && !!teamB && teamA===teamB;
}

/* ============================================================
   サイト調整（デバッグ）モード状態
   ============================================================ */
export const sightCal = {active:false, pitch:0, yaw:0, roll:0, crossX:0, crossY:0, fov:50,
  muzzleX:0, muzzleY:0, muzzleZ:0, crossSize:14, circleSize:0,
  hipX:0.22, hipY:-0.22, hipZ:-0.48,   // 銃の保持位置（腰だめ描写）＝GUN_HIP既定値
  walk:false, walkDragging:false};      // walk: WASD移動で確認するサブモード
export const sightCalOrbit = {active:false, dragging:false, yaw:0.6, pitch:0.35, dist:0.3};
