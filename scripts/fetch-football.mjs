// Flash Boys: fetch Premier League squads, injuries, fixtures, starting XIs and xG
// from the official Fantasy Premier League API (free, no key), and save them to
// data/fpl.json for the app. Runs on a schedule via GitHub Actions.
import fs from "node:fs";

const BASE = process.env.FPL_BASE || "https://fantasy.premierleague.com/api";
const OUT = "data/fpl.json";
const now = new Date();

let before = "", state = {};
try { before = fs.readFileSync(OUT, "utf8"); state = JSON.parse(before); } catch {}
state.live = state.live || {}; // finished gameweeks already processed: { gw: true }

async function get(path) {
  const res = await fetch(`${BASE}/${path}`, {
    headers: { "User-Agent": "Mozilla/5.0 (FlashBoysSyndicate data job)", "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`FPL ${path} → HTTP ${res.status}`);
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
