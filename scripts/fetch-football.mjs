// Flash Boys: fetch Premier League squads, injuries, fixtures, starting XIs and xG
// from the official Fantasy Premier League API (free, no key), plus confirmed
// lineups from ESPN's public match feed once clubs announce them (free, no key).
// Lineups are verified against the official FPL squad lists before being marked
// as verified. Saves everything to data/fpl.json. Runs via GitHub Actions.
import fs from "node:fs";

const BASE = process.env.FPL_BASE || "https://fantasy.premierleague.com/api";
const ESPN = process.env.ESPN_BASE || "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1";
const ODDS = process.env.ODDS_BASE || "https://api.the-odds-api.com/v4/sports/soccer_epl";
const ODDS_KEY = process.env.ODDS_API_KEY;
const OUT = "data/fpl.json";
const now = new Date();

let before = "", state = {};
try { before = fs.readFileSync(OUT, "utf8"); state = JSON.parse(before); } catch {}
state.live = state.live || {}; // finished gameweeks already processed: { gw: true }
state.lineups = state.lineups || {}; // FPL fixture id -> confirmed lineups from ESPN
state.odds = state.odds || {};       // FPL fixture id -> Betfair Exchange match odds

async function get(path, base = BASE) {
  const res = await fetch(`${base}/${path}`, {
    headers: { "User-Agent": "Mozilla/5.0 (FlashBoysSyndicate data job)", "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`${base === BASE ? "FPL" : "ESPN"} ${path} → HTTP ${res.status}`);
  return res.json();
}

async function main() {
  // 1. Teams, players (with injury status) and gameweeks
  const boot = await get("bootstrap-static/");
  const season = boot.events && boot.events[0] && boot.events[0].deadline_time ? boot.events[0].deadline_time.slice(0, 4) : String(now.getUTCFullYear());
  if (state.season && state.season !== season) { state = { live: {} }; } // new season: start fresh
  state.season = season;
  state.teams = {};
  boot.teams.forEach((t) => { state.teams[t.id] = { name: t.name, short: t.short_name }; });
  // players: id -> [name, team, position(1 GK,2 DEF,3 MID,4 FWD), status, chance next round, news]
  state.players = {};
  boot.elements.forEach((p) => {
    state.players[p.id] = [p.web_name, p.team, p.element_type, p.status, p.chance_of_playing_next_round, p.news || ""];
  });

  // 2. All fixtures this season
  const fx = await get("fixtures/");
  const prev = {};
  (state.fixtures || []).forEach((f) => { prev[f.id] = f; });
  state.fixtures = fx.filter((f) => f.kickoff_time).map((f) => {
    const p = prev[f.id] || {};
    return {
      id: f.id, gw: f.event, ko: f.kickoff_time, h: f.team_h, a: f.team_a,
      hs: f.team_h_score, as: f.team_a_score, done: !!(f.finished || f.finished_provisional),
      st: p.st || null, xg: p.xg || null,
    };
  });

  // 3. Starting XIs and xG for finished gameweeks (one request per gameweek, done once)
  const byId = {};
  state.fixtures.forEach((f) => { byId[f.id] = f; });
  const gws = [...new Set(state.fixtures.filter((f) => f.done && f.gw).map((f) => f.gw))].sort((a, b) => a - b);
  for (const gw of gws) {
    const gwFixtures = state.fixtures.filter((f) => f.gw === gw);
    const complete = gwFixtures.every((f) => f.done);
    if (state.live[gw] && gwFixtures.every((f) => f.st)) continue;
    const live = await get(`event/${gw}/live/`);
    const st = {}, xg = {};
    live.elements.forEach((el) => {
      const pl = state.players[el.id];
      const team = pl ? pl[1] : null;
      const parts = (el.explain || []).map((e) => ({
        fixture: e.fixture,
        minutes: ((e.stats || []).find((s) => s.identifier === "minutes") || {}).value || 0,
      })).filter((p) => byId[p.fixture]);
      const totalMin = parts.reduce((a, p) => a + p.minutes, 0) || 0;
      parts.forEach((p) => {
        const f = byId[p.fixture];
        const side = team === f.h ? 0 : team === f.a ? 1 : null;
        if (side === null || !p.minutes) return;
        // started: single game uses the official "starts" stat; double gameweeks use 45+ minutes
        const started = parts.length === 1 ? (el.stats && el.stats.starts) === 1 : p.minutes >= 45;
        if (started) ((st[f.id] = st[f.id] || [[], []])[side]).push(el.id);
        const share = totalMin ? p.minutes / totalMin : 0;
        const g = parseFloat((el.stats && el.stats.expected_goals) || 0) * share;
        (xg[f.id] = xg[f.id] || [0, 0])[side] += g;
      });
    });
    gwFixtures.forEach((f) => {
      if (st[f.id]) f.st = st[f.id];
      if (xg[f.id]) f.xg = xg[f.id].map((v) => Math.round(v * 100) / 100);
    });
    if (complete) state.live[gw] = true;
    console.log(`  Gameweek ${gw}: starting XIs for ${Object.keys(st).length} game(s)`);
  }
  state.status = { ok: true, message: "Connected", checked: now.toISOString() };

  // 4. Confirmed lineups from ESPN, for games from 75 minutes before kick-off to 2 hours after
  try { await lineups(boot); state.lineupStatus = { ok: true }; }
  catch (e) { console.error("ESPN lineups error:", e.message); state.lineupStatus = { ok: false, message: e.message }; }

  // 5. Betfair Exchange match odds via The Odds API (only if a key is set up)
  try { await exchangeOdds(); }
  catch (e) { console.error("Odds error:", e.message); state.oddsStatus = Object.assign({}, state.oddsStatus, { ok: false, message: e.message, pulled: now.toISOString() }); }
}

// Free plan = 500 credits a month and one pull costs 1 credit, so pull sparingly:
// every 3 hours normally, every 30 minutes when a game kicks off within 2 hours or is in play,
// and back off if credits run low.
async function exchangeOdds() {
  if (!ODDS_KEY) { state.oddsStatus = { ok: false, message: "Not set up" }; return; }
  const os = state.oddsStatus || {};
  const last = os.pulled ? Date.parse(os.pulled) : 0, mins = (now - last) / 6e4;
  const busy = state.fixtures.some((f) => { const m = (Date.parse(f.ko) - now) / 6e4; return m <= 120 && m >= -110; });
  const low = os.remaining != null && os.remaining < 60;
  const due = low ? mins >= 720 : busy ? mins >= 28 : mins >= 175;
  if (!due) return;
  const url = `${ODDS}/odds?apiKey=${encodeURIComponent(ODDS_KEY)}&regions=uk&markets=h2h&oddsFormat=decimal&bookmakers=betfair_ex_uk`;
  const res = await fetch(url);
  const remaining = res.headers.get("x-requests-remaining");
  if (!res.ok) {
    let msg = `HTTP ${res.status}`; try { const j = await res.json(); if (j.message) msg = j.message; } catch {}
    throw new Error(msg);
  }
  const events = await res.json();
  let matched = 0;
  events.forEach((e) => {
    const f = state.fixtures.find((x) => Math.abs(Date.parse(x.ko) - Date.parse(e.commence_time)) < 3 * 36e5
      && sameTeam(e.home_team, state.teams[x.h].name) && sameTeam(e.away_team, state.teams[x.a].name));
    if (!f) return;
    const bk = (e.bookmakers || []).find((b) => b.key === "betfair_ex_uk");
    const mk = bk && (bk.markets || []).find((m) => m.key === "h2h");
    if (!mk) return;
    const price = (name) => { const o = mk.outcomes.find((x) => x.name === name); return o ? o.price : null; };
    const h = price(e.home_team), d = price("Draw"), a = price(e.away_team);
    if (!h || !d || !a) return;
    state.odds[f.id] = { h, d, a, at: bk.last_update || now.toISOString(), live: Date.parse(e.commence_time) < now };
    matched++;
  });
  // drop odds for games that finished a while ago
  Object.keys(state.odds).forEach((id) => { const f = state.fixtures.find((x) => String(x.id) === id); if (!f || (f.done && Date.parse(f.ko) < now - 864e5)) delete state.odds[id]; });
  state.oddsStatus = { ok: true, pulled: now.toISOString(), remaining: remaining != null ? +remaining : null, matched };
  console.log(`  Betfair Exchange odds: ${matched} game(s) priced (credits left this month: ${remaining ?? "?"})`);
}

// ---- name matching helpers ----
const ALIAS = { "manchester united": "man utd", "manchester city": "man city", "tottenham hotspur": "spurs", "tottenham": "spurs",
  "nottingham forest": "nottm forest", "wolverhampton wanderers": "wolves", "brighton & hove albion": "brighton", "brighton and hove albion": "brighton",
  "newcastle united": "newcastle", "west ham united": "west ham", "leeds united": "leeds", "sheffield united": "sheff utd",
  "west bromwich albion": "west brom", "afc bournemouth": "bournemouth", "leicester city": "leicester", "ipswich town": "ipswich",
  "coventry city": "coventry", "hull city": "hull", "luton town": "luton", "norwich city": "norwich", "stoke city": "stoke" };
const plain = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/ø/g, "o").replace(/[^a-z& ]/g, "").replace(/\s+/g, " ").trim();
const teamKey = (n) => { const p = plain(n).replace(/ fc$/, ""); return (ALIAS[p] || p).replace(/[^a-z]/g, ""); };
const sameTeam = (a, b) => { a = teamKey(a); b = teamKey(b); return a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))); };
const tokens = (s) => plain(s).replace(/&/g, "").split(" ").filter(Boolean);

