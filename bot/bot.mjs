// Claude Trading Simulator — bot serveur (simulation, aucun argent réel).
// Lancé par GitHub Actions toutes les 5 minutes. Lit l'état, trade pendant ~3,5 min, réécrit l'état.
import fs from "node:fs";

const STATE_FILE = process.env.STATE_FILE || "state.json";
const RUN_MS = +(process.env.RUN_MS || 210000);
const TICK_MS = +(process.env.TICK_MS || 30000);
const TD_KEY = (process.env.TWELVEDATA_KEY || "").trim();

// ===== Paramètres =====
const START = 10000, FEE = 0.001, RISK = 0.01, MAXW = 0.16, MAXPOS = 6;
const DAY_LOSSES = 6, DAY_DD = 0.03, COOLDOWN = 3 * 60e3, MINVOL = 50e6;
const VOL_X = 1.5, BOOK_X = 1.15, RR = 1.5;
const CRYPTO = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","ADAUSDT","DOGEUSDT","LINKUSDT","AVAXUSDT","DOTUSDT","LTCUSDT","TRXUSDT"];
const STOCKS = ["SPY","QQQ","DIA","AAPL","NVDA","MSFT","TSLA","AMZN","META"];
const isStock = s => STOCKS.includes(s);
const TD_DAY_MAX = 780;

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

// ===== Données crypto : Binance (données publiques), sinon Coinbase =====
const BIN = "https://data-api.binance.vision";
const CB = "https://api.exchange.coinbase.com";
const cbId = s => s.replace("USDT", "") + "-USD";
const CB_OK = new Set(["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","ADAUSDT","DOGEUSDT","LINKUSDT","AVAXUSDT","DOTUSDT","LTCUSDT"]);
let PROVIDER = "binance";

const binance = {
  async klines(s, iv, n) { const k = await getJSON(`${BIN}/api/v3/klines?symbol=${s}&interval=${iv}&limit=${n}`); return k ? k.map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })) : null },
  async depth(s) { const d = await getJSON(`${BIN}/api/v3/depth?symbol=${s}&limit=100`); return d ? { bids: d.bids.map(x => [+x[0], +x[1]]), asks: d.asks.map(x => [+x[0], +x[1]]) } : null },
  async vol24() { const v = await getJSON(`${BIN}/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(CRYPTO))}`); if (!v) return null; const m = {}; v.forEach(x => m[x.symbol] = +x.quoteVolume); return m },
  async eurusd() { const p = await getJSON(`${BIN}/api/v3/ticker/price?symbol=EURUSDT`); return p ? +p.price : null },
  has: () => true,
};
const coinbase = {
  async klines(s, iv, n) { const g = iv === "15m" ? 900 : 60; const k = await getJSON(`${CB}/products/${cbId(s)}/candles?granularity=${g}`); return Array.isArray(k) ? k.slice(0, n).reverse().map(x => ({ t: x[0] * 1000, l: +x[1], h: +x[2], o: +x[3], c: +x[4], v: +x[5] })) : null },
  async depth(s) { const d = await getJSON(`${CB}/products/${cbId(s)}/book?level=2`); return d && d.bids ? { bids: d.bids.slice(0, 200).map(x => [+x[0], +x[1]]), asks: d.asks.slice(0, 200).map(x => [+x[0], +x[1]]) } : null },
  async vol24() { const m = {}; for (const s of CRYPTO) { if (!CB_OK.has(s)) continue; const x = await getJSON(`${CB}/products/${cbId(s)}/stats`); if (x) m[s] = +x.volume * +x.last } return m },
  async eurusd() { const x = await getJSON("https://api.frankfurter.app/latest?from=EUR&to=USD"); return x && x.rates ? +x.rates.USD : null },
  has: s => CB_OK.has(s),
};
let DP = binance;
async function pickProvider() {
  const k = await binance.klines("BTCUSDT", "1m", 5);
  if (k && k.length) { DP = binance; PROVIDER = "binance" } else { DP = coinbase; PROVIDER = "coinbase" }
}

