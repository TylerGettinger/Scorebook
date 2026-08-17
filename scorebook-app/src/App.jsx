import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "./lib/supabaseClient.js";

/* ---------------------------------------------------------
   SCOREBOOK — private live softball scorekeeping & stats
   Data layer: Supabase (Postgres + Realtime)
--------------------------------------------------------- */

const C = {
  green: "#1E3D2F",
  greenDeep: "#142B21",
  greenLight: "#2F5744",
  dirt: "#A9682C",
  dirtLight: "#C98B4A",
  chalk: "#F5F3EC",
  chalkDim: "#E7E2D4",
  amber: "#E8A33D",
  navy: "#14213D",
  line: "#C9C2B4",
  red: "#B3423A",
  ink: "#26241D",
};

// A game is assumed to run this many innings when computing ERA (typical for
// travel/high-school softball). Doesn't affect anything except that one number.
const ERA_INNINGS = 7;

const OUTCOMES = [
  { key: "1B", label: "1B", full: "Single", ab: true, hit: true, bases: 1, out: false },
  { key: "2B", label: "2B", full: "Double", ab: true, hit: true, bases: 2, out: false },
  { key: "3B", label: "3B", full: "Triple", ab: true, hit: true, bases: 3, out: false },
  { key: "HR", label: "HR", full: "Home Run", ab: true, hit: true, bases: 4, out: false },
  { key: "BB", label: "BB", full: "Walk", ab: false, hit: false, bases: 1, out: false },
  { key: "HBP", label: "HBP", full: "Hit By Pitch", ab: false, hit: false, bases: 1, out: false },
  { key: "E", label: "E", full: "Reached on Error", ab: true, hit: false, bases: 1, out: false },
  { key: "FC", label: "FC", full: "Fielder's Choice", ab: true, hit: false, bases: 1, out: false },
  { key: "K", label: "K", full: "Strikeout", ab: true, hit: false, bases: 0, out: true },
  { key: "OUT", label: "OUT", full: "Ground/Fly/Line Out", ab: true, hit: false, bases: 0, out: true },
  { key: "SF", label: "SF", full: "Sacrifice Fly", ab: false, hit: false, bases: 0, out: true },
];
const outcomeByKey = (k) => OUTCOMES.find((o) => o.key === k);

const POSITIONS = ["P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "EX"];

function emptyPitchingState() {
  return {
    ourPitcherId: null,
    ourBalls: 0,
    ourStrikes: 0,
    ourOutsAtStintStart: 0,
    ourEarnedRuns: 0,
    ourHistory: [], // [{ playerId, balls, strikes, outsRecorded, earnedRuns }]
    theirName: "",
    theirBalls: 0,
    theirStrikes: 0,
  };
}
function emptyGameState() {
  return {
    lineup: [],
    currentBatterIndex: 0,
    inning: 1,
    half: "top",
    outs: 0,
    totalPitchingOuts: 0, // cumulative outs recorded while WE are on defense (doesn't reset each half)
    count: { balls: 0, strikes: 0 }, // current batter's live ball-strike count
    bases: { 1: null, 2: null, 3: null },
    plays: [],
    scores: [],
    currentPlayId: null,
    report: "",
    defense: { positions: {} }, // playerId -> position code
    fielding: {}, // playerId -> { PO, A, E }
    pitching: emptyPitchingState(),
  };
}

/* ---------------- row <-> app-object mapping ---------------- */
function rowToGame(row) {
  const base = { ...emptyGameState(), ...(row.state || {}) };
  base.pitching = { ...emptyPitchingState(), ...(base.pitching || {}) };
  return {
    id: row.id,
    teamId: row.team_id,
    opponent: row.opponent,
    date: row.date,
    isHome: row.is_home,
    status: row.status,
    ourScore: row.our_score,
    theirScore: row.their_score,
    ...base,
  };
}
function gameToRow(g) {
  const { id, teamId, opponent, date, isHome, status, ourScore, theirScore, ...state } = g;
  return {
    id,
    team_id: teamId,
    opponent,
    date,
    is_home: isHome,
    status,
    our_score: ourScore,
    their_score: theirScore,
    state,
  };
}

/* ---------------- stat math ---------------- */
function computeStatsFromPlays(playerId, plays, scores) {
  const s = { PA: 0, AB: 0, R: 0, H: 0, "2B": 0, "3B": 0, HR: 0, RBI: 0, BB: 0, HBP: 0, K: 0, SF: 0 };
  for (const p of plays) {
    if (p.playerId !== playerId) continue;
    const o = outcomeByKey(p.outcome);
    if (!o) continue;
    s.PA += 1;
    if (o.ab) s.AB += 1;
    if (o.hit) {
      s.H += 1;
      if (o.key === "2B") s["2B"] += 1;
      if (o.key === "3B") s["3B"] += 1;
      if (o.key === "HR") s.HR += 1;
    }
    if (o.key === "BB") s.BB += 1;
    if (o.key === "HBP") s.HBP += 1;
    if (o.key === "K") s.K += 1;
    if (o.key === "SF") s.SF += 1;
    s.RBI += p.rbi || 0;
  }
  for (const sc of scores || []) {
    if (sc.playerId === playerId) s.R += 1;
  }
  const totalBases = s.H - s["2B"] - s["3B"] - s.HR + s["2B"] * 2 + s["3B"] * 3 + s.HR * 4;
  s.AVG = s.AB > 0 ? s.H / s.AB : 0;
  s.OBP = s.AB + s.BB + s.HBP + s.SF > 0 ? (s.H + s.BB + s.HBP) / (s.AB + s.BB + s.HBP + s.SF) : 0;
  s.SLG = s.AB > 0 ? totalBases / s.AB : 0;
  return s;
}
const fmt3 = (n) => (n === 0 ? ".000" : n.toFixed(3).replace(/^0/, ""));
const firstName = (full) => (full || "").trim().split(/\s+/)[0] || "";
const ipDisplay = (outs) => `${Math.floor(outs / 3)}.${outs % 3}`;
function pitchingLine(stints) {
  // stints: [{balls, strikes, outsRecorded, earnedRuns}]
  const balls = stints.reduce((a, s) => a + (s.balls || 0), 0);
  const strikes = stints.reduce((a, s) => a + (s.strikes || 0), 0);
  const outs = stints.reduce((a, s) => a + (s.outsRecorded || 0), 0);
  const er = stints.reduce((a, s) => a + (s.earnedRuns || 0), 0);
  const pitches = balls + strikes;
  const strikePct = pitches > 0 ? (strikes / pitches) * 100 : 0;
  const ip = outs / 3;
  const era = ip > 0 ? (er * ERA_INNINGS) / ip : 0;
  return { balls, strikes, outs, er, pitches, strikePct, ip, era };
}

/* ---------------- small UI atoms ---------------- */
function Btn({ children, onClick, tone = "dirt", size = "md", disabled, style }) {
  const tones = {
    dirt: { bg: C.dirt, fg: C.chalk },
    green: { bg: C.green, fg: C.chalk },
    amber: { bg: C.amber, fg: C.ink },
    ghost: { bg: "transparent", fg: C.chalk, border: `1px solid ${C.line}` },
    red: { bg: C.red, fg: C.chalk },
    chalk: { bg: C.chalk, fg: C.green },
  };
  const t = tones[tone];
  const pad = size === "sm" ? "6px 10px" : size === "lg" ? "14px 22px" : "10px 16px";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: t.bg,
        color: t.fg,
        border: t.border || "none",
        padding: pad,
        borderRadius: 8,
        fontFamily: "Inter, sans-serif",
        fontWeight: 600,
        fontSize: size === "sm" ? 13 : 15,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        letterSpacing: 0.2,
        ...style,
      }}
    >
      {children}
    </button>
  );
}
function Card({ children, style }) {
  return (
    <div style={{ background: C.greenLight, border: `1px solid ${C.line}33`, borderRadius: 12, padding: 18, ...style }}>
      {children}
    </div>
  );
}
function Eyebrow({ children }) {
  return (
    <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: C.amber, marginBottom: 6 }}>
      {children}
    </div>
  );
}
function Diamond({ bases, names }) {
  const pos = { home: [100, 160], 1: [165, 100], 2: [100, 40], 3: [35, 100] };
  const labelPos = { 1: [pos[1][0] + 14, pos[1][1] + 4], 2: [pos[2][0], pos[2][1] - 16], 3: [pos[3][0] - 14, pos[3][1] + 4] };
  const labelAnchor = { 1: "start", 2: "middle", 3: "end" };
  const baseFill = (n) => (bases[n] ? C.amber : "transparent");
  const baseStroke = (n) => (bases[n] ? C.amber : C.chalk);
  return (
    <svg viewBox="0 0 200 190" style={{ width: 170, height: 160 }}>
      <polygon points={`${pos.home.join(",")} ${pos[1].join(",")} ${pos[2].join(",")} ${pos[3].join(",")}`} fill="none" stroke={C.chalkDim} strokeWidth="2" opacity="0.5" />
      {[1, 2, 3].map((n) => (
        <g key={n}>
          <rect
            x={pos[n][0] - 10}
            y={pos[n][1] - 10}
            width="20"
            height="20"
            transform={`rotate(45 ${pos[n][0]} ${pos[n][1]})`}
            fill={baseFill(n)}
            stroke={baseStroke(n)}
            strokeWidth="2.5"
            style={{ filter: bases[n] ? `drop-shadow(0 0 6px ${C.amber})` : "none" }}
          />
          {bases[n] && names && names[n] && (
            <text x={labelPos[n][0]} y={labelPos[n][1]} textAnchor={labelAnchor[n]} fill={C.amber} fontFamily="IBM Plex Mono, monospace" fontSize="11" fontWeight="700">
              {names[n]}
            </text>
          )}
        </g>
      ))}
      <rect x={pos.home[0] - 9} y={pos.home[1] - 9} width="18" height="18" fill={C.chalk} stroke={C.dirt} strokeWidth="2" transform={`rotate(45 ${pos.home[0]} ${pos.home[1]})`} />
    </svg>
  );
}

