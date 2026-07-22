/* ============================================================
   ビューモデル（銃のGLTFモデル）・アイアンサイト校正・
   サイト調整（デバッグ）モード
   ============================================================ */
import { THREE, S, $, camera, scene, RT, sightCal, sightCalOrbit, player, weapon, MAG_SIZE } from "./state.js";

/* ============================================================
   銃の種類（ビューモデル・射撃特性・既定キャリブレーション）
   pellets: 1回の発射で出るBB弾の数（ショットガンは3発同時）
   modes:   使用できる射撃モード（ショットガン・スナイパーはセミオートのみ）
   scope:   ADS時にスコープ表示にするか（スナイパーライフル）
   cal:     このモデル用の既定サイト調整値（サイト調整モードで上書き保存できる）
   ============================================================ */
export const WEAPONS = {
  type20: {
    // 光学サイト付きなので、ADSではスナイパー同様スコープ表示にして銃本体を隠す
    name:"アサルトライフル", file:"howa_type_20.glb", len:0.85,
    modes:["SEMI","FULL"], pellets:1, scope:true,
    /* このモデルは原点が機関部の下前方寄りなので、保持位置は他モデルより下げ・後ろへ置く
       （銃の見た目の中心が腰だめの標準位置に来るよう調整した値） */
    cal:{pitchDeg:0, yawDeg:0, rollDeg:0, crossX:0, crossY:0, fovDeg:25,
         muzzleX:0, muzzleY:0, muzzleZ:0, crossSize:0, circleSize:0,
         hipX:0.22, hipY:-0.39, hipZ:-0.43, spreadHip:0.45, spreadAds:0.10},
  },
  shotgun: {
    name:"ショットガン", file:"hawk_18.4mm_type_97-1_shotgun_qfb_18.4mm.glb", len:0.95,
    modes:["SEMI"], pellets:3, scope:false,
    cal:{pitchDeg:0, yawDeg:0, rollDeg:0, crossX:0, crossY:0, fovDeg:45,
         muzzleX:0, muzzleY:0, muzzleZ:0, crossSize:0, circleSize:0,
         hipX:0.235, hipY:-0.225, hipZ:-0.35, spreadHip:2.2, spreadAds:1.6},
  },
  sniper: {
    name:"スナイパーライフル", file:"hunting_rifle.glb", len:1.10,
    modes:["SEMI"], pellets:1, scope:true,
    cal:{pitchDeg:0, yawDeg:0, rollDeg:0, crossX:0, crossY:0, fovDeg:12,
         muzzleX:0, muzzleY:0, muzzleZ:0.603, crossSize:0, circleSize:0,
         hipX:0.175, hipY:-0.225, hipZ:-0.35, spreadHip:0.70, spreadAds:0.02},
  },
};
export function currentWeapon(){ return WEAPONS[S.weaponType]||WEAPONS.type20; }

/* ---- プロシージャル銃（GLTFロード完了までのフォールバック表示） ---- */
export const gun = new THREE.Group();
export const gunProcedural = new THREE.Group();
gun.add(gunProcedural);
{
  const black=new THREE.MeshStandardMaterial({color:0x1d1f22,metalness:.4,roughness:.6});
  const tan  =new THREE.MeshStandardMaterial({color:0x8f7a58,metalness:.2,roughness:.7});
  const add=(geo,mat,x,y,z,rx=0)=>{
    const m=new THREE.Mesh(geo,mat); m.position.set(x,y,z); m.rotation.x=rx;
    gunProcedural.add(m); return m;
  };
  add(new THREE.BoxGeometry(.065,.13,.42), black, 0,0,0);                    // レシーバー
  add(new THREE.BoxGeometry(.055,.06,.36), tan,   0,.01,-.38);               // ハンドガード
  const barrel=add(new THREE.CylinderGeometry(.009,.009,.16), black, 0,.01,-.62);
  barrel.rotation.x=Math.PI/2;
  add(new THREE.BoxGeometry(.06,.11,.24),  tan,   0,-.015,.30);              // ストック
  add(new THREE.BoxGeometry(.05,.13,.07),  black, 0,-.125,.10, .25);         // グリップ
  add(new THREE.BoxGeometry(.06,.20,.09),  black, 0,-.155,-.04, .12);        // マガジン
  add(new THREE.BoxGeometry(.05,.03,.09),  black, 0,.08,-.10);               // サイトベース
}
export const GUN_HIP = new THREE.Vector3(.235,-.225,-.35);
export const GUN_ADS = new THREE.Vector3(0,-.115,-.30);
gun.position.copy(GUN_HIP);
camera.add(gun);
export let MUZZLE_LOCAL = new THREE.Vector3(0,.01,-.70);   // gun局所（プロシージャル銃用の暫定値、モデル読込み後に実測値へ差替え）
export let MUZZLE_LOCAL_MODEL = null;                       // gunCorrected局所（読込んだモデルの実マズル先端）

