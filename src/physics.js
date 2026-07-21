/* ============================================================
   物理モデル（adspawn/bb-ballistics より移植・3D拡張）
   m r'' = -mg e_z - ½Cd ρπR² v·v + Cl(4/3)πR³·2ρ (ω × v)
   I ω'  = -½Cf ρR²(8πR²/3)·√(v² + (cRω)²)·ω
   ============================================================ */
export const ENV = { rho:1.205, eta:1.822e-5, g:9.80665, d:5.95e-3, Cl:0.12, c:0.5, snd:343 };
ENV.R = ENV.d/2;
ENV.A = Math.PI*ENV.R*ENV.R;
export const KMAG = ENV.Cl*(4/3)*Math.PI*ENV.R**3*2*ENV.rho;   // マグヌス係数
export const SPIN_FRIC = 0.5*(ENV.rho*ENV.R*ENV.R)*(8*Math.PI*ENV.R*ENV.R/3);

export function cdMorrison(v){
  const Re = ENV.rho*v*ENV.d/ENV.eta;
  return 24/Re
    + 2.6*(Re/5)/(1+Math.pow(Re/5,1.52))
    + 0.411*Math.pow(Re/263000,-7.94)/(1+Math.pow(Re/263000,-8.0))
    + Math.pow(Re,0.80)/461000;
}
export function cdLoth(v){
  const Re = ENV.rho*v*ENV.d/ENV.eta, Ma = v/ENV.snd;
  const CM = Ma<1.5 ? 1.65+0.65*Math.tanh(4*Ma-3.4) : 2.18-0.13*Math.tanh(0.9*Ma-2.7);
  const GM = Ma<0.8 ? 166*Ma**3+3.29*Ma*Ma-10.9*Ma+20 : 5+40*Math.pow(Ma,-3);
  const HM = Ma<1 ? 0.0239*Ma**3+0.212*Ma*Ma-0.074*Ma+1 : 0.93+1/(3.5+Ma**5);
  return 24/Re*(1+0.15*Math.pow(Re,0.687))*HM
    + 0.42*CM/(1 + 42500/Math.pow(Re,1.16*CM) + GM/Math.sqrt(Re));
}

/* 2D参照シミュレーション（ゼロイン距離・適正ホップ算出用、リポジトリと同一式） */
export function simulate2D(o){
  const m = o.massG*1e-3;
  const I = 0.4*m*ENV.R*ENV.R;
  const cdf = o.drag==="loth" ? cdLoth : cdMorrison;
  let x=0, z=o.h0, vx=o.v0, vz=0;
  let w = 2*Math.PI*o.spinRps, t=0;
  const dt = 5e-4;
  let maxRise=0, zeroIn=null, prevX=0, prevZ=z;
  while (z>0 && t<12 && x<400){
    const v = Math.hypot(vx,vz);
    const Fd = 0.5*cdf(v)*ENV.rho*ENV.A*v;
    const ax = (-Fd*vx - KMAG*vz*w)/m;
    const az = -ENV.g + (-Fd*vz + KMAG*vx*w)/m;
    const Re = ENV.rho*v*ENV.d/ENV.eta;
    const Cf = 1.328/Math.sqrt(Re);
    const dw = -SPIN_FRIC*Cf*Math.sqrt(v*v+(ENV.c*ENV.R*w)**2)*w/I;
    prevX=x; prevZ=z;
    vx+=ax*dt; vz+=az*dt; x+=vx*dt; z+=vz*dt; w=Math.max(0,w+dw*dt); t+=dt;
    const rise = z-o.h0;
    if (rise>maxRise) maxRise=rise;
    if (zeroIn===null && x>0.5 && (prevZ-o.h0)>0 && rise<=0){
      const f=(prevZ-o.h0)/((prevZ-o.h0)-rise);
      zeroIn = prevX+f*(x-prevX);
    }
  }
  let landX=x;
  if (z<=0 && prevZ>0) landX = prevX + prevZ/(prevZ-z)*(x-prevX);
  return { landX, zeroIn, maxRise };
}
/* 適正ホップ: 射線から5mm以上浮き上がらない最大回転数（二分探索） */
export function solveOptimalSpin(o){
  let lo=0, hi=800;
  for(let i=0;i<20;i++){
    const mid=(lo+hi)/2;
    if (simulate2D({...o, spinRps:mid}).maxRise > 0.005) hi=mid; else lo=mid;
  }
  return lo;
}
