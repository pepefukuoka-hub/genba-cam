(function () {
  'use strict';
  const VER = 7;
  const $ = (id) => document.getElementById(id);
  const show = (id) => { document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== id; }); window.scrollTo(0, 0); };
  $('ver').textContent = '版 ' + VER;

  // ---------- 文字列の圧縮と、QRコードへの変換 ----------
  const toB64u = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const fromB64u = (t) => { const b = atob(t.replace(/-/g, '+').replace(/_/g, '/')), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  async function pipe(stream, bytes) {
    const w = stream.writable.getWriter(); w.write(bytes); w.close();
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
  }
  // 先頭の1バイトは、圧縮の有無(0x7a=圧縮、0x72=そのまま)
  async function packBytes(text) {
    const raw = new TextEncoder().encode(text);
    let body, kind;
    if (typeof CompressionStream === 'function') { body = await pipe(new CompressionStream('deflate-raw'), raw); kind = 0x7a; } else { body = raw; kind = 0x72; }
    const out = new Uint8Array(body.length + 1); out[0] = kind; out.set(body, 1); return out;
  }
  async function unpackBytes(u8) {
    const body = u8.subarray(1);
    if (u8[0] === 0x7a) return new TextDecoder().decode(await pipe(new DecompressionStream('deflate-raw'), body));
    if (u8[0] === 0x72) return new TextDecoder().decode(body);
    throw new Error('コードの形式が違います');
  }
  const pack = async (text) => toB64u(await packBytes(text));      // 文字のコード(リンクや貼り付け用)
  const unpack = async (code) => unpackBytes(fromB64u(code));
  const bytesToStr = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; };   // QRに、1文字=1バイトで入れる
  function drawQR(cv, text) {
    let qr = qrcode(0, 'L'); qr.addData(text); qr.make();
    if (qr.getModuleCount() === 109) { qr = qrcode(24, 'L'); qr.addData(text); qr.make(); }   // 読み取り部品が、型番23だけ読めないため、24にする
    const n = qr.getModuleCount(), q = 4, total = n + q * 2, px = Math.max(3, Math.floor(1040 / total));
    cv.width = cv.height = total * px;
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect((c + q) * px, (r + q) * px, px, px);
    return n;
  }
  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); btn.textContent = 'コピーしました'; }
    catch (e) { btn.textContent = 'コピーできませんでした'; }
    setTimeout(() => { btn.textContent = btn.dataset.label; }, 2000);
  }
  ['copyOffer', 'copyAnswer'].forEach((id) => { $(id).dataset.label = $(id).textContent; });

  // QRコードを小さくするため、つなぐのに必須でない行を省く(IPv6やTCPの接続先、使わない拡張項目)。
  // 残すもの: 映像の向き(video-orientation)、帯域の推定(transport-cc)、再送要求(nack / pli)
  function slim(sdp) {
    const dropExt = /^a=extmap:\d+ (?!urn:3gpp:video-orientation|http:\/\/www\.ietf\.org\/id\/draft-holmer-rmcat-transport-wide-cc|urn:ietf:params:rtp-hdrext:sdes:mid)/;
    const dropMisc = /^a=(extmap-allow-mixed|ice-options:|rtcp-rsize|msid-semantic|ssrc:\d+ msid:|rtcp-fb:\d+ (goog-remb|ccm fir))/;
    const lines = sdp.split(/\r?\n/).filter((l) => l);
    const out = lines.filter((l) => {
      if (dropExt.test(l) || dropMisc.test(l)) return false;
      if (l.indexOf('a=candidate:') === 0) { const f = l.split(' '); return f[2].toLowerCase() === 'udp' && f[4].indexOf(':') < 0; }   // UDPのIPv4だけ
      return true;
    });
    // 候補は、先頭の1つだけで足りる(IPv4のUDP)。残りは、重複する
    let seen = false;
    const final = out.filter((l) => { if (l.indexOf('a=candidate:') !== 0) return true; if (seen) return false; seen = true; return true; });
    return final.join('\r\n') + '\r\n';
  }

  // ---------- 返信(見る側 → 映す側)を、小さく送る ----------
  // 返信に本当に要るのは、数値だけ(認証用の名前と合言葉、証明書の指紋、必要なら接続先)。約80バイトで、QRは小さく・読み取りやすくなる。
  // 映す側は、自分が出した元の情報(offer)を土台にして、返信を組み立て直す。
  function answerFields(sdp) {
    const get = (re) => { const m = sdp.match(re); return m ? m[1].trim() : null; };
    const f = { ufrag: get(/^a=ice-ufrag:(.+)$/m), pwd: get(/^a=ice-pwd:(.+)$/m), fp: null, active: get(/^a=setup:(\w+)/m) !== 'passive', ip: null, port: 0 };
    const fp = get(/^a=fingerprint:sha-256 (.+)$/m); if (fp) f.fp = fp.split(':').map((h) => parseInt(h, 16));
    if (!f.ufrag || !f.pwd || !f.fp || f.fp.length !== 32) throw new Error('接続情報を取り出せません');
    for (const l of sdp.split(/\r?\n/)) {   // 接続先は、IPv4(UDP)があれば添える。端末名(mDNS)のときは省く。相手が先に届くので、なくても、つながる
      if (l.indexOf('a=candidate:') !== 0) continue;
      const c = l.split(' ');
      if (c[2].toLowerCase() === 'udp' && /^\d+\.\d+\.\d+\.\d+$/.test(c[4])) { f.ip = c[4].split('.').map(Number); f.port = +c[5]; break; }
    }
    return f;
  }
  function encodeAnswer(f) {
    const e = new TextEncoder(), u = e.encode(f.ufrag), p = e.encode(f.pwd);
    const out = [0x41, 0x32, (f.active ? 1 : 0) | (f.ip ? 2 : 0), u.length].concat(Array.from(u), [p.length], Array.from(p), f.fp);   // 'A' '2' ...
    if (f.ip) out.push(f.ip[0], f.ip[1], f.ip[2], f.ip[3], f.port >> 8, f.port & 255);
    return Uint8Array.from(out);
  }
  function decodeAnswer(b) {   // b は 'A' '2' から始まる
    if (b[0] !== 0x41 || b[1] !== 0x32) throw new Error('形式が違います');
    const flags = b[2], d = new TextDecoder(); let i = 3;
    const ul = b[i++], ufrag = d.decode(b.slice(i, i + ul)); i += ul;
    const pl = b[i++], pwd = d.decode(b.slice(i, i + pl)); i += pl;
    const fp = Array.from(b.slice(i, i + 32)); i += 32;
    const f = { ufrag, pwd, fp, active: !!(flags & 1), ip: null, port: 0 };
    if (flags & 2) { f.ip = [b[i], b[i + 1], b[i + 2], b[i + 3]]; f.port = (b[i + 4] << 8) | b[i + 5]; }
    if (fp.length !== 32 || !ufrag || !pwd) throw new Error('欠けています');
    return f;
  }
  function buildAnswerSdp(offer, f) {   // 自分の offer の VP8 だけを受け入れた、受信専用の返信を組み立てる
    const L = offer.split(/\r?\n/).filter(Boolean), mi = L.findIndex((l) => l.indexOf('m=') === 0), head = L.slice(0, mi), sec = L.slice(mi);
    const pts = new Set(sec.filter((l) => /^a=rtpmap:\d+ VP8\//i.test(l)).map((l) => l.match(/^a=rtpmap:(\d+)/)[1]));
    if (!pts.size) throw new Error('VP8がありません');
    sec.forEach((l) => { const m = l.match(/^a=fmtp:(\d+) apt=(\d+)/); if (m && pts.has(m[2])) pts.add(m[1]); });   // 再送用(rtx)も
    const order = sec[0].split(' ').slice(3).filter((p) => pts.has(p));
    const mid = sec.find((l) => l.indexOf('a=mid:') === 0) || 'a=mid:0';
    const ip = f.ip ? f.ip.join('.') : '0.0.0.0', port = f.ip ? f.port : 9;
    const fp = f.fp.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
    const codec = sec.filter((l) => { const m = l.match(/^a=(rtpmap|fmtp|rtcp-fb):(\d+)/); return m && pts.has(m[2]); });
    return head.filter((l) => /^(v=|o=|s=|t=|a=group:)/.test(l)).concat(
      ['m=video ' + port + ' UDP/TLS/RTP/SAVPF ' + order.join(' '), 'c=IN IP4 ' + ip, 'a=rtcp:9 IN IP4 0.0.0.0'],
      f.ip ? ['a=candidate:1 1 udp 2122194687 ' + ip + ' ' + port + ' typ host generation 0'] : [],
      ['a=ice-ufrag:' + f.ufrag, 'a=ice-pwd:' + f.pwd, 'a=fingerprint:sha-256 ' + fp, 'a=setup:' + (f.active ? 'active' : 'passive'), mid],
      sec.filter((l) => l.indexOf('a=extmap:') === 0), ['a=recvonly', 'a=rtcp-mux'], codec).join('\r\n') + '\r\n';
  }

  // ---------- 接続の共通部分 ----------
  let pc = null, wake = null;
  // 同じWi-Fi(またはテザリング)の中だけでつなぐ。外のサーバーは使わない
  function newPC() { return new RTCPeerConnection({ iceServers: [] }); }
  function gathered(p, ms) {
    return new Promise((res) => {
      if (p.iceGatheringState === 'complete') return res();
      const done = () => { clearTimeout(t); p.removeEventListener('icegatheringstatechange', on); res(); };
      const on = () => { if (p.iceGatheringState === 'complete') done(); };
      const t = setTimeout(done, ms || 3000);
      p.addEventListener('icegatheringstatechange', on);
    });
  }
  async function keepAwake() {   // 映している間、画面が消えないようにする
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && pc && pc.connectionState === 'connected') keepAwake(); });

  // ---------- 映す側 ----------
  let stream = null, facing = 'environment', scanTimer = 0, answered = false, offerSlim = '';
  const sMsg = (t) => { $('sMsg').textContent = t; };
  const cam = (f) => navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: f }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });

  function preferCodecs(p) {   // 形式を VP8 だけにして、QRコードを小さくする(Chrome・Safariの両方で使える)
    try {
      const caps = RTCRtpSender.getCapabilities('video').codecs;
      const vp8 = caps.filter((c) => /video\/VP8$/i.test(c.mimeType)), rtx = caps.filter((c) => /video\/rtx$/i.test(c.mimeType));
      if (vp8.length) p.getTransceivers()[0].setCodecPreferences([].concat(vp8, rtx));
    } catch (e) {}
  }

  async function startSender() {
    show('sender'); $('sState').textContent = '準備しています…'; sMsg('');
    try { stream = await cam(facing); }
    catch (e) { sMsg('カメラが許可されていません。設定 > Safari(またはChrome) > カメラ で許可して、ページを開き直してください。'); return; }
    const v = $('prev'); v.srcObject = stream; v.play().catch(() => {});
    pc = newPC();
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    preferCodecs(pc);
    pc.onconnectionstatechange = onSenderState;
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      offerSlim = slim(pc.localDescription.sdp);
      const code = await pack(offerSlim);
      const url = location.origin + location.pathname + '#o=' + code;
      drawQR($('qrOffer'), url);
      $('copyOffer').onclick = () => copy(url, $('copyOffer'));
      $('sState').textContent = '見る側の、読み取りを待っています';
      scanLoop();
    } catch (e) { sMsg('QRコードを作れませんでした(' + (e && e.message ? e.message : e) + ')'); }
  }

  function scanLoop() {   // 見る側のQRコードを、カメラの映像から探す
    const v = $('prev'), c = document.createElement('canvas'), g = c.getContext('2d', { willReadFrequently: true });
    clearInterval(scanTimer);
    scanTimer = setInterval(() => {
      if (answered || !v.videoWidth) return;
      const sc = Math.min(1, 1280 / v.videoWidth); c.width = Math.round(v.videoWidth * sc); c.height = Math.round(v.videoHeight * sc);
      g.drawImage(v, 0, 0, c.width, c.height);
      const img = g.getImageData(0, 0, c.width, c.height), r = window.jsQR(img.data, c.width, c.height, { inversionAttempts: 'dontInvert' });
      const b = r && r.binaryData;
      if (b && b.length > 40 && b[0] === 0x41 && b[1] === 0x32) acceptBytes(Uint8Array.from(b));
    }, 250);
  }
  const acceptAnswer = (code) => { try { acceptBytes(fromB64u(code.trim())); } catch (e) { sMsg('コードを読み込めませんでした。'); } };   // 貼り付けのコード
  async function acceptBytes(bytes) {
    if (answered) return;
    answered = true; $('sState').textContent = 'つないでいます…'; sMsg('');
    try { await pc.setRemoteDescription({ type: 'answer', sdp: buildAnswerSdp(offerSlim, decodeAnswer(bytes)) }); }
    catch (e) { answered = false; $('sState').textContent = '読み取りを待っています'; sMsg('コードを読み込めませんでした。もう一度、読み取らせてください。'); }
  }
  $('usePaste').onclick = () => { const t = $('pasteAnswer').value.trim(); if (t) acceptAnswer(t.indexOf('A2.') === 0 ? t.slice(3) : t); };

  async function onSenderState() {
    const s = pc.connectionState;
    if (s === 'connected') {
      clearInterval(scanTimer);
      $('sPair').hidden = true; $('sLive').hidden = false; $('sState').textContent = '映しています'; sMsg('');
      keepAwake();
      try {   // 上限を決めて、電波が弱いときも粘る
        const sender = pc.getSenders()[0], p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = 3000000; await sender.setParameters(p);
      } catch (e) {}
    } else if (s === 'disconnected') { $('sState').textContent = '切れかけています…'; }
    else if (s === 'failed' || s === 'closed') {
      $('sState').textContent = 'つながりませんでした'; sMsg('同じWi-Fi(またはテザリング)につながっているか、確認してください。「戻る」から、もう一度つなぎ直せます。');
    }
  }
  $('flip').onclick = async () => {   // 前面・背面カメラの切り替え
    try {
      facing = facing === 'environment' ? 'user' : 'environment';
      const ns = await cam(facing), nt = ns.getVideoTracks()[0];
      await pc.getSenders()[0].replaceTrack(nt);
      stream.getTracks().forEach((t) => t.stop()); stream = ns; $('prev').srcObject = ns;
    } catch (e) { sMsg('カメラを切り替えられませんでした。'); }
  };

  // ---------- 見る側 ----------
  const vMsg = (t) => { $('vMsg').textContent = t; };
  let statTimer = 0;
  async function startViewer(offerCode) {
    show('viewer');
    if (!offerCode) { $('vState').textContent = '待っています'; return; }
    $('vWait').hidden = true; $('vPaste').hidden = true; $('vState').textContent = '接続の準備をしています…'; vMsg('');
    try {
      pc = newPC();
      pc.ontrack = (e) => { const v = $('remote'); v.srcObject = e.streams[0] || new MediaStream([e.track]); v.play().catch(() => {}); };
      pc.onconnectionstatechange = onViewerState;
      await pc.setRemoteDescription({ type: 'offer', sdp: await unpack(offerCode.trim()) });
      try {   // 受け取る形式は VP8 だけにする(返信を小さくするため)
        const rc = RTCRtpReceiver.getCapabilities('video').codecs;
        pc.getTransceivers()[0].setCodecPreferences(rc.filter((c) => /video\/VP8$/i.test(c.mimeType)).concat(rc.filter((c) => /video\/rtx$/i.test(c.mimeType))));
      } catch (e) {}
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      const bytes = encodeAnswer(answerFields(pc.localDescription.sdp));
      drawQR($('qrAnswer'), bytesToStr(bytes));   // 読み取りやすいよう、文字ではなくバイナリで入れる
      const code = 'A2.' + toB64u(bytes);
      $('copyAnswer').onclick = () => copy(code, $('copyAnswer'));
      $('vAnswer').hidden = false; $('vState').textContent = '映す側の、読み取りを待っています';
    } catch (e) { $('vState').textContent = '失敗しました'; vMsg('コードを読み込めませんでした。映す側のQRコードを、もう一度、読み取ってください。'); }
  }
  function onViewerState() {
    const s = pc.connectionState;
    if (s === 'connected') {
      $('vPair').hidden = true; $('vLive').hidden = false; $('vState').textContent = '見ています'; vMsg(''); keepAwake();
      clearInterval(statTimer); let last = null;
      statTimer = setInterval(async () => {
        try {
          const rep = await pc.getStats(); let t = null;
          rep.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') t = r; });
          if (!t) return;
          const now = performance.now(), mbps = last ? ((t.bytesReceived - last.b) * 8 / ((now - last.t) / 1000) / 1e6) : 0;
          last = { b: t.bytesReceived, t: now };
          $('stats').textContent = (t.frameWidth ? t.frameWidth + '×' + t.frameHeight + ' / ' : '') + Math.round(t.framesPerSecond || 0) + ' fps / ' + mbps.toFixed(1) + ' Mbps';
        } catch (e) {}
      }, 1000);
    } else if (s === 'disconnected') { $('vState').textContent = '切れかけています…'; }
    else if (s === 'failed' || s === 'closed') { $('vState').textContent = 'つながりませんでした'; vMsg('同じWi-Fi(またはテザリング)につながっているか、確認してください。「戻る」から、もう一度つなぎ直せます。'); }
  }
  $('full').onclick = () => { const v = $('remote'), f = v.requestFullscreen || v.webkitRequestFullscreen || v.webkitEnterFullscreen; if (f) try { f.call(v); } catch (e) {} };
  $('useOffer').onclick = () => {
    const t = $('pasteOffer').value.trim(), m = t.match(/#o=([A-Za-z0-9_-]+)/);
    startViewer(m ? m[1] : t);
  };

  // ---------- 入口 ----------
  $('goSender').onclick = startSender;
  $('goViewer').onclick = () => startViewer('');
  const back = () => { location.href = location.pathname; };
  $('sBack').onclick = back; $('vBack').onclick = back;

  const m = location.hash.match(/^#o=([A-Za-z0-9_-]+)$/);
  if (m) { history.replaceState(null, '', location.pathname); startViewer(m[1]); }   // QRコードから開いたときは、そのまま見る側へ

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