/* ---- アイアンサイト・キャリブレーション（前方サイト固定・後方サイト可動のピボット回転） ----
   FRONT_LOCAL/REAR_LOCAL: モデル読込み直後（回転補正なし）の corrected 局所空間での
   フロントサイト先端・リアサイト穴中心（スキン変形込み頂点解析、z窓ヒューリスティック）。
   sightPitch/Yaw/Roll(度) を変えると、フロントサイト先端が常に画面中心に固定されたまま
   モデルがその点を中心に回転する（＝リアサイト側だけが画面上で動く）ので、
   実機を覗きながら合わせるのと同じ感覚でリアを追い込める。
   画面上の「十字」はあくまで目視用のCSSマーカーであり、銃の3D姿勢には一切影響しない
   （BB弾はここではなく、実測したマズル先端 MUZZLE_LOCAL_MODEL から発射される）。 */
export let FRONT_LOCAL=null, REAR_LOCAL=null, gunCorrected=null;
export let ADS_FOV=50;   // ADS倍率（サイト調整モードの「倍率」スライダーで変更、実ゲームプレイにも反映）
const S_CAL_KEY="airsoft_fps_sight_calib";
/* 「corrected局所空間」= corrected.position/quaternionが作用する直前の座標系
   （corrected.scaleは含む＝実メートルスケール、T・Rはこの空間の外側で適用される）。
   一時的にcorrectedのT・Rだけ単位化（Sはそのまま）して測定することで、
   後の corrected.position = F0 - q.applyQuaternion(F0)（scale込みの相似変換）の
   前提と一致する座標を得る */
/* corrected局所空間の全頂点を走査する（スキンメッシュ・通常メッシュどちらも対応）。
   走査中だけ corrected の T・R を単位化し、終わったら必ず元へ戻す */
function forEachVertexLocal(corrected, cb){
  const savedPos=corrected.position.clone(), savedQuat=corrected.quaternion.clone();
  corrected.position.set(0,0,0); corrected.quaternion.identity();
  corrected.updateMatrixWorld(true);
  const invParent=new THREE.Matrix4().copy(corrected.parent.matrixWorld).invert();
  const v=new THREE.Vector3();
  corrected.traverse(o=>{
    if (!o.isMesh) return;
    const toScaledLocal=new THREE.Matrix4().multiplyMatrices(invParent, o.matrixWorld);
    const posAttr=o.geometry.attributes.position;
    if (!posAttr) return;
    for (let i=0;i<posAttr.count;i++){
      if (o.isSkinnedMesh) o.getVertexPosition(i,v);
      else v.fromBufferAttribute(posAttr,i);
      v.applyMatrix4(toScaledLocal);
      cb(v);
    }
  });
  corrected.position.copy(savedPos); corrected.quaternion.copy(savedQuat);
  corrected.updateMatrixWorld(true);
}
/* 銃口が-Z(前方)を向いているかを判定する。
   「最も前にある頂点＝銃口」とみなすとストックの方が長く伸びているモデルで
   前後を取り違えるため、両端の“断面の太さ”を比べる（銃身の先端は細く、床尾板側は太い）。
   バンドを広く取るとフォアエンド/ポンプの太さを拾って逆転するので、ごく先端だけを見る */
const MUZZLE_TIP_BAND=0.03;
function muzzleFacesForward(corrected){
  let zMin=1e9, zMax=-1e9;
  forEachVertexLocal(corrected, p=>{
    if (p.z<zMin) zMin=p.z;
    if (p.z>zMax) zMax=p.z;
  });
  const band=(zMax-zMin)*MUZZLE_TIP_BAND;
  const acc=[{x0:1e9,x1:-1e9,y0:1e9,y1:-1e9},{x0:1e9,x1:-1e9,y0:1e9,y1:-1e9}];
  forEachVertexLocal(corrected, p=>{
    const i = p.z < zMin+band ? 0 : p.z > zMax-band ? 1 : -1;
    if (i<0) return;
    const a=acc[i];
    if (p.x<a.x0) a.x0=p.x; if (p.x>a.x1) a.x1=p.x;
    if (p.y<a.y0) a.y0=p.y; if (p.y>a.y1) a.y1=p.y;
  });
  const area=a=>Math.max(0,a.x1-a.x0)*Math.max(0,a.y1-a.y0);
  return area(acc[0]) <= area(acc[1]);   // -Z端の方が細ければ銃口は前を向いている
}
function measureSightPoints(corrected){
  let mMinZ=1e9,mAtX=0,mAtY=0;   // マズル先端＝モデル全体で最もZが小さい（前方）頂点
  let bMaxY=-1e9, bMaxZ=-1e9;
  /* 1周目: 全体のバウンディングとマズル先端を求める */
  forEachVertexLocal(corrected, p=>{
    if (p.y>bMaxY) bMaxY=p.y;
    if (p.z>bMaxZ) bMaxZ=p.z;
    if (p.z<mMinZ){ mMinZ=p.z; mAtX=p.x; mAtY=p.y; }
  });
  /* 2周目: 銃の一番上のバンド(＝アイアンサイト/スコープが載っている高さ)だけを抜き出し、
     その前後端と高さからサイトの位置を推定する。モデルの原点やストック長に依存せず、
     どの銃でも「照準器そのもの」を基準にできる */
  let sMinY=1e9, sMinZ=1e9, sMaxZ=-1e9;
  const yThresh=bMaxY*0.85;
  forEachVertexLocal(corrected, p=>{
    if (p.y<yThresh) return;
    if (p.y<sMinY) sMinY=p.y;
    if (p.z<sMinZ) sMinZ=p.z;
    if (p.z>sMaxZ) sMaxZ=p.z;
  });
  const sightY = sMinY<1e8 ? (sMinY+bMaxY)/2 : bMaxY*0.92;   // 照準器の光軸のおおよその高さ
  const eyeZ   = sMaxZ>-1e8 ? sMaxZ : bMaxZ*0.35;            // 接眼側(手前端)＝目を置く基準
  const tipZ   = sMinZ<1e8 ? sMinZ : mMinZ*0.72;             // 対物側(前端)
  return {
    front:new THREE.Vector3(0, sightY, tipZ),
    rear:new THREE.Vector3(0, sightY, eyeZ),
    muzzle:new THREE.Vector3(mAtX,mAtY,mMinZ),
    eyeZ,   // ADSでこの点をアイレリーフ分だけカメラ前に置く
  };
}
/* pitch/yaw/roll(度) → corrected姿勢を再計算。フロント先端を常に画面中心(FRONT_LOCAL)に固定。
   十字マーカーの位置やfovDegはここでは3D側に影響しない（fovDegはADS倍率としてのみ使う） */
