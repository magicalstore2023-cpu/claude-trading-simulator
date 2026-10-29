// Claude Trading Simulator — bot crypto serveur (simulation, aucun argent réel).
// Lancé par GitHub Actions, se relance après chaque passage. Scanne tout le marché Binance (paires USDT liquides).
import fs from "node:fs";

const STATE_FILE = process.env.STATE_FILE || "state.json";
const RUN_MS = +(process.env.RUN_MS || 210000);
const TICK_MS = +(process.env.TICK_MS || 30000);

// ===== Paramètres =====
const START = 10000, FEE = 0.001, RISK = 0.01, MAXW = 0.16, MAXPOS = 6;
const DAY_LOSSES = 6, DAY_DD = 0.03, COOLDOWN = 3 * 60e3;
const MINVOL = 15e6;          // volume minimum sur 24 h (en dollars) pour qu'une crypto soit tradée
const UNIVERSE = 40;          // nombre de cryptos analysées à chaque passage (les plus échangées + les plus gros mouvements)
const VOL_X = 1.5, BOOK_X = 1.15, RR = 1.5;
const CORE = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT"];
// Exclus : stablecoins, monnaies classiques, jetons à effet de levier
const EXCLUDE = /^(USDC|FDUSD|TUSD|BUSD|USDP|DAI|USDE|USD1|EUR|EURI|AEUR|GBP|TRY|BRL|PAXG|WBTC|WBETH|BFUSD|XUSD|RLUSD)USDT$|(UP|DOWN|BULL|BEAR)USDT$/;
// Exclus aussi : actions et ETF tokenisés (pas des cryptos)
const STOCK_TOKENS = /^(INTC|SOXL|TSLA|NVDA|AAPL|MSFT|AMZN|META|GOOGL|GOOG|NFLX|AMD|COIN|MSTR|HOOD|CRCL|PLTR|SPY|QQQ|TQQQ|SQQQ|IWM|DIA|GLD|SLV|ORCL|AVGO|BABA|UBER)[A-Z]?USDT$/;

// ===== Outils =====
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sma = (a, n) => a.slice(-n).reduce((x, y) => x + y, 0) / n;
function ema(a, n) { const k = 2 / (n + 1); let e = a[0]; const out = [e]; for (let i = 1; i < a.length; i++) { e = a[i] * k + e * (1 - k); out.push(e) } return out }
function rsi(c, n = 14) { let g = 0, l = 0; for (let i = c.length - n; i < c.length; i++) { const d = c[i] - c[i - 1]; d > 0 ? g += d : l -= d } return l === 0 ? 100 : 100 - 100 / (1 + g / l) }
function atrB(b, n = 14) { let t = 0; for (let i = b.length - n; i < b.length; i++) t += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)); return t / n }
function trendDir(cl) { const e = ema(cl, 50), a = cl.at(-1), e1 = e.at(-1), e6 = e.at(-6); return a > e1 && e1 > e6 ? 1 : a < e1 && e1 < e6 ? -1 : 0 }
function crossed(c, dir) { for (let i = 1; i <= 3; i++) { const cc = c.slice(0, -i), a = sma(cc, 5), b = sma(cc, 20); if (dir > 0 ? a <= b : a >= b) return true } return false }
const f1 = v => v.toFixed(1).replace(".", ","), f2 = v => v.toFixed(2).replace(".", ",");
const pct = d => (d * 100).toFixed(2).replace(".", ",") + " %";
const dayIL = () => new Date().toLocaleDateString("fr-CA", { timeZone: "Asia/Jerusalem" });

async function getJSON(url, timeout = 10000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "claude-trading-simulator/1.0" } }); if (!r.ok) return null; return await r.json() }
  catch (e) { return null } finally { clearTimeout(t) }
}

// ===== Données : Binance (données publiques), sinon Coinbase =====
const BIN = "https://data-api.binance.vision";
const CB = "https://api.exchange.coinbase.com";
const cbId = s => s.replace("USDT", "") + "-USD";
const CB_LIST = ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","ADAUSDT","DOGEUSDT","LINKUSDT","AVAXUSDT","DOTUSDT","LTCUSDT","SHIBUSDT","PEPEUSDT","SUIUSDT","NEARUSDT","AAVEUSDT","UNIUSDT"];
let PROVIDER = "binance";

