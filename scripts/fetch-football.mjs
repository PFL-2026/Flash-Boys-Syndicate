// Flash Boys: fetch Premier League lineups, match stats (incl. xG), player ratings
// and injuries from API-Football, and save them to data/football.json.
// Runs on a schedule via GitHub Actions. Uses very few requests: most runs make none.
import fs from "node:fs";

const KEY = process.env.APIFOOTBALL_KEY;
const FORCE = process.env.FORCE === "1";
const BASE = process.env.APIFOOTBALL_BASE || "https://v3.football.api-sports.io";
const LEAGUE = 39; // Premier League
const OUT = "data/football.json";
const FINISHED = ["FT", "AET", "PEN"];
const DEAD = ["PST", "CANC", "ABD", "AWD", "WO"];

const now = new Date();
const seasonYear = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
const day = (offset) => new Date(now.getTime() + offset * 864e5).toISOString().slice(0, 10);
const today = day(0);

let state, before = "";
try { before = fs.readFileSync(OUT, "utf8"); state = JSON.parse(before); } catch { state = {}; }
state = Object.assign({ version: 1, season: seasonYear, fixtures: {}, injuries: [], meta: {} }, state);
if (state.season !== seasonYear) { state = { version: 1, season: seasonYear, fixtures: {}, injuries: [], meta: {} }; }

let calls = 0, remaining = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path) {
  if (calls > 0) await sleep(+(process.env.GAP_MS ?? 7000)); // stay well under the per-minute limit
  calls++;
  const res = await fetch(`${BASE}/${path}`, { headers: { "x-apisports-key": KEY } });
  remaining = res.headers.get("x-ratelimit-requests-remaining") ?? remaining;
  const json = await res.json().catch(() => ({}));
  const errs = json.errors;
  const hasErr = errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length);
  if (!res.ok || hasErr) {
    const msg = hasErr ? Object.values(errs).join(" ") : `HTTP ${res.status}`;
    const e = new Error(msg); e.api = true; throw e;
  }
  console.log(`  GET ${path.split("?")[0]} → ${json.results ?? 0} results (requests left today: ${remaining ?? "?"})`);
  return json.response || [];
}

function basic(f) {
  return {
    id: f.fixture.id,
    date: f.fixture.date,
    status: f.fixture.status && f.fixture.status.short,
    home: { id: f.teams.home.id, name: f.teams.home.name },
    away: { id: f.teams.away.id, name: f.teams.away.name },
    goals: [f.goals.home, f.goals.away],
  };
}

function statVal(list, type) {
  const s = (list || []).find((x) => x.type === type);
  if (!s || s.value == null) return null;
  const v = parseFloat(String(s.value).replace("%", ""));
  return isNaN(v) ? null : v;
}

function detail(f) {
  const out = basic(f);
  const side = (teamId) => (teamId === out.home.id ? 0 : 1);
  if (Array.isArray(f.lineups) && f.lineups.length === 2) {
    out.lineups = [null, null];
    f.lineups.forEach((l) => {
      out.lineups[side(l.team.id)] = {
        formation: l.formation || null,
        xi: (l.startXI || []).map((p) => ({ id: p.player.id, name: p.player.name, pos: p.player.pos })),
      };
    });
  }
  if (Array.isArray(f.statistics) && f.statistics.length === 2) {
    const st = [null, null];
    f.statistics.forEach((s) => {
      st[side(s.team.id)] = {
        xg: statVal(s.statistics, "expected_goals"),
        shots: statVal(s.statistics, "Total Shots"),
        sot: statVal(s.statistics, "Shots on Goal"),
        poss: statVal(s.statistics, "Ball Possession"),
      };
    });
    out.stats = st;
  }
  if (Array.isArray(f.players) && f.players.length === 2) {
    const pl = [[], []];
    f.players.forEach((t) => {
      pl[side(t.team.id)] = (t.players || []).map((p) => {
        const g = (p.statistics && p.statistics[0] && p.statistics[0].games) || {};
        return { id: p.player.id, name: p.player.name, min: g.minutes || 0, rating: g.rating ? parseFloat(g.rating) : null };
      }).filter((p) => p.min > 0);
    });
    out.players = pl;
  }
  return out;
}

