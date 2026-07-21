/* ============================================================
   マップ作成モード（バリケード設置・localStorage自動保存）
   ============================================================ */
import { THREE, S, $, scene, camera, RT, keys, obstacles, EDIT_AREA, ENEMY_FLAG, PLAYER_FLAG, edit } from "./state.js";
import { showMsg } from "./effects.js";
import { sndClick } from "./sound.js";
import { propDims, makePropMesh, PROP_NAMES, loadCustomMap, MAP_KEY, buildFlag } from "./bots.js";

const editRaycaster=new THREE.Raycaster();
const _dir=new THREE.Vector3();

export function saveCustomMap(){
  localStorage.setItem(MAP_KEY,
    JSON.stringify(edit.props.map(p=>({t:p.t, x:p.x, y:p.y, z:p.z, o:p.o}))));
  updateEditHUD();
}
export function updateEditHUD(){
  $("editSel").textContent=PROP_NAMES[edit.sel]+`（${edit.o}°）`;
  $("editCount").textContent=edit.props.length;
}
/* カスタムマップをJSONファイルとして書き出し／読み込み */
export function exportCustomMap(){
  const data=edit.props.map(p=>({t:p.t, x:+p.x.toFixed(3), y:+(p.y||0).toFixed(3), z:+p.z.toFixed(3), o:p.o}));
  const blob=new Blob([JSON.stringify(data,null,1)],{type:"application/json"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url; a.download="airsoft_fps_map.json";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showMsg(`マップを書き出しました（${data.length}個）`,1.8);
}
export function importCustomMapData(data){
  if (!Array.isArray(data)) throw new Error("invalid map data");
  for (const p of edit.props) scene.remove(p.mesh);
  edit.props.length=0;
  for (const d of data){
    if (!d || typeof d.t!=="string" || typeof d.x!=="number" || typeof d.z!=="number") continue;
    editPlace(d.t, d.x, d.y||0, d.z, d.o||0, false);
  }
  saveCustomMap();
}
export function importCustomMapFile(file){
  const reader=new FileReader();
  reader.onload=()=>{
    try{
      importCustomMapData(JSON.parse(reader.result));
      showMsg(`マップを読み込みました（${edit.props.length}個）`,1.8);
    }catch(e){
      showMsg("読み込み失敗：JSON形式が不正です",2.2);
    }
  };
  reader.readAsText(file);
}
export function makeGhost(){
  if (edit.ghost){ scene.remove(edit.ghost); edit.ghost=null; }
  const dim=propDims(edit.sel,edit.o);
  const geo = edit.sel==="drum" ? new THREE.CylinderGeometry(.3,.3,.9,16)
    : edit.sel==="crate" ? new THREE.BoxGeometry(1.1,1.1,1.1)
    : new THREE.BoxGeometry(.9,1.8,.05);
  edit.ghost=new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
    color:0x44ff88, transparent:true, opacity:.45, depthWrite:false}));
  edit.ghost.rotation.y=(edit.o||0)*Math.PI/180;
  edit.ghost.position.y=dim.h/2;
  edit.ghost.visible=false;
  scene.add(edit.ghost);
}
export function enterEditMode(){
  const saved=loadCustomMap()||[];
  for (const d of saved) editPlace(d.t, d.x, d.y||0, d.z, d.o, false);
  // フラッグを目印表示
  const ef=buildFlag(0xd8352a); ef.position.set(ENEMY_FLAG.x,0,ENEMY_FLAG.z);
  const pf=buildFlag(0x2a6fd8); pf.position.set(PLAYER_FLAG.x,0,PLAYER_FLAG.z);
  scene.add(ef); scene.add(pf); edit.flags=[ef,pf];
  makeGhost();
  updateEditHUD();
}
export function exitEditMode(){
  for (const p of edit.props) scene.remove(p.mesh);
  edit.props.length=0;
  for (const f of edit.flags) scene.remove(f);
  edit.flags.length=0;
  if (edit.ghost){ scene.remove(edit.ghost); edit.ghost=null; }
}
export function editPlace(t,x,y,z,o,save=true){
  const m=makePropMesh(t,o);
  m.position.set(x, y+propDims(t,o).h/2, z);
  scene.add(m);
  edit.props.push({mesh:m, t, x, y, z, o});
  if (save){ saveCustomMap(); sndClick(600,.2); }
}
/* 3D重なり判定（ぴったり隣接・積み重ねはepsilonで許容） */
export function editValidAt(x,y,z){
  const d=propDims(edit.sel,edit.o);
  if (x-d.hw<EDIT_AREA.xMin || x+d.hw>EDIT_AREA.xMax ||
      z-d.hd<EDIT_AREA.zMin || z+d.hd>EDIT_AREA.zMax) return false;
  if (y<0 || y+d.h>8) return false;
  const e=0.001;
  for (const p of edit.props){
    const q=propDims(p.t,p.o);
    if (Math.abs(x-p.x)<d.hw+q.hw-e && Math.abs(z-p.z)<d.hd+q.hd-e &&
        y<p.y+q.h-e && y+d.h>p.y+e) return false;
  }
  // 常設の木箱・バリケード・壁とも重ねない
  for (const o2 of obstacles){
    if (x>o2.min.x-d.hw && x<o2.max.x+d.hw &&
        z>o2.min.z-d.hd && z<o2.max.z+d.hd &&
        y<o2.max.y-e && y+d.h>o2.min.y+e) return false;
  }
  return true;
}
export function editDelete(){
  editRaycaster.set(camera.position, camera.getWorldDirection(_dir));
  const hits=editRaycaster.intersectObjects(edit.props.map(p=>p.mesh), false);
  if (!hits.length) return;
  const i=edit.props.findIndex(p=>p.mesh===hits[0].object);
  if (i>=0){
    scene.remove(edit.props[i].mesh);
    edit.props.splice(i,1);
    saveCustomMap(); sndClick(300,.2);
  }
}
/* ゴースト追従（毎フレーム）:
   Shiftキーを押しっぱなしの間だけスナップ有効（積み重ね中心/隣接/0.25mグリッド/縁吸着）。
   押していなければノンスナップ＝レイの当たった座標にそのまま自由配置。 */
