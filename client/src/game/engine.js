// ===================================================================
//  Cotton Picker Sim — game engine (framework-agnostic)
//  All simulation, PeerJS networking and canvas rendering live here.
//  React mounts it via a ref and talks to it through `emit` events
//  and the returned API. The engine NEVER touches React or the DOM
//  overlays — only the <canvas> it is given.
// ===================================================================
import Peer from 'peerjs';

export function createEngine(canvas, emit) {
  const ctx = canvas.getContext('2d');

  // ============================== CONFIG ==============================
  const CFG = {
    matchGoal: 4000,     // first to this score wins
    matchDays: 8,        // time limit (after which highest score wins)
    dayLen: 70,          // seconds per day (drives day/night + match clock)
    basePrice: 1.85,
    pimaMult: 1.95,
    regrow: 30,
    baseCap: 160, baseSpeed: 175, baseHeader: 34, baseUnload: 160,
    accel: 240, drag: 2.4, turn: 2.5,
    STATE_HZ: 15, PLOT_HZ: 5, INPUT_HZ: 20,
  };
  const WORLD = { w: 2800, h: 2000 };
  const CELL = 46;
  const GINS = [
    { x: WORLD.w * 0.18, y: WORLD.h * 0.5 - 55, w: 180, h: 110 },
    { x: WORLD.w * 0.82 - 180, y: WORLD.h * 0.5 - 55, w: 180, h: 110 },
  ];
  const SPAWNS = [
    { x: WORLD.w * 0.5,  y: WORLD.h * 0.5 },
    { x: WORLD.w * 0.5,  y: WORLD.h * 0.35 },
    { x: WORLD.w * 0.42, y: WORLD.h * 0.6 },
    { x: WORLD.w * 0.58, y: WORLD.h * 0.6 },
  ];
  const COLORS = ['#4c8c2b', '#c0392b', '#2f81c4', '#d59b2a'];
  const ACCENTS = ['#f2c200', '#f1d4cf', '#cfe6f5', '#3a2c10'];
  const WEATHER_TYPES = ['clear', 'rain', 'drought', 'storm'];
  const WEATHER = {
    clear:   { label: 'Clear',   regrow: 1.0,  tint: null,                    icon: 'sun' },
    rain:    { label: 'Rain',    regrow: 1.7,  tint: 'rgba(70,110,160,.16)',  icon: 'rain' },
    drought: { label: 'Drought', regrow: 0.45, tint: 'rgba(200,150,60,.13)',  icon: 'dry' },
    storm:   { label: 'Storm',   regrow: 1.4,  tint: 'rgba(30,40,70,.30)',    icon: 'storm' },
  };
  const SHOP = {
    cap:    { name: 'Basket Capacity', base: 260, desc: '+50 units before you must run to the gin.', apply: p => { p.cap += 50; } },
    speed:  { name: 'Engine & Drive',  base: 300, desc: '+18% top speed across the field.',          apply: p => { p.ms += 30; } },
    header: { name: 'Wider Header',     base: 280, desc: 'Bigger swath — clears more rows per pass.',  apply: p => { p.hr += 7; } },
    unload: { name: 'Fast Unload',      base: 300, desc: 'Empty the basket at the gin much faster.',   apply: p => { p.ur += 70; } },
  };

  // ============================== UTIL ==============================
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const fmt = n => '$' + Math.round(n).toLocaleString('en-US');
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  function makeCode() { let s = ''; for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]; return s; }
  function mulberry32(seed) { let a = seed >>> 0; return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // ============================== WORLD GEN (deterministic) ==============================
  function buildWorld(seed) {
    const rng = mulberry32(seed);
    const patches = [];
    const plots = [];
    const N = 7;
    for (let pi = 0; pi < N; pi++) {
      const cols = 7 + Math.floor(rng() * 6);
      const rows = 6 + Math.floor(rng() * 4);
      const pw = cols * CELL, ph = rows * CELL;
      const px = 140 + rng() * (WORLD.w - 280 - pw);
      const py = 140 + rng() * (WORLD.h - 280 - ph);
      const pima = rng() < 0.33;
      patches.push({ x: px, y: py, w: pw, h: ph });
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const cx = px + c * CELL + CELL / 2;
        const cy = py + r * CELL + CELL / 2;
        let skip = false;
        for (const g of GINS) { if (cx > g.x - 34 && cx < g.x + g.w + 34 && cy > g.y - 34 && cy < g.y + g.h + 34) { skip = true; break; } }
        if (skip) continue;
        plots.push({ cx, cy, crop: pima ? 'pima' : 'cotton' });
      }
    }
    return { plots, patches };
  }

  // ============================== STATE ==============================
  let ROLE = null;          // 'host' | 'client'
  let MY = 0;               // my player index
  let SEED = 0;
  let world = null;
  let stages = null;        // Uint8Array: byte = stage(0 stub,1 grow,2 ripe) | growthQuant<<2
  let running = false;
  let matchOver = false;
  let myNameVal = 'Player';

  let H = null;             // host-only authoritative state
  function freshHostPlayer(i, name) {
    return {
      i, name, x: SPAWNS[i].x, y: SPAWNS[i].y, angle: -Math.PI / 2, vel: 0,
      cotton: 0, pima: 0, fuel: 100, score: 0, cash: 0,
      cap: CFG.baseCap, ms: CFG.baseSpeed, hr: CFG.baseHeader, ur: CFG.baseUnload,
      up: { cap: 0, speed: 0, header: 0, unload: 0 },
      inThr: 0, inSteer: 0, alive: true, glow: 0,
    };
  }
  function initHostSim(playerDefs) {
    H = {
      players: playerDefs.map((p, i) => freshHostPlayer(i, p.name)),
      plot: world.plots.map(() => ({ state: 2, growth: 1, regrowT: 0 })),
      market: { index: 1, t: Math.random() * 8 },
      weather: { type: 'clear', timer: 10 },
      elapsed: 0, hvBatch: [],
    };
    for (const ps of H.plot) { if (Math.random() < 0.3) { ps.state = 1; ps.growth = Math.random() * 0.7; } }
    syncStagesFromHost();
  }
  function syncStagesFromHost() {
    for (let i = 0; i < H.plot.length; i++) {
      const ps = H.plot[i];
      const gq = ps.state === 1 ? clamp(Math.floor(ps.growth * 15), 0, 15) : 0;
      stages[i] = (ps.state & 3) | (gq << 2);
    }
  }

  let netP = [];            // per-player public snapshot (client view)
  let lobbyPlayers = [];    // [{i,name}]
  let predict = null;       // client-side own predicted vehicle
  let remoteDisp = [];      // smoothed display for other players
  let matchInfo = { day: 1, tl: CFG.matchDays * CFG.dayLen, mk: 1, w: 0 };
  let clientUp = { cap: 0, speed: 0, header: 0, unload: 0 };

  // fx
  let particles = [], floats = [];
  function puff(x, y) { if (particles.length > 140) return; for (let i = 0; i < 4; i++) particles.push({ x: x + (Math.random() - .5) * 16, y: y + (Math.random() - .5) * 16, vx: (Math.random() - .5) * 28, vy: -18 - Math.random() * 28, life: .65, max: .65, r: 3 + Math.random() * 4, k: 'c' }); }
  function ginPuff(x, y) { if (particles.length > 140) return; particles.push({ x, y, vx: (Math.random() - .5) * 40, vy: -40 - Math.random() * 40, life: .55, max: .55, r: 3 + Math.random() * 4, k: 'c' }); }
  function rainDrop() { if (particles.length > 180) return; particles.push({ x: cam.x + Math.random() * VW, y: cam.y - 10, vx: -40, vy: 430, life: 1.1, max: 1.1, k: 'r' }); }

  // ============================== NETWORKING (PeerJS) ==============================
  let peer = null, hostConns = [], clientConn = null, myCode = null, openTimer = null;
  const NET_OK = (typeof Peer !== 'undefined');
  const PEER_CFG = { debug: 1, config: { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ] } };
  const CONNECT_HELP = 'Couldn’t reach the PeerJS signalling broker. Check your internet connection. The free public broker can be busy — for production, run your own PeerServer (see the README).';

  function menuStatus(text, err) { emit('menustatus', { text: text || '', err: !!err }); }
  function lobbyStatus(text, err) { emit('lobbystatus', { text: text || '', err: !!err }); }
  function toast(msg) { emit('toast', msg); }
  function pushLobby() { emit('lobby', { players: lobbyPlayers.slice().sort((a, b) => a.i - b.i), code: myCode, isHost: ROLE === 'host', myIndex: MY }); }

  // ---- HOST ----
  function hostCreate(name) {
    myNameVal = (name || 'Player').slice(0, 12);
    if (!NET_OK) { menuStatus('Multiplayer can’t load its connection library. Make sure peerjs is installed and you have internet.', true); return; }
    ROLE = 'host'; MY = 0;
    menuStatus('Creating game…');
    attemptHostPeer();
  }
  function attemptHostPeer() {
    myCode = makeCode();
    if (peer) { try { peer.destroy(); } catch (e) {} }
    peer = new Peer('CPS' + myCode, PEER_CFG);
    clearTimeout(openTimer);
    openTimer = setTimeout(() => { if (!(peer && peer.open)) menuStatus(CONNECT_HELP, true); }, 9000);
    peer.on('open', () => {
      clearTimeout(openTimer); menuStatus('');
      lobbyPlayers = [{ i: 0, name: myNameVal }];
      emit('screen', 'lobby'); pushLobby();
      lobbyStatus('Lobby open. Share the code and wait for players to join.');
    });
    peer.on('connection', conn => {
      conn.on('open', () => {
        if (running || hostConns.length >= 3) { conn.send({ t: 'full' }); setTimeout(() => conn.close(), 200); return; }
        const used = new Set([0, ...hostConns.map(c => c.pidx)]);
        let idx = 1; while (used.has(idx)) idx++;
        conn.pidx = idx;
        hostConns.push(conn);
        conn.on('data', d => hostHandle(conn, d));
        conn.on('close', () => hostDropConn(conn));
        conn.on('error', () => hostDropConn(conn));
      });
    });
    peer.on('error', err => {
      if (err && err.type === 'unavailable-id') { attemptHostPeer(); return; } // code taken, retry
      clearTimeout(openTimer);
      menuStatus('Connection error (' + ((err && err.type) || 'unknown') + '). ' + CONNECT_HELP, true);
      emit('screen', 'menu');
    });
  }
  function hostHandle(conn, d) {
    if (!d) return;
    if (d.t === 'hello') {
      const exists = lobbyPlayers.find(p => p.i === conn.pidx);
      if (!exists) lobbyPlayers.push({ i: conn.pidx, name: (d.name || ('Player ' + (conn.pidx + 1))).slice(0, 12) });
      conn.send({ t: 'welcome', you: conn.pidx });
      pushLobby(); lobbyStatus(lobbyPlayers.length + ' player(s) in the lobby.');
      broadcast({ t: 'lobby', players: lobbyPlayers, started: running, seed: SEED, cfgGoal: CFG.matchGoal, cfgDays: CFG.matchDays });
      if (running) conn.send({ t: 'full' });
    } else if (d.t === 'i') {
      const pl = H && H.players[conn.pidx];
      if (pl) { pl.inThr = clamp(d.thr || 0, -1, 1); pl.inSteer = clamp(d.steer || 0, -1, 1); }
    } else if (d.t === 'buy') {
      hostBuy(conn.pidx, d.key);
    }
  }
  function hostDropConn(conn) {
    hostConns = hostConns.filter(c => c !== conn);
    lobbyPlayers = lobbyPlayers.filter(p => p.i !== conn.pidx);
    if (H) { const pl = H.players[conn.pidx]; if (pl) pl.alive = false; }
    pushLobby();
    broadcast({ t: 'lobby', players: lobbyPlayers, started: running, seed: SEED, cfgGoal: CFG.matchGoal, cfgDays: CFG.matchDays });
    if (running) toast('A player left the game.');
  }
  function broadcast(msg) { for (const c of hostConns) { try { c.send(msg); } catch (e) {} } }

  function hostStartMatch() {
    SEED = (Math.random() * 1e9) | 0;
    world = buildWorld(SEED);
    stages = new Uint8Array(world.plots.length);
    initHostSim(lobbyPlayers.slice().sort((a, b) => a.i - b.i));
    // re-map players to lobby indices precisely (preserve index, mark gaps dead)
    H.players = [];
    lobbyPlayers.sort((a, b) => a.i - b.i);
    const maxIdx = Math.max(...lobbyPlayers.map(p => p.i));
    for (let i = 0; i <= maxIdx; i++) {
      const lp = lobbyPlayers.find(p => p.i === i);
      H.players[i] = freshHostPlayer(i, lp ? lp.name : ('P' + (i + 1)));
      if (!lp) H.players[i].alive = false;
    }
    running = true; matchOver = false;
    broadcast({ t: 'start', seed: SEED, players: lobbyPlayers, goal: CFG.matchGoal, days: CFG.matchDays });
    enterGame();
  }

  function hostBuy(idx, key) {
    const pl = H.players[idx]; if (!pl) return;
    const lvl = pl.up[key] || 0;
    const cost = Math.round(SHOP[key].base * Math.pow(1.7, lvl));
    if (pl.cash >= cost) { pl.cash -= cost; pl.up[key] = lvl + 1; SHOP[key].apply(pl); }
  }

  // ---- CLIENT ----
  function clientJoin(name, code) {
    myNameVal = (name || 'Player').slice(0, 12);
    if (!NET_OK) { menuStatus('Multiplayer can’t load its connection library. Make sure peerjs is installed and you have internet.', true); return; }
    if (!code || code.length < 4) { menuStatus('Enter the 4-character code.', true); return; }
    ROLE = 'client';
    if (peer) { try { peer.destroy(); } catch (e) {} }
    menuStatus('Connecting…');
    peer = new Peer(PEER_CFG);
    clearTimeout(openTimer);
    openTimer = setTimeout(() => { if (!(peer && peer.open)) menuStatus(CONNECT_HELP, true); }, 9000);
    peer.on('open', () => {
      clearTimeout(openTimer);
      clientConn = peer.connect('CPS' + code.toUpperCase(), { reliable: true });
      let opened = false;
      clientConn.on('open', () => { opened = true; clientConn.send({ t: 'hello', name: myNameVal }); menuStatus('Connected — waiting in the lobby.'); });
      clientConn.on('data', d => clientHandle(d));
      clientConn.on('close', () => { if (running) { toast('Host ended the game.'); leaveGame(); } });
      clientConn.on('error', () => menuStatus('Connection problem — check the code and try again.', true));
      setTimeout(() => { if (!opened) menuStatus('No game found with that code (it may have closed, or the match already started).', true); }, 7000);
    });
    peer.on('error', err => {
      clearTimeout(openTimer);
      if (err && err.type === 'peer-unavailable') menuStatus('No game found with that code.', true);
      else menuStatus('Could not connect (' + ((err && err.type) || 'unknown') + '). ' + CONNECT_HELP, true);
    });
  }
  function clientHandle(d) {
    if (!d) return;
    if (d.t === 'full') { menuStatus('That game is full or already started.', true); return; }
    if (d.t === 'welcome') { MY = d.you; pushLobby(); return; }
    if (d.t === 'lobby') {
      lobbyPlayers = d.players || [];
      SEED = d.seed || SEED;
      if (!running) { emit('screen', 'lobby'); pushLobby(); lobbyStatus('Waiting for the host to start…'); }
    } else if (d.t === 'start') {
      SEED = d.seed; CFG.matchGoal = d.goal; CFG.matchDays = d.days;
      lobbyPlayers = d.players || lobbyPlayers;
      world = buildWorld(SEED);
      stages = new Uint8Array(world.plots.length); stages.fill(2);
      running = true; matchOver = false;
      enterGame();
    } else if (d.t === 's') {
      applyState(d);
    } else if (d.t === 'p') {
      applyPlots(d.s);
    } else if (d.t === 'over') {
      showResults(d.rank, d.reason);
    }
  }

  // ============================== STATE ENCODE/DECODE ==============================
  function buildStateMsg() {
    const P = H.players.map(p => {
      const tot = p.cotton + p.pima;
      return [Math.round(p.x), Math.round(p.y), +p.angle.toFixed(3),
        Math.round(p.score), Math.round(p.cash),
        +(clamp(tot / p.cap, 0, 1)).toFixed(2), Math.round(p.fuel),
        Math.round(p.ms), Math.round(p.hr), p.alive ? 1 : 0];
    });
    const day = Math.floor(H.elapsed / CFG.dayLen) + 1;
    const tl = Math.max(0, CFG.matchDays * CFG.dayLen - H.elapsed);
    const msg = { t: 's', P, day, tl: Math.round(tl), mk: +H.market.index.toFixed(3), w: WEATHER_TYPES.indexOf(H.weather.type), hv: H.hvBatch };
    H.hvBatch = [];
    return msg;
  }
  function buildPlotMsg() {
    let s = ''; for (let i = 0; i < stages.length; i++) s += String.fromCharCode(stages[i]);
    return { t: 'p', s };
  }
  function applyState(d) {
    netP = d.P.map((a, i) => ({ x: a[0], y: a[1], a: a[2], score: a[3], cash: a[4], bf: a[5], fuel: a[6], ms: a[7], hr: a[8], alive: !!a[9], name: (lobbyPlayers.find(p => p.i === i) || {}).name || ('P' + (i + 1)) }));
    matchInfo.day = d.day; matchInfo.tl = d.tl; matchInfo.mk = d.mk; matchInfo.w = d.w;
    if (d.hv && d.hv.length) { for (const idx of d.hv) { stages[idx] = (stages[idx] & ~3) | 0; } }
    if (ROLE === 'client' && netP[MY]) {
      const np = netP[MY];
      if (!predict) { predict = { x: np.x, y: np.y, angle: np.a, vel: 0, fuel: np.fuel, ms: np.ms, hr: np.hr }; }
      predict.ms = np.ms; predict.hr = np.hr; predict.fuel = np.fuel;
      const dx = np.x - predict.x, dy = np.y - predict.y;
      if (dx * dx + dy * dy > 150 * 150) { predict.x = np.x; predict.y = np.y; predict.angle = np.a; }
      else { predict.x += dx * 0.18; predict.y += dy * 0.18; predict.angle = lerpAngle(predict.angle, np.a, 0.18); }
    }
  }
  function lerpAngle(a, b, t) { let d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI; return a + d * t; }
  function applyPlots(s) {
    if (!stages || s.length !== stages.length) return;
    for (let i = 0; i < s.length; i++) stages[i] = s.charCodeAt(i);
  }

  // ============================== SIM (host) ==============================
  function hostUpdate(dt) {
    if (!running || matchOver) return;
    H.elapsed += dt;
    const tl = CFG.matchDays * CFG.dayLen - H.elapsed;
    if (tl <= 0) { endMatch('time'); return; }

    H.market.t += dt;
    H.market.index = clamp(1.02 + Math.sin(H.market.t * 0.18) * 0.18 + Math.sin(H.market.t * 0.057 + 1.3) * 0.12 + Math.sin(H.market.t * 0.9) * 0.03, 0.7, 1.45);

    H.weather.timer -= dt;
    if (H.weather.timer <= 0) {
      const r = Math.random(); const next = r < 0.55 ? 'clear' : r < 0.78 ? 'rain' : r < 0.92 ? 'drought' : 'storm';
      H.weather.type = next; H.weather.timer = next === 'clear' ? 14 + Math.random() * 14 : 8 + Math.random() * 8;
      if (next === 'storm') { for (const ps of H.plot) { if (ps.state === 2 && Math.random() < 0.16) { ps.state = 0; ps.growth = 0; ps.regrowT = 0; } } toast('Storm rolling in — protect your fields!'); }
    }
    const rg = WEATHER[H.weather.type].regrow;

    for (const ps of H.plot) {
      if (ps.state === 0) { ps.regrowT += dt * rg; if (ps.regrowT >= CFG.regrow * 0.35) { ps.state = 1; ps.growth = 0; } }
      else if (ps.state === 1) { ps.growth += dt / (CFG.regrow * 0.65) * rg; if (ps.growth >= 1) { ps.growth = 1; ps.state = 2; } }
    }

    for (const pl of H.players) {
      if (!pl.alive) continue;
      const thr = pl.i === MY ? input.thr : pl.inThr;
      const steer = pl.i === MY ? input.steer : pl.inSteer;
      stepVehicle(pl, thr, steer, dt);

      const hx = pl.x + Math.cos(pl.angle) * 30, hy = pl.y + Math.sin(pl.angle) * 30;
      const R2 = pl.hr * pl.hr, tot = pl.cotton + pl.pima;
      if (Math.abs(pl.vel) > 12 && tot < pl.cap) {
        const plots = world.plots;
        for (let i = 0; i < plots.length; i++) {
          if (H.plot[i].state !== 2) continue;
          const dx = plots[i].cx - hx, dy = plots[i].cy - hy;
          if (dx * dx + dy * dy < R2) {
            H.plot[i].state = 0; H.plot[i].growth = 0; H.plot[i].regrowT = 0;
            if (plots[i].crop === 'pima') pl.pima += 12; else pl.cotton += 14;
            H.hvBatch.push(i);
            if (pl.i === MY) puff(plots[i].cx, plots[i].cy);
          }
        }
      }
      let inGin = false;
      for (const g of GINS) { if (pl.x > g.x - 6 && pl.x < g.x + g.w + 6 && pl.y > g.y - 6 && pl.y < g.y + g.h + 6) { inGin = true; break; } }
      if (inGin) {
        const want = pl.ur * dt; let sold = 0, rev = 0;
        for (const crop of ['cotton', 'pima']) {
          if (pl[crop] <= 0) continue;
          const take = Math.min(pl[crop], want);
          pl[crop] -= take; sold += take;
          rev += take * CFG.basePrice * H.market.index * (crop === 'pima' ? CFG.pimaMult : 1);
        }
        if (sold > 0) { pl.score += rev; pl.cash += rev; pl.glow = 1; if (pl.i === MY && Math.random() < 0.4) ginPuff(pl.x + (Math.random() - .5) * 40, pl.y - 10); }
        pl.fuel = clamp(pl.fuel + 38 * dt, 0, 100);
        if (pl.score >= CFG.matchGoal) { endMatch('goal'); return; }
      }
      pl.glow = Math.max(0, pl.glow - dt * 2);
    }
  }
  function stepVehicle(v, thr, steer, dt) {
    const maxV = v.ms;
    if (thr !== 0 && v.fuel > 0) v.vel += thr * CFG.accel * dt;
    v.vel -= v.vel * CFG.drag * dt;
    v.vel = clamp(v.vel, -maxV * 0.55, maxV);
    const sf = clamp(Math.abs(v.vel) / maxV, 0, 1);
    v.angle += steer * (CFG.turn * sf) * dt * Math.sign(v.vel || 1);
    v.x += Math.cos(v.angle) * v.vel * dt;
    v.y += Math.sin(v.angle) * v.vel * dt;
    v.x = clamp(v.x, 18, WORLD.w - 18);
    v.y = clamp(v.y, 18, WORLD.h - 18);
    if (thr !== 0) v.fuel = clamp(v.fuel - Math.abs(thr) * dt * 1.7, 0, 100);
  }
  function endMatch(reason) {
    matchOver = true; running = false;
    const rank = H.players.filter(p => p.alive || p.score > 0)
      .map(p => ({ name: p.name, score: Math.round(p.score), i: p.i }))
      .sort((a, b) => b.score - a.score);
    broadcast({ t: 'over', rank, reason });
    showResults(rank, reason);
  }

  // ============================== INPUT ==============================
  const input = { thr: 0, steer: 0 };
  const keys = new Set();
  const KMAP = { up: ['w', 'arrowup'], down: ['s', 'arrowdown'], left: ['a', 'arrowleft'], right: ['d', 'arrowright'] };
  function readKeyboard() {
    let thr = 0, steer = 0;
    if (KMAP.up.some(k => keys.has(k))) thr += 1;
    if (KMAP.down.some(k => keys.has(k))) thr -= 1;
    if (KMAP.right.some(k => keys.has(k))) steer += 1;
    if (KMAP.left.some(k => keys.has(k))) steer -= 1;
    return { thr, steer };
  }
  const stick = { active: false, id: null, bx: 0, by: 0, kx: 0, ky: 0, R: 62, out: { x: 0, y: 0 } };
  const isTouch = (typeof window !== 'undefined') && (('ontouchstart' in window) || (navigator.maxTouchPoints > 0));
  function gatherInput() {
    const kb = readKeyboard();
    let thr = kb.thr, steer = kb.steer;
    if (stick.active) {
      const ax = stick.out.x, ay = stick.out.y;
      if (Math.abs(ay) > 0.18) thr = clamp(-ay / 0.9, -1, 1);
      if (Math.abs(ax) > 0.18) steer = clamp(ax / 0.9, -1, 1);
    }
    input.thr = clamp(thr, -1, 1); input.steer = clamp(steer, -1, 1);
  }

  // ============================== CANVAS / CAMERA ==============================
  let VW = 0, VH = 0, DPR = 1;
  const cam = { x: 0, y: 0 };
  function resize() {
    const rect = canvas.getBoundingClientRect();
    VW = Math.round(rect.width) || window.innerWidth;
    VH = Math.round(rect.height) || window.innerHeight;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(VW * DPR); canvas.height = Math.floor(VH * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    stick.bx = 92; stick.by = VH - 98;
  }

  // ============================== RENDER ==============================
  function localPlayerPos() {
    if (ROLE === 'host') { const p = H.players[MY]; return p ? { x: p.x, y: p.y, angle: p.angle } : { x: WORLD.w / 2, y: WORLD.h / 2, angle: 0 }; }
    return predict || (netP[MY] ? { x: netP[MY].x, y: netP[MY].y, angle: netP[MY].a } : { x: WORLD.w / 2, y: WORLD.h / 2, angle: 0 });
  }
  function dayBrightness() {
    const elapsed = ROLE === 'host' ? H.elapsed : (CFG.matchDays * CFG.dayLen - matchInfo.tl);
    const t = (elapsed % CFG.dayLen) / CFG.dayLen;
    return clamp(Math.sin(t * Math.PI) * 1.6 - 0.25, 0, 1);
  }
  function weatherType() { return ROLE === 'host' ? H.weather.type : (WEATHER_TYPES[matchInfo.w] || 'clear'); }
  function marketIndex() { return ROLE === 'host' ? H.market.index : matchInfo.mk; }

  function playersForRender() {
    const list = [];
    const n = ROLE === 'host' ? H.players.length : netP.length;
    for (let i = 0; i < n; i++) {
      if (ROLE === 'host') {
        const p = H.players[i]; if (!p || !p.alive) continue;
        list.push({ i, x: p.x, y: p.y, a: p.angle, glow: p.glow, bf: clamp((p.cotton + p.pima) / p.cap, 0, 1), name: p.name, me: i === MY });
      } else {
        const pub = netP[i]; if (!pub || !pub.alive) continue;
        if (i === MY && predict) { list.push({ i, x: predict.x, y: predict.y, a: predict.angle, glow: 0, bf: pub.bf, name: pub.name, me: true }); }
        else { const rd = remoteDisp[i] || (remoteDisp[i] = { x: pub.x, y: pub.y, a: pub.a }); list.push({ i, x: rd.x, y: rd.y, a: rd.a, glow: 0, bf: pub.bf, name: pub.name, me: false }); }
      }
    }
    return list;
  }

  function render() {
    if (!VW || !VH) resize();
    const lp = localPlayerPos();
    cam.x = clamp(lp.x - VW / 2, 0, Math.max(0, WORLD.w - VW));
    cam.y = clamp(lp.y - VH / 2, 0, Math.max(0, WORLD.h - VH));
    if (WORLD.w < VW) cam.x = (WORLD.w - VW) / 2;
    if (WORLD.h < VH) cam.y = (WORLD.h - VH) / 2;

    ctx.fillStyle = '#3f6e32'; ctx.fillRect(0, 0, VW, VH);
    ctx.strokeStyle = 'rgba(255,255,255,.04)'; ctx.lineWidth = 1;
    const step = 200;
    const x0 = Math.floor(cam.x / step) * step;
    for (let x = x0; x < cam.x + VW; x += step) { const sx = x - cam.x; ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, VH); ctx.stroke(); }
    const y0 = Math.floor(cam.y / step) * step;
    for (let y = y0; y < cam.y + VH; y += step) { const sy = y - cam.y; ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(VW, sy); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(20,14,8,.5)'; ctx.lineWidth = 6;
    ctx.strokeRect(-cam.x, -cam.y, WORLD.w, WORLD.h);

    if (world) {
      for (const pa of world.patches) {
        const sx = pa.x - cam.x, sy = pa.y - cam.y;
        if (sx > VW || sy > VH || sx + pa.w < 0 || sy + pa.h < 0) continue;
        ctx.fillStyle = '#5e4128'; roundRect(sx - 10, sy - 10, pa.w + 20, pa.h + 20, 8); ctx.fill();
      }
      drawGins();
      drawPlots();
    }
    for (const p of playersForRender()) drawPicker(p);
    drawParticles(); drawFloats();

    const b = dayBrightness();
    if (b < 0.92) {
      const night = 1 - b;
      ctx.fillStyle = `rgba(12,16,40,${night * 0.6})`; ctx.fillRect(0, 0, VW, VH);
      if (night > 0.25) { for (const p of playersForRender()) drawHeadlight(p, night); }
    }
    const wt = WEATHER[weatherType()].tint;
    if (wt) { ctx.fillStyle = wt; ctx.fillRect(0, 0, VW, VH); }
    drawWeatherFX();

    drawHUD();
    drawMinimap();
    if (stick.active || isTouch) drawStick();
  }

  function drawPlots() {
    const plots = world.plots;
    for (let i = 0; i < plots.length; i++) {
      const p = plots[i];
      const sx = p.cx - cam.x, sy = p.cy - cam.y;
      if (sx < -26 || sy < -26 || sx > VW + 26 || sy > VH + 26) continue;
      const byte = stages[i]; const stage = byte & 3; const gq = (byte >> 2) & 15;
      if (stage === 0) { ctx.fillStyle = '#8a6b45'; for (let k = 0; k < 3; k++) { dot(sx - 7 + k * 7, sy + 5, 1.5); } continue; }
      if (stage === 1) { ctx.fillStyle = p.crop === 'pima' ? '#3c7e57' : '#4f9a3c'; const r = 4 + (gq / 15) * 12; ctx.beginPath(); ctx.arc(sx, sy, r, 0, 6.283); ctx.fill(); continue; }
      ctx.fillStyle = p.crop === 'pima' ? '#2f6b48' : '#386b2d'; ctx.beginPath(); ctx.arc(sx, sy, 15, 0, 6.283); ctx.fill();
      ctx.fillStyle = p.crop === 'pima' ? '#fbf7ee' : '#f5f3ec';
      dot(sx - 6, sy - 4, 4); dot(sx + 6, sy - 4, 4); dot(sx, sy + 3, 4); dot(sx - 4, sy + 6, 3.4); dot(sx + 5, sy + 5, 3.4);
      if (p.crop === 'pima') { ctx.fillStyle = '#e6a92e'; dot(sx + 9, sy - 9, 2); }
    }
  }
  function drawGins() {
    for (const g of GINS) {
      const sx = g.x - cam.x, sy = g.y - cam.y;
      if (sx > VW || sy > VH || sx + g.w < 0 || sy + g.h < 0) continue;
      ctx.fillStyle = '#473322'; roundRect(sx - 10, sy - 10, g.w + 20, g.h + 20, 10); ctx.fill();
      const grd = ctx.createLinearGradient(0, sy, 0, sy + g.h); grd.addColorStop(0, '#7c5a36'); grd.addColorStop(1, '#5d4327');
      ctx.fillStyle = grd; roundRect(sx, sy, g.w, g.h, 8); ctx.fill();
      ctx.fillStyle = '#caa45f'; ctx.fillRect(sx, sy, g.w, 16);
      ctx.fillStyle = 'rgba(20,14,8,.5)'; for (let k = 0; k < 3; k++) { roundRect(sx + 16 + k * 54, sy + 32, 42, g.h - 46, 4); ctx.fill(); }
      ctx.fillStyle = '#f3ece0'; ctx.font = '800 15px Segoe UI, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('GIN', sx + g.w / 2, sy + 8.5);
      ctx.fillStyle = '#e6a92e'; ctx.font = '700 11px Segoe UI, sans-serif'; ctx.fillText('UNLOAD · REFUEL', sx + g.w / 2, sy + g.h + 4);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
  }
  function drawPicker(p) {
    const sx = p.x - cam.x, sy = p.y - cam.y;
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(p.a);
    ctx.fillStyle = 'rgba(0,0,0,.25)'; roundRect(-20, -15, 46, 30, 7); ctx.fill();
    ctx.fillStyle = COLORS[p.i % 4]; roundRect(-22, -16, 44, 32, 7); ctx.fill();
    ctx.fillStyle = ACCENTS[p.i % 4]; roundRect(20, -19, 12, 38, 3); ctx.fill();
    ctx.fillStyle = '#2a2a2a'; for (let t = -15; t <= 15; t += 7) ctx.fillRect(31, t - 1.5, 4, 3);
    ctx.fillStyle = '#1f2a33'; roundRect(-6, -11, 16, 22, 4); ctx.fill();
    ctx.fillStyle = 'rgba(150,200,230,.5)'; roundRect(-3, -8, 9, 16, 3); ctx.fill();
    ctx.fillStyle = '#3a2c1c'; roundRect(-20, -15, 12, 30, 3); ctx.fill();
    ctx.fillStyle = p.bf >= 1 ? '#e6a92e' : '#f3ece0'; const fh = 28 * clamp(p.bf, 0, 1); ctx.fillRect(-19, 14 - fh, 10, fh);
    ctx.restore();
    if (p.glow > 0) { ctx.strokeStyle = `rgba(230,169,46,${p.glow})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(sx, sy, 30, 0, 6.283); ctx.stroke(); }
    ctx.fillStyle = p.me ? '#fff' : 'rgba(255,255,255,.82)';
    ctx.font = (p.me ? '800 ' : '700 ') + '11px Segoe UI, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText((p.me ? '▾ ' : '') + p.name, sx, sy - 26); ctx.textAlign = 'left';
  }
  function drawHeadlight(p, night) {
    const sx = p.x - cam.x, sy = p.y - cam.y;
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(p.a);
    const grd = ctx.createRadialGradient(34, 0, 4, 34, 0, 90);
    grd.addColorStop(0, `rgba(255,240,190,${0.5 * night})`); grd.addColorStop(1, 'rgba(255,240,190,0)');
    ctx.fillStyle = grd; ctx.beginPath(); ctx.moveTo(28, -10); ctx.lineTo(120, -44); ctx.lineTo(120, 44); ctx.lineTo(28, 10); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  function drawParticles() {
    for (const q of particles) { if (q.k !== 'c') continue; const a = clamp(q.life / q.max, 0, 1); ctx.fillStyle = `rgba(248,246,238,${a})`; ctx.beginPath(); ctx.arc(q.x - cam.x, q.y - cam.y, q.r, 0, 6.283); ctx.fill(); }
  }
  function drawWeatherFX() {
    ctx.strokeStyle = 'rgba(180,205,235,.5)'; ctx.lineWidth = 1.5;
    for (const q of particles) { if (q.k !== 'r') continue; const x = q.x - cam.x, y = q.y - cam.y; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 3, y + 10); ctx.stroke(); }
  }
  function drawFloats() {
    ctx.textAlign = 'center';
    for (const f of floats) { const a = clamp(f.life / f.max, 0, 1); ctx.globalAlpha = a; ctx.fillStyle = f.c; ctx.font = '800 14px Segoe UI, sans-serif'; ctx.fillText(f.t, f.x - cam.x, f.y - cam.y); }
    ctx.globalAlpha = 1; ctx.textAlign = 'left';
  }

  function panel(x, y, w, h) { ctx.fillStyle = 'rgba(34,26,18,.84)'; roundRect(x, y, w, h, 10); ctx.fill(); }
  function drawHUD() {
    const me = ROLE === 'host' ? hostPublicSelf() : (netP[MY] || { score: 0, cash: 0, bf: 0, fuel: 100 });
    panel(12, 12, 196, 72);
    ctx.fillStyle = '#8a7355'; ctx.font = '700 10px Segoe UI, sans-serif'; ctx.fillText('YOUR SCORE', 24, 30);
    ctx.fillStyle = '#e6a92e'; ctx.font = '800 28px Segoe UI, sans-serif'; ctx.fillText(fmt(me.score), 24, 56);
    ctx.fillStyle = '#b8a988'; ctx.font = '600 11px Segoe UI, sans-serif'; ctx.fillText('Cash ' + fmt(me.cash) + '  ·  Goal ' + fmt(CFG.matchGoal), 24, 74);

    panel(12, 90, 196, 40);
    bar(24, 100, 160, 'Basket', me.bf, me.bf >= 1 ? '#e6a92e' : '#f3ece0');
    bar(24, 114, 160, 'Fuel', (me.fuel || 0) / 100, (me.fuel || 0) < 20 ? '#c45a3a' : '#6fae4a');

    const cw = 224, cx = (VW - cw) / 2;
    panel(cx, 12, cw, 58);
    const total = CFG.matchDays * CFG.dayLen; const tl = matchInfo.tl;
    ctx.fillStyle = '#8a7355'; ctx.font = '700 10px Segoe UI, sans-serif'; ctx.fillText('TIME LEFT', cx + 14, 28);
    ctx.fillStyle = '#3a2c1c'; roundRect(cx + 14, 33, cw - 90, 9, 5); ctx.fill();
    ctx.fillStyle = tl / total < 0.2 ? '#c45a3a' : '#6fae4a'; roundRect(cx + 14, 33, (cw - 90) * clamp(tl / total, 0, 1), 9, 5); ctx.fill();
    const mm = Math.floor(tl / 60), ss = Math.floor(tl % 60);
    ctx.fillStyle = '#d8c9aa'; ctx.font = '700 12px Segoe UI, sans-serif'; ctx.fillText('Day ' + matchInfo.day + '/' + CFG.matchDays, cx + 14, 56);
    ctx.fillText(mm + ':' + String(ss).padStart(2, '0'), cx + cw - 66, 28);
    ctx.fillStyle = '#6fae4a'; ctx.font = '800 16px Segoe UI, sans-serif'; ctx.fillText('$' + (CFG.basePrice * marketIndex()).toFixed(2) + '/u', cx + cw - 66, 52);
    const w = WEATHER[weatherType()]; drawWeatherIcon(w.icon, cx + cw - 14, 50);

    drawRanking();
  }
  function bar(x, y, w, label, frac, color) {
    ctx.fillStyle = '#b8a988'; ctx.font = '600 10px Segoe UI, sans-serif'; ctx.fillText(label, x, y + 8);
    ctx.fillStyle = '#3a2c1c'; roundRect(x + 44, y, w - 44, 8, 4); ctx.fill();
    ctx.fillStyle = color; roundRect(x + 44, y, (w - 44) * clamp(frac, 0, 1), 8, 4); ctx.fill();
  }
  function hostPublicSelf() { const p = H.players[MY]; const tot = p.cotton + p.pima; return { score: p.score, cash: p.cash, bf: clamp(tot / p.cap, 0, 1), fuel: p.fuel }; }
  function rankingData() {
    let arr;
    if (ROLE === 'host') arr = H.players.filter(p => p.alive || p.score > 0).map(p => ({ i: p.i, name: p.name, score: p.score }));
    else arr = netP.map((p, i) => ({ i, name: p.name, score: p.score })).filter(p => netP[p.i] && netP[p.i].alive);
    return arr.sort((a, b) => b.score - a.score);
  }
  function drawRanking() {
    const arr = rankingData(); if (!arr.length) return;
    const w = 176, rh = 22, h = 18 + arr.length * rh;
    const x = VW - w - 12, y = VH - h - 72;
    panel(x, y, w, h);
    ctx.fillStyle = '#8a7355'; ctx.font = '700 10px Segoe UI, sans-serif'; ctx.fillText('STANDINGS', x + 12, y + 15);
    arr.forEach((p, k) => {
      const ry = y + 18 + k * rh + 12;
      ctx.fillStyle = COLORS[p.i % 4]; dot(x + 16, ry - 3, 5);
      ctx.fillStyle = p.i === MY ? '#fff' : '#d8c9aa'; ctx.font = (p.i === MY ? '800 ' : '700 ') + '11px Segoe UI, sans-serif';
      ctx.fillText((k + 1) + '. ' + p.name, x + 28, ry);
      ctx.fillStyle = '#e6a92e'; ctx.textAlign = 'right'; ctx.fillText(fmt(p.score), x + w - 12, ry); ctx.textAlign = 'left';
    });
  }
  function drawMinimap() {
    const mw = 150, mh = mw * (WORLD.h / WORLD.w); const x = VW - mw - 12, y = 12;
    ctx.fillStyle = 'rgba(20,15,9,.8)'; roundRect(x - 4, y - 4, mw + 8, mh + 8, 8); ctx.fill();
    ctx.fillStyle = '#3f6e32'; roundRect(x, y, mw, mh, 5); ctx.fill();
    const sx = mw / WORLD.w, sy = mh / WORLD.h;
    if (world) for (const pa of world.patches) { ctx.fillStyle = 'rgba(94,65,40,.85)'; ctx.fillRect(x + pa.x * sx, y + pa.y * sy, pa.w * sx, pa.h * sy); }
    for (const g of GINS) { ctx.fillStyle = '#caa45f'; ctx.fillRect(x + g.x * sx - 1, y + g.y * sy - 1, Math.max(4, g.w * sx), Math.max(4, g.h * sy)); }
    ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1; ctx.strokeRect(x + cam.x * sx, y + cam.y * sy, VW * sx, VH * sy);
    for (const p of playersForRender()) { ctx.fillStyle = COLORS[p.i % 4]; ctx.beginPath(); ctx.arc(x + p.x * sx, y + p.y * sy, p.me ? 3.5 : 2.5, 0, 6.283); ctx.fill(); if (p.me) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke(); } }
  }
  function drawStick() {
    if (!stick.active) {
      ctx.globalAlpha = 0.25; ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(92, VH - 98, 58, 0, 6.283); ctx.fill();
      ctx.globalAlpha = 1; ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(92, VH - 98, 58, 0, 6.283); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = '700 10px Segoe UI'; ctx.textAlign = 'center'; ctx.fillText('DRIVE', 92, VH - 95); ctx.textAlign = 'left';
      return;
    }
    ctx.globalAlpha = 0.3; ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(stick.bx, stick.by, stick.R, 0, 6.283); ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(stick.bx, stick.by, stick.R, 0, 6.283); ctx.stroke();
    ctx.fillStyle = 'rgba(230,169,46,.9)'; ctx.beginPath(); ctx.arc(stick.kx, stick.ky, 26, 0, 6.283); ctx.fill();
  }
  function drawWeatherIcon(kind, x, y) {
    ctx.save(); ctx.translate(x, y);
    if (kind === 'sun') { ctx.fillStyle = '#e6a92e'; ctx.beginPath(); ctx.arc(0, 0, 6, 0, 6.283); ctx.fill(); }
    else if (kind === 'rain') { ctx.fillStyle = '#9bb0c8'; ctx.beginPath(); ctx.arc(0, -2, 6, 0, 6.283); ctx.fill(); ctx.strokeStyle = '#6f8db0'; ctx.lineWidth = 2; for (let i = -3; i <= 3; i += 3) { ctx.beginPath(); ctx.moveTo(i, 5); ctx.lineTo(i - 1, 9); ctx.stroke(); } }
    else if (kind === 'dry') { ctx.fillStyle = '#e0a13c'; ctx.beginPath(); ctx.arc(0, 0, 6, 0, 6.283); ctx.fill(); ctx.strokeStyle = '#c98f1e'; ctx.lineWidth = 1.5; for (let a = 0; a < 6; a++) { const an = a / 6 * 6.283; ctx.beginPath(); ctx.moveTo(Math.cos(an) * 8, Math.sin(an) * 8); ctx.lineTo(Math.cos(an) * 11, Math.sin(an) * 11); ctx.stroke(); } }
    else { ctx.fillStyle = '#7a8aa8'; ctx.beginPath(); ctx.arc(0, -2, 6, 0, 6.283); ctx.fill(); ctx.strokeStyle = '#e6c84a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, 3); ctx.lineTo(-3, 9); ctx.lineTo(1, 9); ctx.lineTo(-2, 14); ctx.stroke(); }
    ctx.restore();
  }
  function roundRect(x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function dot(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill(); }

  // ============================== MAIN LOOP ==============================
  let last = 0, sAcc = 0, pAcc = 0, iAcc = 0, rafId = null;
  function loop(now) {
    let dt = (now - last) / 1000; last = now; dt = Math.min(dt, 0.05);
    if (running) {
      gatherInput();
      if (ROLE === 'host') {
        hostUpdate(dt);
        if (running) {
          sAcc += dt; pAcc += dt;
          if (sAcc >= 1 / CFG.STATE_HZ) { sAcc = 0; broadcast(buildStateMsg()); }
          if (pAcc >= 1 / CFG.PLOT_HZ) { pAcc = 0; syncStagesFromHost(); broadcast(buildPlotMsg()); }
        }
      } else {
        if (predict) stepVehicle(predict, input.thr, input.steer, dt);
        if (predict && netP[MY] && netP[MY].alive) {
          const hx = predict.x + Math.cos(predict.angle) * 30, hy = predict.y + Math.sin(predict.angle) * 30; const R2 = predict.hr * predict.hr;
          if (Math.abs(predict.vel) > 12 && netP[MY].bf < 1) {
            const plots = world.plots;
            for (let i = 0; i < plots.length; i++) { if ((stages[i] & 3) !== 2) continue; const dx = plots[i].cx - hx, dy = plots[i].cy - hy; if (dx * dx + dy * dy < R2) { stages[i] = (stages[i] & ~3) | 0; puff(plots[i].cx, plots[i].cy); } }
          }
        }
        for (let i = 0; i < netP.length; i++) { if (i === MY) continue; const np = netP[i]; if (!np) continue; const rd = remoteDisp[i] || (remoteDisp[i] = { x: np.x, y: np.y, a: np.a }); rd.x += (np.x - rd.x) * Math.min(1, dt * 12); rd.y += (np.y - rd.y) * Math.min(1, dt * 12); rd.a = lerpAngle(rd.a, np.a, Math.min(1, dt * 12)); }
        iAcc += dt; if (iAcc >= 1 / CFG.INPUT_HZ) { iAcc = 0; if (clientConn && clientConn.open) clientConn.send({ t: 'i', thr: input.thr, steer: input.steer }); }
      }
      for (let i = particles.length - 1; i >= 0; i--) { const q = particles[i]; q.x += q.vx * dt; q.y += q.vy * dt; if (q.k === 'c') q.vy += 120 * dt; q.life -= dt; if (q.life <= 0 || q.y > cam.y + VH + 20) particles.splice(i, 1); }
      for (let i = floats.length - 1; i >= 0; i--) { const f = floats[i]; f.y -= dt * 22; f.life -= dt; if (f.life <= 0) floats.splice(i, 1); }
      const wt = weatherType(); if (wt === 'rain') { for (let i = 0; i < 2; i++) rainDrop(); } if (wt === 'storm') { for (let i = 0; i < 5; i++) rainDrop(); }
      render();
    }
    rafId = requestAnimationFrame(loop);
  }

  // ============================== SCREENS / lifecycle ==============================
  function enterGame() {
    emit('shop', false);
    particles = []; floats = []; remoteDisp = []; predict = null;
    if (ROLE === 'client') clientUp = { cap: 0, speed: 0, header: 0, unload: 0 };
    matchInfo = { day: 1, tl: CFG.matchDays * CFG.dayLen, mk: 1, w: 0 };
    emit('screen', 'playing');
    resize();
  }
  function showResults(rank, reason) {
    matchOver = true; running = false;
    emit('results', { rank, reason, isHost: ROLE === 'host' });
    emit('screen', 'results');
  }
  function leaveGame() {
    running = false; matchOver = false;
    try { if (clientConn) clientConn.close(); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
    peer = null; clientConn = null; hostConns = []; H = null; world = null; ROLE = null;
    keys.clear();
    emit('screen', 'menu'); menuStatus('');
  }

  // ---- shop API for React ----
  function getShopData() {
    const levels = ROLE === 'host' ? (H ? H.players[MY].up : {}) : clientUp;
    const cash = ROLE === 'host' ? (H ? H.players[MY].cash : 0) : (netP[MY] ? netP[MY].cash : 0);
    const items = Object.keys(SHOP).map(key => {
      const lvl = levels[key] || 0;
      const cost = Math.round(SHOP[key].base * Math.pow(1.7, lvl));
      return { key, name: SHOP[key].name, desc: SHOP[key].desc, level: lvl, cost, affordable: cash >= cost };
    });
    return { cash, items };
  }
  function buyUpgrade(key) {
    if (ROLE === 'host') { hostBuy(MY, key); return; }
    const cash = netP[MY] ? netP[MY].cash : 0;
    const lvl = clientUp[key] || 0;
    const cost = Math.round(SHOP[key].base * Math.pow(1.7, lvl));
    if (cash >= cost) { clientUp[key] = lvl + 1; if (clientConn && clientConn.open) clientConn.send({ t: 'buy', key }); }
  }

  // ---- input listeners (attached on mount, removed on unmount) ----
  const onKeyDown = e => { const k = e.key.toLowerCase(); if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault(); keys.add(k); };
  const onKeyUp = e => keys.delete(e.key.toLowerCase());
  const onBlur = () => keys.clear();
  const onResize = () => resize();
  const onPointerDown = e => {
    if (!running) return;
    const r = canvas.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < VW * 0.5 && y > VH * 0.45) { stick.active = true; stick.id = e.pointerId; stick.bx = x; stick.by = y; stick.kx = x; stick.ky = y; stick.out = { x: 0, y: 0 }; try { canvas.setPointerCapture(e.pointerId); } catch (err) {} }
  };
  const onPointerMove = e => {
    if (stick.active && e.pointerId === stick.id) {
      const r = canvas.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
      let dx = x - stick.bx, dy = y - stick.by; const d = Math.hypot(dx, dy);
      if (d > stick.R) { dx = dx / d * stick.R; dy = dy / d * stick.R; }
      stick.kx = stick.bx + dx; stick.ky = stick.by + dy;
      stick.out = { x: dx / stick.R, y: dy / stick.R };
    }
  };
  const onPointerUp = e => { if (e.pointerId === stick.id) { stick.active = false; stick.id = null; stick.out = { x: 0, y: 0 }; } };

  function mount() {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onResize);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    resize();
    emit('screen', 'menu');
    if (!NET_OK) menuStatus('peerjs failed to load — run `npm install peerjs`.', true);
    last = performance.now();
    rafId = requestAnimationFrame(loop);
  }
  function unmount() {
    if (rafId) cancelAnimationFrame(rafId);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', onResize);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    try { if (clientConn) clientConn.close(); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
    clearTimeout(openTimer);
  }

  return {
    mount, unmount,
    createGame: hostCreate,
    joinGame: clientJoin,
    startMatch: hostStartMatch,
    buyUpgrade,
    leaveGame,
    getShopData,
    config: { matchGoal: CFG.matchGoal, matchDays: CFG.matchDays },
  };
}
