// Flash Boys: download history for testing the model.
//  - football-data.co.uk: Premier League (E0) and Championship (E1) results with
//    Bet365 and Pinnacle closing odds, 2019-20 to now (free, no key)
//  - ClubElo: rating history for every English club in those leagues (free, no key)
// Saves everything under data/history/. Run it from the Actions tab when needed.
import fs from "node:fs";

const OUT = "data/history";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(`${OUT}/elo`, { recursive: true });

async function get(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (FlashBoysSyndicate history job)" } });
      if (res.ok) return await res.text();
      console.log(`  ${url} → HTTP ${res.status}`);
      if (res.status === 404) return null;
    } catch (e) { console.log(`  ${url} → ${e.message}`); }
    await sleep(2000 * attempt);
  }
  return null;
}

// 1. Results and closing odds
const now = new Date();
const startYear = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
const seasons = [];
for (let y = 2019; y <= startYear; y++) seasons.push(String(y).slice(2) + String(y + 1).slice(2));
let files = 0;
for (const s of seasons) {
  for (const lg of ["E0", "E1"]) {
    const path = `${OUT}/${lg}-${s}.csv`;
    const current = s === seasons[seasons.length - 1];
    if (!current && fs.existsSync(path)) continue; // finished seasons never change
    const csv = await get(`https://www.football-data.co.uk/mmz4281/${s}/${lg}.csv`);
    if (csv && csv.includes("HomeTeam")) { fs.writeFileSync(path, csv); files++; console.log(`Saved ${lg} ${s}: ${csv.trim().split("\n").length - 1} games`); }
    await sleep(1000);
  }
}

// 2. ClubElo: find every English club from season-start snapshots, then download each club's history
const clubs = new Set();
for (const s of seasons) {
  const date = `20${s.slice(0, 2)}-08-01`;
  const csv = await get(`http://api.clubelo.com/${date}`);
  if (!csv) continue;
  csv.trim().split("\n").slice(1).forEach((line) => {
    const c = line.split(",");
    if (c[2] === "ENG" && (c[3] === "1" || c[3] === "2")) clubs.add(c[1]);
  });
  await sleep(800);
}
const today = await get(`http://api.clubelo.com/${now.toISOString().slice(0, 10)}`);
if (today) {
  fs.writeFileSync(`${OUT}/elo-today.csv`, today);
  today.trim().split("\n").slice(1).forEach((line) => { const c = line.split(","); if (c[2] === "ENG" && (c[3] === "1" || c[3] === "2")) clubs.add(c[1]); });
}
console.log(`ClubElo: ${clubs.size} English clubs`);
let elo = 0;
for (const club of clubs) {
  const csv = await get(`http://api.clubelo.com/${encodeURIComponent(club.replace(/\s+/g, ""))}`);
  if (csv && csv.includes("Elo")) { fs.writeFileSync(`${OUT}/elo/${club.replace(/[^A-Za-z0-9]+/g, "_")}.csv`, csv); elo++; }
  await sleep(800);
}
console.log(`Done. ${files} odds file(s) updated, ${elo} club rating histories saved.`);