function merge(fx) {
  const prev = state.fixtures[fx.id] || {};
  state.fixtures[fx.id] = Object.assign({}, prev, fx);
}

async function main() {
  if (!KEY) {
    state.status = { ok: false, message: "No API key found. Add the APIFOOTBALL_KEY secret in GitHub.", checked: now.toISOString() };
    return;
  }
  const daily = FORCE || state.meta.lastDaily !== today;

  // 1. Once: back-fill this season's finished games (for player minutes, ratings and xG)
  if (!state.meta.backfilled || FORCE) {
    console.log("Back-filling this season’s finished games…");
    const done = await api(`fixtures?league=${LEAGUE}&season=${seasonYear}&status=FT-AET-PEN`);
    done.forEach((f) => merge(basic(f)));
    state.meta.backfilled = true;
  }

  // 2. Once a day: fixture list (last 4 days to next 10) and injuries
  if (daily) {
    console.log("Daily refresh: fixtures and injuries…");
    const list = await api(`fixtures?league=${LEAGUE}&season=${seasonYear}&from=${day(-4)}&to=${day(10)}`);
    list.forEach((f) => merge(basic(f)));
    const inj = await api(`injuries?league=${LEAGUE}&season=${seasonYear}`);
    const upcomingIds = new Set(Object.values(state.fixtures).filter((f) => !FINISHED.includes(f.status) && Date.parse(f.date) > now - 864e5).map((f) => f.id));
    state.injuries = inj
      .filter((i) => i.fixture && upcomingIds.has(i.fixture.id))
      .map((i) => ({ fixture: i.fixture.id, team: i.team.id, id: i.player.id, name: i.player.name, type: i.player.type, reason: i.player.reason }));
    state.meta.lastDaily = today;
  }

  // 3. Details where needed: lineups close to kick-off, full stats once finished
  const need = Object.values(state.fixtures).filter((f) => {
    if (DEAD.includes(f.status)) return false;
    const ko = Date.parse(f.date), mins = (ko - now) / 6e4;
    const lineupWindow = mins <= 80 && mins >= -30 && !(f.lineups && f.lineups[0] && f.lineups[0].xi.length);
    const finishedNeedsStats = (FINISHED.includes(f.status) || mins < -135) && !f.final && (f.tries || 0) < 6;
    return lineupWindow || finishedNeedsStats;
  }).map((f) => f.id);

  for (let i = 0; i < need.length; i += 20) {
    const ids = need.slice(i, i + 20);
    console.log(`Fetching details for ${ids.length} game(s)…`);
    const res = await api(`fixtures?ids=${ids.join("-")}`);
    ids.forEach((id) => { if (state.fixtures[id]) state.fixtures[id].tries = (state.fixtures[id].tries || 0) + 1; });
    res.forEach((f) => {
      const d = detail(f);
      if (FINISHED.includes(d.status) && d.stats) d.final = true;
      merge(d);
    });
  }
  state.status = { ok: true, message: "Connected", checked: now.toISOString() };
}

try {
  await main();
} catch (e) {
  console.error("API-Football error:", e.message);
  state.status = { ok: false, message: e.message, checked: now.toISOString() };
}
// Only write when something actually changed, so the repo isn't spammed with commits.
const stable = (o) => JSON.stringify(Object.assign({}, o, { updated: null, status: Object.assign({}, o.status, { checked: null }) }));
let prev = null; try { prev = JSON.parse(before); } catch {}
if (!prev || stable(prev) !== stable(state)) {
  state.updated = now.toISOString();
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(state));
  console.log("Saved data/football.json");
} else console.log("No changes.");
console.log(`Done. ${calls} request(s) used this run. Status: ${state.status.ok ? "OK" : state.status.message}`);