const binance = {
  async klines(s, iv, n) { const k = await getJSON(`${BIN}/api/v3/klines?symbol=${s}&interval=${iv}&limit=${n}`); return k ? k.map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })) : null },
  async depth(s) { const d = await getJSON(`${BIN}/api/v3/depth?symbol=${s}&limit=100`); return d ? { bids: d.bids.map(x => [+x[0], +x[1]]), asks: d.asks.map(x => [+x[0], +x[1]]) } : null },
  async tickers() {
    const v = await getJSON(`${BIN}/api/v3/ticker/24hr`, 20000); if (!Array.isArray(v)) return null;
    return v.filter(x => x.symbol.endsWith("USDT") && !EXCLUDE.test(x.symbol) && !STOCK_TOKENS.test(x.symbol) && +x.quoteVolume > 0 && +x.count > 0)
      .map(x => ({ s: x.symbol, vol: +x.quoteVolume, ch: +x.priceChangePercent / 100, last: +x.lastPrice }));
  },
  async eurusd() { const p = await getJSON(`${BIN}/api/v3/ticker/price?symbol=EURUSDT`); return p ? +p.price : null },
};
const coinbase = {
  async klines(s, iv, n) { const g = iv === "15m" ? 900 : 60; const k = await getJSON(`${CB}/products/${cbId(s)}/candles?granularity=${g}`); return Array.isArray(k) ? k.slice(0, n).reverse().map(x => ({ t: x[0] * 1000, l: +x[1], h: +x[2], o: +x[3], c: +x[4], v: +x[5] })) : null },
  async depth(s) { const d = await getJSON(`${CB}/products/${cbId(s)}/book?level=2`); return d && d.bids ? { bids: d.bids.slice(0, 200).map(x => [+x[0], +x[1]]), asks: d.asks.slice(0, 200).map(x => [+x[0], +x[1]]) } : null },
  async tickers() {
    const out = [];
    for (const s of CB_LIST) { const x = await getJSON(`${CB}/products/${cbId(s)}/stats`); if (x && +x.open) out.push({ s, vol: +x.volume * +x.last, ch: (+x.last - +x.open) / +x.open, last: +x.last }) }
    return out.length ? out : null;
  },
  async eurusd() { const x = await getJSON("https://api.frankfurter.app/latest?from=EUR&to=USD"); return x && x.rates ? +x.rates.USD : null },
};
let DP = binance;

// ===== État =====
function fresh() { return { cash: START, pos: {}, trades: [], eq: [[Date.now(), START]], start: Date.now(), day: { d: dayIL(), losses: 0, startEq: START }, cool: {}, P: {}, CH: {}, ST: {} } }
let S;
try { S = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) } catch (e) { S = null }
if (!S || typeof S.cash !== "number") S = fresh();
for (const k of ["cool", "P", "CH", "ST"]) if (!S[k]) S[k] = {};
delete S.td; delete S.orb; delete S.stStatus;
let FX = S.fx || null;
let HTF = {}, VOL24 = {};

const posVal = (s, p) => { const cur = S.P[s] || p.entry; return (p.dir || 1) > 0 ? p.qty * cur : p.cost + p.qty * (p.entry - cur) };
const equity = () => S.cash + Object.entries(S.pos).reduce((t, [s, p]) => t + posVal(s, p), 0);
const isPaused = () => S.day.losses >= DAY_LOSSES || equity() < S.day.startEq * (1 - DAY_DD);

function closePos(s, ex, why) {
  const p = S.pos[s], dir = p.dir || 1; let pnl;
  if (dir > 0) { const val = p.qty * ex * (1 - FEE); pnl = val - p.cost; S.cash += val }
  else { pnl = p.qty * (p.entry - ex) - p.qty * (p.entry + ex) * FEE; S.cash += p.cost + pnl }
  const R = p.risk ? pnl / p.risk : 0; if (pnl < 0) S.day.losses++;
  S.trades.unshift({ t: Date.now(), s, side: "SORTIE", dir, price: ex, qty: p.qty, amt: p.cost + pnl, pnl, R, why });
  delete S.pos[s]; S.cool[s] = Date.now(); S.ST[s] = "Position clôturée";
  console.log(`SORTIE ${s} ${why} ${pnl.toFixed(2)} €`);
}

function openPos(s, dir, pE, dist, why, lastT) {
  const eq = equity(), size = Math.min(eq * RISK / dist, eq * MAXW, S.cash);
  if (size < 50) { S.ST[s] = "Pas assez de cash"; return }
  const qty = dir > 0 ? size * (1 - FEE) / pE : size / pE;
  const stop = dir > 0 ? pE * (1 - dist) : pE * (1 + dist), tp = dir > 0 ? pE * (1 + RR * dist) : pE * (1 - RR * dist);
  S.cash -= size;
  S.pos[s] = { dir, qty, entry: pE, cost: size, risk: size * dist, stop, stop0: stop, tp, t: Date.now(), max: pE, min: pE, be: false, last: lastT };
  S.trades.unshift({ t: Date.now(), s, side: "ENTREE", dir, price: pE, qty, amt: size, pnl: null, why: `${why} · stop ${pct(dist)}, objectif ${pct(dist * RR)}` });
  S.ST[s] = dir > 0 ? "Entrée LONG ✓" : "Entrée SHORT ✓";
  console.log(`ENTREE ${s} ${dir > 0 ? "LONG" : "SHORT"} ${size.toFixed(2)} € — ${why}`);
}

