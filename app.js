(function () {
  'use strict';
  const VER = 14;
  const $ = (id) => document.getElementById(id);
  const errText = (e) => (e && (e.name || e.message)) ? (String(e.name || '') + (e.message ? ': ' + String(e.message).slice(0, 100) : '')) : '不明';
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
      if (l.indexOf('a=candidate:') === 0) { const f = l.split(' '); return f[2].toLowerCase() === 'udp' && (f[4].indexOf(':') < 0 || /^[23][0-9a-f]{3}:/i.test(f[4])); }   // UDPの、IPv4と、グローバルIPv6だけ
      return true;
    });
    // 接続先は、IPv4を最大4つと、IPv6を最大2つ残す。IPv6は、モバイル回線どうしでも、直接つながる可能性がある。テザリングの親機は、回線用と子機向けなど、複数の住所を持つため、1つに絞ると、届かない住所を選ぶことがある
    let n4 = 0, n6 = 0;
    const final = out.filter((l) => { if (l.indexOf('a=candidate:') !== 0) return true; return l.split(' ')[4].indexOf(':') < 0 ? ++n4 <= 4 : ++n6 <= 2; });
    return final.join('\r\n') + '\r\n';
  }

  // ---------- 住所(IPv4 と IPv6) ----------
  function ip6ToBytes(s) {
    const parts = s.split('%')[0].split('::'), hs = parts[0] ? parts[0].split(':') : [], ts = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
    const fill = parts.length > 1 ? 8 - hs.length - ts.length : 0, w = hs.concat(Array(Math.max(fill, 0)).fill('0'), ts);
    if (w.length !== 8) throw new Error('IPv6の形式');
    const out = []; w.forEach((x) => { const n = parseInt(x || '0', 16); out.push(n >> 8, n & 255); }); return out;
  }
  function bytesToIp6(b) { const w = []; for (let i = 0; i < 16; i += 2) w.push(((b[i] << 8) | b[i + 1]).toString(16)); return w.join(':'); }
  const ipStr = (x) => x.v6 ? bytesToIp6(x.ip) : x.ip.join('.');
  const putAddr = (out, x) => { out.push(x.v6 ? 6 : 4); x.ip.forEach((n) => out.push(n)); out.push(x.port >> 8, x.port & 255); };
  function readAddrs(b, i) {   // 個数 + 各住所。{addrs, 次の位置}
    const n = b[i++], addrs = [];
    for (let k = 0; k < n; k++) { const v6 = b[i++] === 6, len = v6 ? 16 : 4; addrs.push({ v6, ip: Array.from(b.slice(i, i + len)), port: (b[i + len] << 8) | b[i + len + 1] }); i += len + 2; }
    return { addrs, i };
  }
  const candLine = (x, k) => 'a=candidate:' + (k + 1) + ' 1 udp ' + (2122194687 - k * 256) + ' ' + ipStr(x) + ' ' + x.port + ' typ host generation 0';

  // ---------- 返信(見る側 → 映す側)を、小さく送る ----------
  // 返信に本当に要るのは、数値だけ(認証用の名前と合言葉、証明書の指紋、必要なら接続先)。約80バイトで、QRは小さく・読み取りやすくなる。
  // 映す側は、自分が出した元の情報(offer)を土台にして、返信を組み立て直す。
  function answerFields(sdp) {
    const get = (re) => { const m = sdp.match(re); return m ? m[1].trim() : null; };
    const f = { ufrag: get(/^a=ice-ufrag:(.+)$/m), pwd: get(/^a=ice-pwd:(.+)$/m), fp: null, active: get(/^a=setup:(\w+)/m) !== 'passive', addrs: [] };
    const fp = get(/^a=fingerprint:sha-256 (.+)$/m); if (fp) f.fp = fp.split(':').map((h) => parseInt(h, 16));
    if (!f.ufrag || !f.pwd || !f.fp || f.fp.length !== 32) throw new Error('接続情報を取り出せません');
    const v4 = [], v6 = [];   // 接続先は、IPv4(最大4つ)と、グローバルIPv6(最大2つ)。端末名(mDNS)は省く。相手が先に届くので、なくても、つながることがある
    for (const l of sdp.split(/\r?\n/)) {
      if (l.indexOf('a=candidate:') !== 0) continue;
      const c = l.split(' ');
      if (c[2].toLowerCase() !== 'udp') continue;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(c[4])) { if (v4.length < 4) v4.push({ v6: false, ip: c[4].split('.').map(Number), port: +c[5] }); }
      else if (/^[23][0-9a-f]{3}:/i.test(c[4])) { if (v6.length < 2) { try { v6.push({ v6: true, ip: ip6ToBytes(c[4]), port: +c[5] }); } catch (e) {} } }
    }
    f.addrs = v4.concat(v6);
    return f;
  }
  function encodeAnswer(f) {
    const e = new TextEncoder(), u = e.encode(f.ufrag), p = e.encode(f.pwd);
    const out = [0x41, 0x34, (f.active ? 1 : 0), u.length].concat(Array.from(u), [p.length], Array.from(p), f.fp, [f.addrs.length]);   // 'A' '4' ...
    f.addrs.forEach((x) => putAddr(out, x));
    return Uint8Array.from(out);
  }
  function decodeAnswer(b) {   // b は 'A' '2' から始まる
    if (b[0] !== 0x41 || b[1] !== 0x34) throw new Error('形式が違います(版がそろっていない可能性。両方のスマホで、ページを開き直してください)');
    const flags = b[2], d = new TextDecoder(); let i = 3;
    const ul = b[i++], ufrag = d.decode(b.slice(i, i + ul)); i += ul;
    const pl = b[i++], pwd = d.decode(b.slice(i, i + pl)); i += pl;
    const fp = Array.from(b.slice(i, i + 32)); i += 32;
    const f = { ufrag, pwd, fp, active: !!(flags & 1), addrs: readAddrs(b, i).addrs };
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
    const first = f.addrs[0], ip = first ? ipStr(first) : '0.0.0.0', port = first ? first.port : 9, fam = first && first.v6 ? '6' : '4';
    const fp = f.fp.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
    const codec = sec.filter((l) => { const m = l.match(/^a=(rtpmap|fmtp|rtcp-fb):(\d+)/); return m && pts.has(m[2]); });
    return head.filter((l) => /^(v=|o=|s=|t=|a=group:)/.test(l)).concat(
      ['m=video ' + port + ' UDP/TLS/RTP/SAVPF ' + order.join(' '), 'c=IN IP' + fam + ' ' + ip, 'a=rtcp:9 IN IP4 0.0.0.0'],
      f.addrs.map(candLine),
      ['a=ice-ufrag:' + f.ufrag, 'a=ice-pwd:' + f.pwd, 'a=fingerprint:sha-256 ' + fp, 'a=setup:' + (f.active ? 'active' : 'passive'), mid],
      sec.filter((l) => /^a=extmap:\d+ (urn:3gpp:video-orientation|http:\/\/www\.ietf\.org\/id\/draft-holmer-rmcat-transport-wide-cc|urn:ietf:params:rtp-hdrext:sdes:mid)/.test(l)), ['a=recvonly', 'a=rtcp-mux'], codec).join('\r\n') + '\r\n';
  }

  // ---------- 最初の接続情報(映す側 → 見る側)も、小さな形式にする ----------
  const ru32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const rd32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  function offerFields(sdp) {   // 自分の offer から、組み立てに必要な数値だけを取り出す。取り出せなければ、例外(→ 長い形式に切り替え)
    const get = (re) => { const m = sdp.match(re); return m ? m[1].trim() : null; };
    const vp8 = get(/^a=rtpmap:(\d+) VP8\//im); if (!vp8) throw new Error('VP8なし');
    const rtx = get(new RegExp('^a=fmtp:(\\d+) apt=' + vp8 + '\\s*$', 'm'));
    const fbs = []; sdp.split(/\r?\n/).forEach((l) => { const m = l.match(new RegExp('^a=rtcp-fb:' + vp8 + ' (.+)$')); if (m) fbs.push(m[1].trim()); });
    const ext = (needle) => { const m = sdp.split(/\r?\n/).map((l) => l.match(/^a=extmap:(\d+)(?:\/\w+)? (\S+)/)).find((x) => x && x[2].indexOf(needle) >= 0); return m ? +m[1] : 0; };
    const g = sdp.match(/^a=ssrc-group:FID (\d+) (\d+)/m), one = sdp.match(/^a=ssrc:(\d+) /m);
    if (!g && !one) throw new Error('ssrcなし');
    const f = answerFields(sdp);   // ufrag / pwd / fp / ip / port(同じ取り出し方)
    if (!f.addrs.length) throw new Error('接続先なし');
    return { vp8: +vp8, rtx: rtx ? +rtx : 0, nack: fbs.indexOf('nack') >= 0, pli: fbs.indexOf('nack pli') >= 0, tcc: fbs.indexOf('transport-cc') >= 0,
      vo: ext('video-orientation'), tccExt: ext('transport-wide-cc'), midExt: ext('sdes:mid'), ssrc1: g ? +g[1] : +one[1], ssrc2: g ? +g[2] : 0,
      mid: get(/^a=mid:(.+)$/m) || '0', ufrag: f.ufrag, pwd: f.pwd, fp: f.fp, addrs: f.addrs };
  }
  function encodeOffer(f) {
    const e = new TextEncoder(), m = e.encode(f.mid), u = e.encode(f.ufrag), p = e.encode(f.pwd);
    const flags = (f.rtx ? 1 : 0) | (f.nack ? 2 : 0) | (f.pli ? 4 : 0) | (f.tcc ? 8 : 0);
    const out = [0x4f, 0x34, flags, f.vp8, f.rtx, f.vo, f.tccExt, f.midExt].concat(ru32(f.ssrc1), ru32(f.ssrc2), [m.length], Array.from(m), [u.length], Array.from(u), [p.length], Array.from(p), f.fp, [f.addrs.length]);
    f.addrs.forEach((x) => putAddr(out, x));
    return Uint8Array.from(out);
  }
  function decodeOffer(b) {
    if (b[0] !== 0x4f || b[1] !== 0x34) throw new Error('形式が違います(版がそろっていない可能性。両方のスマホで、ページを開き直してください)');
    const d = new TextDecoder(), flags = b[2], f = { vp8: b[3], rtx: b[4], vo: b[5], tccExt: b[6], midExt: b[7], nack: !!(flags & 2), pli: !!(flags & 4), tcc: !!(flags & 8) };
    f.ssrc1 = rd32(b, 8); f.ssrc2 = rd32(b, 12); let i = 16;
    const ml = b[i++]; f.mid = d.decode(b.slice(i, i + ml)); i += ml;
    const ul = b[i++]; f.ufrag = d.decode(b.slice(i, i + ul)); i += ul;
    const pl = b[i++]; f.pwd = d.decode(b.slice(i, i + pl)); i += pl;
    f.fp = Array.from(b.slice(i, i + 32)); i += 32; f.addrs = readAddrs(b, i).addrs;
    if (f.fp.length !== 32 || !f.ufrag || !f.pwd || !f.addrs.length) throw new Error('欠けています');
    return f;
  }
  function buildOfferSdp(f) {   // 受け取った数値から、映像を送るだけの offer を組み立てる
    const ip = ipStr(f.addrs[0]), fam = f.addrs[0].v6 ? '6' : '4', port0 = f.addrs[0].port, fp = f.fp.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
    const pts = [f.vp8].concat(f.rtx ? [f.rtx] : []);
    const L = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE ' + f.mid,
      'm=video ' + port0 + ' UDP/TLS/RTP/SAVPF ' + pts.join(' '), 'c=IN IP' + fam + ' ' + ip, 'a=rtcp:9 IN IP4 0.0.0.0']
      .concat(f.addrs.map(candLine),
      ['a=ice-ufrag:' + f.ufrag, 'a=ice-pwd:' + f.pwd, 'a=fingerprint:sha-256 ' + fp, 'a=setup:actpass', 'a=mid:' + f.mid]);
    if (f.vo) L.push('a=extmap:' + f.vo + ' urn:3gpp:video-orientation');
    if (f.tccExt) L.push('a=extmap:' + f.tccExt + ' http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01');
    if (f.midExt) L.push('a=extmap:' + f.midExt + ' urn:ietf:params:rtp-hdrext:sdes:mid');
    L.push('a=sendonly', 'a=msid:g t', 'a=rtcp-mux', 'a=rtpmap:' + f.vp8 + ' VP8/90000');
    if (f.tcc) L.push('a=rtcp-fb:' + f.vp8 + ' transport-cc');
    if (f.nack) L.push('a=rtcp-fb:' + f.vp8 + ' nack');
    if (f.pli) L.push('a=rtcp-fb:' + f.vp8 + ' nack pli');
    if (f.rtx) L.push('a=rtpmap:' + f.rtx + ' rtx/90000', 'a=fmtp:' + f.rtx + ' apt=' + f.vp8);
    if (f.rtx && f.ssrc2) L.push('a=ssrc-group:FID ' + f.ssrc1 + ' ' + f.ssrc2);
    L.push('a=ssrc:' + f.ssrc1 + ' cname:g'); if (f.rtx && f.ssrc2) L.push('a=ssrc:' + f.ssrc2 + ' cname:g');
    return L.join('\r\n') + '\r\n';
  }
  // 見る側の入口: {kind:'o4', code} は小さな形式、{kind:'o', code} は長い形式(予備)
  async function offerSdpFrom(spec) { return spec.kind === 'o4' ? buildOfferSdp(decodeOffer(fromB64u(spec.code))) : unpack(spec.code); }
  function parseOfferText(t) {   // リンク・コード・QRの文字から、取り出す
    const m2 = t.match(/#?o4=([A-Za-z0-9_-]+)/), m1 = t.match(/#?o=([A-Za-z0-9_-]+)/);
    if (m2) return { kind: 'o4', code: m2[1] };
    if (m1) return { kind: 'o', code: m1[1] };
    return /^[A-Za-z0-9_-]+$/.test(t.trim()) ? { kind: 'o', code: t.trim() } : null;
  }

  // ---------- つながっている経路(通信料がかかるか) ----------
  // 同じネットワークの中(プライベートな住所どうし、または、同じIPv6の範囲)なら、モバイル回線は通らない
  const sdpCands = (sdp) => (sdp || '').split(/\r?\n/).filter((l) => l.indexOf('a=candidate:') === 0).map((l) => { const c = l.split(' '); return { ip: c[4], port: +c[5] }; });
  const priv4 = (ip) => { const m = ip.match(/^(\d+)\.(\d+)\./); if (!m) return false; const x = +m[1], y = +m[2]; return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254); };
  async function pathInfo(p) {
    try {
      const rep = await p.getStats(), byId = {}; let sel = null;
      rep.forEach((r) => { byId[r.id] = r; });
      rep.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) sel = byId[r.selectedCandidatePairId]; });
      if (!sel) rep.forEach((r) => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) sel = r; });
      if (!sel) return null;
      const lc = byId[sel.localCandidateId], rc = byId[sel.remoteCandidateId];
      if (!lc || !rc) return null;
      const L = sdpCands(p.localDescription && p.localDescription.sdp), R = sdpCands(p.remoteDescription && p.remoteDescription.sdp);
      const la = lc.address || lc.ip || (L.find((x) => x.port === lc.port) || {}).ip || '', ra = rc.address || rc.ip || (R.find((x) => x.port === rc.port) || {}).ip || '';
      if (lc.networkType === 'cellular' || rc.networkType === 'cellular') return { local: false, text: 'モバイル回線を通っています(通信料がかかります)' };
      if (priv4(la) && priv4(ra)) return { local: true, text: '同じWi-Fi(テザリング)の中を、直接通っています(通信料はかかりません)' };
      if (la.indexOf(':') >= 0 && ra.indexOf(':') >= 0 && la.split(':').slice(0, 4).join(':') === ra.split(':').slice(0, 4).join(':')) return { local: true, text: '同じネットワークの中を、直接通っています(通信料はかかりません)' };
      if (la.indexOf(':') >= 0 || ra.indexOf(':') >= 0) return { local: false, text: 'IPv6で、ネットワークの外を通っています(どちらかがモバイル回線なら、通信料がかかります)' };
      return { local: false, text: 'ネットワークの外を通っています(通信料がかかる可能性があります)' };
    } catch (e) { return null; }
  }
  function showPath(p, el) {
    pathInfo(p).then((r) => { if (!r) return; el.textContent = '経路: ' + r.text; el.style.color = r.local ? 'var(--accent)' : '#e5484d'; });
  }

  // ---------- 接続の詳しい報告 ----------
  // つながらないとき、どの住所を持ち、どの組み合わせを試し、どうなったかを、画面に出す(原因を絞るため)
  async function netReport(p) {
    const rep = await p.getStats(), ids = {}, cands = [], pairs = [];
    rep.forEach((r) => {
      if (r.type === 'local-candidate' || r.type === 'remote-candidate') {
        const addr = (r.address || r.ip || '?') + ':' + r.port; ids[r.id] = addr;
        cands.push((r.type === 'local-candidate' ? '自分 ' : '相手 ') + addr + ' ' + (r.candidateType || '') + ' ' + (r.protocol || '') + (r.networkType ? ' ' + r.networkType : ''));
      }
    });
    rep.forEach((r) => { if (r.type === 'candidate-pair') pairs.push((ids[r.localCandidateId] || '?') + ' → ' + (ids[r.remoteCandidateId] || '?') + ' ' + r.state + (r.nominated ? ' ★' : '') + ' 送' + (r.requestsSent || 0) + '/返' + (r.responsesReceived || 0)); });
    return ['接続の状態: ' + p.connectionState + ' / ICE ' + p.iceConnectionState + ' / 住所の収集 ' + p.iceGatheringState].concat(cands.length ? cands : ['(住所の情報がありません)'], pairs.length ? ['試した組み合わせ:'].concat(pairs) : ['試した組み合わせ: なし']).join('\n');
  }
  // 12秒たってもつながらないとき、報告を出す
  function watchConnect(p, box) {
    setTimeout(async () => {
      if (!p || p.connectionState === 'connected' || p.connectionState === 'closed') return;
      try { box.hidden = false; box.textContent = await netReport(p); } catch (e) {}
    }, 12000);
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
  // カメラは、条件をゆるめながら順に試す。端末によっては、細かい指定で失敗するため
  async function cam(f) {
    const tries = [
      { facingMode: { ideal: f }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      { facingMode: { ideal: f } },
      true
    ];
    let last = null;
    for (const v of tries) {
      try { return await navigator.mediaDevices.getUserMedia({ audio: false, video: v }); } catch (e) { last = e; if (e && (e.name === 'NotAllowedError' || e.name === 'NotReadableError' || e.name === 'SecurityError')) break; }
    }
    throw last;
  }

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
    catch (e) { $('sState').textContent = 'カメラを開けません'; sMsg('カメラを開けませんでした(' + errText(e) + ')。設定でカメラを許可し、ほかのタブやアプリ(「にぎにぎ」など)がカメラを使っていないか確認してください。LINEなどの中のブラウザでは開けないので、SafariかChromeで開いてください。'); return; }
    const v = $('prev'); v.srcObject = stream; v.play().catch(() => {});
    pc = newPC();
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    preferCodecs(pc);
    pc.onconnectionstatechange = onSenderState;
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      offerSlim = slim(pc.localDescription.sdp);
      let tail;
      try { tail = '#o4=' + toB64u(encodeOffer(offerFields(offerSlim))); }   // 小さな形式(QRが小さく、読み取りやすい)
      catch (e) { tail = '#o=' + await pack(offerSlim); }                     // 取り出せない端末は、長い形式
      const url = location.origin + location.pathname + tail;
      drawQR($('qrOffer'), url);
      $('copyOffer').onclick = () => copy(url, $('copyOffer'));
      $('sState').textContent = '見る側の、読み取りを待っています';
      scanLoop();
    } catch (e) { $('sState').textContent = '失敗しました'; sMsg('QRコードを作れませんでした(' + errText(e) + ')'); }
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
      if (b && b.length > 40 && b[0] === 0x41 && b[1] === 0x34) acceptBytes(Uint8Array.from(b));
    }, 250);
  }
  const acceptAnswer = (code) => { try { acceptBytes(fromB64u(code.trim())); } catch (e) { sMsg('コードを読み込めませんでした。'); } };   // 貼り付けのコード
  async function acceptBytes(bytes) {
    if (answered) return;
    answered = true; $('sState').textContent = 'つないでいます…'; sMsg(''); watchConnect(pc, $('sNet'));
    try { await pc.setRemoteDescription({ type: 'answer', sdp: buildAnswerSdp(offerSlim, decodeAnswer(bytes)) }); }
    catch (e) { answered = false; $('sState').textContent = '読み取りを待っています'; sMsg('返信コードを読み込めませんでした(' + errText(e) + ')。もう一度、読み取らせてください。'); }
  }
  $('usePaste').onclick = () => { const t = $('pasteAnswer').value.trim(); if (t) acceptAnswer(t.indexOf('A4.') === 0 ? t.slice(3) : t); };

  async function onSenderState() {
    const s = pc.connectionState;
    if (s === 'connected') {
      clearInterval(scanTimer);
      $('sPair').hidden = true; $('sLive').hidden = false; $('sState').textContent = '映しています'; sMsg('');
      keepAwake();
      setTimeout(() => showPath(pc, $('sPath')), 1500); setInterval(() => showPath(pc, $('sPath')), 5000);
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
  async function startViewer(spec) {
    show('viewer'); stopViewerScan();
    if (!spec) { $('vState').textContent = '待っています'; return; }
    $('vWait').hidden = true; $('vPaste').hidden = true; $('vState').textContent = '接続の準備をしています…'; vMsg('');
    try {
      pc = newPC();
      pc.ontrack = (e) => { const v = $('remote'); v.srcObject = e.streams[0] || new MediaStream([e.track]); v.play().catch(() => {}); };
      pc.onconnectionstatechange = onViewerState;
      await pc.setRemoteDescription({ type: 'offer', sdp: await offerSdpFrom(spec) });
      try {   // 受け取る形式は VP8 だけにする(返信を小さくするため)
        const rc = RTCRtpReceiver.getCapabilities('video').codecs;
        pc.getTransceivers()[0].setCodecPreferences(rc.filter((c) => /video\/VP8$/i.test(c.mimeType)).concat(rc.filter((c) => /video\/rtx$/i.test(c.mimeType))));
      } catch (e) {}
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      const bytes = encodeAnswer(answerFields(pc.localDescription.sdp));
      drawQR($('qrAnswer'), bytesToStr(bytes));   // 読み取りやすいよう、文字ではなくバイナリで入れる
      const code = 'A4.' + toB64u(bytes);
      $('copyAnswer').onclick = () => copy(code, $('copyAnswer'));
      $('vAnswer').hidden = false; $('vState').textContent = '映す側の、読み取りを待っています'; watchConnect(pc, $('vNet'));
    } catch (e) { $('vState').textContent = '失敗しました'; vMsg('接続情報を読み込めませんでした(' + errText(e) + ')。映す側のQRコードを、もう一度、読み取ってください。直らないときは、トップの「この端末で診断」の結果を教えてください。'); }
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
          showPath(pc, $('vPath'));
          $('stats').textContent = (t.frameWidth ? t.frameWidth + '×' + t.frameHeight + ' / ' : '') + Math.round(t.framesPerSecond || 0) + ' fps / ' + mbps.toFixed(1) + ' Mbps';
        } catch (e) {}
      }, 1000);
    } else if (s === 'disconnected') { $('vState').textContent = '切れかけています…'; }
    else if (s === 'failed' || s === 'closed') { $('vState').textContent = 'つながりませんでした'; vMsg('同じWi-Fi(またはテザリング)につながっているか、確認してください。「戻る」から、もう一度つなぎ直せます。'); }
  }
  let vStream = null, vScan = 0;
  function stopViewerScan() { clearInterval(vScan); if (vStream) { vStream.getTracks().forEach((t) => t.stop()); vStream = null; } $('vScanBox').hidden = true; }
  $('vScanBtn').onclick = async () => {   // 標準カメラで読めないときの代わり。このスマホのカメラで、映す側のQRを読む
    vMsg(''); $('vScanBtn').disabled = true;
    try { vStream = await cam('environment'); } catch (e) { $('vScanBtn').disabled = false; vMsg('カメラを開けませんでした(' + errText(e) + ')。ほかのタブやアプリがカメラを使っていないか確認してください。'); return; }
    const v = $('vPrev'); v.srcObject = vStream; v.play().catch(() => {}); $('vScanBox').hidden = false;
    const c = document.createElement('canvas'), g = c.getContext('2d', { willReadFrequently: true });
    vScan = setInterval(() => {
      if (!v.videoWidth) return;
      const sc = Math.min(1, 1280 / v.videoWidth); c.width = Math.round(v.videoWidth * sc); c.height = Math.round(v.videoHeight * sc);
      g.drawImage(v, 0, 0, c.width, c.height);
      const d = g.getImageData(0, 0, c.width, c.height), r = window.jsQR(d.data, c.width, c.height, { inversionAttempts: 'dontInvert' });
      const spec = r && r.data && /#o4?=/.test(r.data) ? parseOfferText(r.data) : null;
      if (spec) { stopViewerScan(); startViewer(spec); }
    }, 250);
  };
  $('full').onclick = () => { const v = $('remote'), f = v.requestFullscreen || v.webkitRequestFullscreen || v.webkitEnterFullscreen; if (f) try { f.call(v); } catch (e) {} };
  $('useOffer').onclick = () => {
    const spec = parseOfferText($('pasteOffer').value.trim());
    if (spec) startViewer(spec); else vMsg('リンクを読み込めませんでした。');
  };


  // ---------- 2台を同時に見る(iPad向け。横にすると、左と右に並ぶ) ----------
  const slots = [];
  function makeSlot(i) {
    const lr = i === 0 ? '左' : '右', ud = i === 0 ? '上' : '下';
    const root = document.createElement('div'); root.className = 'pane';
    root.innerHTML =
      '<div class="phead"><span class="lab"><span class="lr">' + lr + '</span><span class="ud">' + ud + '</span></span>' +
      '<input class="pname" maxlength="12" placeholder="名前(なくてもOK)" aria-label="名前"><span class="pst">待っています</span></div>' +
      '<div class="ppair">' +
        '<button type="button" class="pscan">このカメラで、映す側のQRを読み取る</button>' +
        '<div class="pscanbox" hidden><video playsinline muted autoplay></video><p class="msg">映す側のQRコードを、この映像に映してください。</p></div>' +
        '<details><summary>QRコードが読めないとき</summary><textarea rows="2" placeholder="映す側のリンクを貼り付け"></textarea><button type="button" class="small puse">このリンクでつなぐ</button></details>' +
        '<div class="pans" hidden><p class="lead">このQRコードを、映す側のカメラで読み取らせてください。</p><canvas class="qr" aria-label="返信用のQRコード"></canvas></div>' +
      '</div>' +
      '<div class="plive" hidden><video playsinline muted autoplay></video><span class="tag"></span></div>' +
      '<div class="row"><button type="button" class="small pfull" hidden>全画面</button><button type="button" class="small pre">つなぎ直す</button><span class="msg pstat"></span></div>' +
      '<p class="msg ppath"></p><p class="msg pmsg" role="status"></p><pre class="net" hidden></pre>';
    const q = (s) => root.querySelector(s);
    const S = { i, root, pc: null, vs: null, timer: 0, stat: 0 };
    const nameKey = 'genba.slot' + i;
    try { q('.pname').value = localStorage.getItem(nameKey) || ''; } catch (e) {}
    const tag = () => { q('.tag').textContent = lr + (q('.pname').value ? ' ' + q('.pname').value : ''); };
    q('.pname').addEventListener('input', () => { try { localStorage.setItem(nameKey, q('.pname').value); } catch (e) {} tag(); });
    tag();
    const st = (t) => { q('.pst').textContent = t; }, msg = (t) => { q('.pmsg').textContent = t; };
    function stopScan() { clearInterval(S.timer); if (S.vs) { S.vs.getTracks().forEach((t) => t.stop()); S.vs = null; } q('.pscanbox').hidden = true; q('.pscan').disabled = false; }
    S.stopScan = stopScan;
    function reset() {
      stopScan(); clearInterval(S.stat);
      if (S.pc) { try { S.pc.close(); } catch (e) {} S.pc = null; }
      const lv = q('.plive video'); lv.srcObject = null;
      q('.plive').hidden = true; q('.ppair').hidden = false; q('.pans').hidden = true; q('.pscan').hidden = false; q('details').hidden = false;
      q('.pfull').hidden = true; q('.pstat').textContent = ''; q('.ppath').textContent = ''; q('.pnet'); msg(''); st('待っています');
      const n = q('.net'); n.hidden = true; n.textContent = '';
    }
    q('.pre').onclick = reset;
    async function begin(spec) {
      stopScan(); q('.pscan').hidden = true; q('details').hidden = true; st('接続の準備をしています…'); msg('');
      try {
        const p = newPC(); S.pc = p;
        p.ontrack = (e) => { const v = q('.plive video'); v.srcObject = e.streams[0] || new MediaStream([e.track]); v.play().catch(() => {}); };
        p.onconnectionstatechange = () => {
          const s = p.connectionState;
          if (s === 'connected') {
            q('.ppair').hidden = true; q('.plive').hidden = false; q('.pfull').hidden = false; st('見ています'); msg(''); keepAwake(); updateDualState();
            clearInterval(S.stat); let last = null;
            S.stat = setInterval(async () => {
              try {
                const rep = await p.getStats(); let t = null; rep.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') t = r; });
                if (!t) return; const now = performance.now(), mbps = last ? ((t.bytesReceived - last.b) * 8 / ((now - last.t) / 1000) / 1e6) : 0; last = { b: t.bytesReceived, t: now };
                showPath(p, q('.ppath'));
                q('.pstat').textContent = (t.frameWidth ? t.frameWidth + '×' + t.frameHeight + ' / ' : '') + Math.round(t.framesPerSecond || 0) + ' fps / ' + mbps.toFixed(1) + ' Mbps';
              } catch (e) {}
            }, 1000);
          } else if (s === 'disconnected') st('切れかけています…');
          else if (s === 'failed' || s === 'closed') { st('つながりませんでした'); msg('同じWi-Fi(またはテザリング)か、確認してください。「つなぎ直す」を押してください。'); updateDualState(); }
        };
        await p.setRemoteDescription({ type: 'offer', sdp: await offerSdpFrom(spec) });
        try { const rc = RTCRtpReceiver.getCapabilities('video').codecs; p.getTransceivers()[0].setCodecPreferences(rc.filter((c) => /video\/VP8$/i.test(c.mimeType)).concat(rc.filter((c) => /video\/rtx$/i.test(c.mimeType)))); } catch (e) {}
        await p.setLocalDescription(await p.createAnswer()); await gathered(p);
        drawQR(q('.qr'), bytesToStr(encodeAnswer(answerFields(p.localDescription.sdp))));
        q('.pans').hidden = false; st('映す側の、読み取りを待っています'); watchConnect(p, q('.net'));
      } catch (e) { st('失敗しました'); msg('接続情報を読み込めませんでした(' + errText(e) + ')。「つなぎ直す」を押して、もう一度、読み取ってください。'); q('.pscan').hidden = false; q('details').hidden = false; }
    }
    q('.puse').onclick = () => { const spec = parseOfferText(q('textarea').value.trim()); if (spec) begin(spec); else msg('リンクを読み込めませんでした。'); };
    q('.pscan').onclick = async () => {
      slots.forEach((o) => { if (o !== S) o.stopScan(); });   // 読み取りは、同時に1か所だけ
      msg(''); q('.pscan').disabled = true;
      try { S.vs = await cam('environment'); } catch (e) { q('.pscan').disabled = false; msg('カメラを開けませんでした(' + errText(e) + ')。'); return; }
      const v = q('.pscanbox video'); v.srcObject = S.vs; v.play().catch(() => {}); q('.pscanbox').hidden = false;
      const c = document.createElement('canvas'), g = c.getContext('2d', { willReadFrequently: true });
      S.timer = setInterval(() => {
        if (!v.videoWidth) return;
        const sc = Math.min(1, 1280 / v.videoWidth); c.width = Math.round(v.videoWidth * sc); c.height = Math.round(v.videoHeight * sc);
        g.drawImage(v, 0, 0, c.width, c.height);
        const d = g.getImageData(0, 0, c.width, c.height), r = window.jsQR(d.data, c.width, c.height, { inversionAttempts: 'dontInvert' });
        const spec = r && r.data && /#o4?=/.test(r.data) ? parseOfferText(r.data) : null;
        if (spec) begin(spec);
      }, 250);
    };
    q('.pfull').onclick = () => { const v = q('.plive video'), f = v.requestFullscreen || v.webkitRequestFullscreen || v.webkitEnterFullscreen; if (f) try { f.call(v); } catch (e) {} };
    return S;
  }
  function updateDualState() {
    const n = slots.filter((s) => s.pc && s.pc.connectionState === 'connected').length;
    $('dState').textContent = n === 2 ? '2台とも、見ています' : n === 1 ? '1台つながっています' : '2台のカメラを、つなぎます';
  }
  function startDual() {
    show('dual');
    if (!slots.length) { const g = $('dualGrid'); for (let i = 0; i < 2; i++) { const s = makeSlot(i); slots.push(s); g.appendChild(s.root); } }
  }
  $('goDual').onclick = startDual;
  $('dBack').onclick = () => { location.href = location.pathname; };

  // ---------- この端末での自己診断 ----------
  // 1台の中で、映す側と見る側を両方動かし、接続の手順を通して試す。端末ごとの非対応・相性を見つけるため
  const waitFor = (fn, ms) => new Promise((res) => { const t0 = Date.now(); const id = setInterval(() => { if (fn()) { clearInterval(id); res(true); } else if (Date.now() - t0 > ms) { clearInterval(id); res(false); } }, 150); });
  async function selfTest() {
    const out = [], log = (ok, t) => { out.push((ok ? '○ ' : '× ') + t); $('diag').textContent = out.join('\n'); };
    $('diagBtn').disabled = true; $('diag').hidden = false; $('diag').textContent = '診断しています…';
    log(!!window.isSecureContext, 'https で開いている');
    log(!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia), 'カメラ機能');
    log(typeof RTCPeerConnection === 'function', 'WebRTC');
    log(typeof CompressionStream === 'function' && typeof DecompressionStream === 'function', '圧縮機能');
    try { log(RTCRtpSender.getCapabilities('video').codecs.some((c) => /VP8$/i.test(c.mimeType)), '映像形式 VP8'); } catch (e) { log(false, '映像形式の確認: ' + errText(e)); }
    log(true, '端末: ' + navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 80));
    let A, B, timer;
    try {
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180; const g = cv.getContext('2d'); let n = 0;
      timer = setInterval(() => { g.fillStyle = '#246'; g.fillRect(0, 0, 320, 180); g.fillStyle = '#fff'; g.fillRect((n++ * 7) % 300, 80, 20, 20); }, 66);
      const st = cv.captureStream(15);
      A = newPC(); st.getTracks().forEach((t) => A.addTrack(t, st)); preferCodecs(A);
      await A.setLocalDescription(await A.createOffer()); await gathered(A);
      const offerSlim = slim(A.localDescription.sdp); let spec, size;
      try { const bytes = encodeOffer(offerFields(offerSlim)); spec = { kind: 'o4', code: toB64u(bytes) }; size = bytes.length + 'バイト(小さな形式)'; }
      catch (e) { spec = { kind: 'o', code: await pack(offerSlim) }; size = spec.code.length + '文字(長い形式。理由: ' + errText(e) + ')'; }
      log(true, '1 映す側の接続情報を作成(' + size + ')');
      B = newPC(); const vid = document.createElement('video'); vid.muted = true; vid.playsInline = true;
      B.ontrack = (e) => { vid.srcObject = e.streams[0] || new MediaStream([e.track]); vid.play().catch(() => {}); };
      await B.setRemoteDescription({ type: 'offer', sdp: await offerSdpFrom(spec) }); log(true, '2 見る側が読み込み');
      try { const rc = RTCRtpReceiver.getCapabilities('video').codecs; B.getTransceivers()[0].setCodecPreferences(rc.filter((c) => /video\/VP8$/i.test(c.mimeType)).concat(rc.filter((c) => /video\/rtx$/i.test(c.mimeType)))); } catch (e) {}
      await B.setLocalDescription(await B.createAnswer()); await gathered(B);
      const bytes = encodeAnswer(answerFields(B.localDescription.sdp)); log(true, '3 返信を作成(' + bytes.length + 'バイト)');
      await A.setRemoteDescription({ type: 'answer', sdp: buildAnswerSdp(offerSlim, decodeAnswer(bytes)) }); log(true, '4 映す側が返信を読み込み');
      const ok = await waitFor(() => A.connectionState === 'connected' && B.connectionState === 'connected', 9000);
      log(ok, '5 接続(' + A.connectionState + ' / ' + B.connectionState + ')');
      const ok2 = await waitFor(() => vid.videoWidth > 0, 7000);
      log(ok2, '6 映像が届く' + (ok2 ? '(' + vid.videoWidth + '×' + vid.videoHeight + ')' : ''));
    } catch (e) { log(false, '失敗: ' + errText(e)); }
    clearInterval(timer); try { A && A.close(); } catch (e) {} try { B && B.close(); } catch (e) {}
    log(true, '診断おわり。この画面を、スクリーンショットで教えてください'); $('diagBtn').disabled = false;
  }
  // 住所の確認: この端末が、つなぐときに使える住所(Wi-Fi・テザリングなど)を調べる。カメラの許可を一度使うと、本当の住所が見える
  async function addrTest() {
    const out = [], log = (t) => { out.push(t); $('diag').textContent = out.join('\n'); };
    $('addrBtn').disabled = true; $('diag').hidden = false; $('diag').textContent = '調べています…';
    let st = null, p = null;
    try { st = await cam('environment'); log('カメラの許可: 取得できました'); } catch (e) { log('カメラの許可: 取得できません(' + errText(e) + ')。住所が端末名で隠れることがあります'); }
    try {
      p = newPC(); p.createDataChannel('x'); await p.setLocalDescription(await p.createOffer()); await gathered(p, 4000);
      const sdp = p.localDescription.sdp, lines = sdp.split(/\r?\n/).filter((l) => l.indexOf('a=candidate:') === 0);
      log('見つかった住所: ' + lines.length + ' 件');
      lines.forEach((l) => { const c = l.split(' '); log('  ' + c[4] + ':' + c[5] + ' ' + c[2] + ' ' + (c[7] || '')); });
      if (!lines.some((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l.split(' ')[4]))) log('  → IPv4の住所がありません。この端末では、Wi-Fi・テザリングで直接つなげない可能性があります');
      try { const rep = await p.getStats(); rep.forEach((r) => { if (r.type === 'local-candidate' && r.networkType) log('  種類: ' + (r.address || r.ip) + ' = ' + r.networkType); }); } catch (e) {}
    } catch (e) { log('失敗: ' + errText(e)); }
    try { p && p.close(); } catch (e) {} if (st) st.getTracks().forEach((t) => t.stop());
    log('おわり。この画面を、スクリーンショットで教えてください(テザリングの親と子の、両方でお願いします)'); $('addrBtn').disabled = false;
  }
  $('addrBtn').onclick = addrTest;
  $('diagBtn').onclick = selfTest;
  if (/[?&]selftest=1/.test(location.search)) window.__t = { slim, offerFields, encodeOffer, decodeOffer, buildOfferSdp, answerFields, encodeAnswer, decodeAnswer, buildAnswerSdp };

  // ---------- 入口 ----------
  $('goSender').onclick = startSender;
  $('goViewer').onclick = () => startViewer(null);
  const back = () => { location.href = location.pathname; };
  $('sBack').onclick = back; $('vBack').onclick = back;

  const initial = parseOfferText(location.hash);
  if (initial && /^#o4?=/.test(location.hash)) { history.replaceState(null, '', location.pathname); startViewer(initial); }   // QRコードから開いたときは、そのまま見る側へ

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
