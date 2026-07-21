/* ============================================================
   AIRSOFT FPS - 静的ファイル配信サーバー
   オンラインPVPはPeerJS(WebRTC)によるサーバーレスP2P方式のため、
   このサーバーはindex.html/JS/CSS/アセットの配信のみを行う
   （シグナリングはPeerJSの無料クラウドサーバーが担当し、対戦中の
   通信はブラウザ同士が直接WebRTCで行うためサーバーは一切介在しない）。
   ============================================================ */
const express = require("express");

const PORT = process.env.PORT || 8377;

const app = express();
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`AIRSOFT FPS server listening on http://localhost:${PORT}`);
});