/* ADS時に銃を前へどれだけ出すか。銃身が長いモデルでストック側がカメラ後方へ突き抜けて
   視界が銃の内部で埋まらないよう、モデルの全長に応じて設定する（setWeaponが更新） */
let ADS_Z=-0.30;
/* ADS時に照準器の接眼側をカメラの何m前に置くか。
   実物のアイレリーフ(数cm)そのままだと、ADSは画角を絞る(=拡大する)ぶん照準器が
   画面いっぱいに写ってしまうため、ビューモデルとしては十分に離して置く */
const ADS_EYE_RELIEF=0.45;
export function applySightCalibration(pitchDeg,yawDeg,rollDeg,fovDeg=50){
  if (!gunCorrected || !FRONT_LOCAL) return;
  const e=new THREE.Euler(pitchDeg*Math.PI/180, yawDeg*Math.PI/180, rollDeg*Math.PI/180,"XYZ");
  const q=new THREE.Quaternion().setFromEuler(e);
  gunCorrected.quaternion.copy(q);
  gunCorrected.position.copy(FRONT_LOCAL).sub(FRONT_LOCAL.clone().applyQuaternion(q));
  GUN_ADS.set(-FRONT_LOCAL.x, -FRONT_LOCAL.y, ADS_Z);
  ADS_FOV=fovDeg;
}
/* 保存形式は銃ごとの辞書 {type20:{...}, shotgun:{...}, sniper:{...}}。
   旧バージョンは単一の銃(AR15)用のフラットなオブジェクトだったが、その銃自体が
   入れ替わっており値をそのまま流用すると別モデルに合わない調整が入ってしまうため破棄する */
function loadCalibStore(){
  let raw=null;
  try{ raw=JSON.parse(localStorage.getItem(S_CAL_KEY)||"null"); }catch(e){ return {}; }
  if (!raw || typeof raw!=="object") return {};
  if (raw.pitchDeg!==undefined) return {};   // 旧形式（AR15専用）は使わない
  return raw;
}
/* 指定した銃（省略時は現在の銃）の保存済みキャリブレーション。無ければnull */
export function loadSightCalib(type){
  const store=loadCalibStore();
  return store[type||S.weaponType] || null;
}
export function saveSightCalib(o, type){
  const store=loadCalibStore();
  store[type||S.weaponType]=o;
  localStorage.setItem(S_CAL_KEY, JSON.stringify(store));
}
/* 実際に使う値 = 保存値があればそれ、無ければその銃の既定キャリブレーション */
export function effectiveCalib(type){
  const t=type||S.weaponType;
  return Object.assign({}, (WEAPONS[t]||WEAPONS.type20).cal, loadSightCalib(t)||{});
}
/* HUDクロスヘア(#crosshair)の十字の長さ・丸の半径をCSSカスタムプロパティ経由で反映 */
export function applyCrosshairSize(crossSize, circleSize){
  const el=$("crosshair");
  if (!el) return;
  el.style.setProperty("--len", (crossSize!=null?crossSize:14)+"px");
  el.style.setProperty("--r", (circleSize!=null?circleSize:0)+"px");
}
/* 銃の腰だめ描写位置(GUN_HIP)を反映（updateGunが毎フレームこの値を参照する） */
export function applyGunHip(x, y, z){
  GUN_HIP.set(x!=null?x:0.235, y!=null?y:-0.225, z!=null?z:-0.35);
}
/* sightCalへキャリブレーション値を流し込む（3D姿勢の適用は applyCalibToScene が行う） */
function calibToSightCal(c){
  sightCal.pitch=c.pitchDeg||0; sightCal.yaw=c.yawDeg||0; sightCal.roll=c.rollDeg||0;
  sightCal.crossX=c.crossX||0; sightCal.crossY=c.crossY||0; sightCal.fov=c.fovDeg||50;
  sightCal.muzzleX=c.muzzleX||0; sightCal.muzzleY=c.muzzleY||0; sightCal.muzzleZ=c.muzzleZ||0;
  sightCal.crossSize=c.crossSize!=null?c.crossSize:14;
  sightCal.circleSize=c.circleSize!=null?c.circleSize:0;
  sightCal.hipX=c.hipX!=null?c.hipX:0.235;
  sightCal.hipY=c.hipY!=null?c.hipY:-0.225;
  sightCal.hipZ=c.hipZ!=null?c.hipZ:-0.35;
  sightCal.spreadHip=c.spreadHip!=null?c.spreadHip:0.45;
  sightCal.spreadAds=c.spreadAds!=null?c.spreadAds:0.10;
}
// クロスヘアのサイズ・保持位置は銃モデル(GLB)の読込みを待たず、起動時に即座に反映する
{
  calibToSightCal(effectiveCalib());
  applyCrosshairSize(sightCal.crossSize, sightCal.circleSize);
  applyGunHip(sightCal.hipX, sightCal.hipY, sightCal.hipZ);
  gun.position.copy(GUN_HIP);
}
/* マズル先端からの微調整オフセット（MUZZLE_LOCAL_MODELと同じ「scale適用済み」座標系での加算）。
   サイト調整モードで見えるマーカー球の位置とBB弾の実発射位置の両方に反映される。
   マーカーは gun の子（gunCorrected の子ではない）にする: gunCorrected.scale(実測~0.0007)を
   そのまま子の並進にも掛けてしまうと位置がほぼ潰れるため、位置計算では
   gunCorrected の position・quaternion のみを手動合成し、scaleは二重適用しない
   （MUZZLE_LOCAL_MODEL自体が既にscale込みの値のため）。 */
