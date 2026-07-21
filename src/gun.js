/* ============================================================
   ビューモデル（電動ガン M4風）・AR-15 GLTFモデル・アイアンサイト校正・
   サイト調整（デバッグ）モード
   ============================================================ */
import { THREE, $, camera, scene, RT, sightCal, sightCalOrbit, player, weapon, MAG_SIZE } from "./state.js";

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
export let MUZZLE_LOCAL_MODEL = null;                       // gunCorrected局所（AR15モデルの実マズル先端）

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
function measureSightPoints(corrected, skinned){
  const savedPos=corrected.position.clone(), savedQuat=corrected.quaternion.clone();
  corrected.position.set(0,0,0); corrected.quaternion.identity();
  corrected.updateMatrixWorld(true);
  const invParent=new THREE.Matrix4().copy(corrected.parent.matrixWorld).invert();
  const toScaledLocal=new THREE.Matrix4().multiplyMatrices(invParent, skinned.matrixWorld);
  const posAttr=skinned.geometry.attributes.position, v=new THREE.Vector3();
  let rminX=1e9,rmaxX=-1e9,rminY=1e9,rmaxY=-1e9,rzSum=0,rN=0;
  let fMaxY=-1e9,fAtX=0,fzSum=0,fN=0;
  let mMinZ=1e9,mAtX=0,mAtY=0;   // マズル先端＝モデル全体で最もZが小さい（前方）頂点
  for (let i=0;i<posAttr.count;i++){
    skinned.getVertexPosition(i,v);
    v.applyMatrix4(toScaledLocal);
    if (v.z>0.09&&v.z<0.20&&v.y>0.09&&v.y<0.18){
      rminX=Math.min(rminX,v.x);rmaxX=Math.max(rmaxX,v.x);
      rminY=Math.min(rminY,v.y);rmaxY=Math.max(rmaxY,v.y);rzSum+=v.z;rN++;
    }
    if (v.z>-0.31&&v.z<-0.27){ fzSum+=v.z;fN++; if(v.y>fMaxY){fMaxY=v.y;fAtX=v.x;} }
    if (v.z<mMinZ){ mMinZ=v.z; mAtX=v.x; mAtY=v.y; }
  }
  corrected.position.copy(savedPos); corrected.quaternion.copy(savedQuat);
  corrected.updateMatrixWorld(true);
  return {
    front:new THREE.Vector3(fAtX,fMaxY,fzSum/(fN||1)),
    rear:new THREE.Vector3((rminX+rmaxX)/2,(rminY+rmaxY)/2,rzSum/(rN||1)),
    muzzle:new THREE.Vector3(mAtX,mAtY,mMinZ),
  };
}
/* pitch/yaw/roll(度) → corrected姿勢を再計算。フロント先端を常に画面中心(FRONT_LOCAL)に固定。
   十字マーカーの位置やfovDegはここでは3D側に影響しない（fovDegはADS倍率としてのみ使う） */