/* =========================================================
   PASSCODE GATE (optional, set VITE_APP_PASSCODE to enable)
========================================================= */
function useUnlocked() {
  const required = import.meta.env.VITE_APP_PASSCODE || "";
  const [unlocked, setUnlocked] = useState(!required || sessionStorage.getItem("scorebook-unlocked") === "1");
  const tryUnlock = (code) => {
    if (code === required) {
      sessionStorage.setItem("scorebook-unlocked", "1");
      setUnlocked(true);
      return true;
    }
    return false;
  };
  return { required: !!required, unlocked, tryUnlock };
}
function LockScreen({ onUnlock }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState(false);
  return (
    <Wrap>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "80vh", padding: 20 }}>
        <Card style={{ maxWidth: 320, width: "100%" }}>
          <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 24, color: C.chalk, marginBottom: 10 }}>SCOREBOOK</div>
          <p style={{ color: C.chalkDim, fontSize: 13, marginBottom: 12 }}>Enter the family passcode to continue.</p>
          <input
            type="password"
            value={code}
            onChange={(e) => { setCode(e.target.value); setErr(false); }}
            onKeyDown={(e) => e.key === "Enter" && setErr(!onUnlock(code))}
            style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.chalk, color: C.ink, marginBottom: 10 }}
          />
          {err && <p style={{ color: C.red, fontSize: 12, marginBottom: 10 }}>That's not it — try again.</p>}
          <Btn tone="amber" onClick={() => setErr(!onUnlock(code))}>Enter</Btn>
        </Card>
      </div>
    </Wrap>
  );
}

/* =========================================================
   MAIN APP
========================================================= */
export default function App() {
  const { required, unlocked, tryUnlock } = useUnlocked();
  if (required && !unlocked) return <LockScreen onUnlock={tryUnlock} />;
  return <Scorebook />;
}

