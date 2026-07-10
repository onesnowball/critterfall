/* Semantic effect-verification harness for Critterfall.
 *
 * Unlike the structural soak test, this drives thousands of real random games
 * and, after every action, verifies that the ANIMATION EVENTS the server emits
 * (what a player sees on screen) actually correspond to the real game-state
 * change — plus a set of zero-false-positive integrity invariants.
 *
 * Run: node scripts/verifyEffects.js [games] [maxSteps]
 *
 * HARD failures (a real bug):
 *   - uniqueness: a card instanceId is in two places at once (duplication)
 *   - move/destroy/discard anim event whose card did NOT leave its 'from' zone
 *   - a "Resisted" gene-pool shield while the pool actually dropped that step
 *
 * WARN/stat (eyeball): net card loss, gene-delta mismatches, orphaned events.
 */
const path = require("path");
const ROOT = path.join(__dirname, "..");
const engine = require(path.join(ROOT, "server", "gameEngine.js"));

const GAMES = Number(process.argv[2] || 400);
const MAX_STEPS = Number(process.argv[3] || 1200);

const stats = {
  steps: 0,
  crashes: 0,
  uniquenessFails: 0,
  fromZoneFails: 0,
  resistFails: 0,
  netLossWarns: 0,
  geneMismatchWarns: 0,
  events: {},
  finished: 0,
  scoreFails: 0
};
const samples = [];

function sample(msg) {
  if (samples.length < 40) samples.push(msg);
}

function randInt(n) {
  return Math.floor(Math.random() * n);
}
function pick(arr) {
  return arr[randInt(arr.length)];
}

// Map every card instanceId -> where it lives right now. Detect duplicates.
function locate(room) {
  const loc = new Map();
  const dupes = [];
  const put = (id, where) => {
    if (loc.has(id)) dupes.push({ id, a: loc.get(id), b: where });
    else loc.set(id, where);
  };
  for (const p of room.players) {
    for (const c of p.hand) put(c.instanceId, `hand:${p.id}`);
    for (const c of p.board) {
      put(c.instanceId, `board:${p.id}`);
      for (const a of c.attachments || []) put(a.instanceId, `attach:${p.id}:${c.instanceId}`);
    }
  }
  for (const c of room.traitDeck) put(c.instanceId, "draw");
  for (const c of room.discardPile) put(c.instanceId, "discard");
  // A card mid-effect (e.g. a Parasite awaiting its "which Trait Row?" choice)
  // has already left its hand but is not yet on any board — it lives only in
  // the pending choice's heldCard. Count that in-flight slot so we neither
  // undercount total cards (false net-loss) nor miss a real duplication there.
  const held = room.pendingChoice && room.pendingChoice.heldCard;
  if (held && held.instanceId) put(held.instanceId, "held");
  return { loc, dupes };
}

function geneMap(room) {
  const m = {};
  for (const p of room.players) m[p.id] = Number(p.genePoolSize || 0);
  return m;
}

// Turn an anim `from`/`to` descriptor into the same location string `locate`
// emits, so we can match an exact instance by instanceId.
function locString(desc) {
  if (!desc || !desc.zone) return null;
  if (desc.zone === "discard") return "discard";
  if (desc.zone === "draw") return "draw";
  if (!desc.playerId) return null;
  if (desc.zone === "hand") return `hand:${desc.playerId}`;
  return `board:${desc.playerId}`;
}

function checkStep(before, room, newEvents, label) {
  // 1) Uniqueness — hard.
  const after = locate(room);
  const { dupes } = after;
  if (dupes.length) {
    stats.uniquenessFails += 1;
    sample(`UNIQUENESS ${label}: ${dupes[0].id} in ${dupes[0].a} & ${dupes[0].b}`);
  }

  // 2) Anim-event ↔ state correspondence. Anim snapshots now carry instanceId,
  //    so we verify the EXACT instance left its claimed from-zone (no coarse
  //    card.id counting, which can't tell two same-def copies apart).
  //    A single engine call can cascade (e.g. a card is destroyed, then an Age
  //    lets its owner replay it from discard). Each of those is a truthful,
  //    separately-animated event. So a "left X" event is only a lie if the
  //    instance is back in X AND no LATER event in the same batch legitimately
  //    moved it there (its `to` resolves to X).
  for (let i = 0; i < newEvents.length; i += 1) {
    const ev = newEvents[i];
    stats.events[ev.type] = (stats.events[ev.type] || 0) + 1;

    if ((ev.type === "move" || ev.type === "destroy" || ev.type === "discard") && ev.card && ev.card.instanceId) {
      const fromStr = locString(ev.from);
      const iid = ev.card.instanceId;
      if (fromStr) {
        const wasThere = before.loc.get(iid) === fromStr;
        const stillThere = after.loc.get(iid) === fromStr;
        const broughtBack = newEvents
          .slice(i + 1)
          .some((later) => later.card && later.card.instanceId === iid && locString(later.to) === fromStr);
        // Was in the claimed from-zone before, still there after, and nothing
        // later moved it back — the on-screen "it left" animation is lying.
        if (wasThere && stillThere && !broughtBack) {
          stats.fromZoneFails += 1;
          sample(`FROMZONE ${label}: ${ev.type} of ${ev.card.name} (${iid}) claims from ${fromStr} but it never left`);
        }
      }
    }

    // 3) "Resisted" means a negative gene change was fully blocked.
    if (ev.type === "shield" && ev.label === "Resisted") {
      const b = before.gene[ev.playerId] ?? 0;
      const a = geneMap(room)[ev.playerId] ?? 0;
      if (a < b) {
        stats.resistFails += 1;
        sample(`RESIST ${label}: ${ev.playerId} pool dropped ${b}->${a} despite "Resisted"`);
      }
    }
  }

  // 4) Gene event delta sign sanity (warn only — clamping makes exact sums noisy).
  const geneEvents = newEvents.filter((e) => e.type === "gene");
  if (geneEvents.length === 1) {
    const e = geneEvents[0];
    const b = before.gene[e.playerId] ?? 0;
    const a = geneMap(room)[e.playerId] ?? 0;
    const net = a - b;
    if (net !== 0 && Math.sign(net) !== Math.sign(e.delta)) {
      stats.geneMismatchWarns += 1;
      sample(`GENE ${label}: event delta ${e.delta} but pool moved ${b}->${a}`);
    }
  }

  // 5) Net non-token card loss (warn) — cards should go to discard, not vanish.
  const beforeCount = before.loc.size;
  const afterCount = after.loc.size;
  // Copies can ADD ids; nothing should silently remove them. A drop is suspicious.
  if (afterCount < beforeCount) {
    stats.netLossWarns += 1;
    sample(`NETLOSS ${label}: total tracked cards ${beforeCount}->${afterCount}`);
  }
}