export function applySightCalibration(pitchDeg,yawDeg,rollDeg,fovDeg=50){
  if (!gunCorrected || !FRONT_LOCAL) return;
  const e=new THREE.Euler(pitchDeg*Math.PI/180, yawDeg*Math.PI/180, rollDeg*Math.PI/180,"XYZ");
  const q=new THREE.Quaternion().setFromEuler(e);
  gunCorrected.quaternion.copy(q);
  gunCorrected.position.copy(FRONT_LOCAL).sub(FRONT_LOCAL.clone().applyQuaternion(q));
  GUN_ADS.set(-FRONT_LOCAL.x, -FRONT_LOCAL.y, -0.30);
  ADS_FOV=fovDeg;
}
export function loadSightCalib(){
  try{ return JSON.parse(localStorage.getItem(S_CAL_KEY)||"null"); }catch(e){ return null; }
}
export function saveSightCalib(o){
  localStorage.setItem(S_CAL_KEY, JSON.stringify(o));
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
// クロスヘアのサイズ・保持位置は銃モデル(GLB)の読込みを待たず、起動時に即座に反映する
{
  const savedCross = loadSightCalib();
  if (savedCross){
    sightCal.crossSize = savedCross.crossSize!=null ? savedCross.crossSize : 14;
    sightCal.circleSize = savedCross.circleSize!=null ? savedCross.circleSize : 0;
    if (savedCross.hipX!=null) sightCal.hipX = savedCross.hipX;
    if (savedCross.hipY!=null) sightCal.hipY = savedCross.hipY;
    if (savedCross.hipZ!=null) sightCal.hipZ = savedCross.hipZ;
  }
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

/* ---- AR-15 GLTFモデル読込み ----
   ソース: assets/ar15.glb（Sketchfab配布, FBX由来, スキンメッシュ+アーマチュア構成）
   スキン変形込みの実頂点位置(SkinnedMesh.getVertexPosition)で検証した結果、
   ロード直後の姿勢は既にローカルZ軸=全長軸（幅0.074×高さ0.31×全長0.84、実銃比率と一致）で
   回転補正は不要。ただし銃口（先細り側 = ローカルZ+）がカメラ側(+Z)を向いてしまっているため、
   Y軸180°回転のみで銃口を前方-Zへ反転（上方向Yはそのまま維持）。
   ロード後は自動でバウンディングボックスを測り、実銃全長 ~0.84m に正規化して中心を原点に揃える。
*/
export function loadGunModel(GLTFLoader){
  const GUN_TARGET_LEN = 0.84;
  new GLTFLoader().load("./assets/ar15.glb", (gltf)=>{
    const corrected = new THREE.Group();
    corrected.add(gltf.scene);
    // Y軸回転なし: 前回のY180°補正は前後が逆だったため撤去（銃口が自然に-Z=前方を向く姿勢）
    corrected.updateMatrixWorld(true);

    const box1 = new THREE.Box3().setFromObject(corrected);
    const size1 = box1.getSize(new THREE.Vector3());
    const scale = GUN_TARGET_LEN / Math.max(size1.x, size1.y, size1.z);
    corrected.scale.setScalar(scale);
    corrected.updateMatrixWorld(true);

    const box2 = new THREE.Box3().setFromObject(corrected);
    const center2 = box2.getCenter(new THREE.Vector3());
    corrected.position.sub(center2);   // バウンディングボックス中心をgunグループ原点に
    corrected.updateMatrixWorld(true);

    corrected.traverse(o=>{ if (o.isMesh){ o.castShadow=true; o.receiveShadow=false; } });

    gun.add(corrected);
    gunProcedural.visible = false;
    gunCorrected = corrected;
    gun.add(muzzleMarker);   // gunCorrectedではなくgunの子（scaleを二重適用しないため）

    let skinned=null;
    corrected.traverse(o=>{ if (o.isSkinnedMesh) skinned=o; });
    const pts = measureSightPoints(corrected, skinned);
    FRONT_LOCAL = pts.front;   // corrected局所空間（scale込み・回転補正前）
    REAR_LOCAL  = pts.rear;
    MUZZLE_LOCAL_MODEL = pts.muzzle;   // 実マズル先端（BB弾の発射起点）

    // 保存済みキャリブレーション値があれば復元、なければ実測済みの固定キャリブレーション値で開始
    const saved = loadSightCalib();
    const init = saved || {pitchDeg:-0.7, yawDeg:-0.6, rollDeg:0, crossX:30, crossY:0, fovDeg:25,
      muzzleX:-0.002, muzzleY:-0.007, muzzleZ:0.357, crossSize:0, circleSize:0,
      hipX:0.235, hipY:-0.225, hipZ:-0.35};
    applySightCalibration(init.pitchDeg, init.yawDeg, init.rollDeg, init.fovDeg||50);
    MUZZLE_OFFSET.set(init.muzzleX||0, init.muzzleY||0, init.muzzleZ||0);
    AIM_PX_X=init.crossX||0; AIM_PX_Y=init.crossY||0;
    updateMuzzleMarker();
    if (sightCal){
      sightCal.pitch=init.pitchDeg; sightCal.yaw=init.yawDeg; sightCal.roll=init.rollDeg;
      sightCal.crossX=init.crossX||0; sightCal.crossY=init.crossY||0; sightCal.fov=init.fovDeg||50;
      sightCal.muzzleX=init.muzzleX||0; sightCal.muzzleY=init.muzzleY||0; sightCal.muzzleZ=init.muzzleZ||0;
      sightCal.crossSize=init.crossSize!=null?init.crossSize:14; sightCal.circleSize=init.circleSize!=null?init.circleSize:0;
      sightCal.hipX=init.hipX!=null?init.hipX:0.235; sightCal.hipY=init.hipY!=null?init.hipY:-0.225; sightCal.hipZ=init.hipZ!=null?init.hipZ:-0.35;
      applyCrosshairSize(sightCal.crossSize, sightCal.circleSize);
      applyGunHip(sightCal.hipX, sightCal.hipY, sightCal.hipZ);
    }

    window.__gunModelBox = new THREE.Box3().setFromObject(corrected);   // デバッグ検証用
  }, undefined, (err)=>{
    console.error("AR15モデル読込み失敗、プロシージャルガンを継続表示:", err);
  });
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
  // スライダー・数値入力の両方を現在値に同期（片方を操作してももう片方に反映される）
  for (const [id,val] of [["calPitch",sightCal.pitch],["calYaw",sightCal.yaw],["calRoll",sightCal.roll],
      ["calCrossX",sightCal.crossX],["calCrossY",sightCal.crossY],["calFov",sightCal.fov],
      ["calMuzzleX",sightCal.muzzleX],["calMuzzleY",sightCal.muzzleY],["calMuzzleZ",sightCal.muzzleZ],
      ["calCrossSize",sightCal.crossSize],["calCircleSize",sightCal.circleSize],
      ["calHipX",sightCal.hipX],["calHipY",sightCal.hipY],["calHipZ",sightCal.hipZ]]){
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
  /* 現在のサイト調整値をJSON化（保存・書き出しで共用） */
  const currentCalib=()=>({
    pitchDeg:sightCal.pitch, yawDeg:sightCal.yaw, rollDeg:sightCal.roll,
    crossX:sightCal.crossX, crossY:sightCal.crossY, fovDeg:sightCal.fov,
    muzzleX:sightCal.muzzleX, muzzleY:sightCal.muzzleY, muzzleZ:sightCal.muzzleZ,
    crossSize:sightCal.crossSize, circleSize:sightCal.circleSize,
    hipX:sightCal.hipX, hipY:sightCal.hipY, hipZ:sightCal.hipZ,
  });
  $("sightCalReset").addEventListener("click",()=>{
    // 「リセット」= 実測済みの固定キャリブレーション値（ゲーム既定値）へ戻す
    sightCal.pitch=-0.7; sightCal.yaw=-0.6; sightCal.roll=0;
    sightCal.crossX=30; sightCal.crossY=0; sightCal.fov=25;
    sightCal.muzzleX=-0.002; sightCal.muzzleY=-0.007; sightCal.muzzleZ=0.357;
    sightCal.crossSize=0; sightCal.circleSize=0;
    sightCal.hipX=0.235; sightCal.hipY=-0.225; sightCal.hipZ=-0.35;
    sightCalRefresh();
  });
  $("sightCalApply").addEventListener("click",()=>{
    saveSightCalib(currentCalib());
    $("sightCalSaved").textContent="保存しました（次回起動時も自動適用されます）";
    setTimeout(()=>{ $("sightCalSaved").textContent=""; },2500);
  });
  $("sightCalExport").addEventListener("click",()=>{
    const data=currentCalib();
    const blob=new Blob([JSON.stringify(data,null,1)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download="airsoft_fps_sight_calib.json";
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
        const d=JSON.parse(reader.result);
        sightCal.pitch=+d.pitchDeg||0; sightCal.yaw=+d.yawDeg||0; sightCal.roll=+d.rollDeg||0;
        sightCal.crossX=+d.crossX||0; sightCal.crossY=+d.crossY||0; sightCal.fov=+d.fovDeg||50;
        sightCal.muzzleX=+d.muzzleX||0; sightCal.muzzleY=+d.muzzleY||0; sightCal.muzzleZ=+d.muzzleZ||0;
        sightCal.crossSize=d.crossSize!=null?+d.crossSize:14; sightCal.circleSize=d.circleSize!=null?+d.circleSize:0;
        sightCal.hipX=d.hipX!=null?+d.hipX:0.22; sightCal.hipY=d.hipY!=null?+d.hipY:-0.22; sightCal.hipZ=d.hipZ!=null?+d.hipZ:-0.48;
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
}