function Scorebook() {
  const [ready, setReady] = useState(false);
  const [loadErr, setLoadErr] = useState(null);
  const [teams, setTeams] = useState([]);
  const [players, setPlayers] = useState([]);
  const [gameIndex, setGameIndex] = useState([]);
  const [view, setView] = useState("home");
  const [activeTeamId, setActiveTeamId] = useState(null);
  const [activeGame, setActiveGame] = useState(null);
  const [scorekeeper, setScorekeeper] = useState(false);
  const [selectedBase, setSelectedBase] = useState(null);

  const refreshRoster = useCallback(async () => {
    const { data: t } = await supabase.from("teams").select("*").order("created_at", { ascending: true });
    const { data: p } = await supabase.from("players").select("*").order("created_at", { ascending: true });
    setTeams((t || []).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at })));
    setPlayers((p || []).map((r) => ({ id: r.id, teamId: r.team_id, name: r.name, number: r.number })));
  }, []);

  const refreshGameIndex = useCallback(async () => {
    const { data } = await supabase
      .from("games")
      .select("id, team_id, opponent, date, status, our_score, their_score")
      .order("created_at", { ascending: false });
    setGameIndex(
      (data || []).map((r) => ({ id: r.id, teamId: r.team_id, opponent: r.opponent, date: r.date, status: r.status, ourScore: r.our_score, theirScore: r.their_score }))
    );
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await refreshRoster();
        await refreshGameIndex();
      } catch (e) {
        setLoadErr("Could not connect to the database. Check your Supabase URL/key in the environment variables.");
      }
      setReady(true);
    })();
  }, [refreshRoster, refreshGameIndex]);

  const persistGame = useCallback(async (g) => {
    setActiveGame(g);
    const { error } = await supabase.from("games").update(gameToRow(g)).eq("id", g.id);
    if (error) console.error("game update failed", error);
    setGameIndex((idx) => idx.map((e) => (e.id === g.id ? { ...e, status: g.status, ourScore: g.ourScore, theirScore: g.theirScore, opponent: g.opponent, date: g.date } : e)));
  }, []);

  const openGame = useCallback(async (id) => {
    const { data, error } = await supabase.from("games").select("*").eq("id", id).single();
    if (error || !data) return;
    setActiveGame(rowToGame(data));
    setView(data.status === "final" ? "summary" : "live");
  }, []);

  const deleteGame = useCallback(async (id) => {
    await supabase.from("games").delete().eq("id", id);
    setGameIndex((idx) => idx.filter((g) => g.id !== id));
    setActiveGame((g) => (g && g.id === id ? null : g));
  }, []);

  // realtime: keep the open game in sync for viewers watching along
  useEffect(() => {
    if (!activeGame) return;
    const channel = supabase
      .channel(`game-${activeGame.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${activeGame.id}` }, (payload) => {
        setActiveGame((prev) => (prev ? rowToGame(payload.new) : prev));
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [activeGame?.id]);

  /* ---------- team / roster management ---------- */
  const addTeam = async (name) => {
    const { data, error } = await supabase.from("teams").insert({ name }).select().single();
    if (error) return console.error(error);
    setTeams((t) => [...t, { id: data.id, name: data.name, createdAt: data.created_at }]);
    setActiveTeamId(data.id);
    setView("team");
  };
  const addPlayer = async (teamId, name, number) => {
    const { data, error } = await supabase.from("players").insert({ team_id: teamId, name, number }).select().single();
    if (error) return console.error(error);
    setPlayers((p) => [...p, { id: data.id, teamId: data.team_id, name: data.name, number: data.number }]);
  };
  const removePlayer = async (id) => {
    await supabase.from("players").delete().eq("id", id);
    setPlayers((p) => p.filter((x) => x.id !== id));
  };

  /* ---------- game lifecycle ---------- */
  const startGame = async ({ teamId, opponent, date, isHome, lineup }) => {
    const g = { id: undefined, teamId, opponent, date, isHome, status: "live", ourScore: 0, theirScore: 0, ...emptyGameState(), lineup };
    const row = gameToRow(g);
    delete row.id;
    const { data, error } = await supabase.from("games").insert(row).select().single();
    if (error) return console.error(error);
    const full = rowToGame(data);
    setActiveGame(full);
    setGameIndex((idx) => [{ id: full.id, teamId, opponent, date, status: "live", ourScore: 0, theirScore: 0 }, ...idx]);
    setView("live");
  };

  const usBatting = activeGame ? (activeGame.isHome ? activeGame.half === "bottom" : activeGame.half === "top") : false;

  const flipHalf = (g) => {
    const half = g.half === "top" ? "bottom" : "top";
    const inning = g.half === "top" ? g.inning : g.inning + 1;
    return { ...g, half, inning, outs: 0, bases: { 1: null, 2: null, 3: null }, currentPlayId: null, count: { balls: 0, strikes: 0 } };
  };
  const scoreRunner = (g, playerId, creditRbi) => {
    const scores = [...g.scores, { playerId, playId: g.currentPlayId, creditRbi }];
    const plays = g.plays.map((p) => (p.id === g.currentPlayId && creditRbi ? { ...p, rbi: (p.rbi || 0) + 1 } : p));
    return { ...g, scores, plays, ourScore: g.ourScore + 1 };
  };
  const addRunner = (g, base, playerId) => {
    if (base >= 4) return scoreRunner(g, playerId, true);
    if (g.bases[base]) {
      const occupant = g.bases[base];
      const g2 = { ...g, bases: { ...g.bases, [base]: playerId } };
      return addRunner(g2, base + 1, occupant);
    }
    return { ...g, bases: { ...g.bases, [base]: playerId } };
  };

  const recordOutcome = (key, pitchingPatch) => {
    if (!activeGame || !usBatting) return;
    const o = outcomeByKey(key);
    const batter = players.find((p) => p.id === activeGame.lineup[activeGame.currentBatterIndex % activeGame.lineup.length]);
    if (!batter) return;
    const play = { id: crypto.randomUUID(), playerId: batter.id, outcome: key, rbi: 0, inning: activeGame.inning, half: activeGame.half, ts: Date.now() };
    let g = { ...activeGame, plays: [...activeGame.plays, play], currentPlayId: play.id, pitching: pitchingPatch || activeGame.pitching };
    if (o.out) g = { ...g, outs: g.outs + 1 };
    if (o.key === "HR") {
      const runners = [1, 2, 3].filter((n) => g.bases[n]).map((n) => g.bases[n]);
      g = { ...g, bases: { 1: null, 2: null, 3: null } };
      [...runners, batter.id].forEach((pid) => { g = scoreRunner(g, pid, true); });
    } else if (o.key === "1B" || o.key === "2B" || o.key === "3B") {
      // On a hit, every existing runner advances the same number of bases as the
      // batter — not just runners directly blocking the batter's target base.
      // Otherwise a runner on 1st can get left behind when the batter reaches 2nd or 3rd.
      const advance = o.bases;
      let g2 = { ...g, bases: { 1: null, 2: null, 3: null } };
      [3, 2, 1].forEach((fromBase) => {
        const runnerId = g.bases[fromBase];
        if (!runnerId) return;
        const dest = fromBase + advance;
        g2 = dest >= 4 ? scoreRunner(g2, runnerId, true) : { ...g2, bases: { ...g2.bases, [dest]: runnerId } };
      });
      g = { ...g2, bases: { ...g2.bases, [advance]: batter.id } };
    } else if (o.bases > 0) {
      // Walks / HBP / errors / fielder's choice: only force runners who are
      // directly blocked off their base (a walk with a runner on 2nd but not 1st
      // doesn't push that runner to 3rd).
      g = addRunner(g, o.bases, batter.id);
    }
    g = { ...g, currentBatterIndex: g.currentBatterIndex + 1, count: { balls: 0, strikes: 0 } };
    if (g.outs >= 3) g = flipHalf(g);
    persistGame(g);
  };

  const runnerAction = (action) => {
    if (!activeGame || selectedBase == null) return;
    const playerId = activeGame.bases[selectedBase];
    let g = { ...activeGame, bases: { ...activeGame.bases, [selectedBase]: null } };
    if (action === "advance") g = addRunner({ ...g }, selectedBase + 1, playerId);
    else if (action === "score-rbi") g = scoreRunner(g, playerId, true);
    else if (action === "score-norbi") g = scoreRunner(g, playerId, false);
    else if (action === "out") { g = { ...g, outs: g.outs + 1 }; if (g.outs >= 3) g = flipHalf(g); }
    setSelectedBase(null);
    persistGame(g);
  };

  const defenseOut = (pitchingPatch) => {
    if (!activeGame) return;
    let g = {
      ...activeGame,
      outs: activeGame.outs + 1,
      totalPitchingOuts: activeGame.totalPitchingOuts + 1,
      count: { balls: 0, strikes: 0 },
      pitching: pitchingPatch || activeGame.pitching,
    };
    if (g.outs >= 3) g = flipHalf(g);
    persistGame(g);
  };
  const theirRun = (delta, earned) => {
    if (!activeGame) return;
    let g = { ...activeGame, theirScore: Math.max(0, activeGame.theirScore + delta) };
    if (delta > 0 && earned) {
      g = { ...g, pitching: { ...g.pitching, ourEarnedRuns: g.pitching.ourEarnedRuns + delta } };
    }
    persistGame(g);
  };
  const skipHalf = () => activeGame && persistGame(flipHalf(activeGame));
  const undoLast = () => {
    if (!activeGame || activeGame.plays.length === 0) return;
    const last = activeGame.plays[activeGame.plays.length - 1];
    const o = outcomeByKey(last.outcome);
    persistGame({
      ...activeGame,
      plays: activeGame.plays.slice(0, -1),
      currentBatterIndex: Math.max(0, activeGame.currentBatterIndex - 1),
      outs: o.out ? Math.max(0, activeGame.outs - 1) : activeGame.outs,
    });
  };

  /* ---------- defense: positions + fielding ---------- */
  const setPosition = (playerId, pos) => {
    if (!activeGame) return;
    const positions = { ...activeGame.defense.positions };
    if (pos) positions[playerId] = pos; else delete positions[playerId];
    persistGame({ ...activeGame, defense: { ...activeGame.defense, positions } });
  };
  const bumpFielding = (playerId, stat, delta) => {
    if (!activeGame) return;
    const current = activeGame.fielding[playerId] || { PO: 0, A: 0, E: 0 };
    const next = { ...current, [stat]: Math.max(0, current[stat] + delta) };
    persistGame({ ...activeGame, fielding: { ...activeGame.fielding, [playerId]: next } });
  };

  /* ---------- pitching: balls / strikes / pitcher changes ---------- */
  const archiveCurrentStint = (g) => {
    const p = g.pitching;
    if (!p.ourPitcherId) return p;
    const outsRecorded = g.totalPitchingOuts - p.ourOutsAtStintStart;
    if (outsRecorded === 0 && p.ourBalls === 0 && p.ourStrikes === 0 && p.ourEarnedRuns === 0) return p; // nothing to archive
    return {
      ...p,
      ourHistory: [...p.ourHistory, { playerId: p.ourPitcherId, balls: p.ourBalls, strikes: p.ourStrikes, outsRecorded, earnedRuns: p.ourEarnedRuns }],
    };
  };
  const setOurPitcher = (playerId) => {
    if (!activeGame) return;
    const archived = archiveCurrentStint(activeGame);
    persistGame({
      ...activeGame,
      pitching: { ...archived, ourPitcherId: playerId, ourBalls: 0, ourStrikes: 0, ourEarnedRuns: 0, ourOutsAtStintStart: activeGame.totalPitchingOuts },
    });
  };
  const setTheirPitcherName = (name) => {
    if (!activeGame) return;
    persistGame({ ...activeGame, pitching: { ...activeGame.pitching, theirName: name } });
  };

  // Ties the pitch-count buttons to the current batter's live ball/strike count.
  // side: 'our' (we're pitching, on defense) or 'their' (they're pitching, we're batting).
  // On a 4th ball, auto-records a walk; on a 3rd strike, auto-records a strikeout.
  const bumpPitchAndCount = (side, type, delta) => {
    if (!activeGame) return;
    if (side === "our" && (usBatting || !activeGame.pitching.ourPitcherId)) return;
    if (side === "their" && !usBatting) return;

    const pKey = side === "our" ? (type === "ball" ? "ourBalls" : "ourStrikes") : (type === "ball" ? "theirBalls" : "theirStrikes");
    const newPitching = { ...activeGame.pitching, [pKey]: Math.max(0, activeGame.pitching[pKey] + delta) };

    if (delta > 0) {
      const nextBalls = type === "ball" ? activeGame.count.balls + 1 : activeGame.count.balls;
      const nextStrikes = type === "strike" ? activeGame.count.strikes + 1 : activeGame.count.strikes;

      if (type === "ball" && nextBalls >= 4) {
        if (side === "their") { recordOutcome("BB", newPitching); return; }
        // side === 'our': opponent's batter walks — we don't track their lineup, just reset the count.
        persistGame({ ...activeGame, pitching: newPitching, count: { balls: 0, strikes: 0 } });
        return;
      }
      if (type === "strike" && nextStrikes >= 3) {
        if (side === "their") { recordOutcome("K", newPitching); return; }
        defenseOut(newPitching);
        return;
      }
      persistGame({ ...activeGame, pitching: newPitching, count: { balls: nextBalls, strikes: nextStrikes } });
      return;
    }

    // delta < 0 (the "-1" undo buttons) — just back off the tally, no auto-triggers.
    const nextCount = {
      balls: type === "ball" ? Math.max(0, activeGame.count.balls + delta) : activeGame.count.balls,
      strikes: type === "strike" ? Math.max(0, activeGame.count.strikes + delta) : activeGame.count.strikes,
    };
    persistGame({ ...activeGame, pitching: newPitching, count: nextCount });
  };

  const endGame = () => {
    if (!activeGame) return;
    const archived = archiveCurrentStint(activeGame);
    persistGame({ ...activeGame, status: "final", pitching: archived });
    setView("summary");
  };
  const reopenGame = () => {
    if (!activeGame) return;
    persistGame({ ...activeGame, status: "live" });
    setView("live");
  };
  const updateGameMeta = (patch) => {
    if (!activeGame) return;
    persistGame({ ...activeGame, ...patch });
  };

  /* ---------- recap generation ----------
     Calls a serverless function (/api/recap) so the Anthropic API key stays
     server-side. Requires ANTHROPIC_API_KEY set in Vercel's env vars. */
  const [generating, setGenerating] = useState(false);
  const generateRecap = async () => {
    if (!activeGame) return;
    setGenerating(true);
    try {
      const team = teams.find((t) => t.id === activeGame.teamId);
      const boxscore = activeGame.lineup
        .map((pid) => players.find((p) => p.id === pid))
        .filter(Boolean)
        .map((p) => {
          const s = computeStatsFromPlays(p.id, activeGame.plays, activeGame.scores);
          return `${p.name}: ${s.AB} AB, ${s.H} H, ${s.R} R, ${s.RBI} RBI, ${s.BB} BB, ${s.K} K`;
        })
        .join("\n");
      const res = await fetch("/api/recap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamName: team ? team.name : "Our Team",
          opponent: activeGame.opponent,
          date: activeGame.date,
          ourScore: activeGame.ourScore,
          theirScore: activeGame.theirScore,
          boxscore,
        }),
      });
      const data = await res.json();
      persistGame({ ...activeGame, report: data.report || "Recap could not be generated." });
    } catch (e) {
      persistGame({ ...activeGame, report: "Recap generation isn't set up yet — see README. Write your own notes here." });
    }
    setGenerating(false);
  };

  /* ---------- season stats ---------- */
  const loadFinalGamesForTeam = useCallback(async (teamId) => {
    const { data } = await supabase.from("games").select("*").eq("team_id", teamId).eq("status", "final");
    return (data || []).map(rowToGame);
  }, []);

  /* =========================================================
     RENDER
  ========================================================= */
  if (!ready) {
    return (
      <Wrap>
        <div style={{ color: C.chalk, fontFamily: "Inter, sans-serif", padding: 40, textAlign: "center" }}>Loading Scorebook…</div>
      </Wrap>
    );
  }
  if (loadErr) {
    return (
      <Wrap>
        <div style={{ color: C.chalk, fontFamily: "Inter, sans-serif", padding: 40, textAlign: "center" }}>{loadErr}</div>
      </Wrap>
    );
  }

  return (
    <Wrap>
      <TopBar scorekeeper={scorekeeper} setScorekeeper={setScorekeeper} setView={setView} />
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "20px 16px 60px" }}>
        {view === "home" && (
          <HomeView
            teams={teams}
            gameIndex={gameIndex}
            scorekeeper={scorekeeper}
            addTeam={addTeam}
            openTeam={(id) => { setActiveTeamId(id); setView("team"); }}
            openGame={openGame}
          />
        )}
        {view === "team" && (
          <TeamView
            team={teams.find((t) => t.id === activeTeamId)}
            players={players.filter((p) => p.teamId === activeTeamId)}
            games={gameIndex.filter((g) => g.teamId === activeTeamId)}
            scorekeeper={scorekeeper}
            addPlayer={addPlayer}
            removePlayer={removePlayer}
            openGame={openGame}
            deleteGame={deleteGame}
            goNewGame={() => setView("newgame")}
            goSeason={() => setView("season")}
            goHome={() => setView("home")}
          />
        )}
        {view === "newgame" && (
          <NewGameView teams={teams} players={players} defaultTeamId={activeTeamId} onCancel={() => setView("team")} onStart={startGame} />
        )}
        {view === "live" && activeGame && (
          <LiveGameView
            game={activeGame}
            team={teams.find((t) => t.id === activeGame.teamId)}
            players={players}
            usBatting={usBatting}
            scorekeeper={scorekeeper}
            selectedBase={selectedBase}
            recordOutcome={recordOutcome}
            tapBase={setSelectedBase}
            runnerAction={runnerAction}
            defenseOut={defenseOut}
            theirRun={theirRun}
            skipHalf={skipHalf}
            undoLast={undoLast}
            endGame={endGame}
            setPosition={setPosition}
            bumpFielding={bumpFielding}
            setOurPitcher={setOurPitcher}
            setTheirPitcherName={setTheirPitcherName}
            bumpPitchAndCount={bumpPitchAndCount}
            goHome={() => setView("home")}
          />
        )}
        {view === "summary" && activeGame && (
          <SummaryView
            game={activeGame}
            team={teams.find((t) => t.id === activeGame.teamId)}
            players={players}
            scorekeeper={scorekeeper}
            generating={generating}
            generateRecap={generateRecap}
            updateReport={(text) => persistGame({ ...activeGame, report: text })}
            updateGameMeta={updateGameMeta}
            reopenGame={reopenGame}
            deleteGame={async (id) => { await deleteGame(id); setView("home"); }}
            goHome={() => setView("home")}
          />
        )}
        {view === "season" && (
          <SeasonView teams={teams} players={players} loadFinalGamesForTeam={loadFinalGamesForTeam} goHome={() => setView("home")} />
        )}
      </div>
    </Wrap>
  );
}