export const MUZZLE_OFFSET = new THREE.Vector3(0,0,0);
/* 照準方向のズレ（ゼロイン調整、画面中心からのpx オフセット）。
   0のときはcamera.getWorldDirection()と完全に一致（通常の照準どおり）。
   非0にすると、BB弾は画面上のこの位置を通る方向へ実際に発射される
   （マズル位置とは独立。実銃の「ゼロイン」＝照準と着弾のズレ調整に相当）。 */
export let AIM_PX_X=0, AIM_PX_Y=0;
export const muzzleMarker = new THREE.Mesh(new THREE.SphereGeometry(0.01,10,8),
  new THREE.MeshBasicMaterial({color:0xff9500, transparent:true, opacity:.9,
    depthTest:false, depthWrite:false}));
muzzleMarker.renderOrder=15;
muzzleMarker.visible=false;
export function currentMuzzleLocal(){
  return (MUZZLE_LOCAL_MODEL||MUZZLE_LOCAL).clone().add(MUZZLE_OFFSET);
}
/* マズル位置を gun局所空間で返す（gunCorrectedのposition+quaternionのみ合成、scaleは適用しない） */
export function muzzleInGunLocal(){
  if (!gunCorrected) return currentMuzzleLocal();
  return currentMuzzleLocal().applyQuaternion(gunCorrected.quaternion).add(gunCorrected.position);
}
export function updateMuzzleMarker(){
  if (!gunCorrected) return;
  muzzleMarker.position.copy(muzzleInGunLocal());
}

/* ---- 銃モデル(GLTF)の読込み ----
   モデルごとに元データの向き・スケール・原点がバラバラなので、読込み後に
   1) 実銃相当の全長(spec.len)へ正規化　2) 最長軸をZ(前後)へ揃える
   3) マズルが-Z(前方)を向くよう必要なら180°回す　4) 中心を原点へ
   を自動で行い、どのモデルでも同じ座標系で扱えるようにする。 */
