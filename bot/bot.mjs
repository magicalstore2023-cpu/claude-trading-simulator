// Claude Crypto Simulator — bot serveur (simulation, aucun argent réel).
// Stratégie : suivi de tendance en bougies de 4 h, à l'achat seulement, avec filtre de marché Bitcoin.
// Choisie après un test sur 120 jours de vrais prix : le scalping en 1 min / 15 min perdait à cause des frais.
import fs from "node:fs";

const STATE_FILE = process.env.STATE_FILE || "state.json";
const RUN_MS = +(process.env.RUN_MS || 210000);
const TICK_MS = +(process.env.TICK_MS || 60000);

// ===== Paramètres =====
const START = 10000, FEE = 0.001, RISK = 0.01, MAXW = 0.16, MAXPOS = 8;   // crypto + actions
const MINVOL = 30e6;        // volume minimum sur 24 h (en dollars)
const UNIVERSE = 30;        // cryptos les plus échangées analysées
const N_OUT = 10;           // sortie : clôture sous le plus bas des 10 dernières bougies de 4 h
const STOP_ATR = 2;         // stop initial : 2 ATR sous l'entrée
const REGIME_EMA = 120;     // filtre : Bitcoin au-dessus de sa moyenne de 120 bougies de 4 h (~20 jours)
const TREND_EMA = 200;      // la crypto doit être au-dessus de sa moyenne de 200 bougies de 4 h
const EXCLUDE = /^(USDC|FDUSD|TUSD|BUSD|USDP|DAI|USDE|USD1|EUR|EURI|AEUR|GBP|TRY|BRL|PAXG|XAUT|WBTC|WBETH|BFUSD|XUSD|RLUSD)USDT$|(UP|DOWN|BULL|BEAR)USDT$/;
const STOCK_TOKENS = /^(INTC|SOXL|TSLA|NVDA|AAPL|MSFT|AMZN|META|GOOGL|GOOG|NFLX|AMD|COIN|MSTR|HOOD|CRCL|PLTR|SPY|QQQ|TQQQ|SQQQ|IWM|DIA|GLD|SLV|ORCL|AVGO|BABA|UBER|SKHY)[A-Z]?USDT$/;
const H4 = 4 * 3600e3;

// ===== Outils =====
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ema(a, n) { const k = 2 / (n + 1); let e = a[0]; const out = [e]; for (let i = 1; i < a.length; i++) { e = a[i] * k + e * (1 - k); out.push(e) } return out }
function atr(b, n = 14) { let t = 0; for (let i = b.length - n; i < b.length; i++) t += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)); return t / n }
const f1 = v => v.toFixed(1).replace(".", ","), f2 = v => v.toFixed(2).replace(".", ",");
const pct = d => (d * 100).toFixed(2).replace(".", ",") + " %";
const dayIL = () => new Date().toLocaleDateString("fr-CA", { timeZone: "Asia/Jerusalem" });

async function getJSON(url, timeout = 15000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "claude-trading-simulator/1.0" } }); if (!r.ok) return null; return await r.json() }
  catch (e) { return null } finally { clearTimeout(t) }
}

// ===== Données Binance (publiques) =====
const BIN = "https://data-api.binance.vision";
const klines = async (s, iv, n) => { const k = await getJSON(`${BIN}/api/v3/klines?symbol=${s}&interval=${iv}&limit=${n}`); return Array.isArray(k) ? k.map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })) : null };
async function tickers() {
  const v = await getJSON(`${BIN}/api/v3/ticker/24hr`, 20000); if (!Array.isArray(v)) return null;
  return v.filter(x => x.symbol.endsWith("USDT") && !EXCLUDE.test(x.symbol) && !STOCK_TOKENS.test(x.symbol) && +x.count > 0)
    .map(x => ({ s: x.symbol, vol: +x.quoteVolume, ch: +x.priceChangePercent / 100 }));
}
async function eurusd() { const p = await getJSON(`${BIN}/api/v3/ticker/price?symbol=EURUSDT`); if (p) return +p.price; const x = await getJSON("https://api.frankfurter.app/latest?from=EUR&to=USD"); return x && x.rates ? +x.rates.USD : null }