// Gestion d'une position ouverte (long ou short), y compris ce qui s'est passé entre deux passages
function manage(s, bars, conv, maxHold) {
  const p = S.pos[s]; p.dir = p.dir || 1; if (p.min === undefined) p.min = p.entry; if (p.last === undefined) p.last = p.t;
  const stopWhy = p.be ? "Stop au point mort (trade protégé)" : "Stop-loss touché", tpWhy = `Objectif atteint (+${f1(RR)}R)`;
  const r1 = Math.abs(p.entry - p.stop0);
  const breakeven = () => { if (!p.be && ((p.dir > 0 && p.max >= p.entry + r1) || (p.dir < 0 && p.min <= p.entry - r1))) { p.stop = p.entry * (1 + (p.dir > 0 ? 2 : -2) * FEE); p.be = true } };
  for (let i = 0; i < bars.length - 1; i++) {
    const b = bars[i]; if (!(b.t > p.last)) continue;
    const lo = b.l / conv, hi = b.h / conv, op = b.o / conv;
    if (p.dir > 0) { if (lo <= p.stop) return closePos(s, Math.min(op, p.stop), stopWhy); if (hi >= p.tp) return closePos(s, Math.max(op, p.tp), tpWhy); p.max = Math.max(p.max, hi) }
    else { if (hi >= p.stop) return closePos(s, Math.max(op, p.stop), stopWhy); if (lo <= p.tp) return closePos(s, Math.min(op, p.tp), tpWhy); p.min = Math.min(p.min, lo) }
    breakeven();
  }
  const lc = bars.at(-2).t; if (lc > p.last) p.last = lc;
  const cur = bars.at(-1).c / conv;
  if (p.dir > 0) { if (cur <= p.stop) return closePos(s, cur, stopWhy); if (cur >= p.tp) return closePos(s, cur, tpWhy); p.max = Math.max(p.max, cur) }
  else { if (cur >= p.stop) return closePos(s, cur, stopWhy); if (cur <= p.tp) return closePos(s, cur, tpWhy); p.min = Math.min(p.min, cur) }
  breakeven();
  if (Date.now() - p.t > maxHold) return closePos(s, cur, `Durée max ${maxHold / 60e3} min`);
  const c = bars.map(b => b.c), f = sma(c, 5), sl = sma(c, 20);
  if (p.dir > 0 && f < sl && cur < p.entry) return closePos(s, cur, "Tendance retournée, sortie avant le stop");
  if (p.dir < 0 && f > sl && cur > p.entry) return closePos(s, cur, "Tendance retournée, sortie avant le stop");
  S.ST[s] = p.dir > 0 ? "En position LONG" : "En position SHORT";
}

async function htf(s) {
  if (HTF[s] !== undefined) return HTF[s];
  const k = await DP.klines(s, "15m", 80); if (!k || k.length < 60) return 0;
  return HTF[s] = trendDir(k.map(x => x.c));
}
async function bookRatio(s) {
  const d = await DP.depth(s); if (!d || !d.bids.length || !d.asks.length) return 0;
  const mid = (d.bids[0][0] + d.asks[0][0]) / 2;
  const bid = d.bids.filter(x => x[0] >= mid * 0.995).reduce((t, x) => t + x[0] * x[1], 0);
  const ask = d.asks.filter(x => x[0] <= mid * 1.005).reduce((t, x) => t + x[0] * x[1], 0);
  return ask ? bid / ask : 0;
}