const loadedModels = {};   // type -> {root, front, rear, muzzle}
let _GLTFLoader=null;
/* 現在のsightCal値を3Dシーン（銃の姿勢・マズル・クロスヘア）へ反映する */
function applyCalibToScene(){
  applySightCalibration(sightCal.pitch, sightCal.yaw, sightCal.roll, sightCal.fov);
  MUZZLE_OFFSET.set(sightCal.muzzleX, sightCal.muzzleY, sightCal.muzzleZ);
  AIM_PX_X=sightCal.crossX; AIM_PX_Y=sightCal.crossY;
  applyCrosshairSize(sightCal.crossSize, sightCal.circleSize);
  applyGunHip(sightCal.hipX, sightCal.hipY, sightCal.hipZ);
  updateMuzzleMarker();
}
function loadWeaponModel(type){
  const spec=WEAPONS[type];
  if (!spec || !_GLTFLoader) return Promise.resolve(null);
  if (loadedModels[type]) return Promise.resolve(loadedModels[type]);
  return new Promise((resolve)=>{
    new _GLTFLoader().load("./assets/"+spec.file, (gltf)=>{
      const corrected = new THREE.Group();
      const inner = gltf.scene;
      corrected.add(inner);
      corrected.traverse(o=>{ if (o.isMesh){ o.castShadow=true; o.receiveShadow=false; } });
      // 測定は corrected.parent(=gun) の逆行列を使うので、先にシーングラフへ繋いでおく
      corrected.visible=false;
      gun.add(corrected);
      /* 実銃相当の全長へ正規化 → 長手方向の向きを揃える → 中心を原点へ、の順に整える。
         向きの補正は corrected ではなく内側(inner)に掛ける: corrected の quaternion は
         applySightCalibration が毎回上書きするため、そこへ入れると補正が消えてしまう */
      const fit=()=>{
        // 何度呼んでも同じ結果になるよう、必ず等倍・原点に戻してから測り直す
        corrected.scale.setScalar(1);
        corrected.position.set(0,0,0);
        corrected.updateMatrixWorld(true);
        const size=new THREE.Box3().setFromObject(corrected).getSize(new THREE.Vector3());
        corrected.scale.setScalar(spec.len / Math.max(size.x, size.y, size.z));
        corrected.updateMatrixWorld(true);
        const box2=new THREE.Box3().setFromObject(corrected);
        corrected.position.sub(box2.getCenter(new THREE.Vector3()));
        corrected.updateMatrixWorld(true);
      };
      fit();
      /* モデルごとに全長がどの軸を向いているかバラバラなので、
         1) 最長軸を Z（前後方向）へ回す　2) マズルが-Z(前方)に来るよう必要なら180°回す
         の2段階で姿勢を揃える（どちらも内側のinnerに掛ける） */
      corrected.updateMatrixWorld(true);
      const size=new THREE.Box3().setFromObject(corrected).getSize(new THREE.Vector3());
      if (size.x>size.z && size.x>=size.y) inner.rotation.y += Math.PI/2;        // 長手がX軸 → Zへ
      else if (size.y>size.z && size.y>size.x) inner.rotation.x += Math.PI/2;    // 長手がY軸 → Zへ
      fit();
      // 銃身側(細い方)が-Z(前方)に来ていなければ180°回して前後を揃える
      if (!muzzleFacesForward(corrected)){
        inner.rotation.y += Math.PI;
        fit();
      }
      const pts = measureSightPoints(corrected);
      /* ADSで銃を前へ出す量: サイト(照準器)が常に一定のアイレリーフでカメラ前に来るようにする。
         モデルの原点は中心とは限らない（機関部の下前方などにある）ため全長からは決められない。
         この置き方ならストックは自然とカメラの後方へ回り込んで視界に入らない */
      const entry={root:corrected, front:pts.front, rear:pts.rear, muzzle:pts.muzzle,
        adsZ: -ADS_EYE_RELIEF - pts.eyeZ};
      loadedModels[type]=entry;
      resolve(entry);
    }, undefined, (err)=>{
      console.error(spec.file+" の読込みに失敗しました:", err);
      resolve(null);
    });
  });
}
/* 銃を切り替える（モデルは初回のみ読込み、以降はキャッシュを表示切替）。
   モデルごとに独立したサイト調整値・射撃モード制限が適用される */
export function setWeapon(type){
  if (!WEAPONS[type]) type="type20";
  S.weaponType=type;
  const spec=WEAPONS[type];
  // 射撃モードの制限（ショットガン・スナイパーはセミオートのみ）
  if (!spec.modes.includes(weapon.mode)) weapon.mode=spec.modes[0];
  if ($("fireMode")) $("fireMode").textContent = weapon.mode==="SEMI"?"SEMI":"FULL AUTO";
  calibToSightCal(effectiveCalib(type));
  return loadWeaponModel(type).then(entry=>{
    if (S.weaponType!==type) return;   // 読込み待ちの間にさらに切り替わっていたら破棄
    for (const [t,m] of Object.entries(loadedModels)) m.root.visible = (t===type);
    if (entry){
      gunCorrected = entry.root;
      FRONT_LOCAL = entry.front; REAR_LOCAL = entry.rear; MUZZLE_LOCAL_MODEL = entry.muzzle;
      ADS_Z = entry.adsZ;
      gunProcedural.visible = false;
    } else {
      gunCorrected = null; MUZZLE_LOCAL_MODEL = null;
      gunProcedural.visible = true;   // 読込み失敗時はプロシージャル銃にフォールバック
    }
    applyCalibToScene();
    if (sightCal.active) sightCalRefresh();
  });
}
export function loadGunModel(GLTFLoader){
  _GLTFLoader=GLTFLoader;
  gun.add(muzzleMarker);   // gunCorrectedではなくgunの子（scaleを二重適用しないため）
  setWeapon(S.weaponType);
}

/* ============================================================
   サイト調整（デバッグ）モード
   フロントサイトを画面中心に固定し、リアサイト側だけをピッチ/ヨー/ロールの
   スライダーで動かして目視で追い込む。ポインタロック不要（カーソル操作前提）。
   ============================================================ */
/* 自由視点（マズル確認用オービットカメラ）
   gunは通常カメラの子だが、これだと「カメラを動かす」＝「銃も一緒に動く」ため
   周りをぐるぐる回ってマズルを眺めることができない。自由視点中だけgunをシーン直下へ
   一時的に付け替え（見た目が飛ばないよう現在のワールド変換を引き継ぐ）、
   カメラだけをマズルマーカー中心に軌道運動させる。 */