// ===== État =====
function fresh() { return { cash: START, pos: {}, trades: [], eq: [[Date.now(), START]], start: Date.now(), day: { d: dayIL(), losses: 0, startEq: START }, cool: {}, P: {}, CH: {}, ST: {} } }
let S;
try { S = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) } catch (e) { S = null }
if (!S || typeof S.cash !== "number") S = fresh();
for (const k of ["cool", "P", "CH", "ST"]) if (!S[k]) S[k] = {};
let FX = S.fx || null;

// Changement de stratégie : on clôture ce qui reste de l'ancienne et on note le point de départ
const STRAT = "tendance-4h";
if (!S.strategy || S.strategy.name !== STRAT) {
  S.oldPos = Object.keys(S.pos);
  S.strategy = { name: STRAT, since: Date.now(), eqStart: null };
  S.learn = { lessons: [{ t: Date.now(), text: "Test sur 120 jours de vrais prix : le scalping en 1 min / 15 min perdait surtout à cause des frais (≈ 75 % du mouvement moyen). Je passe au suivi de tendance en bougies de 4 h, à l'achat seulement, et je reste en cash quand le Bitcoin est en tendance baissière." }], nIn: 20, lastN: 0 };
}
const L = S.learn;
if (!L.nIn) L.nIn = 20;
if (!L.v3) { L.v3 = true; L.lessons.unshift({ t: Date.now(), text: "J'ajoute les grandes actions US (Nvidia, Apple, Microsoft, Nasdaq, S&P 500…). Test sur 5 ans, frais compris : la même méthode de suivi de tendance y marche bien mieux qu'en crypto (41 % de gagnants, rapport gains/pertes 1,95, aucune année perdante). Achat seulement quand le Nasdaq est en tendance haussière et qu'une action casse son plus haut des 20 derniers jours." }) }
if (!L.v2) { L.v2 = true; L.lessons.unshift({ t: Date.now(), text: "Erreur du 4 novembre : j'ai acheté sur un rebond du Bitcoin qui n'a duré que quelques heures (3 trades, -173 €). Test sur 400 jours : en exigeant 24 h au-dessus de la moyenne et une moyenne qui remonte, les faux signaux baissent nettement (30 derniers jours : -1R au lieu de -9R). J'applique cette confirmation. J'exclus aussi l'or tokenisé (XAUT), qui n'est pas une crypto." }) }

const posVal = (s, p) => { const cur = S.P[s] || p.entry; return p.qty * cur };
const equity = () => S.cash + Object.entries(S.pos).reduce((t, [s, p]) => t + posVal(s, p), 0);
function lesson(text) { L.lessons.unshift({ t: Date.now(), text }); if (L.lessons.length > 30) L.lessons.length = 30; console.log("LEÇON", text) }

function closePos(s, ex, why) {
  const p = S.pos[s], dir = p.dir || 1; let pnl;
  if (dir > 0) { const val = p.qty * ex * (1 - FEE); pnl = val - p.cost; S.cash += val }
  else { pnl = p.qty * (p.entry - ex) - p.qty * (p.entry + ex) * FEE; S.cash += p.cost + pnl }
  const R = p.risk ? pnl / p.risk : 0;
  S.trades.unshift({ t: Date.now(), s, side: "SORTIE", dir, price: ex, qty: p.qty, amt: p.cost + pnl, pnl, R, why, strat: p.strat || "ancienne" });
  delete S.pos[s]; S.cool[s] = Date.now(); S.ST[s] = "Position clôturée";
  console.log(`SORTIE ${s} ${why} ${pnl.toFixed(2)} €`);
}