// ===== État =====
function fresh() { return { cash: START, pos: {}, trades: [], eq: [[Date.now(), START]], start: Date.now(), day: { d: dayIL(), losses: 0, startEq: START }, cool: {}, td: { d: "", used: 0 }, orb: {}, P: {}, CH: {}, ST: {} } }
let S;
try { S = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) } catch (e) { S = null }
if (!S || typeof S.cash !== "number") S = fresh();
for (const k of ["cool", "orb", "P", "CH", "ST"]) if (!S[k]) S[k] = {};
if (!S.td) S.td = { d: "", used: 0 };
let FX = S.fx || null;
const P = S.P, CH = S.CH, ST = S.ST;
let HTF = {}, VOL24 = {};

const posVal = (s, p) => { const cur = P[s] || p.entry; return (p.dir || 1) > 0 ? p.qty * cur : p.cost + p.qty * (p.entry - cur) };
const equity = () => S.cash + Object.entries(S.pos).reduce((t, [s, p]) => t + posVal(s, p), 0);
const isPaused = () => S.day.losses >= DAY_LOSSES || equity() < S.day.startEq * (1 - DAY_DD);

function closePos(s, ex, why) {
  const p = S.pos[s], dir = p.dir || 1; let pnl;
  if (dir > 0) { const val = p.qty * ex * (1 - FEE); pnl = val - p.cost; S.cash += val }
  else { pnl = p.qty * (p.entry - ex) - p.qty * (p.entry + ex) * FEE; S.cash += p.cost + pnl }
  const R = p.risk ? pnl / p.risk : 0; if (pnl < 0) S.day.losses++;
  S.trades.unshift({ t: Date.now(), s, side: "SORTIE", dir, price: ex, qty: p.qty, amt: p.cost + pnl, pnl, R, why });
  delete S.pos[s]; S.cool[s] = Date.now(); ST[s] = "Position clôturée";
  console.log(`SORTIE ${s} ${why} ${pnl.toFixed(2)} €`);
}

function openPos(s, dir, pE, dist, why, lastT) {
  const eq = equity(), size = Math.min(eq * RISK / dist, eq * MAXW, S.cash);
  if (size < 50) { ST[s] = "Pas assez de cash"; return }
  const qty = dir > 0 ? size * (1 - FEE) / pE : size / pE;
  const stop = dir > 0 ? pE * (1 - dist) : pE * (1 + dist), tp = dir > 0 ? pE * (1 + RR * dist) : pE * (1 - RR * dist);
  S.cash -= size;
  S.pos[s] = { dir, qty, entry: pE, cost: size, risk: size * dist, stop, stop0: stop, tp, t: Date.now(), max: pE, min: pE, be: false, last: lastT };
  S.trades.unshift({ t: Date.now(), s, side: "ENTREE", dir, price: pE, qty, amt: size, pnl: null, why: `${why} · stop ${pct(dist)}, objectif ${pct(dist * RR)}` });
  ST[s] = dir > 0 ? "Entrée LONG ✓" : "Entrée SHORT ✓";
  console.log(`ENTREE ${s} ${dir > 0 ? "LONG" : "SHORT"} ${size.toFixed(2)} € — ${why}`);
}