export function updateOrbitCamera(){
  if (!sightCalOrbit.active) return;
  const target=new THREE.Vector3(); muzzleMarker.getWorldPosition(target);
  const d=sightCalOrbit.dist, p=sightCalOrbit.pitch, y=sightCalOrbit.yaw;
  camera.position.set(
    target.x + d*Math.cos(p)*Math.sin(y),
    target.y + d*Math.sin(p),
    target.z + d*Math.cos(p)*Math.cos(y));
  camera.lookAt(target);
}
export function enterOrbitView(){
  if (sightCalOrbit.active) return;
  if (sightCal.walk) exitSightCalWalk();   // 移動モードと自由視点は排他
  camera.updateMatrixWorld(true);
  const wp=new THREE.Vector3(), wq=new THREE.Quaternion(), ws=new THREE.Vector3();
  gun.matrixWorld.decompose(wp,wq,ws);
  camera.remove(gun);
  scene.add(gun);
  gun.position.copy(wp); gun.quaternion.copy(wq);
  sightCalOrbit.active=true;
  sightCalOrbit.yaw=0.6; sightCalOrbit.pitch=0.35; sightCalOrbit.dist=0.3;
  $("sightCalOrbitToggle").classList.add("active");
  $("sightCalOrbitToggle").textContent="🎯 サイト視点に戻る";
  updateOrbitCamera();
}
export function exitOrbitView(){
  if (!sightCalOrbit.active) return;
  scene.remove(gun);
  camera.add(gun);
  gun.position.copy(GUN_ADS);
  gun.quaternion.identity();
  camera.position.set(0,1.6,0);
  camera.rotation.set(0,0,0);
  sightCalOrbit.active=false;
  $("sightCalOrbitToggle").classList.remove("active");
  $("sightCalOrbitToggle").textContent="🔄 自由視点でマズル確認";
}
export function sightCalRefresh(){
  applySightCalibration(sightCal.pitch, sightCal.yaw, sightCal.roll, sightCal.fov);
  applyGunHip(sightCal.hipX, sightCal.hipY, sightCal.hipZ);
  // 通常の調整ビューはADS姿勢固定。自由視点(orbit)とWASD移動(walk)中はそれぞれの更新に任せる
  if (!sightCalOrbit.active && !sightCal.walk){
    gun.position.copy(GUN_ADS);
    gun.rotation.set(0,0,0);
  }
  // WASD移動中は通常FOV(75)を updateGun に任せる。それ以外は倍率プレビュー値を適用
  if (!sightCal.walk){ camera.fov=sightCal.fov; camera.updateProjectionMatrix(); }
  MUZZLE_OFFSET.set(sightCal.muzzleX, sightCal.muzzleY, sightCal.muzzleZ);
  updateMuzzleMarker();
  AIM_PX_X=sightCal.crossX; AIM_PX_Y=sightCal.crossY;   // 実際の発射方向に反映（ゼロイン調整）
  applyCrosshairSize(sightCal.crossSize, sightCal.circleSize);
  if (sightCalOrbit.active) updateOrbitCamera();
  $("calPitchVal").textContent=sightCal.pitch.toFixed(2)+"°";
  $("calYawVal").textContent=sightCal.yaw.toFixed(2)+"°";
  $("calRollVal").textContent=sightCal.roll.toFixed(2)+"°";
  $("calCrossXVal").textContent=sightCal.crossX+"px";
  $("calCrossYVal").textContent=sightCal.crossY+"px";
  $("calFovVal").textContent=sightCal.fov.toFixed(1)+"°";
  $("calMuzzleXVal").textContent=sightCal.muzzleX.toFixed(3)+"m";
  $("calMuzzleYVal").textContent=sightCal.muzzleY.toFixed(3)+"m";
  $("calMuzzleZVal").textContent=sightCal.muzzleZ.toFixed(3)+"m";
  $("calCrossSizeVal").textContent=sightCal.crossSize+"px";
  $("calCircleSizeVal").textContent=sightCal.circleSize+"px";
  $("calHipXVal").textContent=sightCal.hipX.toFixed(3)+"m";
  $("calHipYVal").textContent=sightCal.hipY.toFixed(3)+"m";
  $("calHipZVal").textContent=sightCal.hipZ.toFixed(3)+"m";
  $("calSpreadHipVal").textContent=sightCal.spreadHip.toFixed(2)+"°";
  $("calSpreadAdsVal").textContent=sightCal.spreadAds.toFixed(2)+"°";
  // 銃の種類チップの選択状態を現在の銃に合わせる
  $("sightCalWeaponChips").querySelectorAll(".chip").forEach(c=>{
    c.classList.toggle("sel", c.dataset.w===S.weaponType);
  });
  // スライダー・数値入力の両方を現在値に同期（片方を操作してももう片方に反映される）
  for (const [id,val] of [["calPitch",sightCal.pitch],["calYaw",sightCal.yaw],["calRoll",sightCal.roll],
      ["calCrossX",sightCal.crossX],["calCrossY",sightCal.crossY],["calFov",sightCal.fov],
      ["calMuzzleX",sightCal.muzzleX],["calMuzzleY",sightCal.muzzleY],["calMuzzleZ",sightCal.muzzleZ],
      ["calCrossSize",sightCal.crossSize],["calCircleSize",sightCal.circleSize],
      ["calHipX",sightCal.hipX],["calHipY",sightCal.hipY],["calHipZ",sightCal.hipZ],
      ["calSpreadHip",sightCal.spreadHip],["calSpreadAds",sightCal.spreadAds]]){
    if (document.activeElement!==$(id)) $(id).value=val;
    if (document.activeElement!==$(id+"Num")) $(id+"Num").value=val;
  }
  $("sightCalReadout").textContent=
    `pitch: ${sightCal.pitch.toFixed(2)}° / yaw: ${sightCal.yaw.toFixed(2)}° / roll: ${sightCal.roll.toFixed(2)}° / `+
    `照準ズレ: (${sightCal.crossX}, ${sightCal.crossY})px / 倍率: ${sightCal.fov.toFixed(1)}° / `+
    `マズル: (${sightCal.muzzleX.toFixed(3)}, ${sightCal.muzzleY.toFixed(3)}, ${sightCal.muzzleZ.toFixed(3)})m`;
  const cross=$("sightCalCrosshair");
  cross.style.left=`calc(50% + ${sightCal.crossX}px)`;
  cross.style.top=`calc(50% + ${sightCal.crossY}px)`;
}
export function enterSightCal(){
  sightCal.active=true;
  $("menu").style.display="none";
  $("sightCalPanel").classList.add("show");
  $("sightCalCrosshair").classList.add("show");
  muzzleMarker.visible=true;
  weapon.mag=MAG_SIZE; weapon.reloading=false; weapon.cooldown=0;   // 試射用に弾切れ・リロードなし
  camera.position.set(0,1.6,0);
  camera.rotation.set(0,0,0);
  sightCalRefresh();
}
/* WASD移動サブモード: ポインタロックは使わず（スライダーをカーソルで操作できるように）、
   WASDで移動・右ドラッグで視点回転・左クリックで試射。銃は腰だめ描写(GUN_HIP)で表示され、
   保持位置スライダーを動かしながら見た目を確認できる。射撃練習場の原点にリセットして開始。 */