function step(room, label) {
  const before = { loc: locate(room).loc, gene: geneMap(room) };
  const baseSeq = room.animEvents && room.animEvents.length ? room.animEvents[room.animEvents.length - 1].seq : 0;

  if (room.pendingChoice) {
    const c = room.pendingChoice;
    engine.resolveChoice(room, c.playerId, c.id, pick(c.choices).id);
  } else if (room.pendingDiscard) {
    const pid = room.pendingDiscard.playerId;
    const p = room.players.find((x) => x.id === pid);
    if (p && p.hand.length) engine.discardCard(room, pid, pick(p.hand).instanceId);
    else return before;
  } else if (room.phase === "playing") {
    const cur = room.players[room.currentPlayerIndex];
    if (!cur) {
      engine.skipTurn(room, room.players[0].id);
    } else if (cur.hand.length && Math.random() < 0.72) {
      try {
        engine.playCard(room, cur.id, pick(cur.hand).instanceId);
      } catch (e) {
        engine.skipTurn(room, cur.id);
      }
    } else {
      engine.skipTurn(room, cur.id);
    }
  }

  const newEvents = (room.animEvents || []).filter((e) => e.seq > baseSeq);
  checkStep(before, room, newEvents, label);
  return before;
}

for (let g = 0; g < GAMES; g += 1) {
  const room = engine.createRoom(`VER${g}`, "p1", "Ana");
  engine.joinRoom(room, "p2", "Bo");
  engine.joinRoom(room, "p3", "Cy");
  if (Math.random() < 0.4) engine.joinRoom(room, "p4", "Di");

  try {
    engine.startGame(room, "p1");
  } catch (e) {
    stats.crashes += 1;
    sample(`START ${g}: ${e.message}`);
    continue;
  }

  let s = 0;
  while (s < MAX_STEPS && room.phase === "playing") {
    try {
      step(room, `g${g}s${s}`);
    } catch (e) {
      stats.crashes += 1;
      sample(`STEP g${g}s${s}: ${e.message}`);
      break;
    }
    stats.steps += 1;
    s += 1;
  }

  if (room.phase === "gameOver") {
    stats.finished += 1;
    for (const sc of room.finalScores || []) {
      for (const k of ["baseScore", "bonusTotal", "total"]) {
        if (!Number.isInteger(sc[k])) {
          stats.scoreFails += 1;
          sample(`SCORE g${g}: ${k}=${sc[k]} for ${sc.name}`);
        }
      }
    }
  }
}

console.log("=== Critterfall semantic verification ===");
console.log(`games:            ${GAMES}  (finished ${stats.finished})`);
console.log(`steps:            ${stats.steps}`);
console.log(`crashes:          ${stats.crashes}`);
console.log("--- HARD checks ---");
console.log(`uniqueness fails: ${stats.uniquenessFails}`);
console.log(`from-zone fails:  ${stats.fromZoneFails}`);
console.log(`resist fails:     ${stats.resistFails}`);
console.log(`score fails:      ${stats.scoreFails}`);
console.log("--- WARN/stat ---");
console.log(`net-loss warns:   ${stats.netLossWarns}`);
console.log(`gene mismatch:    ${stats.geneMismatchWarns}`);
console.log(`event census:     ${JSON.stringify(stats.events)}`);
if (samples.length) {
  console.log("--- samples ---");
  for (const m of samples) console.log("  " + m);
}
const hardOk = !stats.crashes && !stats.uniquenessFails && !stats.fromZoneFails && !stats.resistFails && !stats.scoreFails;
console.log(hardOk ? "RESULT: PASS (hard checks)" : "RESULT: FAIL (hard checks)");
process.exit(hardOk ? 0 : 1);
