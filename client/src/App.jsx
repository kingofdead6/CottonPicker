import { useEffect, useRef, useState, useCallback } from 'react';
import { createEngine } from './game/engine.js';
import './styles.css';

const COLORS = ['#4c8c2b', '#c0392b', '#2f81c4', '#d59b2a'];
const fmt = n => '$' + Math.round(n || 0).toLocaleString('en-US');

export default function App() {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);

  const [screen, setScreen] = useState('menu');            // menu | lobby | playing | results
  const [joinMode, setJoinMode] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [menuMsg, setMenuMsg] = useState({ text: '', err: false });
  const [lobby, setLobby] = useState({ players: [], code: '----', isHost: false, myIndex: 0 });
  const [lobbyMsg, setLobbyMsg] = useState({ text: '', err: false });
  const [results, setResults] = useState({ rank: [], reason: 'time', isHost: false });
  const [shopOpen, setShopOpen] = useState(false);
  const [shopData, setShopData] = useState({ cash: 0, items: [] });
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);

  // ---- mount the engine once ----
  useEffect(() => {
    const engine = createEngine(canvasRef.current, (ev, payload) => {
      switch (ev) {
        case 'screen': setScreen(payload); if (payload !== 'playing') setShopOpen(false); break;
        case 'menustatus': setMenuMsg(payload); break;
        case 'lobbystatus': setLobbyMsg(payload); break;
        case 'lobby': setLobby(payload); break;
        case 'results': setResults(payload); break;
        case 'shop': setShopOpen(!!payload); break;
        case 'toast':
          setToast(payload);
          clearTimeout(toastTimer.current);
          toastTimer.current = setTimeout(() => setToast(''), 2600);
          break;
        default: break;
      }
    });
    engineRef.current = engine;
    engine.mount();
    return () => { engine.unmount(); clearTimeout(toastTimer.current); };
  }, []);

  // ---- refresh shop data while it is open ----
  useEffect(() => {
    if (!shopOpen) return;
    const refresh = () => setShopData(engineRef.current.getShopData());
    refresh();
    const id = setInterval(refresh, 250);
    return () => clearInterval(id);
  }, [shopOpen]);

  const eng = () => engineRef.current;
  const createGame = () => eng().createGame(name.trim() || 'Player');
  const joinGame = () => eng().joinGame(name.trim() || 'Player', code.trim().toUpperCase());
  const buy = useCallback((key) => { eng().buyUpgrade(key); setShopData(eng().getShopData()); }, []);
  const leave = () => { if (window.confirm('Leave the game?')) eng().leaveGame(); };

  const goal = eng()?.config?.matchGoal ?? 4000;

  return (
    <div className="wrap">
      <canvas ref={canvasRef} className="game-canvas" />

      {/* in-game on-screen buttons */}
      {screen === 'playing' && (
        <>
          <button className="gbtn shop-btn" onClick={() => setShopOpen(true)}>Upgrades</button>
          <button className="gbtn leave-btn" onClick={leave}>Leave ✕</button>
        </>
      )}

      {toast && <div className="toast">{toast}</div>}

      {/* ---------------- MENU ---------------- */}
      {screen === 'menu' && (
        <div className="overlay">
          <div className="card">
            <div className="eyebrow">Online · Up to 4 players · Race to the goal</div>
            <h1>Cotton<br />Picker Sim</h1>
            <p className="lede">A real-time cotton-harvest race. Drive your picker across a wide-open field, fill the basket, and run loads to the gin faster than your rivals. First to bank the season's cash goal wins — or be on top when the clock runs out. Fields are shared, so the ripe cotton goes to whoever gets there first.</p>

            <label className="fld" htmlFor="nameInput">Your name</label>
            <input id="nameInput" className="txt" maxLength={12} placeholder="e.g. Dusty"
              value={name} onChange={e => setName(e.target.value)} autoComplete="off" />

            <div className="row">
              <button className="btn primary" onClick={() => { setJoinMode(false); createGame(); }}>Create game</button>
              <button className="btn" onClick={() => setJoinMode(v => !v)}>Join with code</button>
            </div>

            {joinMode && (
              <div>
                <label className="fld" htmlFor="codeInput">Enter game code</label>
                <input id="codeInput" className="txt code" maxLength={4} placeholder="••••"
                  value={code} onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                  autoComplete="off" autoCapitalize="characters" />
                <div className="row"><button className="btn primary" onClick={joinGame}>Connect</button></div>
              </div>
            )}
            <div className={'status' + (menuMsg.err ? ' err' : '')}>{menuMsg.text}</div>
          </div>
        </div>
      )}

      {/* ---------------- LOBBY ---------------- */}
      {screen === 'lobby' && (
        <div className="overlay">
          <div className="card">
            <div className="eyebrow">{lobby.isHost ? 'Waiting room — share the code' : 'Waiting room'}</div>
            <h2>{lobby.isHost ? 'Your game lobby' : 'You joined the game'}</h2>

            {lobby.isHost && (
              <div className="codebox">
                <div className="lbl">Share this code</div>
                <div className="code">{lobby.code || '----'}</div>
              </div>
            )}

            <ul className="players">
              {lobby.players.map(p => (
                <li key={p.i}>
                  <span className="dot" style={{ background: COLORS[p.i % 4] }} />
                  {p.name || ('Player ' + (p.i + 1))}
                  <span className="tag">{p.i === 0 ? 'Host' : 'Player ' + (p.i + 1)}{p.i === lobby.myIndex ? ' · you' : ''}</span>
                </li>
              ))}
            </ul>

            <div className={'status' + (lobbyMsg.err ? ' err' : '')}>{lobbyMsg.text}</div>
            <div className="row">
              {lobby.isHost && <button className="btn primary" onClick={() => eng().startMatch()}>Start match</button>}
              <button className="btn ghost" onClick={() => eng().leaveGame()}>Leave</button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- SHOP ---------------- */}
      {screen === 'playing' && shopOpen && (
        <div className="overlay">
          <div className="card">
            <div className="eyebrow">Equipment yard — the race keeps running</div>
            <h2>Upgrades <span className="wallet">{fmt(shopData.cash)}</span></h2>
            <p className="lede" style={{ marginBottom: 10 }}>Spend cash to out-harvest your rivals. Buying doesn't lower your score — only your spendable cash.</p>
            <div className="shop-grid">
              {shopData.items.map(it => (
                <div className="item" key={it.key}>
                  <div className="top"><span className="nm">{it.name}</span><span className="lv">Lv {it.level}</span></div>
                  <div className="ds">{it.desc}</div>
                  <button className="btn primary" disabled={!it.affordable} onClick={() => buy(it.key)}>
                    {it.affordable ? 'Buy · ' + fmt(it.cost) : 'Need ' + fmt(it.cost)}
                  </button>
                </div>
              ))}
            </div>
            <div className="row"><button className="btn primary" onClick={() => setShopOpen(false)}>Back to the field</button></div>
          </div>
        </div>
      )}

      {/* ---------------- RESULTS ---------------- */}
      {screen === 'results' && (
        <div className="overlay">
          <div className="card">
            <div className="eyebrow">{results.reason === 'goal' ? 'Goal reached' : "Time's up"}</div>
            <h2>Final standings</h2>
            <ul className="rank">
              {results.rank.map((p, k) => (
                <li key={p.i} className={k === 0 ? 'win' : ''}>
                  <span className="pos">{k + 1}</span>
                  <span className="dot" style={{ background: COLORS[p.i % 4] }} />
                  <span>{p.name}{p.i === lobby.myIndex ? ' (you)' : ''}</span>
                  {k === 0 && <span className="crown">👑</span>}
                  <span className="sc">{fmt(p.score)}</span>
                </li>
              ))}
            </ul>
            <div className="row">
              {results.isHost && <button className="btn primary" onClick={() => eng().startMatch()}>Rematch</button>}
              <button className="btn ghost" onClick={() => eng().leaveGame()}>Leave to menu</button>
            </div>
            {!results.isHost && <div className="status">Waiting for the host to start a rematch…</div>}
          </div>
        </div>
      )}
    </div>
  );
}