function matchPlayer(name, squad) {
  const t = tokens(name);
  if (!t.length) return null;
  const scored = squad.map((p) => {
    const full = tokens(`${p.first_name} ${p.second_name}`), web = tokens(p.web_name.replace(/\./g, " "));
    const all = new Set([...full, ...web]);
    let score = 0;
    if (t.join(" ") === full.join(" ")) score = 4;                                   // exact full name
    else if (t.every((x) => all.has(x))) score = 3;                                  // all name parts present
    else if (web.length && t.slice(-web.length).join(" ") === web.join(" ")) score = 2; // ends with FPL short name
    else if (t[t.length - 1] === full[full.length - 1] && t[0][0] === (full[0] || "")[0]) score = 1; // surname + initial
    return { p, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[1].score === scored[0].score) return null; // ambiguous: don't guess
  return scored[0].p.id;
}

async function lineups(boot) {
  const due = state.fixtures.filter((f) => {
    const mins = (Date.parse(f.ko) - now) / 6e4;
    const L = state.lineups[f.id];
    return mins <= 75 && mins >= -120 && !(L && L.verified);
  });
  // tidy: keep lineups for two weeks
  Object.keys(state.lineups).forEach((id) => { if (Date.parse(state.lineups[id].at) < now - 14 * 864e5) delete state.lineups[id]; });
  if (!due.length) return;
  const dates = [...new Set(due.map((f) => f.ko.slice(0, 10).replace(/-/g, "")))];
  const events = [];
  for (const d of dates) { const sb = await get(`scoreboard?dates=${d}`, ESPN); (sb.events || []).forEach((e) => events.push(e)); }
  for (const f of due) {
    const H = state.teams[f.h].name, A = state.teams[f.a].name;
    const ev = events.find((e) => {
      const c = (e.competitions && e.competitions[0] && e.competitions[0].competitors) || [];
      const home = c.find((x) => x.homeAway === "home"), away = c.find((x) => x.homeAway === "away");
      return home && away && Math.abs(Date.parse(e.date) - Date.parse(f.ko)) < 3 * 36e5
        && sameTeam(home.team.displayName || home.team.name, H) && sameTeam(away.team.displayName || away.team.name, A);
    });
    if (!ev) { console.log(`  Lineups: ${H} v ${A} not found on ESPN yet`); continue; }
    const sum = await get(`summary?event=${ev.id}`, ESPN);
    const rosters = sum.rosters || [];
    const sides = ["home", "away"].map((ha, i) => rosters.find((r) => r.homeAway === ha) || rosters[i]);
    const out = { src: "ESPN", event: ev.id, at: now.toISOString() };
    let complete = true, verified = true;
    sides.forEach((r, i) => {
      const teamId = i === 0 ? f.h : f.a;
      const squad = boot.elements.filter((p) => p.team === teamId);
      const starters = r && Array.isArray(r.roster) ? r.roster.filter((p) => p.starter) : [];
      if (starters.length !== 11) { complete = false; return; }
      const ids = [], names = [], unmatched = [];
      starters.forEach((p) => {
        const nm = (p.athlete && (p.athlete.displayName || p.athlete.fullName)) || "?";
        const id = matchPlayer(nm, squad);
        names.push(nm); if (id) ids.push(id); else { ids.push(null); unmatched.push(nm); }
      });
      const key = i === 0 ? "h" : "a";
      out[key] = ids; out[key + "n"] = names; out[key + "f"] = r.formation || null;
      if (unmatched.length) out[key + "u"] = unmatched;
      if (unmatched.length > 1) verified = false; // allow one (e.g. a debutant not yet in FPL)
    });
    if (!complete) { console.log(`  Lineups: ${H} v ${A} not announced yet`); continue; }
    out.verified = verified;
    state.lineups[f.id] = out;
    console.log(`  Lineups: ${H} v ${A} confirmed${verified ? " and verified" : " (names not fully verified)"}`);
  }
}

try {
  await main();
} catch (e) {
  console.error("FPL error:", e.message);
  state.status = { ok: false, message: e.message, checked: now.toISOString() };
}

// Only write when something changed, so the repo isn't spammed with commits.
const stable = (o) => JSON.stringify(Object.assign({}, o, { updated: null, status: Object.assign({}, o.status, { checked: null }) }));
let old = null; try { old = JSON.parse(before); } catch {}
if (!old || stable(old) !== stable(state)) {
  state.updated = now.toISOString();
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(state));
  console.log(`Saved ${OUT}: ${Object.keys(state.players || {}).length} players, ${(state.fixtures || []).length} fixtures`);
} else console.log("No changes.");
console.log(`Done. Status: ${state.status.ok ? "OK" : state.status.message}`);