// Gestion d'une position ouverte (long ou short), y compris ce qui s'est passé entre deux passages
function manage(s, bars, conv, o) {
  const p = S.pos[s]; p.dir = p.dir || 1; if (p.min === undefined) p.min = p.entry;
  if (p.last === undefined) p.last = isStock(s) ? bars.at(-1).t : p.t;
  const stopWhy = p.be ? "Stop au point mort (trade protégé)" : "Stop-loss touché", tpWhy = `Objectif atteint (+${f1(RR)}R)`;
  for (let i = 0; i < bars.length - 1; i++) {
    const b = bars[i]; if (!(b.t > p.last)) continue;
    const lo = b.l / conv, hi = b.h / conv, op = b.o / conv;
    if (p.dir > 0) { if (lo <= p.stop) return closePos(s, Math.min(op, p.stop), stopWhy); if (hi >= p.tp) return closePos(s, Math.max(op, p.tp), tpWhy); p.max = Math.max(p.max, hi) }
    else { if (hi >= p.stop) return closePos(s, Math.max(op, p.stop), stopWhy); if (lo <= p.tp) return closePos(s, Math.min(op, p.tp), tpWhy); p.min = Math.min(p.min, lo) }
    const r1 = Math.abs(p.entry - p.stop0);
    if (!p.be && ((p.dir > 0 && p.max >= p.entry + r1) || (p.dir < 0 && p.min <= p.entry - r1))) { p.stop = p.entry * (1 + (p.dir > 0 ? 2 : -2) * FEE); p.be = true }
  }
  const lc = bars.at(-2).t; if (lc > p.last) p.last = lc;
  const cur = bars.at(-1).c / conv;
  if (p.dir > 0) { if (cur <= p.stop) return closePos(s, cur, stopWhy); if (cur >= p.tp) return closePos(s, cur, tpWhy); p.max = Math.max(p.max, cur) }
  else { if (cur >= p.stop) return closePos(s, cur, stopWhy); if (cur <= p.tp) return closePos(s, cur, tpWhy); p.min = Math.min(p.min, cur) }
  const r1 = Math.abs(p.entry - p.stop0);
  if (!p.be && ((p.dir > 0 && p.max >= p.entry + r1) || (p.dir < 0 && p.min <= p.entry - r1))) { p.stop = p.entry * (1 + (p.dir > 0 ? 2 : -2) * FEE); p.be = true }
  if (o.forceClose) return closePos(s, cur, "Clôture avant la fermeture de la bourse");
  if (Date.now() - p.t > o.maxHold) return closePos(s, cur, `Durée max ${o.maxHold / 60e3} min`);
  const c = bars.map(b => b.c), f = sma(c, 5), sl = sma(c, 20);
  if (p.dir > 0 && f < sl && cur < p.entry) return closePos(s, cur, "Tendance retournée, sortie avant le stop");
  if (p.dir < 0 && f > sl && cur > p.entry) return closePos(s, cur, "Tendance retournée, sortie avant le stop");
  ST[s] = p.dir > 0 ? "En position LONG" : "En position SHORT";
}

function gate(s, o) {
  if (o.paused) return "Pause du jour (limite de pertes)";
  if (Object.keys(S.pos).length >= MAXPOS) return `${MAXPOS} positions déjà ouvertes`;
  if (S.cool[s] && Date.now() - S.cool[s] < COOLDOWN) return "Pause de 3 min après sortie";
  if (o.noEntry) return o.noEntry;
  return null;
}

// Stratégie tendance + volume « baleine » (long ou short)
async function evaluate(s, bars, conv, o) {
  const g = gate(s, o); if (g) { ST[s] = g; return }
  const c = bars.map(b => b.c), vol = bars.map(b => b.v), price = c.at(-1), f = sma(c, 5), sl = sma(c, 20);
  let dir = 0; if (f > sl && crossed(c, 1)) dir = 1; else if (f < sl && crossed(c, -1)) dir = -1;
  if (!dir) { ST[s] = "Pas de croisement"; return }
  const vNow = sma(vol, 3), vAvg = vol.slice(-23, -3).reduce((a, b) => a + b, 0) / 20, vx = vAvg ? vNow / vAvg : 0;
  const mom = dir > 0 ? price > c.at(-4) : price < c.at(-4);
  if (vx < VOL_X || !mom) { ST[s] = `Volume normal (${f1(vx)}×)`; return }
  const r = rsi(c);
  if (dir > 0 && (r < 45 || r > 70)) { ST[s] = `RSI hors zone long (${r.toFixed(0)})`; return }
  if (dir < 0 && (r < 30 || r > 55)) { ST[s] = `RSI hors zone short (${r.toFixed(0)})`; return }
  if ((await o.trend()) !== dir) { ST[s] = dir > 0 ? "Tendance de fond pas haussière" : "Tendance de fond pas baissière"; return }
  let bx = null;
  if (o.book) {
    const ratio = await o.book(); bx = dir > 0 ? ratio : (ratio ? 1 / ratio : 0);
    if (bx < BOOK_X) { ST[s] = `Carnet pas assez ${dir > 0 ? "acheteur" : "vendeur"} (${f2(bx)}×)`; return }
  }
  if (S.pos[s] || Object.keys(S.pos).length >= MAXPOS) return;
  const dist = Math.min(o.dmax, Math.max(o.dmin, 1.5 * atrB(bars) / price));
  openPos(s, dir, price / conv, dist,
    `${dir > 0 ? "Long" : "Short"} · volume ${f1(vx)}×${bx !== null ? `, carnet ${f2(bx)}× ${dir > 0 ? "acheteur" : "vendeur"}` : ""}, RSI ${r.toFixed(0)}, tendance de fond ${dir > 0 ? "haussière" : "baissière"}`,
    bars.at(-1).t);
}