/* ---------------- layout shells ---------------- */
function Wrap({ children }) {
  return (
    <div style={{ background: C.green, minHeight: "100vh", fontFamily: "Inter, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap');
        * { box-sizing: border-box; }
        html, body, #root { height: 100%; }
        body { margin: 0; }
        button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid ${C.amber}; outline-offset: 2px; }
        input, select, textarea { font-family: 'Inter', sans-serif; }
        .live-grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
        @media (min-width: 820px) {
          .live-grid { grid-template-columns: 1fr 300px; align-items: start; }
          .live-grid .sidebar { position: sticky; top: 76px; }
        }
      `}</style>
      {children}
    </div>
  );
}
function TopBar({ scorekeeper, setScorekeeper, setView }) {
  return (
    <div style={{ background: C.greenDeep, borderBottom: `1px solid ${C.line}33`, position: "sticky", top: 0, zIndex: 10 }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div onClick={() => setView("home")} style={{ cursor: "pointer", display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontFamily: "Oswald, sans-serif", fontWeight: 700, fontSize: 22, color: C.chalk, letterSpacing: 0.5 }}>SCOREBOOK</span>
          <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11, color: C.amber, letterSpacing: 1.5 }}>PRIVATE LEAGUE</span>
        </div>
        <button
          onClick={() => setScorekeeper(!scorekeeper)}
          style={{
            background: scorekeeper ? C.amber : "transparent",
            color: scorekeeper ? C.ink : C.chalkDim,
            border: `1px solid ${scorekeeper ? C.amber : C.line}`,
            borderRadius: 20,
            padding: "6px 14px",
            fontFamily: "IBM Plex Mono, monospace",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            letterSpacing: 0.5,
          }}
        >
          {scorekeeper ? "● SCOREKEEPER MODE" : "○ VIEWER MODE"}
        </button>
      </div>
    </div>
  );
}

/* ---------------- HOME ---------------- */
function HomeView({ teams, gameIndex, scorekeeper, addTeam, openTeam, openGame }) {
  const [newTeam, setNewTeam] = useState("");
  const liveGames = gameIndex.filter((g) => g.status === "live");
  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <Eyebrow>Season {new Date().getFullYear()}</Eyebrow>
        <h1 style={{ fontFamily: "Oswald, sans-serif", color: C.chalk, fontSize: 34, margin: 0, fontWeight: 600 }}>Track every at-bat, keep it in the family.</h1>
        <p style={{ color: C.chalkDim, marginTop: 8, maxWidth: 560, lineHeight: 1.5 }}>
          Log games live, hold season stats for every player, and send a recap to whoever's not in the stands.
        </p>
      </div>

      {liveGames.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <Eyebrow>Live now</Eyebrow>
          {liveGames.map((g) => (
            <div key={g.id} onClick={() => openGame(g.id)} style={{ cursor: "pointer", background: C.amber, borderRadius: 10, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontFamily: "Oswald, sans-serif", fontWeight: 600, color: C.ink }}>vs {g.opponent}</span>
              <span style={{ fontFamily: "IBM Plex Mono, monospace", fontWeight: 600, color: C.ink }}>{g.ourScore} – {g.theirScore}</span>
            </div>
          ))}
        </div>
      )}

      <Eyebrow>Teams</Eyebrow>
      {teams.length === 0 && (
        <Card style={{ marginBottom: 16 }}>
          <p style={{ color: C.chalkDim, margin: 0 }}>No teams yet.</p>
        </Card>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12, marginBottom: 20 }}>
        {teams.map((t) => {
          const tGames = gameIndex.filter((g) => g.teamId === t.id);
          return (
            <Card key={t.id} style={{ cursor: "pointer" }}>
              <div onClick={() => openTeam(t.id)}>
                <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 20, color: C.chalk, fontWeight: 600 }}>{t.name}</div>
                <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 12, color: C.amber, marginTop: 4 }}>{tGames.length} game{tGames.length !== 1 ? "s" : ""} logged</div>
              </div>
            </Card>
          );
        })}
      </div>

      {scorekeeper && (
        <Card style={{ marginBottom: 20 }}>
          <Eyebrow>Add a team</Eyebrow>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={newTeam} onChange={(e) => setNewTeam(e.target.value)} placeholder="e.g. Fayetteville Fireballs 12U" style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.chalk, color: C.ink }} />
            <Btn onClick={() => { if (newTeam.trim()) { addTeam(newTeam.trim()); setNewTeam(""); } }}>Add Team</Btn>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ---------------- TEAM ---------------- */
function TeamView({ team, players, games, scorekeeper, addPlayer, removePlayer, openGame, deleteGame, goNewGame, goSeason, goHome }) {
  const [name, setName] = useState("");
  const [num, setNum] = useState("");
  if (!team) return <div style={{ color: C.chalk }}>Team not found. <a onClick={goHome} style={{ color: C.amber, cursor: "pointer" }}>Go home</a></div>;
  return (
    <div>
      <BackLink onClick={goHome}>All teams</BackLink>
      <h1 style={{ fontFamily: "Oswald, sans-serif", color: C.chalk, fontSize: 30, margin: "6px 0 16px" }}>{team.name}</h1>
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        {scorekeeper && <Btn tone="amber" onClick={goNewGame}>+ Start New Game</Btn>}
        <Btn tone="ghost" onClick={goSeason}>View Season Stats</Btn>
      </div>
      <Eyebrow>Roster ({players.length})</Eyebrow>
      <Card style={{ marginBottom: 20 }}>
        {players.length === 0 && <p style={{ color: C.chalkDim, margin: 0 }}>No players yet.</p>}
        {players.map((p) => (
          <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: `1px solid ${C.line}22` }}>
            <span style={{ color: C.chalk }}><span style={{ fontFamily: "IBM Plex Mono, monospace", color: C.amber, marginRight: 8 }}>#{p.number || "—"}</span>{p.name}</span>
            {scorekeeper && <button onClick={() => removePlayer(p.id)} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 13 }}>Remove</button>}
          </div>
        ))}
        {scorekeeper && (
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <input value={num} onChange={(e) => setNum(e.target.value)} placeholder="#" style={{ width: 56, padding: "10px 8px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.chalk, color: C.ink }} />
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Player name" style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.chalk, color: C.ink }} />
            <Btn onClick={() => { if (name.trim()) { addPlayer(team.id, name.trim(), num.trim()); setName(""); setNum(""); } }}>Add</Btn>
          </div>
        )}
      </Card>
      <Eyebrow>Games ({games.length})</Eyebrow>
      <Card>
        {games.length === 0 && <p style={{ color: C.chalkDim, margin: 0 }}>No games logged yet.</p>}
        {games.map((g) => (
          <div key={g.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.line}22`, gap: 10 }}>
            <div onClick={() => openGame(g.id)} style={{ cursor: "pointer", flex: 1 }}>
              <div style={{ color: C.chalk, fontFamily: "Oswald, sans-serif", fontWeight: 500 }}>vs {g.opponent}</div>
              <div style={{ color: C.chalkDim, fontSize: 12, fontFamily: "IBM Plex Mono, monospace" }}>{g.date}</div>
            </div>
            <div onClick={() => openGame(g.id)} style={{ cursor: "pointer", textAlign: "right" }}>
              <div style={{ fontFamily: "IBM Plex Mono, monospace", color: C.amber, fontWeight: 600 }}>{g.ourScore} – {g.theirScore}</div>
              <div style={{ fontSize: 11, color: g.status === "live" ? C.amber : C.chalkDim, textTransform: "uppercase", letterSpacing: 1 }}>{g.status}</div>
            </div>
            {scorekeeper && (
              <button
                onClick={() => { if (window.confirm(`Delete the game vs ${g.opponent} (${g.date})? This can't be undone.`)) deleteGame(g.id); }}
                style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 16, padding: 4 }}
                title="Delete game"
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
function BackLink({ onClick, children = "Back" }) {
  return <div onClick={onClick} style={{ cursor: "pointer", color: C.amber, fontSize: 13, fontFamily: "IBM Plex Mono, monospace", marginBottom: 4 }}>← {children}</div>;
}

/* ---------------- NEW GAME ---------------- */
function NewGameView({ teams, players, defaultTeamId, onCancel, onStart }) {
  const [teamId, setTeamId] = useState(defaultTeamId || (teams[0] && teams[0].id) || "");
  const [opponent, setOpponent] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [isHome, setIsHome] = useState(true);
  const [lineup, setLineup] = useState([]);
  const teamPlayers = players.filter((p) => p.teamId === teamId);
  const toggleLineup = (id) => setLineup((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  const move = (id, dir) => setLineup((l) => { const i = l.indexOf(id); const j = i + dir; if (j < 0 || j >= l.length) return l; const c = [...l]; [c[i], c[j]] = [c[j], c[i]]; return c; });
  return (
    <div>
      <BackLink onClick={onCancel}>Cancel</BackLink>
      <h1 style={{ fontFamily: "Oswald, sans-serif", color: C.chalk, fontSize: 30, margin: "6px 0 16px" }}>New Game</h1>
      <Card style={{ marginBottom: 16 }}>
        <Field label="Team">
          <select value={teamId} onChange={(e) => { setTeamId(e.target.value); setLineup([]); }} style={selStyle}>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field label="Opponent"><input value={opponent} onChange={(e) => setOpponent(e.target.value)} placeholder="Opponent team name" style={selStyle} /></Field>
        <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={selStyle} /></Field>
        <Field label="We are">
          <div style={{ display: "flex", gap: 8 }}>
            <Btn tone={isHome ? "amber" : "ghost"} onClick={() => setIsHome(true)}>Home</Btn>
            <Btn tone={!isHome ? "amber" : "ghost"} onClick={() => setIsHome(false)}>Away</Btn>
          </div>
        </Field>
      </Card>
      <Eyebrow>Batting lineup — tap players in order</Eyebrow>
      <Card style={{ marginBottom: 16 }}>
        {teamPlayers.length === 0 && <p style={{ color: C.chalkDim }}>Add players to this team's roster first.</p>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: lineup.length ? 14 : 0 }}>
          {teamPlayers.map((p) => (
            <button key={p.id} onClick={() => toggleLineup(p.id)} style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${lineup.includes(p.id) ? C.amber : C.line}`, background: lineup.includes(p.id) ? C.amber : "transparent", color: lineup.includes(p.id) ? C.ink : C.chalk, fontWeight: 600, cursor: "pointer" }}>
              #{p.number || "—"} {p.name}
            </button>
          ))}
        </div>
        {lineup.length > 0 && lineup.map((id, i) => {
          const p = teamPlayers.find((x) => x.id === id);
          return (
            <div key={id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0" }}>
              <span style={{ fontFamily: "IBM Plex Mono, monospace", color: C.amber, width: 24 }}>{i + 1}.</span>
              <span style={{ color: C.chalk, flex: 1 }}>{p ? p.name : ""}</span>
              <button onClick={() => move(id, -1)} style={arrowStyle}>▲</button>
              <button onClick={() => move(id, 1)} style={arrowStyle}>▼</button>
            </div>
          );
        })}
      </Card>
      <Btn tone="amber" size="lg" disabled={!teamId || !opponent.trim() || lineup.length === 0} onClick={() => onStart({ teamId, opponent: opponent.trim(), date, isHome, lineup })}>Start Game</Btn>
    </div>
  );
}
const selStyle = { width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.chalk, color: C.ink };
const arrowStyle = { background: "none", border: `1px solid ${C.line}`, color: C.chalkDim, borderRadius: 6, width: 26, height: 26, cursor: "pointer" };
function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11, letterSpacing: 1, color: C.chalkDim, marginBottom: 5, textTransform: "uppercase" }}>{label}</div>
      {children}
    </div>
  );
}

/* ---------------- BATTING PREVIEW (at bat / on deck / in the hole) ---------------- */
function BattingPreview({ lineup, players, currentBatterIndex }) {
  if (!lineup || lineup.length === 0) return null;
  const at = (offset) => {
    const p = players.find((x) => x.id === lineup[(currentBatterIndex + offset) % lineup.length]);
    return p ? `#${p.number || "—"} ${p.name}` : "—";
  };
  return (
    <Card style={{ marginBottom: 16 }}>
      <Eyebrow>Batting order</Eyebrow>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        <div>
          <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: C.amber, letterSpacing: 1, marginBottom: 3 }}>AT BAT</div>
          <div style={{ color: C.chalk, fontFamily: "Oswald, sans-serif", fontSize: 15 }}>{at(0)}</div>
        </div>
        <div>
          <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: C.chalkDim, letterSpacing: 1, marginBottom: 3 }}>ON DECK</div>
          <div style={{ color: C.chalkDim, fontFamily: "Oswald, sans-serif", fontSize: 15 }}>{at(1)}</div>
        </div>
        <div>
          <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: C.chalkDim, letterSpacing: 1, marginBottom: 3 }}>IN THE HOLE</div>
          <div style={{ color: C.chalkDim, fontFamily: "Oswald, sans-serif", fontSize: 15 }}>{at(2)}</div>
        </div>
      </div>
    </Card>
  );
}

/* ---------------- BALL-STRIKE COUNTER (shared by offense/defense) ---------------- */
function PitchCounter({ title, pitcherControl, balls, strikes, onBall, onStrike, disabled }) {
  const pitches = balls + strikes;
  const pct = pitches > 0 ? Math.round((strikes / pitches) * 100) : 0;
  return (
    <Card style={{ marginBottom: 16 }}>
      <Eyebrow>{title}</Eyebrow>
      {pitcherControl && <div style={{ marginBottom: 10 }}>{pitcherControl}</div>}
      <div style={{ fontSize: 11, color: C.chalkDim, marginBottom: 10 }}>Tap here for every pitch — it updates the live count above and this pitcher's game totals together.</div>
      <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: C.chalkDim, letterSpacing: 1 }}>BALLS</div>
          <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 26, color: C.chalk, fontWeight: 700 }}>{balls}</div>
          <Btn size="sm" onClick={onBall} disabled={disabled}>+1 Ball</Btn>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: C.chalkDim, letterSpacing: 1 }}>STRIKES</div>
          <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 26, color: C.chalk, fontWeight: 700 }}>{strikes}</div>
          <Btn size="sm" tone="amber" onClick={onStrike} disabled={disabled}>+1 Strike</Btn>
        </div>
        <div style={{ textAlign: "center", marginLeft: "auto" }}>
          <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: C.chalkDim, letterSpacing: 1 }}>PITCHES / STRIKE%</div>
          <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 18, color: C.amber, fontWeight: 700 }}>{pitches} · {pct}%</div>
        </div>
      </div>
    </Card>
  );
}