// ===== Apprentissage : ajuste la sélectivité selon les résultats de la stratégie =====
function learn() {
  const ex = S.trades.filter(t => t.side === "SORTIE" && t.strat === STRAT);
  if (ex.length < 12 || ex.length === L.lastN) return;
  L.lastN = ex.length;
  const last = ex.slice(0, 30), win = last.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0), loss = -last.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);
  const pf = loss ? win / loss : 9;
  if (pf < 0.8 && L.nIn < 40) { L.nIn += 5; lesson(`Rapport gains/pertes faible (${f2(pf)}) sur les derniers trades : j'exige une cassure plus forte (plus haut de ${L.nIn} bougies de 4 h).`) }
  else if (pf > 1.6 && L.nIn > 20) { L.nIn -= 5; lesson(`Rapport gains/pertes solide (${f2(pf)}) : je reviens à une cassure du plus haut de ${L.nIn} bougies.`) }
}


// ===== Bourse US : suivi de tendance en bougies journalières (données Yahoo Finance) =====
// Test sur 5 ans (15 grandes actions/indices, frais compris) : 41 % de gagnants, rapport gains/pertes 1,95, aucune année perdante.
const STOCKS = ["SPY","QQQ","DIA","NVDA","AAPL","MSFT","AMZN","META","GOOGL","TSLA","AVGO","AMD","NFLX","JPM","COST"];
const SNAMES = { SPY: "S&P 500", QQQ: "Nasdaq 100", DIA: "Dow Jones", NVDA: "Nvidia", AAPL: "Apple", MSFT: "Microsoft", AMZN: "Amazon", META: "Meta", GOOGL: "Google", TSLA: "Tesla", AVGO: "Broadcom", AMD: "AMD", NFLX: "Netflix", JPM: "JPMorgan", COST: "Costco" };
const isStock = s => STOCKS.includes(s);
async function yahoo(s) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&range=2y`, 20000);
  const r = j && j.chart && j.chart.result && j.chart.result[0]; if (!r || !r.timestamp) return null;
  const q = r.indicators.quote[0], bars = [];
  r.timestamp.forEach((t, i) => { if (q.close[i] != null && q.high[i] != null && q.low[i] != null && q.open[i] != null) bars.push({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] }) });
  return { bars, price: r.meta && r.meta.regularMarketPrice };
}
function nyOpen() { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })); const m = d.getHours() * 60 + d.getMinutes(); return d.getDay() > 0 && d.getDay() < 6 && m >= 570 && m < 960 }
async function stockTick() {
  if (!FX) return;
  const open = nyOpen(), data = {};
  for (const s of STOCKS) data[s] = await yahoo(s);
  const q = data.QQQ; if (!q || q.bars.length < 120) { S.stockStatus = "Données actions indisponibles pour le moment"; return }
  const closedOf = d => d.bars.filter(b => b.t + 6.5 * 3600e3 <= Date.now());
  const qc = closedOf(q).map(b => b.c), qe = ema(qc, 50);
  const reg = qc.slice(-3).every((c, i) => c > qe[qe.length - 3 + i]) && qe.at(-1) > qe.at(-6);
  if (S.stockRegime !== undefined && S.stockRegime !== reg) lesson(reg ? "Le Nasdaq tient au-dessus de sa moyenne de 50 jours depuis 3 jours et elle monte : les actions sont en tendance haussière, je peux acheter les cassures." : "Le Nasdaq n'est plus en tendance haussière : je vends mes actions et je reste en cash côté bourse.");
  S.stockRegime = reg; S.nasdaq = { price: qc.at(-1), ema: qe.at(-1) };
  S.stockStatus = open ? "Bourse US ouverte" : "Bourse US fermée (ouverte 9h30–16h00 à New York) : les achats se font à l'ouverture";
  for (const s of STOCKS) {
    try {
      const d = data[s]; if (!d || d.bars.length < 210) { S.ST[s] = "Données indisponibles"; continue }
      const closed = closedOf(d), price = d.price || closed.at(-1).c, pE = price / FX;
      S.P[s] = pE; S.CH[s] = (price - closed.at(-1).c) / closed.at(-1).c;
      const p = S.pos[s];
      if (p) {
        if (open && pE <= p.stop) { closePos(s, pE, p.trail ? "Stop suiveur touché (gain protégé)" : "Stop-loss touché"); continue }
        if (open && !reg) { closePos(s, pE, "Nasdaq plus en tendance haussière : retour en cash"); continue }
        const lowN = Math.min(...closed.slice(-11, -1).map(x => x.l)) / FX;
        if (open && closed.at(-1).c / FX < lowN && closed.at(-1).t > p.tEntryBar) { closePos(s, pE, "Clôture sous le plus bas des 10 derniers jours : fin de tendance"); continue }
        if (lowN > p.stop) { p.stop = lowN; p.trail = true }
        S.ST[s] = `En position · ${((pE / p.entry - 1) * 100).toFixed(1).replace(".", ",")} %`; continue;
      }
      if (!reg) { S.ST[s] = "Nasdaq pas en tendance haussière : en attente"; continue }
      if (Object.keys(S.pos).length >= MAXPOS) { S.ST[s] = `${MAXPOS} positions déjà ouvertes`; continue }
      if (S.cool[s] && Date.now() - S.cool[s] < 24 * 3600e3) { S.ST[s] = "Pause de 24 h après sortie"; continue }
      const cl = closed.map(x => x.c), last = closed.at(-1);
      if (last.c <= ema(cl, 200).at(-1)) { S.ST[s] = "Sous sa tendance de fond (moyenne 200 jours)"; continue }
      const hh = Math.max(...closed.slice(-21, -1).map(x => x.h));
      if (last.c <= hh) { S.ST[s] = `Pas de cassure (${((last.c / hh - 1) * 100).toFixed(1).replace(".", ",")} % du plus haut 20 jours)`; continue }
      if (price <= hh) { S.ST[s] = "Cassure retombée sous le niveau"; continue }
      if (S.lastBreak && S.lastBreak[s] === last.t) { S.ST[s] = "Cassure déjà jouée"; continue }
      if (!open) { S.ST[s] = "Signal de cassure ✓ · achat à l'ouverture de la bourse"; continue }
      const a = atr(closed), stop = (price - STOP_ATR * a) / FX, dist = (pE - stop) / pE;
      if (dist <= 0.004 || dist > 0.25) { S.ST[s] = "Volatilité hors limites"; continue }
      const eq = equity(), size = Math.min(eq * RISK / dist, eq * MAXW, S.cash);
      if (size < 50) { S.ST[s] = "Pas assez de cash"; continue }
      const qty = size * (1 - FEE) / pE; S.cash -= size;
      S.pos[s] = { dir: 1, qty, entry: pE, cost: size, risk: size * dist, stop, stop0: stop, tp: null, t: Date.now(), max: pE, tEntryBar: last.t, strat: STRAT, mkt: "bourse" };
      (S.lastBreak = S.lastBreak || {})[s] = last.t;
      S.trades.unshift({ t: Date.now(), s, side: "ENTREE", dir: 1, price: pE, qty, amt: size, pnl: null, strat: STRAT,
        why: `Long · ${SNAMES[s]} casse son plus haut des 20 derniers jours, au-dessus de sa moyenne 200 jours, Nasdaq haussier · stop ${pct(dist)} (2 ATR), on laisse courir la tendance` });
      S.ST[s] = "Entrée LONG ✓"; console.log(`ENTREE ${s} ${size.toFixed(2)} €`);
    } catch (e) { console.log("erreur", s, e.message) }
  }
}

// ===== Un passage =====
let WATCH = [], REGIME = null;
async function scan() {
  const t = await tickers(); if (!t) return false;
  const liquid = t.filter(x => x.vol >= MINVOL).sort((a, b) => b.vol - a.vol);
  WATCH = [...new Set([...Object.keys(S.pos), ...liquid.slice(0, UNIVERSE).map(x => x.s)])];
  S.radar = liquid.slice().sort((a, b) => Math.abs(b.ch) - Math.abs(a.ch)).slice(0, 10).map(x => ({ s: x.s, ch: x.ch, vol: x.vol }));
  S.scanned = { total: t.length, liquid: liquid.length, watched: WATCH.length };
  for (const s of Object.keys(S.ST)) if (!WATCH.includes(s) && !isStock(s)) { delete S.ST[s]; delete S.P[s]; delete S.CH[s] }
  return true;
}

async function regime() {
  const b = await klines("BTCUSDT", "4h", 300); if (!b || b.length < REGIME_EMA + 5) return REGIME;
  const closed = b.slice(0, -1), cl = closed.map(x => x.c), e = ema(cl, REGIME_EMA);
  // Confirmation : les 6 dernières bougies de 4 h (24 h) au-dessus de la moyenne, et la moyenne en hausse.
  // Évite les faux rebonds d'une seule bougie (erreur du 4 novembre : 3 achats, 3 pertes le lendemain).
  const ok = cl.slice(-6).every((c, i) => c > e[e.length - 6 + i]) && e.at(-1) > e.at(-7);
  if (S.regime !== undefined && S.regime !== ok) lesson(ok ? "Le Bitcoin tient au-dessus de sa moyenne de 20 jours depuis 24 h et la moyenne remonte : marché haussier confirmé, je peux de nouveau acheter les cassures." : "Le marché n'est plus haussier confirmé (Bitcoin sous sa moyenne ou moyenne en baisse) : je vends mes positions et je reste en cash.");
  S.regime = ok; S.btc = { price: cl.at(-1), ema: e.at(-1) };
  return ok;
}

async function tick() {
  const fx = await eurusd(); if (fx) FX = fx; if (!FX) return;
  REGIME = await regime();
  if (S.day.d !== dayIL()) S.day = { d: dayIL(), losses: 0, startEq: equity() };
  for (const s of WATCH) {
    if (isStock(s)) continue;
    try {
      const b = await klines(s, "4h", 260); if (!b || b.length < 60) { S.ST[s] = "Données indisponibles"; continue }
      const cur = b.at(-1), closed = b.slice(0, -1), price = cur.c;
      S.P[s] = price / FX; S.CH[s] = (price - closed.at(-6).c) / closed.at(-6).c;   // variation sur ~24 h
      const p = S.pos[s];
      // --- Positions de l'ancienne stratégie : clôturées au premier passage ---
      if (p && !p.strat) { closePos(s, price / FX, "Changement de stratégie (passage au suivi de tendance 4 h)"); continue }
      // --- Gestion d'une position ouverte ---
      if (p) {
        const lowE = cur.l / FX;
        if (lowE <= p.stop) { closePos(s, Math.min(cur.o / FX, p.stop), p.trail ? "Stop suiveur touché (gain protégé)" : "Stop-loss touché"); continue }
        if (!REGIME) { closePos(s, price / FX, "Marché baissier (Bitcoin sous sa moyenne) : retour en cash"); continue }
        const lowN = Math.min(...closed.slice(-N_OUT - 1, -1).map(x => x.l)) / FX;
        if (closed.at(-1).c / FX < lowN && closed.at(-1).t > p.tEntryBar) { closePos(s, price / FX, `Clôture sous le plus bas des ${N_OUT} dernières bougies : fin de tendance`); continue }
        // stop suiveur : remonte au plus bas des 10 dernières bougies s'il est plus haut que le stop actuel
        if (lowN > p.stop) { p.stop = lowN; p.trail = true }
        p.max = Math.max(p.max || p.entry, cur.h / FX);
        S.ST[s] = `En position · ${((price / FX / p.entry - 1) * 100).toFixed(1).replace(".", ",")} %`;
        continue;
      }
      // --- Recherche d'une entrée ---
      if (!REGIME) { S.ST[s] = "Marché baissier : en attente"; continue }
      if (Object.keys(S.pos).length >= MAXPOS) { S.ST[s] = `${MAXPOS} positions déjà ouvertes`; continue }
      const cl = closed.map(x => x.c), last = closed.at(-1);
      if (S.cool[s] && Date.now() - S.cool[s] < H4) { S.ST[s] = "Pause de 4 h après sortie"; continue }
      const e200 = ema(cl, Math.min(TREND_EMA, cl.length - 1)).at(-1);
      if (last.c <= e200) { S.ST[s] = "Sous sa tendance de fond"; continue }
      const hh = Math.max(...closed.slice(-L.nIn - 1, -1).map(x => x.h));
      if (last.c <= hh) { S.ST[s] = `Pas de cassure (${((last.c / hh - 1) * 100).toFixed(1).replace(".", ",")} % du plus haut ${L.nIn} bougies)`; continue }
      if (price <= hh) { S.ST[s] = "Cassure retombée sous le niveau"; continue }   // on n'achète que si le prix tient au-dessus de la cassure
      if (S.lastBreak && S.lastBreak[s] === last.t) { S.ST[s] = "Cassure déjà jouée"; continue }
      const a = atr(closed), pE = price / FX, stop = (price - STOP_ATR * a) / FX, dist = (pE - stop) / pE;
      if (dist <= 0.004 || dist > 0.2) { S.ST[s] = "Volatilité hors limites"; continue }
      const eq = equity(), size = Math.min(eq * RISK / dist, eq * MAXW, S.cash);
      if (size < 50) { S.ST[s] = "Pas assez de cash"; continue }
      const qty = size * (1 - FEE) / pE;
      S.cash -= size;
      S.pos[s] = { dir: 1, qty, entry: pE, cost: size, risk: size * dist, stop, stop0: stop, tp: null, t: Date.now(), max: pE, tEntryBar: last.t, strat: STRAT };
      (S.lastBreak = S.lastBreak || {})[s] = last.t;
      S.trades.unshift({ t: Date.now(), s, side: "ENTREE", dir: 1, price: pE, qty, amt: size, pnl: null, strat: STRAT,
        why: `Long · cassure du plus haut des ${L.nIn} dernières bougies de 4 h, au-dessus de sa tendance de fond, Bitcoin haussier · stop ${pct(dist)} (2 ATR), pas d'objectif fixe : on laisse courir la tendance` });
      S.ST[s] = "Entrée LONG ✓";
      console.log(`ENTREE ${s} ${size.toFixed(2)} €`);
    } catch (e) { console.log("erreur", s, e.message) }
  }
}

async function main() {
  const t0 = Date.now();
  learn();
  if (!(await scan())) { console.log("Binance indisponible"); return }
  let stocksDone = false;
  while (true) {
    await tick();
    if (!stocksDone) { try { await stockTick() } catch (e) { console.log("erreur actions", e.message) } stocksDone = true }
    if (S.strategy.eqStart === null) S.strategy.eqStart = equity();
    S.eq.push([Date.now(), equity()]);
    if (S.eq.length > 3000) S.eq = S.eq.filter((_, i) => i % 2 === 0);
    if (S.trades.length > 1000) S.trades.length = 1000;
    S.updated = Date.now(); S.provider = "binance"; S.fx = FX;
    fs.writeFileSync(STATE_FILE, JSON.stringify(S));
    if (Date.now() - t0 + TICK_MS > RUN_MS) break;
    await sleep(TICK_MS);
  }
  console.log(`Fin du passage · portefeuille ${equity().toFixed(2)} € · ${Object.keys(S.pos).length} position(s) · marché ${REGIME ? "haussier" : "baissier"}`);
}
main().catch(e => { console.error(e); process.exit(1) });