async function htfCrypto(s) {
  const c = HTF[s]; if (c) return c;
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

// ===== Crypto =====
async function cryptoTick() {
  const fx = await DP.eurusd(); if (fx) FX = fx; if (!FX) { console.log("Pas de taux EUR/USD"); return }
  if (S.day.d !== dayIL()) S.day = { d: dayIL(), losses: 0, startEq: equity() };
  const paused = isPaused();
  for (const s of CRYPTO) {
    try {
      if (!DP.has(s)) { if (S.pos[s]) ST[s] = "Données indisponibles"; else ST[s] = "Non disponible chez le fournisseur de secours"; continue }
      const bars = await DP.klines(s, "1m", 60); if (!bars || bars.length < 30) { ST[s] = "Données indisponibles"; continue }
      P[s] = bars.at(-1).c / FX; CH[s] = (bars.at(-1).c - bars[0].o) / bars[0].o;
      if (S.pos[s]) { manage(s, bars, FX, { maxHold: 30 * 60e3 }); continue }
      if (VOL24[s] !== undefined && VOL24[s] < MINVOL) { ST[s] = "Liquidité trop faible"; continue }
      await evaluate(s, bars, FX, { paused, trend: () => htfCrypto(s), book: () => bookRatio(s), dmin: 0.003, dmax: 0.012 });
    } catch (e) { console.log("erreur", s, e.message) }
  }
}

// ===== Bourse US (Twelve Data, bougies 5 min) =====
function ny() { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })); return { day: d.getDay(), m: d.getHours() * 60 + d.getMinutes(), date: d.toLocaleDateString("fr-CA") } }
function mkt() { const n = ny(); if (n.day === 0 || n.day === 6 || n.m < 570 || n.m >= 960) return "closed"; if (n.m >= 950) return "closing"; if (n.m >= 930) return "late"; if (n.m < 585) return "opening"; return "open" }

// Cassure du range d'ouverture (15 premières minutes), long au-dessus, short en dessous
function orbSignal(s, bars) {
  const n = ny(), day = n.date; if (S.orb[s] === day) return null;
  const today = bars.filter(b => b.t.startsWith(day)), rng = today.filter(b => b.t.slice(11, 16) < "09:45");
  if (rng.length < 3) return null;
  const hi = Math.max(...rng.map(b => b.h)), lo = Math.min(...rng.map(b => b.l)), mid = (hi + lo) / 2;
  const closed = today.filter(b => b.t.slice(11, 16) >= "09:45").slice(0, -1);   // la dernière bougie est encore en cours
  if (!closed.length) return null;
  let first = null;
  for (const b of closed) { if (b.c > hi) { first = { b, dir: 1 }; break } if (b.c < lo) { first = { b, dir: -1 }; break } }
  if (!first) return null;
  S.orb[s] = day;                                       // un seul signal par action et par jour
  if (first.b !== closed.at(-1)) return { late: true }; // cassure déjà ancienne : on ne court pas après
  const entry = bars.at(-1).c, dist = Math.abs(entry - mid) / entry;
  if (dist > 0.015) return { wide: true };
  return { dir: first.dir, dist: Math.max(0.003, dist), hi, lo };
}

async function fetchTD(batch) {
  const d = await getJSON(`https://api.twelvedata.com/time_series?symbol=${batch.join(",")}&interval=5min&outputsize=80&apikey=${encodeURIComponent(TD_KEY)}`, 20000);
  S.td.used += batch.length;
  if (!d) return { err: "Connexion à Twelve Data impossible" };
  if (d.status === "error") return { err: "Erreur Twelve Data : " + String(d.message || "").slice(0, 140) };
  return { map: batch.length === 1 ? { [batch[0]]: d } : d };
}