export function enterSightCalWalk(){
  exitOrbitView();
  sightCal.walk=true; sightCal.walkDragging=false;
  RT.ads=false; RT.firing=false;
  document.body.classList.add("sightcal-walk");
  $("sightCalWalkToggle").classList.add("active");
  $("sightCalWalkToggle").textContent="🛑 WASD移動を終了";
  $("sightCalCrosshair").classList.remove("show");   // 移動中は照準ズレ用の青十字は隠す
  player.pos.set(0,0,0); player.vel.set(0,0,0);
  player.yaw=0; player.pitch=0; player.lean=0;
  camera.fov=75; camera.updateProjectionMatrix();
}
export function exitSightCalWalk(){
  sightCal.walk=false; sightCal.walkDragging=false;
  document.body.classList.remove("sightcal-walk");
  $("sightCalWalkToggle").classList.remove("active");
  $("sightCalWalkToggle").textContent="🚶 WASD移動で確認";
  if (sightCal.active){
    $("sightCalCrosshair").classList.add("show");
    camera.position.set(0,1.6,0);
    camera.rotation.set(0,0,0);
    sightCalRefresh();   // 調整ビュー（ADS固定）に復帰
  }
}
export function toggleSightCalWalk(){
  if (sightCal.walk) exitSightCalWalk(); else enterSightCalWalk();
}
export function exitSightCal(){
  if (sightCal.walk) exitSightCalWalk();
  exitOrbitView();   // gunがシーン直下に付け替わったままにならないよう必ず復帰させる
  sightCal.active=false;
  RT.firing=false;
  $("sightCalPanel").classList.remove("show");
  $("sightCalCrosshair").classList.remove("show");
  muzzleMarker.visible=false;
  camera.fov=75; camera.updateProjectionMatrix();
  $("menu").style.display="";   // インラインstyle指定を解除し、CSS(.locked #menu)の制御に戻す
}
export function wireSightCalUI(){
  // サイト調整モードは通常メニューには表示せず、専用URL(?sightcal)からのみ入れる(main.js側で判定)
  $("sightCalExit").addEventListener("click", exitSightCal);
  $("sightCalOrbitToggle").addEventListener("click",()=>{
    if (sightCalOrbit.active) exitOrbitView(); else enterOrbitView();
  });
  $("sightCalWalkToggle").addEventListener("click", toggleSightCalWalk);
  /* スライダー・数値入力を同じキーに双方向バインド */
  function bindCal(key, id){
    const onInput=(v)=>{ if(!isNaN(v)){ sightCal[key]=v; sightCalRefresh(); } };
    $(id).addEventListener("input",e=>onInput(+e.target.value));
    $(id+"Num").addEventListener("input",e=>onInput(+e.target.value));
  }
  bindCal("pitch","calPitch"); bindCal("yaw","calYaw"); bindCal("roll","calRoll");
  bindCal("crossX","calCrossX"); bindCal("crossY","calCrossY"); bindCal("fov","calFov");
  bindCal("muzzleX","calMuzzleX"); bindCal("muzzleY","calMuzzleY"); bindCal("muzzleZ","calMuzzleZ");
  bindCal("crossSize","calCrossSize"); bindCal("circleSize","calCircleSize");
  bindCal("hipX","calHipX"); bindCal("hipY","calHipY"); bindCal("hipZ","calHipZ");
  bindCal("spreadHip","calSpreadHip"); bindCal("spreadAds","calSpreadAds");
  /* 銃の種類の切替（それぞれ独立したサイト調整値を持つ） */
  $("sightCalWeaponChips").addEventListener("click",e=>{
    const b=e.target.closest(".chip"); if (!b) return;
    setWeapon(b.dataset.w);
  });
  /* 現在のサイト調整値をJSON化（保存・書き出しで共用） */
  const currentCalib=()=>({
    pitchDeg:sightCal.pitch, yawDeg:sightCal.yaw, rollDeg:sightCal.roll,
    crossX:sightCal.crossX, crossY:sightCal.crossY, fovDeg:sightCal.fov,
    muzzleX:sightCal.muzzleX, muzzleY:sightCal.muzzleY, muzzleZ:sightCal.muzzleZ,
    crossSize:sightCal.crossSize, circleSize:sightCal.circleSize,
    hipX:sightCal.hipX, hipY:sightCal.hipY, hipZ:sightCal.hipZ,
    spreadHip:sightCal.spreadHip, spreadAds:sightCal.spreadAds,
  });
  $("sightCalReset").addEventListener("click",()=>{
    // 「リセット」= 現在の銃の既定キャリブレーション値へ戻す
    calibToSightCal(currentWeapon().cal);
    sightCalRefresh();
  });
  $("sightCalApply").addEventListener("click",()=>{
    saveSightCalib(currentCalib());
    $("sightCalSaved").textContent=`${currentWeapon().name}の値を保存しました（次回起動時も自動適用されます）`;
    setTimeout(()=>{ $("sightCalSaved").textContent=""; },2500);
  });
  $("sightCalExport").addEventListener("click",()=>{
    const data=currentCalib();
    const blob=new Blob([JSON.stringify(data,null,1)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download=`airsoft_fps_sight_calib_${S.weaponType}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    $("sightCalSaved").textContent="JSONを書き出しました";
    setTimeout(()=>{ $("sightCalSaved").textContent=""; },2500);
  });
  $("sightCalImportBtn").addEventListener("click",()=> $("sightCalImportInput").click());
  $("sightCalImportInput").addEventListener("change",e=>{
    const f=e.target.files[0];
    e.target.value="";
    if (!f) return;
    const reader=new FileReader();
    reader.onload=()=>{
      try{
        calibToSightCal(JSON.parse(reader.result));
        sightCalRefresh();
        $("sightCalSaved").textContent="JSONを読み込みました（「確定・保存」を押すと次回も適用されます）";
        setTimeout(()=>{ $("sightCalSaved").textContent=""; },3200);
      }catch(err){
        $("sightCalSaved").textContent="読み込み失敗：JSON形式が不正です";
        setTimeout(()=>{ $("sightCalSaved").textContent=""; },2500);
      }
    };
    reader.readAsText(f);
  });
}

/* ============================================================
   ビューモデル更新（毎フレーム）
   ============================================================ */
let bobT=0;
const _gunTarget=new THREE.Vector3();
export function updateGun(dt){
  const speed2d=Math.hypot(player.vel.x,player.vel.z);
  bobT += dt*(4+speed2d*1.4);
  const bobAmp=(RT.ads?0.001:0.004)*Math.min(1,speed2d/4);
  _gunTarget.copy(RT.ads?GUN_ADS:GUN_HIP);
  _gunTarget.x += Math.sin(bobT)*bobAmp;
  _gunTarget.y += Math.abs(Math.cos(bobT))*bobAmp;
  // 発射キック
  weapon.kick=Math.max(0,weapon.kick-dt*10);
  _gunTarget.z += weapon.kick*0.025;
  gun.position.lerp(_gunTarget, Math.min(1,dt*14));
  gun.rotation.y=(RT.ads?0:-0.04);
  gun.rotation.x=weapon.kick*0.05;

  const targetFov=RT.ads?ADS_FOV:75;
  camera.fov += (targetFov-camera.fov)*Math.min(1,dt*14);
  camera.updateProjectionMatrix();
  document.body.classList.toggle("ads",RT.ads);
  // スナイパーライフルのADSはスコープ表示（覗き込むと視界がスコープ内に切り替わる）。
  // 完全に絞り込んでから出すため、FOVが目標付近に収束してから表示する
  const scoped = RT.ads && currentWeapon().scope && camera.fov < ADS_FOV+6;
  document.body.classList.toggle("scoped", scoped);
  if (gunCorrected) gunCorrected.visible = !scoped;   // スコープ内では銃本体は視界の邪魔なので隠す
}
