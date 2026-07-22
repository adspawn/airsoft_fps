/* ============================================================
   スマホ / タッチ端末向け操作（ポインタロック非対応の代替）
   ============================================================ */
import { RT, keys, clearKeys, renderer, $, S, player, weapon } from "./state.js";
import { currentWeapon } from "./gun.js";
import { sndClick } from "./sound.js";

let touchDevice = false;
const stick = { active:false, touchId:null, dx:0, dy:0 };
let lookId = null, lookLastX = 0, lookLastY = 0;

export function isTouchDevice(){ return touchDevice; }

export function detectTouchDevice(){
  touchDevice = window.matchMedia("(pointer: coarse)").matches
    || (navigator.maxTouchPoints > 0 && Math.min(window.screen.width, window.screen.height) <= 900);
  document.body.classList.toggle("touch-device", touchDevice);
  return touchDevice;
}

export function initTouchMenuHints(){
  if (!touchDevice) return;
  $("startBtn").textContent = "タップして開始";
  const help = $("mobileHelp");
  if (help) help.style.display = "block";
  const editBtn = $("modeEdit");
  if (editBtn){
    editBtn.classList.add("soon");
    editBtn.disabled = true;
    editBtn.title = "スマホでは未対応";
    if (S.mode === "edit"){
      $("modeRange").click();
    }
  }
  $("controls").style.display = "none";
}

function syncStickKeys(){
  keys["KeyW"] = stick.dy < -0.22;
  keys["KeyS"] = stick.dy > 0.22;
  keys["KeyA"] = stick.dx < -0.22;
  keys["KeyD"] = stick.dx > 0.22;
  keys["ShiftLeft"] = stick.dy < -0.55 && Math.hypot(stick.dx, stick.dy) > 0.45;
}

function resetStick(){
  stick.active = false;
  stick.touchId = null;
  stick.dx = 0;
  stick.dy = 0;
  const knob = $("mobStickKnob");
  if (knob) knob.style.transform = "translate(-50%,-50%)";
  syncStickKeys();
}

export function setPlayLocked(locked){
  RT.locked = locked;
  RT.touchPlay = locked && touchDevice;
  document.body.classList.toggle("locked", locked);
  document.body.classList.toggle("touch-play", RT.touchPlay);
  if (!locked){
    clearKeys();
    RT.firing = false;
    RT.ads = false;
    lookId = null;
    resetStick();
  }
}

export function requestPlayLock(){
  if (touchDevice) setPlayLocked(true);
  else renderer.domElement.requestPointerLock();
}

function applyLookDelta(dx, dy){
  const s = 0.0034 * S.sens * (RT.ads ? 0.65 : 1);
  player.yaw   -= dx * s;
  player.pitch -= dy * s;
  player.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, player.pitch));
}

function toggleFireMode(){
  const modes = currentWeapon().modes;
  if (modes.length <= 1){ sndClick(240, .12); return; }
  weapon.mode = weapon.mode === "SEMI" ? "FULL" : "SEMI";
  $("fireMode").textContent = weapon.mode === "SEMI" ? "SEMI" : "FULL AUTO";
  sndClick(500, .2);
}

export function wireMobileControls({ startReload, tryShoot, pauseToMenu }){
  if (!touchDevice) return;

  const stickBase = $("mobStickBase");
  const stickKnob = $("mobStickKnob");
  const lookZone = $("touchLookZone");
  const maxR = 52;

  function moveStick(clientX, clientY){
    const r = stickBase.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let dx = clientX - cx, dy = clientY - cy;
    const len = Math.hypot(dx, dy) || 1;
    if (len > maxR){ dx = dx / len * maxR; dy = dy / len * maxR; }
    stick.dx = dx / maxR;
    stick.dy = dy / maxR;
    stickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    syncStickKeys();
  }

  stickBase.addEventListener("touchstart", e=>{
    if (!RT.touchPlay) return;
    e.preventDefault();
    const t = e.changedTouches[0];
    stick.active = true;
    stick.touchId = t.identifier;
    moveStick(t.clientX, t.clientY);
  }, { passive:false });

  stickBase.addEventListener("touchmove", e=>{
    if (!stick.active) return;
    e.preventDefault();
    for (const t of e.changedTouches){
      if (t.identifier === stick.touchId){
        moveStick(t.clientX, t.clientY);
        break;
      }
    }
  }, { passive:false });

  function endStick(e){
    for (const t of e.changedTouches){
      if (t.identifier === stick.touchId){ resetStick(); break; }
    }
  }
  stickBase.addEventListener("touchend", endStick);
  stickBase.addEventListener("touchcancel", endStick);

  lookZone.addEventListener("touchstart", e=>{
    if (!RT.touchPlay || S.mode === "edit") return;
    for (const t of e.changedTouches){
      if (lookId === null){
        lookId = t.identifier;
        lookLastX = t.clientX;
        lookLastY = t.clientY;
        break;
      }
    }
  }, { passive:true });

  lookZone.addEventListener("touchmove", e=>{
    if (lookId === null) return;
    for (const t of e.changedTouches){
      if (t.identifier === lookId){
        applyLookDelta(t.clientX - lookLastX, t.clientY - lookLastY);
        lookLastX = t.clientX;
        lookLastY = t.clientY;
        e.preventDefault();
        break;
      }
    }
  }, { passive:false });

  function endLook(e){
    for (const t of e.changedTouches){
      if (t.identifier === lookId) lookId = null;
    }
  }
  lookZone.addEventListener("touchend", endLook);
  lookZone.addEventListener("touchcancel", endLook);

  function bindHoldBtn(id, on, off){
    const el = $(id);
    if (!el) return;
    el.addEventListener("touchstart", e=>{
      if (!RT.touchPlay) return;
      e.preventDefault();
      on();
    }, { passive:false });
    el.addEventListener("touchend", e=>{ e.preventDefault(); off(); });
    el.addEventListener("touchcancel", ()=> off());
  }

  bindHoldBtn("mobFire", ()=>{
    RT.firing = true;
    if (weapon.mode === "SEMI") tryShoot();
  }, ()=>{ RT.firing = false; });

  bindHoldBtn("mobAds", ()=>{ RT.ads = true; }, ()=>{ RT.ads = false; });

  $("mobJump").addEventListener("touchstart", e=>{
    if (!RT.touchPlay) return;
    e.preventDefault();
    keys["Space"] = true;
  }, { passive:false });
  $("mobJump").addEventListener("touchend", ()=>{ keys["Space"] = false; });
  $("mobJump").addEventListener("touchcancel", ()=>{ keys["Space"] = false; });

  $("mobCrouch").addEventListener("click", ()=>{
    if (!RT.touchPlay) return;
    player.crouchToggle = !player.crouchToggle;
    sndClick(360, .15);
  });

  $("mobReload").addEventListener("click", ()=>{
    if (!RT.touchPlay) return;
    startReload();
  });

  $("mobMode").addEventListener("click", ()=>{
    if (!RT.touchPlay) return;
    toggleFireMode();
  });

  $("mobPause").addEventListener("click", ()=>{
    if (!RT.touchPlay) return;
    pauseToMenu();
  });

  /* タッチ後に合成 mouse イベントで二重発射しない */
  let lastTouch = 0;
  document.addEventListener("touchstart", ()=>{ lastTouch = performance.now(); }, { capture:true, passive:true });
  document.addEventListener("mousedown", e=>{
    if (RT.touchPlay && performance.now() - lastTouch < 700) e.stopPropagation();
  }, true);
}