// Stratégie tendance + volume « baleine » (long ou short)
async function evaluate(s, bars, conv, paused) {
  const fail = m => { S.ST[s] = m };
  if (paused) return fail("Pause du jour (limite de pertes)");
  if (Object.keys(S.pos).length >= MAXPOS) return fail(`${MAXPOS} positions déjà ouvertes`);
  if (S.cool[s] && Date.now() - S.cool[s] < COOLDOWN) return fail("Pause de 3 min après sortie");
  const c = bars.map(b => b.c), vol = bars.map(b => b.v), price = c.at(-1), f = sma(c, 5), sl = sma(c, 20);
  let dir = 0; if (f > sl && crossed(c, 1)) dir = 1; else if (f < sl && crossed(c, -1)) dir = -1;
  if (!dir) return fail("Pas de croisement");
  const vNow = sma(vol, 3), vAvg = vol.slice(-23, -3).reduce((a, b) => a + b, 0) / 20, vx = vAvg ? vNow / vAvg : 0;
  const mom = dir > 0 ? price > c.at(-4) : price < c.at(-4);
  if (vx < VOL_X || !mom) return fail(`Volume normal (${f1(vx)}×)`);
  const r = rsi(c);
  if (dir > 0 && (r < 45 || r > 70)) return fail(`RSI hors zone long (${r.toFixed(0)})`);
  if (dir < 0 && (r < 30 || r > 55)) return fail(`RSI hors zone short (${r.toFixed(0)})`);
  if ((await htf(s)) !== dir) return fail(dir > 0 ? "Tendance de fond pas haussière" : "Tendance de fond pas baissière");
  const ratio = await bookRatio(s), bx = dir > 0 ? ratio : (ratio ? 1 / ratio : 0);
  if (bx < BOOK_X) return fail(`Carnet pas assez ${dir > 0 ? "acheteur" : "vendeur"} (${f2(bx)}×)`);
  if (S.pos[s] || Object.keys(S.pos).length >= MAXPOS) return;
  const dist = Math.min(0.015, Math.max(0.003, 1.5 * atrB(bars) / price));
  openPos(s, dir, price / conv, dist,
    `${dir > 0 ? "Long" : "Short"} · volume ${f1(vx)}×, carnet ${f2(bx)}× ${dir > 0 ? "acheteur" : "vendeur"}, RSI ${r.toFixed(0)}, tendance de fond ${dir > 0 ? "haussière" : "baissière"}`,
    bars.at(-1).t);
}

// ===== Choix des cryptos à analyser =====
let WATCH = [];
async function scanMarket() {
  let t = await binance.tickers();
  if (t && t.length) { DP = binance; PROVIDER = "binance" } else { DP = coinbase; PROVIDER = "coinbase"; t = await coinbase.tickers() || [] }
  VOL24 = {}; t.forEach(x => VOL24[x.s] = x.vol);
  const liquid = t.filter(x => x.vol >= MINVOL);
  const byVol = liquid.slice().sort((a, b) => b.vol - a.vol);
  const byMove = liquid.slice().sort((a, b) => Math.abs(b.ch) - Math.abs(a.ch));
  const set = new Set([...Object.keys(S.pos), ...CORE.filter(s => VOL24[s] !== undefined)]);
  for (const x of byMove) { if (set.size >= Math.floor(UNIVERSE * 0.4) + CORE.length) break; set.add(x.s) }   // les plus gros mouvements du jour
  for (const x of byVol) { if (set.size >= UNIVERSE) break; set.add(x.s) }                                    // complété par les plus échangées
  WATCH = [...set];
  // Radar des opportunités : plus gros mouvements sur 24 h parmi les cryptos liquides
  S.radar = byMove.slice(0, 10).map(x => ({ s: x.s, ch: x.ch, vol: x.vol }));
  S.scanned = { total: t.length, liquid: liquid.length, watched: WATCH.length };
  for (const s of Object.keys(S.ST)) if (!WATCH.includes(s)) { delete S.ST[s]; delete S.P[s]; delete S.CH[s] }
}

async function tick() {
  const fx = await DP.eurusd(); if (fx) FX = fx; if (!FX) { console.log("Pas de taux EUR/USD"); return }
  if (S.day.d !== dayIL()) S.day = { d: dayIL(), losses: 0, startEq: equity() };
  const paused = isPaused();
  for (const s of WATCH) {
    try {
      const bars = await DP.klines(s, "1m", 60); if (!bars || bars.length < 30) { S.ST[s] = "Données indisponibles"; continue }
      S.P[s] = bars.at(-1).c / FX; S.CH[s] = (bars.at(-1).c - bars[0].o) / bars[0].o;
      if (S.pos[s]) { manage(s, bars, FX, 30 * 60e3); continue }
      await evaluate(s, bars, FX, paused);
    } catch (e) { console.log("erreur", s, e.message) }
  }
}

async function main() {
  const t0 = Date.now();
  await scanMarket();
  console.log(`Marché : ${S.scanned.total} paires, ${S.scanned.liquid} liquides, ${WATCH.length} analysées · source ${PROVIDER}`);
  while (true) {
    await tick();
    S.eq.push([Date.now(), equity()]);
    if (S.eq.length > 3000) S.eq = S.eq.filter((_, i) => i % 2 === 0);
    if (S.trades.length > 1000) S.trades.length = 1000;
    S.updated = Date.now(); S.provider = PROVIDER; S.fx = FX;
    fs.writeFileSync(STATE_FILE, JSON.stringify(S));
    if (Date.now() - t0 + TICK_MS > RUN_MS) break;
    await sleep(TICK_MS);
  }
  console.log(`Fin du passage · portefeuille ${equity().toFixed(2)} € · ${Object.keys(S.pos).length} position(s)`);
}
main().catch(e => { console.error(e); process.exit(1) });