async function stockBatch(batch) {
  const m = mkt();
  if (m === "closed") {
    for (const s of STOCKS) if (S.pos[s]) closePos(s, P[s] || S.pos[s].entry, "Clôture de fin de séance");
    S.stStatus = "Bourse US fermée. Ouverture du lundi au vendredi, 9h30–16h00 heure de New York.";
    return;
  }
  if (!TD_KEY) { S.stStatus = "Clé Twelve Data à ajouter sur GitHub pour activer la bourse."; return }
  if (!FX) return;
  if (S.td.d !== dayIL()) S.td = { d: dayIL(), used: 0 };
  if (S.td.used + batch.length > TD_DAY_MAX) { S.stStatus = "Quota gratuit du jour atteint, reprise demain."; return }
  const r = await fetchTD(batch);
  if (r.err) { S.stStatus = r.err; return }
  const paused = isPaused();
  for (const s of batch) {
    try {
      const x = r.map && r.map[s]; if (!x || x.status === "error" || !x.values) { ST[s] = "Données indisponibles"; continue }
      const bars = x.values.slice().reverse().map(v => ({ t: v.datetime, o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +(v.volume || 0) }));
      if (bars.length < 30) continue;
      P[s] = bars.at(-1).c / FX;
      const day = bars.at(-1).t.slice(0, 10), first = bars.find(b => b.t.startsWith(day));
      CH[s] = first ? (bars.at(-1).c - first.o) / first.o : 0;
      if (S.pos[s]) { manage(s, bars, FX, { maxHold: 60 * 60e3, forceClose: m === "closing" }); continue }
      const noEntry = m === "closing" || m === "late" ? "Plus d'entrée avant la fermeture" : m === "opening" ? "Range d'ouverture en formation (jusqu'à 9h45)" : null;
      const g = gate(s, { paused, noEntry });
      if (g) { ST[s] = g; continue }
      const o = orbSignal(s, bars);
      if (o && o.dir) {
        openPos(s, o.dir, bars.at(-1).c / FX, o.dist,
          `${o.dir > 0 ? "Long" : "Short"} · cassure du range d'ouverture (${f2(o.lo)}–${f2(o.hi)} $), stop au milieu du range`, bars.at(-1).t);
        continue;
      }
      const cl = bars.map(b => b.c);
      await evaluate(s, bars, FX, { paused, trend: async () => trendDir(cl), dmin: 0.003, dmax: 0.015 });
      if (!S.pos[s] && o && o.late) ST[s] = "Cassure du range déjà passée · " + ST[s];
    } catch (e) { console.log("erreur", s, e.message) }
  }
  S.stStatus = `Bourse US ouverte · analyse toutes les 5 min · ${S.td.used}/${TD_DAY_MAX} requêtes gratuites utilisées aujourd'hui`;
}

// ===== Boucle d'un passage =====
async function main() {
  const t0 = Date.now();
  await pickProvider();
  VOL24 = (await DP.vol24()) || {};
  const batches = [STOCKS.slice(0, 8), STOCKS.slice(8)];
  let nextStock = 0, lastStockAt = 0;
  while (true) {
    await cryptoTick();
    if (nextStock < batches.length && Date.now() - lastStockAt >= 61000) {
      await stockBatch(batches[nextStock]); nextStock++; lastStockAt = Date.now();
    }
    S.eq.push([Date.now(), equity()]);
    if (S.eq.length > 3000) S.eq = S.eq.filter((_, i) => i % 2 === 0);
    if (S.trades.length > 1000) S.trades.length = 1000;
    S.updated = Date.now(); S.provider = PROVIDER; S.fx = FX;
    fs.writeFileSync(STATE_FILE, JSON.stringify(S));
    if (Date.now() - t0 + TICK_MS > RUN_MS) break;
    await sleep(TICK_MS);
  }
  console.log(`Fin du passage · portefeuille ${equity().toFixed(2)} € · ${Object.keys(S.pos).length} position(s) · source ${PROVIDER}`);
}
main().catch(e => { console.error(e); process.exit(1) });