export function updateEdit(){
  if (S.mode!=="edit" || !RT.locked){ if (edit.ghost) edit.ghost.visible=false; return; }
  camera.getWorldDirection(_dir);
  edit.valid=false;
  let show=false, x=0, y0=0, z=0;
  const d=propDims(edit.sel,edit.o);
  // Altはブラウザ/OSのメニューキー予約と衝突し、WASD同時押しでフォーカスが奪われ
  // キーが押しっぱなしのまま固まる事故が起きるため使わない（Shiftは安全）
  const snapOn = !!keys["ShiftLeft"] || !!keys["ShiftRight"];
  edit.snapOn=snapOn;
  const snap=(v)=> Math.round(v*4)/4;

  editRaycaster.set(camera.position, _dir);
  editRaycaster.far=45;
  const hits=editRaycaster.intersectObjects(edit.props.map(p=>p.mesh), false);
  let tG=Infinity;
  if (_dir.y<-0.02) tG=-camera.position.y/_dir.y;

  if (hits.length && hits[0].distance < Math.min(tG,45)){
    const hit=hits[0];
    const p=edit.props.find(pp=>pp.mesh===hit.object);
    const q=propDims(p.t,p.o);
    const n=hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    if (n.y>0.5){
      // 上面 → 積み重ね（スナップ時は中心/グリッド吸着、ノンスナップは着弾点そのまま）
      y0=p.y+q.h;
      if (snapOn){
        x=Math.abs(hit.point.x-p.x)<0.35? p.x : snap(hit.point.x);
        z=Math.abs(hit.point.z-p.z)<0.35? p.z : snap(hit.point.z);
      } else { x=hit.point.x; z=hit.point.z; }
      show=true;
    } else if (Math.abs(n.y)<=0.5){
      // 側面 → スナップ時のみぴったり隣接、ノンスナップは着弾点そのまま
      y0=p.y;
      if (snapOn){
        if (Math.abs(n.x)>Math.abs(n.z)){
          x=p.x+Math.sign(n.x)*(q.hw+d.hw);
          z=Math.abs(hit.point.z-p.z)<0.35? p.z : snap(hit.point.z);
        } else {
          z=p.z+Math.sign(n.z)*(q.hd+d.hd);
          x=Math.abs(hit.point.x-p.x)<0.35? p.x : snap(hit.point.x);
        }
      } else { x=hit.point.x; z=hit.point.z; }
      show=true;
    }
  } else if (tG>0 && tG<45){
    x=camera.position.x+_dir.x*tG;
    z=camera.position.z+_dir.z*tG;
    y0=0;
    if (snapOn){
      x=snap(x); z=snap(z);
      // 近隣オブジェクトの縁・中心へ座標スナップ
      for (const p of edit.props){
        if (p.y!==0) continue;
        const q=propDims(p.t,p.o);
        if (Math.abs(z-p.z)<q.hd+d.hd+0.6){
          for (const cx of [p.x, p.x+q.hw+d.hw, p.x-q.hw-d.hw])
            if (Math.abs(x-cx)<0.26){ x=cx; break; }
        }
        if (Math.abs(x-p.x)<q.hw+d.hw+0.6){
          for (const cz of [p.z, p.z+q.hd+d.hd, p.z-q.hd-d.hd])
            if (Math.abs(z-cz)<0.26){ z=cz; break; }
        }
      }
    }
    show=true;
  }
  if (show){
    edit.gx=x; edit.gy=y0; edit.gz=z;
    edit.valid=editValidAt(x,y0,z);
  }
  if (edit.ghost){
    edit.ghost.visible=show;
    if (show){
      edit.ghost.position.set(x, y0+d.h/2, z);
      edit.ghost.material.color.setHex(edit.valid?(snapOn?0x44ff88:0x66ccff):0xff4444);
    }
  }
  const snapEl=$("editSnapState");
  if (snapEl) snapEl.textContent = snapOn? "スナップ ON" : "フリー配置";
}

export function wireMapEditorUI(){
  $("mapImportInput").addEventListener("change",e=>{
    const f=e.target.files[0];
    if (f) importCustomMapFile(f);
    e.target.value="";
  });
}