/* ---------------- LIVE / FINAL BOX SCORE (shared) ---------------- */
function BoxScoreTable({ lineup, players, plays, scores }) {
  const rows = lineup.map((pid) => players.find((p) => p.id === pid)).filter(Boolean).map((p) => ({ p, s: computeStatsFromPlays(p.id, plays, scores) }));
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "IBM Plex Mono, monospace", fontSize: 13 }}>
        <thead><tr style={{ color: C.amber, textAlign: "left" }}>{["Player", "AB", "R", "H", "RBI", "BB", "K", "AVG"].map((h) => <th key={h} style={{ padding: "4px 8px", borderBottom: `1px solid ${C.line}55` }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map(({ p, s }) => (
          <tr key={p.id} style={{ color: C.chalk }}>
            <td style={{ padding: "4px 8px" }}>{p.name}</td><td style={{ padding: "4px 8px" }}>{s.AB}</td><td style={{ padding: "4px 8px" }}>{s.R}</td>
            <td style={{ padding: "4px 8px" }}>{s.H}</td><td style={{ padding: "4px 8px" }}>{s.RBI}</td><td style={{ padding: "4px 8px" }}>{s.BB}</td>
            <td style={{ padding: "4px 8px" }}>{s.K}</td><td style={{ padding: "4px 8px" }}>{fmt3(s.AVG)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
function PitchingLineDisplay({ game, players }) {
  const p = game.pitching;
  const stints = [...p.ourHistory];
  if (p.ourPitcherId) stints.push({ playerId: p.ourPitcherId, balls: p.ourBalls, strikes: p.ourStrikes, outsRecorded: game.totalPitchingOuts - p.ourOutsAtStintStart, earnedRuns: p.ourEarnedRuns });
  const byPlayer = {};
  stints.forEach((s) => {
    byPlayer[s.playerId] = byPlayer[s.playerId] || [];
    byPlayer[s.playerId].push(s);
  });
  const names = Object.keys(byPlayer);
  if (names.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: C.chalkDim, letterSpacing: 1, marginBottom: 4 }}>PITCHING</div>
      {names.map((pid) => {
        const player = players.find((x) => x.id === pid);
        const line = pitchingLine(byPlayer[pid]);
        return (
          <div key={pid} style={{ color: C.chalk, fontSize: 13, fontFamily: "IBM Plex Mono, monospace" }}>
            {player ? player.name : "?"} — {ipDisplay(line.outs)} IP, {line.er} ER, ERA {line.era.toFixed(2)}, {line.strikePct.toFixed(0)}% strikes ({line.strikes}/{line.pitches})
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- LIVE GAME ---------------- */
function LiveGameView(props) {
  const {
    game, team, players, usBatting, scorekeeper, selectedBase,
    recordOutcome, tapBase, runnerAction, defenseOut, theirRun, skipHalf, undoLast, endGame,
    setPosition, bumpFielding, setOurPitcher, setTheirPitcherName, bumpPitchAndCount,
    goHome,
  } = props;
  const batter = players.find((p) => p.id === game.lineup[game.currentBatterIndex % game.lineup.length]);
  const recentPlays = [...game.plays].slice(-14).reverse();
  const baseNames = {
    1: game.bases[1] ? firstName((players.find((p) => p.id === game.bases[1]) || {}).name) : null,
    2: game.bases[2] ? firstName((players.find((p) => p.id === game.bases[2]) || {}).name) : null,
    3: game.bases[3] ? firstName((players.find((p) => p.id === game.bases[3]) || {}).name) : null,
  };
  const defensivePlayers = game.lineup.map((id) => players.find((p) => p.id === id)).filter(Boolean);
  const ourPitcher = players.find((p) => p.id === game.pitching.ourPitcherId);

  return (
    <div>
      <BackLink onClick={goHome}>Home</BackLink>
      <ScoreHeader game={game} team={team} />

      <div className="live-grid">
        <div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
            <Card style={{ flex: "0 0 auto" }}>
              <Diamond bases={game.bases} names={baseNames} />
              <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 10 }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: C.chalkDim, letterSpacing: 1 }}>COUNT</div>
                  <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 28, fontWeight: 700, color: C.amber }}>{game.count.balls}-{game.count.strikes}</div>
                </div>
                <div style={{ width: 1, background: `${C.line}55` }} />
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: C.chalkDim, letterSpacing: 1 }}>OUTS</div>
                  <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 28, fontWeight: 700, color: C.chalk }}>{game.outs}<span style={{ fontSize: 16, color: C.chalkDim }}>/3</span></div>
                </div>
              </div>
            </Card>

            {selectedBase != null && scorekeeper && (
              <Card style={{ flex: 1, minWidth: 220 }}>
                <Eyebrow>Runner on base {selectedBase}</Eyebrow>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <Btn size="sm" onClick={() => runnerAction("advance")}>Advance 1 Base</Btn>
                  <Btn size="sm" tone="amber" onClick={() => runnerAction("score-rbi")}>Scores (RBI)</Btn>
                  <Btn size="sm" tone="amber" onClick={() => runnerAction("score-norbi")}>Scores (No RBI)</Btn>
                  <Btn size="sm" tone="red" onClick={() => runnerAction("out")}>Out on Bases</Btn>
                </div>
              </Card>
            )}
          </div>

          {scorekeeper && [1, 2, 3].some((n) => game.bases[n]) && (
            <div style={{ marginTop: -8, marginBottom: 16 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {[1, 2, 3].filter((n) => game.bases[n]).map((n) => (
                  <button key={n} onClick={() => tapBase(n)} style={{ fontSize: 12, padding: "5px 10px", borderRadius: 14, border: `1px solid ${C.amber}`, background: selectedBase === n ? C.amber : "transparent", color: selectedBase === n ? C.ink : C.amber, cursor: "pointer" }}>
                    Runner on {n === 1 ? "1st" : n === 2 ? "2nd" : "3rd"}: {baseNames[n]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!scorekeeper && <BattingPreview lineup={game.lineup} players={players} currentBatterIndex={game.currentBatterIndex} />}

          {!scorekeeper && (
            <Card style={{ marginBottom: 16 }}>
              <p style={{ color: C.chalkDim, margin: 0, fontSize: 13 }}>You're in Viewer Mode — following along live.</p>
            </Card>
          )}

          {scorekeeper && usBatting && (
            <Card style={{ marginBottom: 16 }}>
              <Eyebrow>At bat</Eyebrow>
              <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 24, color: C.chalk, marginBottom: 4 }}>#{batter ? batter.number || "—" : "—"} {batter ? batter.name : "—"}</div>
              <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 12, color: C.chalkDim, marginBottom: 12 }}>
                On deck: {(() => { const p = players.find((x) => x.id === game.lineup[(game.currentBatterIndex + 1) % game.lineup.length]); return p ? p.name : "—"; })()}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))", gap: 8 }}>
                {OUTCOMES.map((o) => (
                  <button key={o.key} title={o.full} onClick={() => recordOutcome(o.key)} style={{ padding: "14px 6px", borderRadius: 10, border: `1px solid ${C.line}55`, background: o.out ? C.navy : o.hit ? C.amber : C.dirt, color: o.out ? C.chalk : o.hit ? C.ink : C.chalk, fontFamily: "IBM Plex Mono, monospace", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>
                    {o.label}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                <Btn tone="ghost" size="sm" onClick={undoLast} disabled={game.plays.length === 0}>Undo Last Play</Btn>
                <Btn tone="ghost" size="sm" onClick={skipHalf}>Skip to Next Half-Inning</Btn>
              </div>
            </Card>
          )}

          {scorekeeper && usBatting && (
            <PitchCounter
              title={`Their pitcher${game.pitching.theirName ? " — " + game.pitching.theirName : ""}`}
              pitcherControl={
                <input
                  value={game.pitching.theirName}
                  onChange={(e) => setTheirPitcherName(e.target.value)}
                  placeholder="Pitcher name / number"
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.chalk, color: C.ink, fontSize: 13 }}
                />
              }
              balls={game.pitching.theirBalls}
              strikes={game.pitching.theirStrikes}
              onBall={() => bumpPitchAndCount("their", "ball", 1)}
              onStrike={() => bumpPitchAndCount("their", "strike", 1)}
            />
          )}

          {scorekeeper && !usBatting && (
            <>
              <Card style={{ marginBottom: 16 }}>
                <Eyebrow>On defense — {game.opponent} batting</Eyebrow>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <Btn onClick={() => defenseOut()} style={{ background: C.navy }}>Record Out</Btn>
                  <Btn tone="amber" onClick={() => theirRun(1, true)}>+1 Run (Earned)</Btn>
                  <Btn tone="dirt" onClick={() => theirRun(1, false)}>+1 Run (Unearned)</Btn>
                  <Btn tone="ghost" size="sm" onClick={() => theirRun(-1, false)}>-1 Run</Btn>
                  <Btn tone="ghost" size="sm" onClick={skipHalf}>Skip to Next Half-Inning</Btn>
                </div>
              </Card>

              <PitchCounter
                title="Our pitcher"
                pitcherControl={
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <select value={game.pitching.ourPitcherId || ""} onChange={(e) => setOurPitcher(e.target.value || null)} style={{ ...selStyle, width: "auto", flex: "1 1 160px" }}>
                      <option value="">Select pitcher…</option>
                      {defensivePlayers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    {ourPitcher && <span style={{ fontSize: 12, color: C.chalkDim, fontFamily: "IBM Plex Mono, monospace" }}>Now pitching: {ourPitcher.name}</span>}
                  </div>
                }
                balls={game.pitching.ourBalls}
                strikes={game.pitching.ourStrikes}
                onBall={() => bumpPitchAndCount("our", "ball", 1)}
                onStrike={() => bumpPitchAndCount("our", "strike", 1)}
                disabled={!game.pitching.ourPitcherId}
              />

              <Card style={{ marginBottom: 16 }}>
                <Eyebrow>Defensive positions & fielding</Eyebrow>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {defensivePlayers.map((p) => {
                    const f = game.fielding[p.id] || { PO: 0, A: 0, E: 0 };
                    return (
                      <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", borderBottom: `1px solid ${C.line}22`, paddingBottom: 8 }}>
                        <span style={{ color: C.chalk, minWidth: 110, fontSize: 13 }}>{p.name}</span>
                        <select value={game.defense.positions[p.id] || ""} onChange={(e) => setPosition(p.id, e.target.value)} style={{ ...selStyle, width: 68, padding: "5px 6px", fontSize: 12 }}>
                          <option value="">–</option>
                          {POSITIONS.map((pos) => <option key={pos} value={pos}>{pos}</option>)}
                        </select>
                        {["PO", "A", "E"].map((stat) => (
                          <span key={stat} style={{ display: "flex", alignItems: "center", gap: 3, fontFamily: "IBM Plex Mono, monospace", fontSize: 12 }}>
                            <button onClick={() => bumpFielding(p.id, stat, -1)} style={miniBtn}>-</button>
                            <span style={{ color: C.amber, minWidth: 26, textAlign: "center" }}>{stat} {f[stat]}</span>
                            <button onClick={() => bumpFielding(p.id, stat, 1)} style={miniBtn}>+</button>
                          </span>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </Card>
            </>
          )}

          <Eyebrow>Live box score — {team ? team.name : "Us"}</Eyebrow>
          <Card style={{ marginBottom: 16 }}>
            <BoxScoreTable lineup={game.lineup} players={players} plays={game.plays} scores={game.scores} />
            <PitchingLineDisplay game={game} players={players} />
          </Card>

          {scorekeeper && <Btn tone="red" size="lg" onClick={endGame}>End Game & Build Recap</Btn>}
        </div>

        <div className="sidebar">
          <Eyebrow>Recent plays</Eyebrow>
          <Card>
            {recentPlays.length === 0 && <p style={{ color: C.chalkDim, margin: 0, fontSize: 13 }}>No plays recorded yet.</p>}
            {recentPlays.map((p) => {
              const pl = players.find((x) => x.id === p.playerId);
              const o = outcomeByKey(p.outcome);
              return (
                <div key={p.id} style={{ padding: "6px 0", borderBottom: `1px solid ${C.line}22`, fontSize: 13 }}>
                  <div style={{ color: C.chalk }}>{p.half === "top" ? "T" : "B"}{p.inning} — {pl ? pl.name : "?"}</div>
                  <div style={{ color: C.amber, fontFamily: "IBM Plex Mono, monospace", fontSize: 12 }}>{o.full}{p.rbi ? ` · ${p.rbi} RBI` : ""}</div>
                </div>
              );
            })}
          </Card>
        </div>
      </div>
    </div>
  );
}
const miniBtn = { background: "none", border: `1px solid ${C.line}`, color: C.chalkDim, borderRadius: 4, width: 18, height: 18, cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 0 };

function BatIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
      <g transform="rotate(-40 12 12)">
        <rect x="10.5" y="2" width="3" height="12" rx="1.5" fill={C.amber} />
        <rect x="10" y="13" width="4" height="9" rx="2" fill={C.dirt} />
      </g>
    </svg>
  );
}

/* ---------------- BIG-PRINT SCOREBOARD ---------------- */
function ScoreHeader({ game, team }) {
  const ourName = team ? team.name : "Us";
  const usBatting = game.isHome ? game.half === "bottom" : game.half === "top";
  return (
    <Card style={{ marginBottom: 16, background: C.navy, border: "none" }}>
      <div
        style={{
          display: "inline-block",
          background: C.amber,
          color: C.ink,
          borderRadius: 8,
          padding: "6px 16px",
          fontFamily: "Oswald, sans-serif",
          fontWeight: 700,
          fontSize: 26,
          letterSpacing: 1,
          marginBottom: 14,
        }}
      >
        {game.half === "top" ? "▲ TOP" : "▼ BOT"} {game.inning}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {[{ name: ourName, score: game.ourScore, batting: usBatting }, { name: game.opponent, score: game.theirScore, batting: !usBatting }].map((row, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
              {row.batting && <BatIcon />}
              <div style={{ fontFamily: "Oswald, sans-serif", color: C.chalk, fontSize: 20, fontWeight: 500, minWidth: 0, wordBreak: "break-word", lineHeight: 1.2 }}>
                {row.name}
              </div>
            </div>
            <div style={{ fontFamily: "IBM Plex Mono, monospace", color: C.chalk, fontSize: 40, fontWeight: 800, minWidth: 56, textAlign: "right" }}>
              {row.score}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ---------------- SUMMARY ---------------- */
function SummaryView({ game, team, players, scorekeeper, generating, generateRecap, updateReport, updateGameMeta, reopenGame, deleteGame, goHome }) {
  const [editing, setEditing] = useState(false);
  const [opponent, setOpponent] = useState(game.opponent);
  const [date, setDate] = useState(game.date);
  const [ourScore, setOurScore] = useState(game.ourScore);
  const [theirScore, setTheirScore] = useState(game.theirScore);

  const rows = game.lineup.map((pid) => players.find((p) => p.id === pid)).filter(Boolean).map((p) => ({ p, s: computeStatsFromPlays(p.id, game.plays, game.scores) }));

  const emailHref = () => {
    const subject = encodeURIComponent(`${team ? team.name : "Game"} vs ${game.opponent} — ${game.date}`);
    const bodyLines = [`Final: ${team ? team.name : "Us"} ${game.ourScore} – ${game.opponent} ${game.theirScore}`, "", game.report || "", "", "Box score:", ...rows.map(({ p, s }) => `${p.name}: ${s.AB} AB, ${s.H} H, ${s.R} R, ${s.RBI} RBI`)];
    return `mailto:?subject=${subject}&body=${encodeURIComponent(bodyLines.join("\n"))}`;
  };

  return (
    <div>
      <BackLink onClick={goHome}>Home</BackLink>
      <ScoreHeader game={game} team={team} />

      {scorekeeper && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: editing ? 12 : 0 }}>
            <Eyebrow>Game settings</Eyebrow>
            <Btn size="sm" tone="ghost" onClick={() => setEditing((e) => !e)}>{editing ? "Cancel" : "Edit Game"}</Btn>
          </div>
          {editing && (
            <>
              <Field label="Opponent"><input value={opponent} onChange={(e) => setOpponent(e.target.value)} style={selStyle} /></Field>
              <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={selStyle} /></Field>
              <div style={{ display: "flex", gap: 10 }}>
                <Field label="Our score"><input type="number" value={ourScore} onChange={(e) => setOurScore(Number(e.target.value))} style={selStyle} /></Field>
                <Field label="Their score"><input type="number" value={theirScore} onChange={(e) => setTheirScore(Number(e.target.value))} style={selStyle} /></Field>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Btn tone="amber" size="sm" onClick={() => { updateGameMeta({ opponent, date, ourScore, theirScore }); setEditing(false); }}>Save Changes</Btn>
                <Btn tone="ghost" size="sm" onClick={reopenGame}>Reopen Game (Fix Plays)</Btn>
                <Btn tone="red" size="sm" onClick={() => { if (window.confirm(`Delete this game vs ${game.opponent}? This can't be undone.`)) deleteGame(game.id); }}>Delete Game</Btn>
              </div>
            </>
          )}
        </Card>
      )}

      <Eyebrow>Final Box Score</Eyebrow>
      <Card style={{ marginBottom: 16 }}>
        <BoxScoreTable lineup={game.lineup} players={players} plays={game.plays} scores={game.scores} />
      </Card>

      {(game.pitching.ourHistory.length > 0 || game.pitching.ourPitcherId || Object.keys(game.fielding).length > 0) && (
        <>
          <Eyebrow>Pitching & Fielding</Eyebrow>
          <Card style={{ marginBottom: 16 }}>
            <PitchingLineDisplay game={game} players={players} />
            {game.pitching.theirName && (
              <div style={{ color: C.chalkDim, fontSize: 13, fontFamily: "IBM Plex Mono, monospace", marginTop: 8 }}>
                {game.opponent} — {game.pitching.theirName}: {game.pitching.theirBalls + game.pitching.theirStrikes} pitches, {game.pitching.theirStrikes} strikes
                ({(game.pitching.theirBalls + game.pitching.theirStrikes) > 0 ? Math.round((game.pitching.theirStrikes / (game.pitching.theirBalls + game.pitching.theirStrikes)) * 100) : 0}%)
              </div>
            )}
            {Object.keys(game.fielding).length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 10 }}>
                {Object.entries(game.fielding).filter(([, f]) => f.PO || f.A || f.E).map(([pid, f]) => {
                  const p = players.find((x) => x.id === pid);
                  return <div key={pid} style={{ color: C.chalk, fontSize: 13, fontFamily: "IBM Plex Mono, monospace" }}>{p ? p.name : "?"} — {f.PO} PO, {f.A} A, {f.E} E</div>;
                })}
              </div>
            )}
          </Card>
        </>
      )}

      <Eyebrow>Game recap</Eyebrow>
      <Card style={{ marginBottom: 16 }}>
        {!game.report && <Btn tone="amber" onClick={generateRecap} disabled={generating}>{generating ? "Writing recap…" : "Generate Recap"}</Btn>}
        {game.report && (
          <>
            <textarea value={game.report} onChange={(e) => updateReport(e.target.value)} rows={8} style={{ width: "100%", padding: 10, borderRadius: 8, border: `1px solid ${C.line}`, background: C.chalk, color: C.ink, fontSize: 14, lineHeight: 1.5, resize: "vertical" }} />
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <Btn size="sm" tone="ghost" onClick={generateRecap} disabled={generating}>{generating ? "Regenerating…" : "Regenerate"}</Btn>
              <Btn size="sm" tone="ghost" onClick={() => navigator.clipboard && navigator.clipboard.writeText(game.report)}>Copy Text</Btn>
              <a href={emailHref()} style={{ textDecoration: "none" }}><Btn size="sm" tone="amber">Email Recap</Btn></a>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

/* ---------------- SEASON STATS ---------------- */
function SeasonView({ teams, players, loadFinalGamesForTeam, goHome }) {
  const [teamId, setTeamId] = useState(teams[0] && teams[0].id);
  const [games, setGames] = useState([]);
  const [sortKey, setSortKey] = useState("AVG");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!teamId) return;
    setLoading(true);
    loadFinalGamesForTeam(teamId).then((g) => { setGames(g); setLoading(false); });
  }, [teamId, loadFinalGamesForTeam]);
  const rosterPlayers = players.filter((p) => p.teamId === teamId);
  const allPlays = games.flatMap((g) => g.plays);
  const allScores = games.flatMap((g) => g.scores || []);
  const rows = rosterPlayers.map((p) => ({ p, s: computeStatsFromPlays(p.id, allPlays, allScores) })).sort((a, b) => b.s[sortKey] - a.s[sortKey]);
  const sortable = ["AVG", "OBP", "SLG", "H", "R", "RBI", "HR", "BB", "K"];

  const fieldingTotals = {};
  const pitchStintsByPlayer = {};
  games.forEach((g) => {
    Object.entries(g.fielding || {}).forEach(([pid, f]) => {
      fieldingTotals[pid] = fieldingTotals[pid] || { PO: 0, A: 0, E: 0 };
      fieldingTotals[pid].PO += f.PO || 0;
      fieldingTotals[pid].A += f.A || 0;
      fieldingTotals[pid].E += f.E || 0;
    });
    (g.pitching?.ourHistory || []).forEach((h) => {
      pitchStintsByPlayer[h.playerId] = pitchStintsByPlayer[h.playerId] || [];
      pitchStintsByPlayer[h.playerId].push(h);
    });
  });

  return (
    <div>
      <BackLink onClick={goHome}>Home</BackLink>
      <h1 style={{ fontFamily: "Oswald, sans-serif", color: C.chalk, fontSize: 30, margin: "6px 0 16px" }}>Season Stats</h1>

      <Field label="Team">
        <select value={teamId} onChange={(e) => setTeamId(e.target.value)} style={selStyle}>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Field>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {sortable.map((k) => (
          <button key={k} onClick={() => setSortKey(k)} style={{ padding: "4px 10px", borderRadius: 14, fontSize: 12, fontFamily: "IBM Plex Mono, monospace", border: `1px solid ${sortKey === k ? C.amber : C.line}`, background: sortKey === k ? C.amber : "transparent", color: sortKey === k ? C.ink : C.chalkDim, cursor: "pointer" }}>{k}</button>
        ))}
      </div>

      <Card style={{ overflowX: "auto", marginBottom: 16 }}>
        {loading && <p style={{ color: C.chalkDim }}>Loading games…</p>}
        {!loading && rows.length === 0 && <p style={{ color: C.chalkDim, margin: 0 }}>No finished games yet for this team.</p>}
        {!loading && rows.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "IBM Plex Mono, monospace", fontSize: 12.5, minWidth: 560 }}>
            <thead>
              <tr style={{ color: C.amber, textAlign: "left" }}>
                {["Player", "PA", "AB", "R", "H", "2B", "3B", "HR", "RBI", "BB", "K", "AVG", "OBP", "SLG"].map((h) => (
                  <th key={h} style={{ padding: "4px 6px", borderBottom: `1px solid ${C.line}55` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, s }) => (
                <tr key={p.id} style={{ color: C.chalk }}>
                  <td style={{ padding: "4px 6px" }}>{p.name}</td>
                  <td style={{ padding: "4px 6px" }}>{s.PA}</td>
                  <td style={{ padding: "4px 6px" }}>{s.AB}</td>
                  <td style={{ padding: "4px 6px" }}>{s.R}</td>
                  <td style={{ padding: "4px 6px" }}>{s.H}</td>
                  <td style={{ padding: "4px 6px" }}>{s["2B"]}</td>
                  <td style={{ padding: "4px 6px" }}>{s["3B"]}</td>
                  <td style={{ padding: "4px 6px" }}>{s.HR}</td>
                  <td style={{ padding: "4px 6px" }}>{s.RBI}</td>
                  <td style={{ padding: "4px 6px" }}>{s.BB}</td>
                  <td style={{ padding: "4px 6px" }}>{s.K}</td>
                  <td style={{ padding: "4px 6px" }}>{fmt3(s.AVG)}</td>
                  <td style={{ padding: "4px 6px" }}>{fmt3(s.OBP)}</td>
                  <td style={{ padding: "4px 6px" }}>{fmt3(s.SLG)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {(Object.keys(pitchStintsByPlayer).length > 0) && (
        <>
          <Eyebrow>Season Pitching</Eyebrow>
          <Card style={{ overflowX: "auto", marginBottom: 16 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "IBM Plex Mono, monospace", fontSize: 12.5, minWidth: 480 }}>
              <thead>
                <tr style={{ color: C.amber, textAlign: "left" }}>
                  {["Player", "IP", "ER", "ERA", "Pitches", "Strike%"].map((h) => <th key={h} style={{ padding: "4px 6px", borderBottom: `1px solid ${C.line}55` }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {Object.entries(pitchStintsByPlayer).map(([pid, stints]) => {
                  const p = rosterPlayers.find((x) => x.id === pid);
                  const line = pitchingLine(stints);
                  return (
                    <tr key={pid} style={{ color: C.chalk }}>
                      <td style={{ padding: "4px 6px" }}>{p ? p.name : "?"}</td>
                      <td style={{ padding: "4px 6px" }}>{ipDisplay(line.outs)}</td>
                      <td style={{ padding: "4px 6px" }}>{line.er}</td>
                      <td style={{ padding: "4px 6px" }}>{line.era.toFixed(2)}</td>
                      <td style={{ padding: "4px 6px" }}>{line.pitches}</td>
                      <td style={{ padding: "4px 6px" }}>{line.strikePct.toFixed(0)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ fontSize: 11, color: C.chalkDim, marginTop: 8 }}>ERA is normalized to a {ERA_INNINGS}-inning game.</div>
          </Card>
        </>
      )}

      {Object.keys(fieldingTotals).length > 0 && (
        <>
          <Eyebrow>Season Fielding</Eyebrow>
          <Card style={{ overflowX: "auto" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {Object.entries(fieldingTotals).map(([pid, f]) => {
                const p = rosterPlayers.find((x) => x.id === pid);
                return <div key={pid} style={{ color: C.chalk, fontSize: 13, fontFamily: "IBM Plex Mono, monospace" }}>{p ? p.name : "?"} — {f.PO} PO, {f.A} A, {f.E} E</div>;
              })}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
