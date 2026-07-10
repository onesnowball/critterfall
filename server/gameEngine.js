const { AGE_CARDS, TRAIT_CARDS } = require("./cards");

const STARTING_HAND_SIZE = 5;
const STARTING_GENE_POOL_SIZE = 5;
const MIN_GENE_POOL_SIZE = 1;
const MAX_GENE_POOL_SIZE = 12;
const MAX_TRAIT_PLAYS_PER_TURN = 3;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const CARD_COLORS = ["Green", "Red", "Blue", "Purple"];
const COLOR_ALIASES = {
  Body: "Green",
  Predatory: "Red",
  Social: "Blue",
  Weird: "Purple"
};

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function cleanName(name) {
  const trimmed = String(name || "").trim();
  return trimmed ? trimmed.slice(0, 24) : "Unnamed Critter";
}

function shuffle(items) {
  const copy = [...items];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }

  return copy;
}

function normalizeColor(color) {
  if (!color) {
    return "Purple";
  }

  return COLOR_ALIASES[color] || color;
}

function createCardInstance(card, copyIndex = 0) {
  const instance = {
    ...clone(card),
    keywords: [...(card.keywords || [])],
    pointMultiplier: 1,
    status: {},
    ownerId: null,
    originalOwnerId: null,
    parasiteOwnerId: null,
    parasiteValue: null,
    token: false,
    attachments: [],
    instanceId: `${card.id}-${copyIndex}-${Math.random().toString(36).slice(2, 9)}`
  };

  delete instance.attachSpec;
  return instance;
}

function createTraitDeck() {
  const deck = [];

  TRAIT_CARDS.forEach((card) => {
    for (let copyIndex = 0; copyIndex < (card.quantity || 1); copyIndex += 1) {
      deck.push(createCardInstance(card, copyIndex));
    }
  });

  return shuffle(deck);
}

function createAgeDeck(playerCount) {
  const finalAges = AGE_CARDS.filter((age) => age.isFinal);
  const openingAges = AGE_CARDS.filter((age) => age.isOpening && !age.isFinal);
  const catastropheTypes = new Set(["destroyOpponentTrait", "destroyOwnTrait", "poison", "discardRandomOpponent", "placeParasite"]);
  const isCatastrophe = (age) => Boolean(age.isFinal || catastropheTypes.has(age.effect?.type));
  const catastropheAges = AGE_CARDS.filter((age) => !age.isFinal && !age.isOpening && isCatastrophe(age));
  const normalAges = AGE_CARDS.filter((age) => !age.isFinal && !age.isOpening && !isCatastrophe(age));
  const totalAges = 12;
  const catastropheSlots = new Set([4, 8]);
  const normalDeck = shuffle(normalAges);
  const catastropheDeck = shuffle(catastropheAges);
  const finalAge = shuffle(finalAges)[0] || normalAges[0];
  const openingAge = shuffle(openingAges)[0] || null;
  const ages = [];

  for (let number = 1; number < totalAges; number += 1) {
    if (number === 1 && openingAge) {
      ages.push({ ...clone(openingAge), isCatastrophe: false });
      continue;
    }

    const pool = catastropheSlots.has(number) ? catastropheDeck : normalDeck;
    const fallbackPool = catastropheSlots.has(number) ? normalDeck : catastropheDeck;
    const age = pool.length ? pool.pop() : fallbackPool.pop();

    if (age) {
      ages.push({
        ...clone(age),
        isCatastrophe: catastropheSlots.has(number) || isCatastrophe(age)
      });
    }
  }

  ages.push({
    ...clone(finalAge),
    isCatastrophe: true
  });

  return ages.map((age, index, ageList) => ({
    ...clone(age),
    number: index + 1,
    total: ageList.length
  }));
}

function addLog(room, text, privateFor = null) {
  room.log.push({
    id: room.nextLogId,
    text,
    privateFor
  });
  room.nextLogId += 1;

  if (room.log.length > 140) {
    room.log = room.log.slice(-140);
  }
}

function createPlayer(id, name, isHost = false) {
  return {
    id,
    name: cleanName(name),
    hand: [],
    board: [],
    genePoolSize: STARTING_GENE_POOL_SIZE,
    skippedTurns: 0,
    flags: {},
    isHost,
    hasActedThisAge: false
  };
}

function createRoom(code, hostId, hostName) {
  const host = createPlayer(hostId, hostName, true);
  const room = {
    code,
    hostId,
    players: [host],
    traitDeck: [],
    discardPile: [],
    ageDeck: [],
    currentAge: null,
    ageIndex: 0,
    currentPlayerIndex: 0,
    playersActedThisAge: [],
    turnOrder: [hostId],
    phase: "lobby",
    turnState: null,
    pendingDiscard: null,
    pendingChoice: null,
    finalScores: null,
    log: [],
    nextLogId: 1,
    nextChoiceId: 1,
    lastPlayedTrait: null,
    revealedHands: {},
    lockedBonuses: {}
  };

  addLog(room, `${host.name} created the room.`);
  return room;
}

function findPlayer(room, playerId) {
  return room.players.find((player) => player.id === playerId) || null;
}

function requirePlayer(room, playerId) {
  const player = findPlayer(room, playerId);

  if (!player) {
    throw new Error("You are not in this room.");
  }

  return player;
}

function requireHost(room, playerId) {
  if (room.hostId !== playerId) {
    throw new Error("Only the host can do that.");
  }
}

function currentPlayer(room) {
  return room.players[room.currentPlayerIndex] || null;
}

function currentTurnOrder(room) {
  const ids = room.turnOrder?.length ? room.turnOrder : room.players.map((player) => player.id);
  return ids.filter((id) => findPlayer(room, id));
}

function orderedPlayers(room) {
  return currentTurnOrder(room).map((id) => findPlayer(room, id)).filter(Boolean);
}

function setCurrentPlayer(room, playerId) {
  const index = room.players.findIndex((player) => player.id === playerId);
  room.currentPlayerIndex = index === -1 ? 0 : index;
}

function isDominant(card) {
  return Boolean(card?.keywords?.includes("Dominant"));
}

function isParasite(card) {
  return Boolean(card?.keywords?.includes("Parasite") || card?.immediateEffect?.type === "placeParasite");
}

function isLate(card) {
  return Boolean(card?.keywords?.includes("Late"));
}

function isPoisonImmune(card) {
  if (isDominant(card) && card.passiveEffect?.type === "dominantProtection") {
    return String(card.passiveEffect.params?.against || "").includes("poison");
  }

  return /immune to poison/i.test(card.text || "");
}

function printedPoints(card) {
  if (card?.token) {
    return 0;
  }

  return Number(card?.points || 0) * Number(card?.pointMultiplier || 1);
}

function dynamicTraitValue(player, card, room = null) {
  if (!player || card?.token || card?.parasiteOwnerId) {
    return null;
  }

  const passive = card?.passiveEffect;

  if (passive?.type !== "dynamicValue") {
    return null;
  }

  const params = passive.params || {};
  let count = 0;

  if (params.basis === "genePoolSize") {
    count = Number(player.genePoolSize || STARTING_GENE_POOL_SIZE);
  } else if (params.basis === "sameNameCount") {
    count = player.board.filter((candidate) => candidate.name === card.name).length;
  } else if (params.basis === "colorCount") {
    count = colorCount(player, params.color);
  } else if (params.basis === "boardCount") {
    count = player.board.length;
  } else if (params.basis === "effectlessCount") {
    count = player.board.filter((candidate) => isEffectlessTrait(candidate)).length;
  } else if (params.basis === "attachmentCount") {
    count = cardAttachments(card).length;
  } else if (params.basis === "handSize") {
    count = player.hand.length;
  } else if (params.basis === "discardPileSize") {
    count = room ? room.discardPile.length : 0;
  } else if (params.basis === "highestGenePoolInLobby") {
    count = room
      ? Math.max(...room.players.map((candidate) => Number(candidate.genePoolSize || STARTING_GENE_POOL_SIZE)))
      : Number(player.genePoolSize || STARTING_GENE_POOL_SIZE);
  } else {
    return null;
  }

  if (params.cap != null) {
    count = Math.min(count, Number(params.cap));
  }

  let value;
  if (params.perGroup) {
    value = Math.floor(count / Number(params.perGroup)) + Number(params.base || 0);
  } else {
    value = count * Number(params.per ?? 1) + Number(params.base || 0);
  }

  return Math.round(value * Number(card?.pointMultiplier || 1));
}

function cardAttachments(card) {
  return Array.isArray(card?.attachments) ? card.attachments : [];
}

function attachmentProtects(card, kind) {
  return cardAttachments(card).some((att) => (att.attachSpec?.protect || []).includes(kind));
}

function attachmentPoints(player, hostCard, room = null) {
  return cardAttachments(hostCard).reduce((sum, att) => {
    const dynamic = dynamicTraitValue(player, att, room);
    const base = dynamic != null ? dynamic : printedPoints(att);
    return sum + base + Number(att.attachSpec?.valueBonus || 0);
  }, 0);
}

function cardScoreForHost(card, player = null, room = null) {
  if (card.parasiteOwnerId) {
    return Number(card.parasiteValue ?? card.points ?? -1);
  }

  const dynamic = dynamicTraitValue(player, card, room);

  if (dynamic != null) {
    return dynamic;
  }

  return printedPoints(card);
}

function boardPoints(player, room = null) {
  return player.board.reduce(
    (total, card) => total + cardScoreForHost(card, player, room) + attachmentPoints(player, card, room),
    0
  );
}

function clampGenePoolSize(value) {
  return Math.max(MIN_GENE_POOL_SIZE, Math.min(MAX_GENE_POOL_SIZE, Number(value) || STARTING_GENE_POOL_SIZE));
}

function handLimitFor(player) {
  return clampGenePoolSize(
    Number(player.genePoolSize || STARTING_GENE_POOL_SIZE) +
      player.board.reduce((total, card) => {
        if (card.passiveEffect?.type !== "handLimitMod") {
          return total;
        }

        return total + Number(card.passiveEffect.params?.amount || 0);
      }, 0)
  );
}

function modifyGenePoolSize(room, player, amount, sourceName = "Effect") {
  if (!player || !amount) {
    return 0;
  }

  if (amount < 0 && player.board.some((card) => card.passiveEffect?.type === "genePoolProtection")) {
    addLog(room, `${player.name}'s Gene Pool resisted ${sourceName}.`);
    return 0;
  }

  const previous = Number(player.genePoolSize || STARTING_GENE_POOL_SIZE);
  const next = clampGenePoolSize(previous + amount);
  player.genePoolSize = next;
  const delta = next - previous;

  if (delta > 0) {
    addLog(room, `${sourceName} increased ${player.name}'s Gene Pool to ${next}.`);
  } else if (delta < 0) {
    addLog(room, `${sourceName} decreased ${player.name}'s Gene Pool to ${next}.`);
  }

  return delta;
}

function addToDiscard(room, card, discardedById = null) {
  const attachments = cardAttachments(card);

  const nextCard = {
    ...card,
    status: {},
    discardedById,
    parasiteOwnerId: null,
    parasiteValue: null,
    attachments: []
  };

  room.discardPile.push(nextCard);

  attachments.forEach((att) => {
    const detached = { ...att, attachSpec: null, attachments: [] };
    room.discardPile.push({
      ...detached,
      status: {},
      discardedById: att.attachSpec?.playedById || discardedById,
      parasiteOwnerId: null,
      parasiteValue: null
    });
  });

  return nextCard;
}

function drawCard(room, player, count = 1) {
  let drawn = 0;

  while (drawn < count) {
    if (!room.traitDeck.length && room.discardPile.length) {
      room.traitDeck = shuffle(room.discardPile.map((card) => ({ ...card, status: {} })));
      room.discardPile = [];
      addLog(room, "The discard pile was shuffled into a new deck.");
    }

    if (!room.traitDeck.length) {
      break;
    }

    const card = room.traitDeck.pop();
    card.ownerId = player.id;
    card.originalOwnerId ||= player.id;
    player.hand.push(card);
    drawn += 1;
  }

  return drawn;
}

function drawToHandSize(room, player) {
  const targetSize = handLimitFor(player);
  const needed = Math.max(0, targetSize - player.hand.length);

  if (!needed) {
    return 0;
  }

  return drawCard(room, player, needed);
}

function discardCardFromHand(room, player, cardIndex = null) {
  if (!player.hand.length) {
    return null;
  }

  const index = cardIndex == null ? Math.floor(Math.random() * player.hand.length) : cardIndex;
  const [card] = player.hand.splice(index, 1);
  addToDiscard(room, card, player.id);
  return card;
}

function discardHighestPointCardFromHand(room, player) {
  if (!player.hand.length) {
    return null;
  }

  let bestIndex = 0;
  let bestPoints = printedPoints(player.hand[0]);

  player.hand.forEach((card, index) => {
    const points = printedPoints(card);

    if (points > bestPoints) {
      bestIndex = index;
      bestPoints = points;
    }
  });

  return discardCardFromHand(room, player, bestIndex);
}

function needsHandLimitDiscard(player) {
  return player.hand.length > handLimitFor(player);
}

function handLimitDiscardChoice(room, player) {
  const limit = handLimitFor(player);

  return {
    type: "handLimitDiscard",
    mode: "discard",
    playerId: player.id,
    actorId: player.id,
    sourceCard: { name: "Gene Pool Limit" },
    params: {},
    prompt: `${player.name}: discard down to Gene Pool ${limit}`,
    choices: player.hand.map((card) => ({
      id: card.instanceId,
      cardInstanceId: card.instanceId
    }))
  };
}

function queueHandLimitDiscard(room, player, context = {}) {
  if (!player || !needsHandLimitDiscard(player)) {
    return false;
  }

  return queueChoice(room, handLimitDiscardChoice(room, player), context);
}

function resolveCount(room, player, value, fallback = 1) {
  if (typeof value === "number") {
    return value;
  }

  if (value === "toHand6") {
    return Math.max(0, 6 - player.hand.length);
  }

  if (value === "socialCount2" || value === "blueCount2") {
    return Math.floor(colorCount(player, "Blue") / 2);
  }

  if (value === "bodyCount" || value === "greenCount") {
    return colorCount(player, "Green");
  }

  return fallback;
}

function colorCount(player, color) {
  const normalizedColor = normalizeColor(color);
  return player.board.filter((card) => effectiveColor(player, card) === normalizedColor).length;
}

function uniqueColors(player) {
  return new Set(player.board.map((card) => effectiveColor(player, card))).size;
}

function effectiveColor(player, card) {
  if (card.colorOverride) {
    return normalizeColor(card.colorOverride);
  }

  if (card.passiveEffect?.type === "copyTrait" && card.passiveEffect.params?.aspect === "colorOfLeftNeighbor") {
    const index = player.board.findIndex((candidate) => candidate.instanceId === card.instanceId);
    const left = index > 0 ? player.board[index - 1] : null;

    if (left) {
      return effectiveColor(player, left);
    }
  }

  return normalizeColor(card.color);
}

function uniqueNormalizedColors(colors = []) {
  return [...new Set(colors.map(normalizeColor).filter(Boolean))];
}

function extraPlayColorsFor(actor, sourceCard, params = {}) {
  const colors = [];

  if (params.restrictColor) {
    colors.push(params.restrictColor);
  }

  if (params.sameColorAsSource && sourceCard) {
    colors.push(effectiveColor(actor, sourceCard));
  }

  return uniqueNormalizedColors(colors);
}

function formatColorRestriction(colors = []) {
  const labels = uniqueNormalizedColors(colors);

  if (!labels.length) {
    return "";
  }

  return labels.length === 1 ? `${labels[0]} only` : `${labels.join(" or ")} only`;
}

function targetPlayers(room, actor, target = "nextOpponent") {
  const players = orderedPlayers(room);
  const actorIndex = actor ? Math.max(0, players.findIndex((player) => player.id === actor.id)) : 0;
  const opponents = actor ? players.filter((player) => player.id !== actor.id) : players;

  switch (target) {
    case "self":
      return actor ? [actor] : [];
    case "allPlayers":
      return players;
    case "allOpponents":
      return opponents;
    case "leftNeighbor":
      return players.length ? [players[(actorIndex - 1 + players.length) % players.length]].filter(Boolean) : [];
    case "rightNeighbor":
    case "nextOpponent":
      return players.length ? [players[(actorIndex + 1) % players.length]].filter((player) => player?.id !== actor?.id) : [];
    case "opponentMostCardsInHand":
      return bestPlayers(opponents, (player) => player.hand.length, "desc", room, "most cards in hand");
    case "opponentHighestGenePoolPoints":
      return bestPlayers(opponents, boardPoints, "desc", room, "most Trait points");
    case "opponentLowestGenePoolPoints":
      return bestPlayers(opponents, boardPoints, "asc", room, "fewest Trait points");
    case "opponentLargestDiscard":
      return bestPlayers(opponents, (player) => discardCardsFor(room, player.id).length, "desc", room, "largest discard");
    case "opponentSmallestPool":
      return bestPlayers(opponents, (player) => player.board.length, "asc", room, "smallest Trait Row");
    case "anyPlayer":
      return players.filter((player) => player.board.length);
    default:
      return opponents.length ? [opponents[0]] : [];
  }
}

function bestPlayers(players, scorer, direction = "desc", room = null, label = null) {
  if (!players.length) {
    return [];
  }

  const scored = players.map((player) => ({ player, value: scorer(player) }));
  const bestValue = scored.reduce(
    (best, cur) => (direction === "asc" ? Math.min(best, cur.value) : Math.max(best, cur.value)),
    direction === "asc" ? Infinity : -Infinity
  );
  const tied = scored.filter((entry) => entry.value === bestValue).map((entry) => entry.player);

  if (tied.length <= 1) {
    return [tied[0]];
  }

  const winner = tied[Math.floor(Math.random() * tied.length)];

  if (room && label) {
    recordTiebreak(room, tied, winner, label);
  }

  return [winner];
}

function recordTiebreak(room, tied, winner, label) {
  room.tiebreakSeq = (room.tiebreakSeq || 0) + 1;
  room.tiebreakRoll = {
    seq: room.tiebreakSeq,
    label,
    candidates: tied.map((player) => ({ id: player.id, name: player.name })),
    winnerId: winner.id,
    winnerName: winner.name
  };
  addLog(room, `Tie for ${label} — a random roll landed on ${winner.name}.`);
}

function nonDominantBoardEntries(room, players, allowDominant = false) {
  return players.flatMap((player) =>
    player.board
      .map((card, index) => ({ player, card, index }))
      .filter((entry) => allowDominant || !isDominant(entry.card))
  );
}

function selectTraitEntry(room, players, fallback = "lowestPointNonDominantTrait", options = {}) {
  let entries = nonDominantBoardEntries(room, players, Boolean(options.allowDominant));

  if (options.color) {
    const wanted = normalizeColor(options.color);
    entries = entries.filter((entry) => effectiveColor(entry.player, entry.card) === wanted);
  }

  if (options.excludeInstanceId) {
    entries = entries.filter((entry) => entry.card.instanceId !== options.excludeInstanceId);
  }

  if (options.protectKind) {
    entries = entries.filter((entry) => !attachmentProtects(entry.card, options.protectKind));
  }

  if (!entries.length) {
    return null;
  }

  if (fallback === "randomNonDominantTrait") {
    return entries[Math.floor(Math.random() * entries.length)];
  }

  if (fallback === "highestPointNonDominantTrait") {
    return [...entries].sort((a, b) => cardScoreForHost(b.card) - cardScoreForHost(a.card))[0];
  }

  if (fallback === "mostRecentTrait") {
    return [...entries].sort((a, b) => b.index - a.index)[0];
  }

  return [...entries].sort((a, b) => cardScoreForHost(a.card) - cardScoreForHost(b.card))[0];
}

function findDestroyBlocker(player, targetCard, destroyAttempt) {
  return player.board.find((card) => {
    if (card.instanceId === targetCard.instanceId || card.passiveEffect?.type !== "shieldLikeBlock") {
      return false;
    }

    const scope = card.passiveEffect.params?.scope || "firstDestroy";
    return scope === "secondDestroy" ? destroyAttempt >= 2 : true;
  });
}

function consumeDestroyBlocker(room, player, blocker, targetCard) {
  const index = player.board.findIndex((card) => card.instanceId === blocker.instanceId);

  if (index === -1) {
    return false;
  }

  const [removed] = player.board.splice(index, 1);
  addToDiscard(room, removed, removed.ownerId || player.id);
  addLog(room, `${removed.name} blocked ${targetCard.name} from being destroyed, then was discarded.`);
  return true;
}

function eligibleTraitEntries(room, players, options = {}) {
  let entries = nonDominantBoardEntries(room, players, Boolean(options.allowDominant));

  if (options.color) {
    const wanted = normalizeColor(options.color);
    entries = entries.filter((entry) => effectiveColor(entry.player, entry.card) === wanted);
  }

  if (options.protectKind) {
    entries = entries.filter((entry) => !attachmentProtects(entry.card, options.protectKind));
  }

  if (options.filter === "playedThisAge" && room.lastPlayedTrait?.card?.instanceId) {
    return entries.filter((entry) => entry.card.instanceId === room.lastPlayedTrait.card.instanceId);
  }

  return entries;
}

function choicePrompt(sourceCard, fallbackText) {
  return `${sourceCard?.name || "Effect"}: ${fallbackText}`;
}

function queueChoice(room, choice, context = {}) {
  const id = `choice-${room.nextChoiceId || 1}`;
  room.nextChoiceId = (room.nextChoiceId || 1) + 1;
  room.pendingChoice = {
    id,
    finishAfterChoice: context.finishAfterChoice || null,
    context,
    ...choice
  };

  if (room.turnState) {
    room.turnState.awaitingChoice = true;
  }

  const actor = findPlayer(room, choice.playerId);
  if (actor) {
    addLog(room, `${actor.name} is choosing: ${choice.prompt}`);
  }

  return true;
}

function clearPendingChoice(room) {
  room.pendingChoice = null;

  if (room.turnState) {
    room.turnState.awaitingChoice = false;
  }
}

function assertNoPendingChoice(room) {
  if (room.pendingChoice) {
    throw new Error("Finish the pending choice first.");
  }
}

function removeBoardEntry(room, entry, reason = "destroyed", options = {}) {
  if (!entry) {
    return null;
  }

  if (ageRules(room).lockTraitRow && !options.bypassLock) {
    addLog(room, `${entry.card.name} is protected this Age and cannot be removed.`);
    return null;
  }

  if (attachmentProtects(entry.card, "remove") && !options.bypassAttachment) {
    addLog(room, `${entry.card.name} is shielded and cannot be removed.`);
    return null;
  }

  if (!options.bypassShield && /destroy|wipe|poison|age/i.test(reason)) {
    const destroyAttempt = Number(entry.player.flags.destroyAttempts || 0) + 1;
    entry.player.flags.destroyAttempts = destroyAttempt;
    const blocker = findDestroyBlocker(entry.player, entry.card, destroyAttempt);

    if (blocker && consumeDestroyBlocker(room, entry.player, blocker, entry.card)) {
      return null;
    }
  }

  const currentIndex = entry.player.board.findIndex((card) => card.instanceId === entry.card.instanceId);
  const removeIndex = currentIndex === -1 ? entry.index : currentIndex;
  const [card] = entry.player.board.splice(removeIndex, 1);

  if (!card) {
    return null;
  }

  addToDiscard(room, card, card.ownerId || entry.player.id);
  entry.player.flags.destroyedThisGame = true;

  if (/wipe|age/i.test(reason)) {
    entry.player.flags.survivedWipe = true;
  }

  addLog(room, `${entry.player.name}'s ${card.name} was ${reason}.`);
  return card;
}

function discardCardsFor(room, playerId) {
  return room.discardPile.filter((card) => (card.ownerId || card.originalOwnerId || card.discardedById) === playerId);
}

function discardOwnerId(card) {
  return card.ownerId || card.originalOwnerId || card.discardedById || null;
}

function discardCardEntries(room, actor, params = {}) {
  // The discard pile is a single public pile shared by everyone. Any effect that
  // pulls from it may pick any card, regardless of who discarded it.
  return room.discardPile.map((card, index) => ({ card, index }));
}

function selectDiscardCard(room, actor, params = {}) {
  const cards = discardCardEntries(room, actor, params);

  if (!cards.length) {
    return null;
  }

  return cards[cards.length - 1];
}

function queueDiscardChoice(room, actor, sourceCard, params = {}, mode = "revive", context = {}) {
  const entries = discardCardEntries(room, actor, params);

  if (!entries.length) {
    addLog(room, `${sourceCard.name} found no card in the discard pile.`);
    return false;
  }

  return queueChoice(
    room,
    {
      type: "discardCard",
      mode,
      playerId: actor.id,
      actorId: actor.id,
      sourceCard,
      params,
      prompt: choicePrompt(
        sourceCard,
        `${mode === "play" ? "play" : params.toZone === "hand" ? "return" : "revive"} a card from the discard pile`
      ),
      choices: entries.map(({ card, index }) => ({
        id: card.instanceId,
        discardIndex: index,
        cardInstanceId: card.instanceId
      }))
    },
    context
  );
}

function reviveOrPlayDiscard(room, actor, sourceCard, params = {}, mode = "revive", context = {}) {
  if (params.mode === "bounce") {
    const entry = selectTraitEntry(room, room.players, params.fallback || "mostRecentTrait");

    if (!entry) {
      return;
    }

    const [card] = entry.player.board.splice(entry.index, 1);
    const owner = findPlayer(room, card.ownerId) || entry.player;
    card.status = {};
    owner.hand.push(card);
    addLog(room, `${sourceCard.name} returned ${card.name} to ${owner.name}'s hand.`);
    return;
  }

  if (context.finishAfterChoice) {
    return queueDiscardChoice(room, actor, sourceCard, params, mode, context);
  }

  const selected = selectDiscardCard(room, actor, params);

  if (!selected) {
    addLog(room, `${sourceCard.name} found no card in the discard pile.`);
    return;
  }

  const [card] = room.discardPile.splice(selected.index, 1);
  card.ownerId = actor.id;
  card.status = {};
  card.parasiteOwnerId = null;
  card.parasiteValue = null;

  if (params.toZone === "hand") {
    actor.hand.push(card);
    addLog(room, `${actor.name} returned ${card.name} from the discard pile to hand.`, actor.id);
    addLog(room, `${actor.name} returned a card from the discard pile to hand.`);
    return;
  }

  actor.board.push(card);
  addLog(room, `${actor.name} ${mode === "play" ? "played" : "revived"} ${card.name} from the discard pile.`);
}

function shuffleHandChoices(target) {
  return shuffle(
    target.hand.map((card) => ({
      id: card.instanceId,
      cardInstanceId: card.instanceId,
      targetId: target.id
    }))
  );
}

function queueFaceDownHandChoice(room, actor, target, sourceCard, params = {}, mode = "steal", context = {}) {
  if (!target?.hand.length) {
    return false;
  }

  return queueChoice(
    room,
    {
      type: "faceDownHand",
      mode,
      playerId: actor.id,
      actorId: actor.id,
      targetId: target.id,
      targetName: target.name,
      sourceCard,
      params,
      prompt: choicePrompt(
        sourceCard,
        `${mode === "discard" ? "discard" : "take"} one face-down card from ${target.name}`
      ),
      choices: shuffleHandChoices(target)
    },
    context
  );
}

function queueHandTargetSequence(room, actor, targets, sourceCard, params = {}, mode = "steal", context = {}) {
  const targetIds = [];

  targets.forEach((target) => {
    const count = Math.max(1, resolveCount(room, target, params.count, 1));

    for (let index = 0; index < count; index += 1) {
      targetIds.push(target.id);
    }
  });

  while (targetIds.length) {
    const target = findPlayer(room, targetIds.shift());

    if (!target?.hand.length) {
      continue;
    }

    return queueChoice(
      room,
      {
        type: "faceDownHand",
        mode,
        playerId: actor.id,
        actorId: actor.id,
        targetId: target.id,
        targetName: target.name,
        remainingTargets: targetIds,
        sourceCard,
        params,
        prompt: choicePrompt(
          sourceCard,
          `${mode === "discard" ? "discard" : "take"} one face-down card from ${target.name}`
        ),
        choices: shuffleHandChoices(target)
      },
      context
    );
  }

  return false;
}

function queueGiveHandCardChoice(room, actor, target, sourceCard, params = {}, context = {}) {
  if (!actor?.hand.length || !target) {
    return false;
  }

  return queueChoice(
    room,
    {
      type: "giveHandCard",
      mode: "give",
      playerId: actor.id,
      actorId: actor.id,
      targetId: target.id,
      targetName: target.name,
      sourceCard,
      params,
      prompt: choicePrompt(sourceCard, `give 1 card to ${target.name}`),
      choices: actor.hand.map((card) => ({
        id: card.instanceId,
        cardInstanceId: card.instanceId
      }))
    },
    context
  );
}

function publicTraitChoiceEntries(room, actor, params = {}, mode = "destroy") {
  // Preservation Order (and similar) lock every Trait Row: nothing may be
  // stolen, destroyed, or poisoned this Age.
  if (ageRules(room).lockTraitRow) {
    return [];
  }

  const options = {
    allowDominant: Boolean(params.allowDominant),
    filter: params.filter,
    color: params.color,
    protectKind: mode === "steal" ? "steal" : mode === "destroy" ? "remove" : undefined
  };
  const targets = targetPlayers(room, actor, params.target || "nextOpponent");
  let entries = eligibleTraitEntries(room, targets, options);

  // If the designated opponent has nothing to hit, widen to any opponent so the
  // effect does not silently fizzle (e.g. Wrecking Tail vs. an empty leader).
  if (!entries.length && params.target !== "self" && params.target !== "allPlayers") {
    entries = eligibleTraitEntries(room, targetPlayers(room, actor, "allOpponents"), options);
  }

  // You can never steal from your own Trait Row.
  if (mode === "steal") {
    entries = entries.filter((entry) => entry.player.id !== actor.id);
  }

  return entries;
}

function queuePublicTraitChoice(room, actor, sourceCard, params = {}, mode = "destroy", context = {}) {
  const entries = publicTraitChoiceEntries(room, actor, params, mode);

  if (!entries.length) {
    return false;
  }

  return queueChoice(
    room,
    {
      type: "publicTrait",
      mode,
      playerId: actor.id,
      actorId: actor.id,
      sourceCard,
      params,
      remainingCount: Math.max(1, Number(params.count || 1)),
      prompt: choicePrompt(
        sourceCard,
        `${mode === "steal" ? "steal" : mode === "poison" ? "poison" : "destroy"} a public Trait`
      ),
      choices: entries.map((entry) => ({
        id: entry.card.instanceId,
        ownerId: entry.player.id,
        cardInstanceId: entry.card.instanceId
      }))
    },
    context
  );
}

function queueParasiteTargetChoice(room, actor, card, context = {}) {
  const params = card.immediateEffect?.params || {};
  const choices = room.players
    .filter((player) => player.id !== actor.id)
    .map((player) => ({
      id: player.id,
      playerId: player.id,
      label: player.name
    }));

  if (!choices.length) {
    actor.board.push(card);
    addLog(room, `${actor.name} played ${card.name}.`);
    return false;
  }

  return queueChoice(
    room,
    {
      type: "targetPlayer",
      mode: "placeParasite",
      playerId: actor.id,
      actorId: actor.id,
      sourceCard: card,
      heldCard: card,
      params,
      prompt: choicePrompt(card, "choose which Trait Row receives this Parasite"),
      choices
    },
    context
  );
}

function queueSwapTargetChoice(room, actor, sourceCard, params, opponents, context = {}) {
  const choices = opponents
    .filter((player) => player.id !== actor.id)
    .map((player) => ({ id: player.id, playerId: player.id, label: player.name }));

  if (!choices.length) {
    return false;
  }

  return queueChoice(
    room,
    {
      type: "targetPlayer",
      mode: "swapHands",
      playerId: actor.id,
      actorId: actor.id,
      sourceCard,
      params,
      prompt: choicePrompt(sourceCard, "choose an opponent to swap hands with"),
      choices
    },
    context
  );
}

function findBoardChoiceEntry(room, choice, option) {
  const owner = findPlayer(room, option.ownerId);

  if (!owner) {
    return null;
  }

  const index = owner.board.findIndex((card) => card.instanceId === option.cardInstanceId);
  if (index === -1) {
    return null;
  }

  const card = owner.board[index];
  if (isDominant(card) && !choice.params?.allowDominant) {
    return null;
  }

  return { player: owner, card, index };
}

function applyDiscardChoice(room, choice, option, actor) {
  const index = room.discardPile.findIndex((card) => card.instanceId === option.cardInstanceId);

  if (index === -1) {
    return false;
  }

  const [card] = room.discardPile.splice(index, 1);
  card.ownerId = actor.id;
  card.status = {};
  card.parasiteOwnerId = null;
  card.parasiteValue = null;

  if (choice.params?.toZone === "hand") {
    actor.hand.push(card);
    addLog(room, `${actor.name} returned ${card.name} from the discard pile to hand.`, actor.id);
    addLog(room, `${actor.name} returned a card from the discard pile to hand.`);
    return false;
  }

  actor.board.push(card);
  addLog(room, `${actor.name} ${choice.mode === "play" ? "played" : "revived"} ${card.name} from the discard pile.`);
  return false;
}

function nextHandTargetChoice(room, choice, actor) {
  const remainingTargets = [...(choice.remainingTargets || [])];

  while (remainingTargets.length) {
    const targetId = remainingTargets.shift();
    const target = findPlayer(room, targetId);

    if (!target?.hand.length) {
      continue;
    }

    return {
      ...choice,
      targetId: target.id,
      targetName: target.name,
      remainingTargets,
      prompt: choicePrompt(
        choice.sourceCard,
        `${choice.mode === "discard" ? "discard" : "take"} one face-down card from ${target.name}`
      ),
      choices: shuffleHandChoices(target)
    };
  }

  return false;
}

function applyFaceDownHandChoice(room, choice, option, actor) {
  const target = findPlayer(room, choice.targetId);

  if (!target) {
    return false;
  }

  const index = target.hand.findIndex((card) => card.instanceId === option.cardInstanceId);

  if (index === -1) {
    return false;
  }

  const [card] = target.hand.splice(index, 1);

  if (choice.mode === "discard") {
    addToDiscard(room, card, target.id);
    addLog(room, `${choice.sourceCard.name} made ${target.name} discard ${card.name}.`, target.id);
    addLog(room, `${choice.sourceCard.name} made ${target.name} discard a card.`);
    return nextHandTargetChoice(room, choice, actor);
  }

  card.ownerId = actor.id;
  actor.hand.push(card);
  addLog(room, `${actor.name} stole ${card.name} from ${target.name}.`, actor.id);
  addLog(room, `${actor.name} stole ${card.name} from you.`, target.id);
  addLog(room, `${actor.name} stole a face-down card from ${target.name}.`);

  if (Number(choice.params?.giveBack || 0) > 0) {
    return {
      type: "giveHandCard",
      mode: "give",
      playerId: actor.id,
      actorId: actor.id,
      targetId: target.id,
      targetName: target.name,
      remainingTargets: choice.remainingTargets || [],
      sourceCard: choice.sourceCard,
      params: choice.params,
      prompt: choicePrompt(choice.sourceCard, `give 1 card to ${target.name}`),
      choices: actor.hand.map((candidate) => ({
        id: candidate.instanceId,
        cardInstanceId: candidate.instanceId
      }))
    };
  }

  return nextHandTargetChoice(room, choice, actor);
}

function applyGiveHandCardChoice(room, choice, option, actor) {
  const target = findPlayer(room, choice.targetId);

  if (!target) {
    return false;
  }

  const index = actor.hand.findIndex((card) => card.instanceId === option.cardInstanceId);

  if (index === -1) {
    return false;
  }

  const [card] = actor.hand.splice(index, 1);
  card.ownerId = target.id;
  target.hand.push(card);
  addLog(room, `${actor.name} gave ${target.name} a card.`, actor.id);
  addLog(room, `${actor.name} gave you ${card.name}.`, target.id);
  return nextHandTargetChoice(room, choice, actor);
}

function applyHandLimitDiscardChoice(room, choice, option, actor) {
  const index = actor.hand.findIndex((card) => card.instanceId === option.cardInstanceId);

  if (index === -1) {
    return false;
  }

  const [card] = actor.hand.splice(index, 1);
  addToDiscard(room, card, actor.id);
  addLog(room, `${actor.name} discarded ${card.name} down to their Gene Pool.`, actor.id);
  addLog(room, `${actor.name} discarded down to their Gene Pool.`);
  return needsHandLimitDiscard(actor) ? handLimitDiscardChoice(room, actor) : false;
}

function threatenedRansomTargets(room, threshold) {
  const targets = [];

  room.players.forEach((player) => {
    player.board.forEach((card) => {
      if (!isDominant(card) && cardScoreForHost(card, player, room) >= threshold) {
        targets.push({ playerId: player.id, instanceId: card.instanceId });
      }
    });
  });

  return targets;
}

function ageRansomDecideChoice(room, target, queue, ransom, threshold) {
  const player = findPlayer(room, target.playerId);
  const card = player?.board.find((candidate) => candidate.instanceId === target.instanceId);

  if (!player || !card) {
    return null;
  }

  const worth = cardScoreForHost(card, player, room);

  return {
    type: "ageRansom",
    mode: "decide",
    playerId: player.id,
    actorId: player.id,
    sourceCard: { name: room.currentAge?.name || "The Age" },
    params: {},
    ransom,
    threshold,
    ransomPaid: 0,
    targetInstanceId: card.instanceId,
    queue,
    prompt: `${player.name}: discard ${ransom} card${ransom === 1 ? "" : "s"} to save ${card.name} (${worth}), or let it be destroyed`,
    choices: [
      { id: "save", label: `Discard ${ransom} to save ${card.name}` },
      { id: "sacrifice", label: `Let ${card.name} be destroyed` }
    ]
  };
}

function ageRansomDiscardChoice(room, choice, actor) {
  const ransom = Number(choice.ransom || 2);
  const paid = Number(choice.ransomPaid || 0);

  return {
    type: "ageRansom",
    mode: "discard",
    playerId: actor.id,
    actorId: actor.id,
    sourceCard: choice.sourceCard,
    params: {},
    ransom,
    threshold: choice.threshold,
    ransomPaid: paid,
    targetInstanceId: choice.targetInstanceId,
    queue: choice.queue,
    prompt: `${actor.name}: choose a card to discard (${ransom - paid} left)`,
    choices: actor.hand.map((card) => ({ id: card.instanceId, cardInstanceId: card.instanceId }))
  };
}

function nextAgeRansom(room, queue, ransom, threshold) {
  while (queue.length) {
    const target = queue.shift();
    const player = findPlayer(room, target.playerId);
    const card = player?.board.find((candidate) => candidate.instanceId === target.instanceId);

    if (!player || !card) {
      continue;
    }

    if (player.hand.length < ransom) {
      const index = player.board.findIndex((candidate) => candidate.instanceId === card.instanceId);
      removeBoardEntry(room, { player, card, index }, "destroyed by an Age wipe");
      continue;
    }

    return ageRansomDecideChoice(room, target, queue, ransom, threshold);
  }

  return false;
}

function applyAgeRansomChoice(room, choice, option, actor) {
  const ransom = Number(choice.ransom || 2);
  const threshold = Number(choice.threshold || 3);
  const queue = choice.queue || [];

  if (choice.mode === "decide") {
    const index = actor.board.findIndex((candidate) => candidate.instanceId === choice.targetInstanceId);
    const card = index === -1 ? null : actor.board[index];

    if (option.id === "sacrifice" || !card) {
      if (card) {
        removeBoardEntry(room, { player: actor, card, index }, "destroyed by an Age wipe");
      }

      return nextAgeRansom(room, queue, ransom, threshold);
    }

    addLog(room, `${actor.name} pays to protect ${card.name} from ${choice.sourceCard?.name || "the Age"}.`);
    return ageRansomDiscardChoice(room, choice, actor);
  }

  const handIndex = actor.hand.findIndex((candidate) => candidate.instanceId === option.cardInstanceId);

  if (handIndex !== -1) {
    const [card] = actor.hand.splice(handIndex, 1);
    addToDiscard(room, card, actor.id);
    addLog(room, `${actor.name} discarded ${card.name} to protect a Trait.`, actor.id);
  }

  const paid = Number(choice.ransomPaid || 0) + 1;

  if (paid < ransom && actor.hand.length) {
    return ageRansomDiscardChoice(room, { ...choice, ransomPaid: paid }, actor);
  }

  addLog(room, `${actor.name}'s Trait survived the Age.`);
  return nextAgeRansom(room, queue, ransom, threshold);
}

function beginAgeRansom(room, threshold, ransom) {
  const queue = threatenedRansomTargets(room, threshold);
  const choice = nextAgeRansom(room, queue, ransom, threshold);

  if (!choice) {
    return false;
  }

  return queueChoice(room, choice, { finishAfterChoice: "ageReveal" });
}

function applyPublicTraitChoice(room, choice, option, actor) {
  const entry = findBoardChoiceEntry(room, choice, option);

  if (!entry) {
    return false;
  }

  if (choice.mode === "steal") {
    if (ageRules(room).lockTraitRow || entry.player.id === actor.id || attachmentProtects(entry.card, "steal")) {
      addLog(room, `${entry.card.name} could not be stolen.`);
      return false;
    }

    const [stolen] = entry.player.board.splice(entry.index, 1);
    stolen.ownerId = actor.id;
    actor.board.push(stolen);
    addLog(room, `${actor.name} stole ${stolen.name} from ${entry.player.name}'s Trait Row.`);
  } else if (choice.mode === "poison") {
    poisonTrait(room, entry, Number(choice.params?.turns || 1));
  } else {
    removeBoardEntry(room, entry, "destroyed");
  }

  const remainingCount = Number(choice.remainingCount || 1) - 1;

  if (remainingCount <= 0) {
    return false;
  }

  const nextChoice = {
    ...choice,
    remainingCount
  };
  nextChoice.choices = publicTraitChoiceEntries(room, actor, choice.params, choice.mode).map((nextEntry) => ({
    id: nextEntry.card.instanceId,
    ownerId: nextEntry.player.id,
    cardInstanceId: nextEntry.card.instanceId
  }));

  return nextChoice.choices.length ? nextChoice : false;
}

function queuePeekPlayChoice(room, actor, target, sourceCard, params, seenIds, context) {
  const ids = (seenIds || []).filter((id) => target.hand.some((card) => card.instanceId === id));

  if (!ids.length) {
    return false;
  }

  return queueChoice(
    room,
    {
      type: "peekPlay",
      playerId: actor.id,
      actorId: actor.id,
      targetId: target.id,
      targetName: target.name,
      sourceCard,
      params,
      prompt: choicePrompt(sourceCard, `look at ${ids.length} of ${target.name}'s cards and take one to play`),
      choices: ids.map((id) => ({ id, cardInstanceId: id }))
    },
    context
  );
}

function applyPeekPlayChoice(room, choice, option, actor) {
  const target = findPlayer(room, choice.targetId);

  if (!target) {
    return false;
  }

  const index = target.hand.findIndex((card) => card.instanceId === option.cardInstanceId);

  if (index === -1) {
    return false;
  }

  const [stolen] = target.hand.splice(index, 1);
  stolen.ownerId = actor.id;
  addLog(room, `${actor.name} looked at ${target.name}'s cards and took ${stolen.name}.`, actor.id);
  addLog(room, `${actor.name} took ${stolen.name} from your hand.`, target.id);
  addLog(room, `${actor.name} peeked at ${target.name}'s hand and took a card.`);

  if (choice.params?.playImmediately === false || isParasite(stolen)) {
    actor.hand.push(stolen);
    return false;
  }

  actor.board.push(stolen);
  addLog(room, `${actor.name} immediately played ${stolen.name}.`);
  // If the played card queues its own choice, it sets room.pendingChoice; we
  // return false and let completeAfterPlay bail out on that pending choice.
  applyEffect(room, actor, stolen.immediateEffect, stolen, {
    finishAfterChoice: choice.finishAfterChoice,
    effectDepth: 0
  });
  room.lastPlayedTrait = { card: stolen, playerId: actor.id };
  room.lastPlayedSeq = (room.lastPlayedSeq || 0) + 1;
  return false;
}

function performAttach(room, actor, sourceCard, params, hostPlayer, hostCard, context = {}) {
  const selfIndex = actor.board.findIndex((candidate) => candidate.instanceId === sourceCard.instanceId);
  let attachmentCard = sourceCard;

  if (selfIndex !== -1) {
    [attachmentCard] = actor.board.splice(selfIndex, 1);
  }

  attachmentCard.attachSpec = {
    protect: Array.isArray(params.protect) ? params.protect : [],
    valueBonus: Number(params.valueBonus || 0),
    playedById: actor.id
  };
  hostCard.attachments = cardAttachments(hostCard).concat(attachmentCard);
  addLog(room, `${actor.name} attached ${attachmentCard.name} to ${hostPlayer.name}'s ${hostCard.name}.`);

  if (params.playHostAction && hostCard.immediateEffect) {
    const pending = applyEffect(room, actor, hostCard.immediateEffect, hostCard, {
      finishAfterChoice: context.finishAfterChoice,
      effectDepth: context.effectDepth
    });

    if (pending) {
      return true;
    }
  }

  return applyThen(room, actor, sourceCard, params, context);
}

function queueAttachChoice(room, actor, sourceCard, params, entries, context) {
  const options = entries.map((entry) => ({
    id: entry.card.instanceId,
    ownerId: entry.player.id,
    cardInstanceId: entry.card.instanceId
  }));

  if (!options.length) {
    return false;
  }

  return queueChoice(
    room,
    {
      type: "attachHost",
      playerId: actor.id,
      actorId: actor.id,
      sourceCard,
      params,
      prompt: choicePrompt(sourceCard, `choose which Trait to attach ${sourceCard.name} to`),
      choices: options
    },
    context
  );
}

function applyAttachChoice(room, choice, option, actor) {
  const hostPlayer = findPlayer(room, option.ownerId);
  const hostCard = hostPlayer?.board.find((candidate) => candidate.instanceId === option.cardInstanceId);

  if (!hostPlayer || !hostCard) {
    return false;
  }

  performAttach(room, actor, choice.sourceCard, choice.params, hostPlayer, hostCard, {
    finishAfterChoice: choice.finishAfterChoice,
    effectDepth: choice.context?.effectDepth || 0
  });
  // performAttach already ran playHostAction and params.then; neutralize the
  // then so resolveChoice's post-switch applyThen doesn't fire it twice.
  choice.params = { ...choice.params, then: null };
  return false;
}

function copyableImmediateEntries(room, actor, sourceCard) {
  return room.players.flatMap((player) =>
    player.board
      .filter(
        (card) =>
          card.immediateEffect &&
          card.immediateEffect.type !== "copyImmediate" &&
          card.instanceId !== sourceCard.instanceId
      )
      .map((card) => ({ player, card }))
  );
}

function queueCopyImmediateChoice(room, actor, sourceCard, params, entries, context) {
  return queueChoice(
    room,
    {
      type: "copyImmediate",
      playerId: actor.id,
      actorId: actor.id,
      sourceCard,
      params,
      prompt: choicePrompt(sourceCard, "choose a Trait already in play to copy its effect"),
      choices: entries.map((entry) => ({
        id: entry.card.instanceId,
        ownerId: entry.player.id,
        cardInstanceId: entry.card.instanceId
      }))
    },
    context
  );
}

function applyCopyImmediateChoice(room, choice, option, actor) {
  const owner = findPlayer(room, option.ownerId);
  const target = owner?.board.find((candidate) => candidate.instanceId === option.cardInstanceId);

  if (!target?.immediateEffect) {
    return false;
  }

  addLog(room, `${choice.sourceCard.name} copied ${target.name}.`);
  applyEffect(room, actor, target.immediateEffect, target, {
    copyDepth: 1,
    finishAfterChoice: choice.finishAfterChoice
  });
  // The copied effect may queue its own choice; the post-switch flow bails on a
  // pending choice, so just report "no further followup from the copy itself".
  return false;
}

function applyTargetPlayerChoice(room, choice, option, actor) {
  const chosen = findPlayer(room, option.playerId);

  if (choice.mode === "swapHands") {
    if (!chosen) {
      return false;
    }

    [actor.hand, chosen.hand] = [chosen.hand, actor.hand];
    addLog(room, `${actor.name} swapped hands with ${chosen.name}.`);
    return false;
  }

  if (choice.mode !== "placeParasite") {
    return false;
  }

  const target = chosen;
  const card = choice.heldCard || choice.sourceCard;

  if (!target || !card) {
    return false;
  }

  card.ownerId = actor.id;
  card.originalOwnerId ||= actor.id;
  card.parasiteOwnerId = actor.id;
  card.parasiteValue = Number(choice.params?.value ?? card.points ?? -1);
  target.board.push(card);
  addLog(room, `${actor.name} placed ${card.name} into ${target.name}'s Trait Row.`);
  return false;
}

function revealHand(room, actor, sourceCard, target) {
  if (!target) {
    return;
  }

  room.revealedHands[target.id] = true;

  if (!target.hand.length) {
    addLog(room, `${sourceCard.name} revealed ${target.name}'s empty hand.`);
    return;
  }

  const fullText = target.hand.map((card) => `${card.emoji} ${card.name} (${card.color}, ${printedPoints(card)}): ${card.text}`).join(" || ");
  addLog(room, `${sourceCard.name} revealed ${target.name}'s hand: ${fullText}`);
}

function poisonTrait(room, entry, turns = 1) {
  if (!entry || !entry.card || isPoisonImmune(entry.card)) {
    return;
  }

  entry.card.status ||= {};
  entry.card.status.poisoned = Math.max(Number(entry.card.status.poisoned || 0), turns);
  addLog(room, `${entry.player.name}'s ${entry.card.name} was poisoned.`);
}

function resolvePoison(room) {
  room.players.forEach((player) => {
    for (let index = player.board.length - 1; index >= 0; index -= 1) {
      const card = player.board[index];

      if (!card.status?.poisoned) {
        continue;
      }

      card.status.poisoned -= 1;

      if (card.status.poisoned <= 0) {
        removeBoardEntry(room, { player, card, index }, "destroyed by poison");
      }
    }
  });
}

function applyStabilize(room) {
  addLog(room, `${room.currentAge?.name || "The Age"} stabilized.`);
  resolvePoison(room);

  room.players.forEach((player) => {
    player.board.forEach((card) => {
      if (card.passiveEffect?.type === "draw" && card.passiveEffect.params?.trigger === "onStabilize") {
        const condition = card.passiveEffect.params?.condition;

        if (!condition || (condition === "emptyHand" && player.hand.length === 0) || (condition === "lowHand2" && player.hand.length < 2)) {
          const count = resolveCount(room, player, card.passiveEffect.params?.count, 1);
          drawCard(room, player, count);
          addLog(room, `${card.name} drew ${count} card${count === 1 ? "" : "s"} for ${player.name}.`, player.id);
        }
      }
    });
  });

  room.revealedHands = {};
}

function applyThen(room, actor, sourceCard, params, context) {
  if (params?.then) {
    return applyEffect(room, actor, params.then, sourceCard, context);
  }

  return false;
}

function applyEffect(room, actor, effect, sourceCard = { name: "Effect" }, context = {}) {
  if (!effect || !actor) {
    return false;
  }

  const depth = Number(context.effectDepth || 0);

  if (depth > 64) {
    return false;
  }

  context = { ...context, effectDepth: depth + 1 };

  const params = effect.params || {};

  switch (effect.type) {
    case "draw": {
      const targets = targetPlayers(room, actor, params.target || "self");

      targets.forEach((target) => {
        const count = Math.min(resolveCount(room, target, params.count, 1), params.max || 99);
        const drawn = drawCard(room, target, count);
        addLog(room, `${target.name} drew ${drawn} card${drawn === 1 ? "" : "s"}.`, target.id);
      });

      return applyThen(room, actor, sourceCard, params, context);
    }

    case "modifyGenePool": {
      const targets = targetPlayers(room, actor, params.target || "self");

      targets.forEach((target) => {
        let baseAmount =
          typeof params.amount === "string" ? resolveCount(room, target, params.amount, 1) : Number(params.amount || 0);
        if (params.max != null) {
          baseAmount = Math.min(baseAmount, Number(params.max));
        }
        const amount = params.direction === "decrease" ? -Math.abs(baseAmount) : baseAmount;
        modifyGenePoolSize(room, target, amount, sourceCard.name);
      });

      return applyThen(room, actor, sourceCard, params, context);
    }

    case "discardSelf": {
      const count = resolveCount(room, actor, params.count, 1);

      for (let index = 0; index < count; index += 1) {
        const discarded = discardCardFromHand(room, actor);

        if (discarded) {
          addLog(room, `${actor.name} discarded ${discarded.name}.`, actor.id);
          addLog(room, `${actor.name} discarded a card.`);
        }
      }

      return applyThen(room, actor, sourceCard, params, context);
    }

    case "discardRandomOpponent": {
      if (context.finishAfterChoice && params.pick !== "highest") {
        const targets = targetPlayers(room, actor, params.target || "nextOpponent");
        const pending = queueHandTargetSequence(room, actor, targets, sourceCard, params, "discard", context);

        if (pending) {
          return true;
        }

        return applyThen(room, actor, sourceCard, params, context);
      }

      targetPlayers(room, actor, params.target || "nextOpponent").forEach((target) => {
        const count = resolveCount(room, target, params.count, 1);

        for (let index = 0; index < count; index += 1) {
          const discarded = params.pick === "highest" ? discardHighestPointCardFromHand(room, target) : discardCardFromHand(room, target);

          if (discarded) {
            addLog(room, `${sourceCard.name} made ${target.name} discard ${discarded.name}.`, target.id);
            addLog(room, `${sourceCard.name} made ${target.name} discard a card.`);
          }
        }
      });

      return applyThen(room, actor, sourceCard, params, context);
    }

    case "stealRandom": {
      const targets = targetPlayers(room, actor, params.target || "nextOpponent");

      if (context.finishAfterChoice && params.zone === "pool") {
        const pending = queuePublicTraitChoice(room, actor, sourceCard, params, "steal", context);

        if (pending) {
          return true;
        }

        return applyThen(room, actor, sourceCard, params, context);
      }

      if (context.finishAfterChoice && params.zone !== "pool") {
        const pending = queueHandTargetSequence(room, actor, targets, sourceCard, params, "steal", context);

        if (pending) {
          return true;
        }

        return applyThen(room, actor, sourceCard, params, context);
      }

      targets.forEach((target) => {
        if (params.zone === "pool") {
          if (target.id === actor.id || ageRules(room).lockTraitRow) {
            return;
          }

          const entry = selectTraitEntry(room, [target], "randomNonDominantTrait", { protectKind: "steal" });

          if (!entry) {
            return;
          }

          const [stolen] = target.board.splice(entry.index, 1);
          stolen.ownerId = actor.id;
          actor.board.push(stolen);
          addLog(room, `${actor.name} stole ${stolen.name} from ${target.name}'s Trait Row.`);
          return;
        }

        const stolen = target.hand.length ? target.hand.splice(Math.floor(Math.random() * target.hand.length), 1)[0] : null;

        if (stolen) {
          stolen.ownerId = actor.id;
          actor.hand.push(stolen);
          addLog(room, `${actor.name} stole ${stolen.name} from ${target.name}.`, actor.id);
          addLog(room, `${actor.name} stole ${stolen.name} from you.`, target.id);
          addLog(room, `${actor.name} stole a random card from ${target.name}.`);
        }
      });

      return applyThen(room, actor, sourceCard, params, context);
    }

    case "stealChosenPublicTrait": {
      if (context.finishAfterChoice) {
        const pending = queuePublicTraitChoice(room, actor, sourceCard, params, "steal", context);

        if (pending) {
          return true;
        }
      }

      if (ageRules(room).lockTraitRow) {
        addLog(room, `${sourceCard.name} could not steal: Trait Rows are locked this Age.`);
        break;
      }

      const stealTargets = targetPlayers(room, actor, params.target || "opponentHighestGenePoolPoints").filter(
        (candidate) => candidate.id !== actor.id
      );
      const target = stealTargets[0];
      const entry = target
        ? selectTraitEntry(room, [target], params.fallback || "highestPointNonDominantTrait", {
            color: params.color,
            protectKind: "steal"
          })
        : null;

      if (entry) {
        const [stolen] = entry.player.board.splice(entry.index, 1);
        stolen.ownerId = actor.id;
        actor.board.push(stolen);
        addLog(room, `${actor.name} stole ${stolen.name} from ${entry.player.name}'s Trait Row.`);
      } else if (params.color) {
        addLog(room, `${sourceCard.name} found no ${normalizeColor(params.color)} Trait to steal.`);
      }
      break;
    }

    case "destroyOpponentTrait": {
      // Most removal cards name their target by a rule ("lowest", "most recent",
      // "the leader's") and must auto-resolve. Only cards that let the player
      // pick — explicit `choose`, or "a Trait played this Age" — open a picker.
      const allowChoice = Boolean(params.choose) || params.filter === "playedThisAge";

      if (context.finishAfterChoice && allowChoice) {
        const pending = queuePublicTraitChoice(room, actor, sourceCard, params, "destroy", context);

        if (pending) {
          return true;
        }
      }

      const fallback = params.fallback || "lowestPointNonDominantTrait";
      const selectOptions = {
        protectKind: "remove",
        color: params.color,
        allowDominant: Boolean(params.allowDominant)
      };
      let entry = selectTraitEntry(room, targetPlayers(room, actor, params.target || "nextOpponent"), fallback, selectOptions);

      if (!entry && params.target !== "self" && params.target !== "allPlayers") {
        entry = selectTraitEntry(room, targetPlayers(room, actor, "allOpponents"), fallback, selectOptions);
      }

      if (entry) {
        removeBoardEntry(room, entry, "destroyed");
      } else {
        addLog(room, `${sourceCard.name} found no Trait to destroy.`);
      }

      return applyThen(room, actor, sourceCard, params, context);
    }

    case "destroyOwnTrait": {
      const entry = selectTraitEntry(room, [actor], params.fallback || "lowestPointNonDominantTrait");
      removeBoardEntry(room, entry, "destroyed");
      return applyThen(room, actor, sourceCard, params, context);
    }

    case "poison":
    case "delayedPoison": {
      if (context.finishAfterChoice) {
        const pending = queuePublicTraitChoice(room, actor, sourceCard, params, "poison", context);

        if (pending) {
          return true;
        }
      }

      const target = targetPlayers(room, actor, params.target || "nextOpponent")[0] || actor;
      const entry = selectTraitEntry(room, [target], params.fallback || "randomNonDominantTrait");
      poisonTrait(room, entry, effect.type === "delayedPoison" ? Number(params.turns || 2) : 1);
      return applyThen(room, actor, sourceCard, params, context);
    }

    case "playExtra": {
      if (room.turnState) {
        const count = resolveCount(room, actor, params.count, 1);
        const allowedColors = extraPlayColorsFor(actor, sourceCard, params);
        room.turnState.playsRemaining = Math.min(room.turnState.playsRemaining + count, MAX_TRAIT_PLAYS_PER_TURN);
        room.turnState.allowedColors = allowedColors.length ? allowedColors : null;
        if (room.turnState.lateWindow && (params.fullTurn || isLate(sourceCard))) {
          room.turnState.lateWindow = false;
        }
        addLog(
          room,
          `${actor.name} may play ${count} extra Trait${count === 1 ? "" : "s"} this turn${allowedColors.length ? ` (${formatColorRestriction(allowedColors)})` : ""}.`
        );
      }
      return applyThen(room, actor, sourceCard, params, context);
    }

    case "reviveFromDiscard":
      if (reviveOrPlayDiscard(room, actor, sourceCard, params, "revived", context)) {
        return true;
      }
      return applyThen(room, actor, sourceCard, params, context);

    case "playFromDiscard":
      return Boolean(reviveOrPlayDiscard(room, actor, sourceCard, params, "play", context));

    case "revealHandFullText": {
      targetPlayers(room, actor, params.target || "nextOpponent").forEach((target) => revealHand(room, actor, sourceCard, target));
      return applyThen(room, actor, sourceCard, params, context);
    }

    case "reverseTurnOrder":
      room.turnOrder = currentTurnOrder(room).reverse();
      addLog(room, `${sourceCard.name} reversed turn order.`);
      return applyThen(room, actor, sourceCard, params, context);

    case "skipNextPlayer": {
      targetPlayers(room, actor, params.target || "nextOpponent").forEach((target) => {
        target.hasActedThisAge = true;
        addLog(room, `${sourceCard.name} skipped ${target.name}'s next action this Age.`);
      });
      return applyThen(room, actor, sourceCard, params, context);
    }

    case "swapHands": {
      if (params.mode === "rotate" || params.mode === "rotateLeft1" || params.target === "allPlayers") {
        const players = orderedPlayers(room);
        const hands = players.map((player) => player.hand);
        players.forEach((player, index) => {
          player.hand = hands[(index + 1) % hands.length] || [];
        });
        addLog(room, `${sourceCard.name} rotated everyone's hand.`);
        break;
      }

      // "Swap with an opponent of your choice" opens a picker; fixed-target
      // swaps (e.g. "the next opponent") resolve automatically.
      const opponents = targetPlayers(room, actor, "allOpponents");

      if (context.finishAfterChoice && params.choose && opponents.length > 1) {
        const pending = queueSwapTargetChoice(room, actor, sourceCard, params, opponents, context);

        if (pending) {
          return true;
        }
      }

      const target = params.choose ? opponents[0] : targetPlayers(room, actor, params.target || "nextOpponent")[0];

      if (target) {
        [actor.hand, target.hand] = [target.hand, actor.hand];
        addLog(room, `${actor.name} swapped hands with ${target.name}.`);
      }
      break;
    }

    case "copyImmediate": {
      if (context.copyDepth) {
        break;
      }

      const copyables = copyableImmediateEntries(room, actor, sourceCard);

      if (!copyables.length) {
        addLog(room, `${sourceCard.name} found no Trait effect to copy.`);
        break;
      }

      if (context.finishAfterChoice && copyables.length > 1) {
        const pending = queueCopyImmediateChoice(room, actor, sourceCard, params, copyables, context);

        if (pending) {
          return true;
        }
      }

      const previous = context.previousTrait || room.lastPlayedTrait?.card;
      const copyEntry =
        (previous && copyables.find((entry) => entry.card.instanceId === previous.instanceId)) ||
        copyables[copyables.length - 1];

      addLog(room, `${sourceCard.name} copied ${copyEntry.card.name}.`);
      return Boolean(
        applyEffect(room, actor, copyEntry.card.immediateEffect, copyEntry.card, {
          copyDepth: 1,
          effectDepth: context.effectDepth,
          finishAfterChoice: context.finishAfterChoice
        })
      );
    }

    case "copyTrait": {
      if (params.aspect === "recolorRandomAll") {
        room.players.forEach((player) => {
          player.board.forEach((card) => {
            if (!isDominant(card)) {
              card.colorOverride = CARD_COLORS[Math.floor(Math.random() * CARD_COLORS.length)];
            }
          });
        });
        addLog(room, `${sourceCard.name} randomized Trait colors.`);
      } else if (params.aspect === "recolorAll") {
        room.players.forEach((player) => {
          player.board.forEach((card) => {
            if (!isDominant(card)) {
              card.colorOverride = normalizeColor(params.to);
            }
          });
        });
        addLog(room, `${sourceCard.name} changed non-Dominant Trait colors.`);
      } else {
        const target = targetPlayers(room, actor, params.target || "opponentHighestGenePoolPoints")[0];
        const entry = target ? selectTraitEntry(room, [target], params.fallback || "highestPointNonDominantTrait") : null;

        if (entry) {
          const copy = createCardInstance(entry.card);
          copy.name = `${entry.card.name} Copy`;
          copy.points = params.asToken ? 0 : entry.card.points;
          copy.token = Boolean(params.asToken);
          copy.ownerId = actor.id;
          copy.originalOwnerId = actor.id;
          actor.board.push(copy);
          addLog(room, `${actor.name} copied ${entry.card.name} into their Trait Row.`);
        }
      }
      break;
    }

    case "destroyMutual": {
      const target = targetPlayers(room, actor, params.target || "nextOpponent")[0];

      if (target) {
        removeBoardEntry(room, selectTraitEntry(room, [target], params.fallback || "lowestPointNonDominantTrait"), "destroyed");
      }

      removeBoardEntry(
        room,
        selectTraitEntry(room, [actor], params.selfFallback || "lowestPointNonDominantTrait", {
          excludeInstanceId: sourceCard.instanceId
        }),
        "destroyed"
      );
      return applyThen(room, actor, sourceCard, params, context);
    }

    case "stealPeekPlay": {
      const target = targetPlayers(room, actor, params.target || "nextOpponent")[0];

      if (!target || !target.hand.length) {
        addLog(room, `${sourceCard.name} found no cards to take.`);
        return applyThen(room, actor, sourceCard, params, context);
      }

      const peek = Math.min(Number(params.peek || 2), target.hand.length);
      const shuffled = shuffle(target.hand.map((card, index) => ({ card, index })));
      const seen = shuffled.slice(0, peek);

      if (context.finishAfterChoice && params.choose) {
        const pending = queuePeekPlayChoice(
          room,
          actor,
          target,
          sourceCard,
          params,
          seen.map((entry) => entry.card.instanceId),
          context
        );

        if (pending) {
          return true;
        }
      }

      const chosen = seen.reduce((best, entry) => (printedPoints(entry.card) > printedPoints(best.card) ? entry : best), seen[0]);
      const handIndex = target.hand.findIndex((card) => card.instanceId === chosen.card.instanceId);
      const [stolen] = target.hand.splice(handIndex, 1);
      stolen.ownerId = actor.id;
      addLog(room, `${actor.name} looked at ${peek} of ${target.name}'s cards and took ${stolen.name}.`, actor.id);
      addLog(room, `${actor.name} peeked at ${target.name}'s hand and stole a card.`);

      if (params.playImmediately === false || isParasite(stolen)) {
        actor.hand.push(stolen);
      } else {
        actor.board.push(stolen);
        addLog(room, `${actor.name} immediately played ${stolen.name}.`);
        const pending = applyEffect(room, actor, stolen.immediateEffect, stolen, { finishAfterChoice: context.finishAfterChoice, effectDepth: context.effectDepth });
        room.lastPlayedTrait = { card: stolen, playerId: actor.id };
        room.lastPlayedSeq = (room.lastPlayedSeq || 0) + 1;

        if (pending) {
          return true;
        }
      }

      return applyThen(room, actor, sourceCard, params, context);
    }

    case "moveSelfToOpponent": {
      const target = targetPlayers(room, actor, params.target || "nextOpponent")[0];
      const index = actor.board.findIndex((card) => card.instanceId === sourceCard.instanceId);

      if (target && index !== -1) {
        const [moved] = actor.board.splice(index, 1);
        moved.parasiteOwnerId = actor.id;
        moved.parasiteValue = Number(params.value ?? moved.points ?? -2);
        target.board.push(moved);
        addLog(room, `${actor.name} moved ${moved.name} into ${target.name}'s Trait Row.`);
      }

      return applyThen(room, actor, sourceCard, params, context);
    }

    case "playTopDiscard": {
      const forced = { ...params, forceTop: true };

      if (context.finishAfterChoice && params.choose) {
        const pending = reviveOrPlayDiscard(room, actor, sourceCard, params, "play", context);

        if (pending) {
          return true;
        }

        return applyThen(room, actor, sourceCard, params, context);
      }

      reviveOrPlayDiscard(room, actor, sourceCard, forced, "play");
      return applyThen(room, actor, sourceCard, params, context);
    }

    case "attach": {
      const scope = params.scope || "self";
      const hostPlayers =
        scope === "self" ? [actor] : scope === "anyBoard" ? room.players : targetPlayers(room, actor, "allOpponents");

      let entries = nonDominantBoardEntries(room, hostPlayers, true).filter(
        (entry) => entry.card.instanceId !== sourceCard.instanceId
      );

      if (params.color) {
        const wanted = normalizeColor(params.color);
        entries = entries.filter((entry) => effectiveColor(entry.player, entry.card) === wanted);
      }

      if (params.effectlessOnly) {
        entries = entries.filter((entry) => isEffectlessTrait(entry.card));
      }

      if (!entries.length) {
        addLog(room, `${sourceCard.name} found no Trait to latch onto and stayed in the Row.`);
        return applyThen(room, actor, sourceCard, params, context);
      }

      const sorted = [...entries].sort(
        (a, b) => cardScoreForHost(b.card, b.player, room) - cardScoreForHost(a.card, a.player, room)
      );

      if (context.finishAfterChoice && entries.length > 1) {
        const pending = queueAttachChoice(room, actor, sourceCard, params, entries, context);
        if (pending) {
          return true;
        }
      }

      const pick = params.hostFallback === "lowest" ? sorted[sorted.length - 1] : sorted[0];
      return performAttach(room, actor, sourceCard, params, pick.player, pick.card, context);
    }

    case "massHandDiscard": {
      const count = resolveCount(room, actor, params.count, 1);
      const targets = targetPlayers(room, actor, params.target || "allOpponents");
      const affected = params.includeSelf ? [...new Set([actor, ...targets])] : targets;

      affected.forEach((person) => {
        let dropped = 0;

        for (let i = 0; i < count && person.hand.length; i += 1) {
          const idx = Math.floor(Math.random() * person.hand.length);
          const [card] = person.hand.splice(idx, 1);
          addToDiscard(room, card, person.id);
          dropped += 1;
        }

        if (dropped) {
          addLog(room, `${person.name} discarded ${dropped} card${dropped === 1 ? "" : "s"} at random.`, person.id);
        }
      });

      return applyThen(room, actor, sourceCard, params, context);
    }

    case "drawInspectPlay": {
      const before = actor.hand.length;
      drawCard(room, actor, 1);

      if (actor.hand.length > before) {
        const drawn = actor.hand.pop();

        if (isDominant(drawn)) {
          addToDiscard(room, drawn, actor.id);
          addLog(room, `${actor.name} drew ${drawn.name} (Dominant) and discarded it.`);
        } else {
          drawn.ownerId = actor.id;
          drawn.originalOwnerId ||= actor.id;
          actor.board.push(drawn);
          addLog(room, `${actor.name} drew ${drawn.name} and played it at once, ignoring its action.`);
        }
      }

      return applyThen(room, actor, sourceCard, params, context);
    }

    case "grantExtraPlays": {
      const count = resolveCount(room, actor, params.count, 1);

      if (room.turnState) {
        room.turnState.playsRemaining += count;

        if (params.ignoreActions) {
          room.turnState.suppressExtraActions = true;
        }

        if (Array.isArray(params.colors) && params.colors.length) {
          room.turnState.extraPlayColorsAfterFirst = uniqueNormalizedColors(params.colors);
        }

        addLog(
          room,
          `${actor.name} may play ${count} additional Trait${count === 1 ? "" : "s"}${
            params.ignoreActions ? " with actions ignored" : ""
          }.`
        );
      }

      return applyThen(room, actor, sourceCard, params, context);
    }

    case "discardHandNoStabilize": {
      const dumped = actor.hand.length;

      while (actor.hand.length) {
        const [card] = actor.hand.splice(0, 1);
        addToDiscard(room, card, actor.id);
      }

      actor.flags.noDrawThisAge = true;

      if (dumped) {
        addLog(room, `${actor.name} discarded their whole hand (${dumped}) and will not refill this Age.`);
      }

      return applyThen(room, actor, sourceCard, params, context);
    }

    default:
      addLog(room, `${sourceCard.name} has an effect that is not implemented yet.`);
      break;
  }

  return false;
}

function placeParasiteCard(room, actor, card, context = {}) {
  if (context.finishAfterChoice) {
    return queueParasiteTargetChoice(room, actor, card, context);
  }

  const params = card.immediateEffect?.params || {};
  const target = targetPlayers(room, actor, params.target || "opponentHighestGenePoolPoints")[0];

  if (!target) {
    actor.board.push(card);
    addLog(room, `${actor.name} played ${card.name}.`);
    return false;
  }

  card.ownerId = actor.id;
  card.originalOwnerId ||= actor.id;
  card.parasiteOwnerId = actor.id;
  card.parasiteValue = Number(params.value ?? card.points ?? -1);
  target.board.push(card);
  addLog(room, `${actor.name} placed ${card.name} into ${target.name}'s Trait Row.`);
  return false;
}

function applyAgeEffect(room) {
  const age = room.currentAge;
  const effect = age?.effect;

  if (age) {
    addLog(room, `Age revealed: ${age.name}. ${age.text}`);
  }

  if (!effect) {
    return;
  }

  const params = effect.params || {};

  switch (effect.type) {
    case "worldsEndScore":
    case "none":
      break;

    case "setGenePool":
      room.players.forEach((player) => {
        player.genePoolSize = clampGenePoolSize(Number(params.value || STARTING_GENE_POOL_SIZE));
      });
      break;

    case "modifyGenePool":
      room.players.forEach((player) => {
        const base = typeof params.amount === "string" ? resolveCount(room, player, params.amount, 1) : Number(params.amount || 1);
        const amount = params.direction === "decrease" ? -Math.abs(base) : Math.abs(base);
        modifyGenePoolSize(room, player, amount, age.name);
      });
      break;

    case "discardPerColor":
      room.players.forEach((player) => {
        const count = colorCount(player, params.color || "Green");

        for (let index = 0; index < count; index += 1) {
          const discarded = discardCardFromHand(room, player);

          if (discarded) {
            addLog(room, `${player.name} discarded ${discarded.name}.`, player.id);
            addLog(room, `${player.name} discarded a card.`);
          }
        }
      });
      break;

    case "drawKeepDiscard":
      room.players.forEach((player) => {
        const drawn = drawCard(room, player, Number(params.draw || 3));
        const keep = Number(params.keep || 1);
        const toDiscard = Math.max(0, drawn - keep);

        for (let index = 0; index < toDiscard; index += 1) {
          const discarded = discardCardFromHand(room, player);

          if (discarded) {
            addLog(room, `${player.name} discarded ${discarded.name}.`, player.id);
          }
        }

        addLog(room, `${player.name} drew ${drawn} and kept ${Math.max(0, drawn - toDiscard)}.`);
      });
      break;

    case "conditionalSteal":
      room.players.forEach((player) => {
        const hasTrait = player.board.some((card) => (card.tags || card.keywords || []).includes(params.requiresKeyword) || card.name === params.requiresName);

        if (!hasTrait) {
          return;
        }

        const target = targetPlayers(room, player, "nextOpponent")[0];
        const stolen = target?.hand.length ? target.hand.splice(Math.floor(Math.random() * target.hand.length), 1)[0] : null;

        if (stolen) {
          stolen.ownerId = player.id;
          player.hand.push(stolen);
          addLog(room, `${player.name}'s ${params.requiresName || params.requiresKeyword} stole a card from ${target.name}.`);
        }
      });
      break;

    case "draw":
    case "draw":
      room.players.forEach((player) => {
        if ((params.condition === "ownBody2" || params.condition === "ownGreen2") && colorCount(player, "Green") < 2) {
          const discarded = discardCardFromHand(room, player);

          if (discarded) {
            addLog(room, `${player.name} discarded ${discarded.name}.`, player.id);
            addLog(room, `${player.name} discarded a card.`);
          }
          return;
        }

        const count = resolveCount(room, player, params.count, 1);
        const drawn = drawCard(room, player, count);
        addLog(room, `${player.name} drew ${drawn} card${drawn === 1 ? "" : "s"}.`, player.id);
      });
      break;

    case "discardRandomOpponent":
      room.players.forEach((player) => {
        const count = resolveCount(room, player, params.count, 1);

        for (let index = 0; index < count; index += 1) {
          const discarded = discardCardFromHand(room, player);

          if (discarded) {
            addLog(room, `${player.name} discarded ${discarded.name}.`, player.id);
            addLog(room, `${player.name} discarded a card.`);
          }
        }

        if (params.then?.type === "poison") {
          poisonTrait(room, selectTraitEntry(room, [player], params.then.params?.fallback || "randomNonDominantTrait"));
        }
      });
      break;

    case "destroyOpponentTrait":
      if (params.scope === "highValue" || params.scope === "value4plus") {
        const threshold = params.scope === "highValue" ? 3 : 4;

        if (params.ransom) {
          return beginAgeRansom(room, threshold, Number(params.ransom));
        }

        room.players.forEach((player) => {
          for (let index = player.board.length - 1; index >= 0; index -= 1) {
            const card = player.board[index];

            if (!isDominant(card) && cardScoreForHost(card) >= threshold) {
              removeBoardEntry(room, { player, card, index }, "destroyed by an Age wipe");
            }
          }
        });
      } else if (params.target === "rightNeighbor") {
        room.players.forEach((player) => {
          const target = targetPlayers(room, player, "rightNeighbor")[0];
          removeBoardEntry(room, selectTraitEntry(room, [target], params.fallback || "mostRecentTrait"), "destroyed by an Age");
        });
      } else {
        room.players.forEach((player) => applyEffect(room, player, effect, age));
      }
      break;

    case "destroyOwnTrait":
      if (params.scope === "keepTop3") {
        room.players.forEach((player) => {
          const keep = [...player.board].sort((a, b) => cardScoreForHost(b) - cardScoreForHost(a)).slice(0, 3);
          const keepIds = new Set(keep.map((card) => card.instanceId));

          for (let index = player.board.length - 1; index >= 0; index -= 1) {
            const card = player.board[index];

            if (!keepIds.has(card.instanceId) && !isDominant(card)) {
              removeBoardEntry(room, { player, card, index }, "discarded by Population Bottleneck");
            }
          }
        });
      }
      break;

    case "poison":
      if (params.scope === "edgeTraits") {
        room.players.forEach((player) => {
          [0, player.board.length - 1]
            .filter((index, listIndex, list) => index >= 0 && list.indexOf(index) === listIndex)
            .forEach((index) => poisonTrait(room, { player, card: player.board[index], index }));
        });
      } else {
        room.players.forEach((player) => {
          const target = targetPlayers(room, player, params.target || "leftNeighbor")[0];
          poisonTrait(room, selectTraitEntry(room, [target], params.fallback || "randomNonDominantTrait"));
        });
      }
      break;

    case "reverseTurnOrder":
      room.turnOrder = currentTurnOrder(room).reverse();
      addLog(room, "Turn order reversed.");
      break;

    case "swapHands":
      applyEffect(room, room.players[0], effect, age);
      break;

    case "copyTrait":
      applyEffect(room, room.players[0], effect, age);
      break;

    case "playFromDiscard":
      room.players.forEach((player) => reviveOrPlayDiscard(room, player, age, params, "play"));
      break;

    case "revealHandFullText":
      room.players.forEach((player) => {
        room.revealedHands[player.id] = true;
      });
      addLog(room, "Every player's hand is revealed until the next Age.");
      break;

    case "playExtra":
      room.players.forEach((player) => {
        player.flags.extraPlayThisAge = Math.min(Number(params.count || 1), MAX_TRAIT_PLAYS_PER_TURN - 1);
        player.flags.extraPlayColorsThisAge = params.restrictColor ? uniqueNormalizedColors([params.restrictColor]) : null;
        player.flags.sameColorExtraThisAge = Boolean(params.sameColorAsFirst);
      });
      addLog(room, params.sameColorAsFirst ? "Everyone gets an extra same-color play this Age." : "Everyone gets an extra play this Age.");
      break;

    case "placeParasite":
      room.players.forEach((player) => {
        const parasiteIndex = player.hand.findIndex((card) => isParasite(card));

        if (parasiteIndex !== -1) {
          const [card] = player.hand.splice(parasiteIndex, 1);
          placeParasiteCard(room, player, card);
        }
      });
      break;

    case "skipNextPlayer":
      addLog(room, "The Long Drought suppresses draw effects this Age.");
      room.players.forEach((player) => {
        player.flags.noDrawThisAge = true;
      });
      break;

    case "endgameBonus":
      if (age.isFinal) {
        break;
      }

      room.players.forEach((player) => {
        if (params.cond === "twoOrFewerColors" && uniqueColors(player) <= 2) {
          room.lockedBonuses[player.id] = (room.lockedBonuses[player.id] || 0) + Number(params.amount || 0);
          addLog(room, `${player.name} banked +${params.amount || 0} convergence points.`);
        }
      });
      break;

    default:
      room.players.forEach((player) => applyEffect(room, player, effect, age));
      break;
  }

  return false;
}

function revealAge(room) {
  room.currentAge = room.ageDeck[room.ageIndex] || null;
  room.ageIndex += 1;
  room.playersActedThisAge = [];
  room.revealedHands = {};
  room.players.forEach((player) => {
    player.hasActedThisAge = false;
    delete player.flags.noDrawThisAge;
    delete player.flags.extraPlayThisAge;
    delete player.flags.extraPlayColorsThisAge;
    delete player.flags.sameColorExtraThisAge;
  });

  if (!room.currentAge) {
    finishGame(room);
    return;
  }

  setCurrentPlayer(room, currentTurnOrder(room)[0]);
  const pendingAgeChoice = applyAgeEffect(room);

  if (pendingAgeChoice || room.pendingChoice) {
    return;
  }

  beginTurn(room);
}

function beginTurn(room) {
  if (room.phase !== "playing") {
    return;
  }

  const player = currentPlayer(room);

  if (!player) {
    finishGame(room);
    return;
  }

  const extra = Number(player.flags.extraPlayThisAge || 0);
  const extraPlayColorsAfterFirst = uniqueNormalizedColors(player.flags.extraPlayColorsThisAge || []);
  const sameColorExtraPending = Boolean(player.flags.sameColorExtraThisAge);
  player.flags.extraPlayThisAge = 0;
  delete player.flags.extraPlayColorsThisAge;
  delete player.flags.sameColorExtraThisAge;
  room.turnState = {
    primaryActionTaken: false,
    playsTaken: 0,
    playsRemaining: Math.min(1 + extra, MAX_TRAIT_PLAYS_PER_TURN),
    allowedColors: null,
    extraPlayColorsAfterFirst: extraPlayColorsAfterFirst.length ? extraPlayColorsAfterFirst : null,
    sameColorExtraPending
  };
  room.pendingDiscard = null;
  addLog(room, `${player.name}'s turn.`);
}

function completeStabilize(room) {
  if (room.pendingChoice) {
    return;
  }

  if (room.currentAge?.isFinal) {
    finishGame(room);
  } else {
    revealAge(room);
  }
}

function endTurn(room) {
  const player = currentPlayer(room);

  if (player) {
    player.hasActedThisAge = true;
    room.playersActedThisAge.push(player.id);
  }

  const next = orderedPlayers(room).find((candidate) => !candidate.hasActedThisAge);

  if (!next) {
    applyStabilize(room);
    completeStabilize(room);
    return;
  }

  setCurrentPlayer(room, next.id);
  beginTurn(room);
}

function joinRoom(room, playerId, playerName) {
  const existing = findPlayer(room, playerId);

  if (existing) {
    const nextName = cleanName(playerName);
    existing.name = nextName;
    addLog(room, `${existing.name} rejoined the room.`);
    return existing;
  }

  if (room.phase !== "lobby") {
    throw new Error("That game has already started.");
  }

  if (room.players.length >= MAX_PLAYERS) {
    throw new Error("That room is full.");
  }

  const player = createPlayer(playerId, playerName);
  room.players.push(player);
  room.turnOrder = room.players.map((candidate) => candidate.id);
  addLog(room, `${player.name} joined the room.`);
  return player;
}

function startGame(room, playerId) {
  requireHost(room, playerId);

  if (room.phase !== "lobby") {
    throw new Error("The game has already started.");
  }

  if (room.players.length < MIN_PLAYERS) {
    throw new Error("At least two players are required.");
  }

  room.phase = "playing";
  room.traitDeck = createTraitDeck();
  room.discardPile = [];
  room.ageDeck = createAgeDeck(room.players.length);
  room.currentAge = null;
  room.ageIndex = 0;
  room.currentPlayerIndex = 0;
  room.turnOrder = room.players.map((player) => player.id);
  room.playersActedThisAge = [];
  room.turnState = null;
  room.pendingDiscard = null;
  room.pendingChoice = null;
  room.finalScores = null;
  room.lastPlayedTrait = null;
  room.revealedHands = {};
  room.lockedBonuses = {};
  room.nextChoiceId = 1;

  room.players.forEach((player) => {
    player.hand = [];
    player.board = [];
    player.genePoolSize = STARTING_GENE_POOL_SIZE;
    player.skippedTurns = 0;
    player.flags = {};
    player.hasActedThisAge = false;
    drawCard(room, player, STARTING_HAND_SIZE);
  });

  addLog(room, `${findPlayer(room, playerId).name} started the game.`);
  revealAge(room);
}

function requireCurrentTurn(room, playerId) {
  if (room.phase !== "playing") {
    throw new Error("The game is not currently playing.");
  }

  const player = requirePlayer(room, playerId);
  const current = currentPlayer(room);

  if (!current || current.id !== playerId) {
    throw new Error("It is not your turn.");
  }

  return player;
}

function ageRules(room) {
  return room.currentAge?.rules || {};
}

function checkPlayCondition(room, player, card) {
  const condition = card.playCondition;

  if (!condition) {
    return { ok: true };
  }

  if (condition.minColorCount) {
    const { color, count } = condition.minColorCount;

    if (colorCount(player, color) < Number(count || 0)) {
      return {
        ok: false,
        message: `${card.name} needs ${count} ${normalizeColor(color)} Traits in your Row.`
      };
    }
  }

  if (condition.maxFaceValue != null && Number(card.points || 0) > Number(condition.maxFaceValue)) {
    return { ok: false, message: `${card.name} cannot be played right now.` };
  }

  if (condition.discardCost) {
    const { color, count } = condition.discardCost;
    const available = countColorInHandAndBoard(player, color, card.instanceId);

    if (available < Number(count || 0)) {
      return {
        ok: false,
        message: `${card.name} needs to discard ${count} ${normalizeColor(color)} Trait${
          Number(count) === 1 ? "" : "s"
        } to play.`
      };
    }
  }

  if (condition.requiresOpponentKeyword) {
    const keyword = condition.requiresOpponentKeyword;
    const present = targetPlayers(room, player, "allOpponents").some((opponent) =>
      opponent.board.some((entry) => entry.keywords?.includes(keyword))
    );

    if (!present) {
      return {
        ok: false,
        message: `${card.name} can only be played while an opponent has a ${keyword} Trait in play.`
      };
    }
  }

  return { ok: true };
}

function countColorInHandAndBoard(player, color, excludeInstanceId) {
  const wanted = normalizeColor(color);
  const inHand = player.hand.filter(
    (candidate) => candidate.instanceId !== excludeInstanceId && normalizeColor(candidate.color) === wanted
  ).length;
  const inBoard = player.board.filter((candidate) => effectiveColor(player, candidate) === wanted).length;
  return inHand + inBoard;
}

function payPlayCost(room, player, card) {
  const cost = card.playCondition?.discardCost;

  if (!cost) {
    return;
  }

  const color = normalizeColor(cost.color);
  let remaining = Number(cost.count || 0);

  for (let i = player.hand.length - 1; i >= 0 && remaining > 0; i -= 1) {
    if (normalizeColor(player.hand[i].color) === color) {
      const [dropped] = player.hand.splice(i, 1);
      addToDiscard(room, dropped, player.id);
      addLog(room, `${player.name} discarded ${dropped.name} to play ${card.name}.`, player.id);
      remaining -= 1;
    }
  }

  for (let i = player.board.length - 1; i >= 0 && remaining > 0; i -= 1) {
    if (effectiveColor(player, player.board[i]) === color) {
      const [dropped] = player.board.splice(i, 1);
      addToDiscard(room, dropped, dropped.ownerId || player.id);
      addLog(room, `${player.name} discarded ${dropped.name} to play ${card.name}.`, player.id);
      remaining -= 1;
    }
  }
}

function canPlayInCurrentWindow(room, player, card) {
  if (room.turnState?.lateWindow && !isLate(card)) {
    return {
      ok: false,
      message: "Only Late Traits can be played right now."
    };
  }

  const allowedColors = uniqueNormalizedColors(room.turnState?.allowedColors || []);

  if (allowedColors.length && !allowedColors.includes(effectiveColor(player, card))) {
    return {
      ok: false,
      message: `Your next Trait must be ${formatColorRestriction(allowedColors)}.`
    };
  }

  const rules = ageRules(room);
  const cardColor = effectiveColor(player, card);

  if (!(rules.freeHeroic && card.playCondition?.minColorCount)) {
    const conditionCheck = checkPlayCondition(room, player, card);

    if (!conditionCheck.ok) {
      return conditionCheck;
    }
  }

  const bannedColors = uniqueNormalizedColors(rules.bannedColors || []);

  if (bannedColors.includes(cardColor)) {
    return { ok: false, message: `This Age forbids ${cardColor} Traits.` };
  }

  if (rules.maxFaceValuePlay != null && Number(card.points || 0) > Number(rules.maxFaceValuePlay)) {
    return { ok: false, message: `This Age only allows Traits of face value ${rules.maxFaceValuePlay} or lower.` };
  }

  if (rules.noSameColorAsLast && room.lastPlayedTrait?.card) {
    const lastOwner = findPlayer(room, room.lastPlayedTrait.playerId);
    const lastColor = effectiveColor(lastOwner || player, room.lastPlayedTrait.card);

    if (lastColor === cardColor) {
      return { ok: false, message: `This Age forbids playing a ${cardColor} Trait after another ${cardColor} Trait.` };
    }
  }

  if (room.turnState?.effectlessOnly) {
    if (!isEffectlessTrait(card)) {
      return { ok: false, message: "This bonus play must be an effectless Trait." };
    }
  }

  return {
    ok: true
  };
}

function isEffectlessTrait(card) {
  if (card.immediateEffect || card.endEffect) {
    return false;
  }

  const passiveType = card.passiveEffect?.type;
  return !passiveType || passiveType === "noEffect";
}

function stabilizeActivePlayer(room, player) {
  if (!player || player.flags.noDrawThisAge) {
    return;
  }

  const fixedHand = ageRules(room).endWithHandSize;

  if (fixedHand != null) {
    const needed = Math.max(0, Number(fixedHand) - player.hand.length);

    if (needed) {
      drawCard(room, player, needed);
      addLog(room, `${player.name} drew up to ${fixedHand} cards for this Age.`, player.id);
    }
  } else {
    const drawn = drawToHandSize(room, player);

    if (drawn) {
      addLog(room, `${player.name} drew back up toward their Gene Pool (${handLimitFor(player)}).`, player.id);
    }
  }
}

function continueAfterActionCleanup(room) {
  if (room.pendingChoice) {
    return;
  }

  const player = currentPlayer(room);

  // The player still has Traits to play this turn; wait for their next action
  // before drawing back up (stabilizing).
  if (room.turnState && room.turnState.playsRemaining > 0) {
    return;
  }

  if (player && room.turnState && !room.turnState.lateWindow && player.hand.some(isLate)) {
    room.turnState.lateWindow = true;
    room.turnState.playsRemaining = 1;
    addLog(room, `${player.name} may play a Late Trait or pass.`);
    return;
  }

  // Stabilize once, at the very end of the turn: draw back up to the Gene Pool.
  if (room.turnState && !room.turnState.stabilized) {
    room.turnState.stabilized = true;
    stabilizeActivePlayer(room, player);
  }

  if (queueHandLimitDiscard(room, player, { finishAfterChoice: "actionCleanup" })) {
    return;
  }

  endTurn(room);
}

function completeAfterPlay(room, player) {
  if (!player || room.phase !== "playing") {
    return;
  }

  continueAfterActionCleanup(room);
}

function playCard(room, playerId, cardInstanceId) {
  const player = requireCurrentTurn(room, playerId);
  assertNoPendingChoice(room);

  if (!room.turnState || room.turnState.playsRemaining <= 0) {
    throw new Error("You cannot play another Trait this turn.");
  }

  const cardIndex = player.hand.findIndex((card) => card.instanceId === cardInstanceId);

  if (cardIndex === -1) {
    throw new Error("That card is not in your hand.");
  }

  const card = player.hand[cardIndex];

  const playWindow = canPlayInCurrentWindow(room, player, card);

  if (!playWindow.ok) {
    throw new Error(playWindow.message);
  }

  const consumedAllowedColors = Boolean(room.turnState.allowedColors?.length);
  player.hand.splice(cardIndex, 1);

  if (card.playCondition?.discardCost) {
    payPlayCost(room, player, card);
  }

  const previousTrait = room.lastPlayedTrait?.card || null;
  card.ownerId = player.id;
  card.originalOwnerId ||= player.id;
  room.turnState.primaryActionTaken = true;
  room.turnState.playsTaken += 1;
  room.turnState.playsRemaining -= 1;

  if (consumedAllowedColors) {
    room.turnState.allowedColors = null;
  }

  if (room.turnState.playsTaken === 1 && room.turnState.playsRemaining > 0) {
    if (room.turnState.sameColorExtraPending) {
      room.turnState.allowedColors = [effectiveColor(player, card)];
      room.turnState.sameColorExtraPending = false;
      addLog(room, `${player.name}'s extra play must be ${formatColorRestriction(room.turnState.allowedColors)}.`);
    } else if (room.turnState.extraPlayColorsAfterFirst?.length) {
      room.turnState.allowedColors = room.turnState.extraPlayColorsAfterFirst;
      addLog(room, `${player.name}'s extra play must be ${formatColorRestriction(room.turnState.allowedColors)}.`);
    }
  }

  const rules = ageRules(room);
  const actionsSuppressed = Boolean(rules.ignoreTraitActions) || Boolean(room.turnState?.suppressExtraActions);
  let isWaitingForChoice = false;

  if (isParasite(card) && !actionsSuppressed) {
    isWaitingForChoice = placeParasiteCard(room, player, card, { finishAfterChoice: "play" });
  } else {
    player.board.push(card);
    addLog(room, `${player.name} played ${card.name}.`);

    if (actionsSuppressed && card.immediateEffect) {
      addLog(room, `The Age suppressed ${card.name}'s action.`);
    } else {
      isWaitingForChoice = applyEffect(room, player, card.immediateEffect, card, {
        previousTrait,
        finishAfterChoice: "play"
      });
    }
  }

  if (rules.effectlessChain && isEffectlessTrait(card) && room.turnState && room.turnState.playsRemaining <= 0 && !room.turnState.effectlessGranted) {
    room.turnState.playsRemaining = 1;
    room.turnState.effectlessOnly = true;
    room.turnState.effectlessGranted = true;
    addLog(room, `${player.name} may play another effectless Trait.`);
  } else if (room.turnState?.effectlessOnly && room.turnState.playsRemaining <= 0) {
    room.turnState.effectlessOnly = false;
  }

  const playedColor = effectiveColor(player, card);

  for (let index = player.board.length - 1; index >= 0; index -= 1) {
    const boardCard = player.board[index];

    if (boardCard.instanceId === card.instanceId || boardCard.passiveEffect?.type !== "returnOnColorPlay") {
      continue;
    }

    if (normalizeColor(boardCard.passiveEffect.params?.color || "Green") === playedColor) {
      const [returned] = player.board.splice(index, 1);
      returned.status = {};
      player.hand.push(returned);
      addLog(room, `${returned.name} returned to ${player.name}'s hand after a ${playedColor} Trait was played.`, player.id);
    }
  }

  room.lastPlayedTrait = { card, playerId: player.id };
  room.lastPlayedSeq = (room.lastPlayedSeq || 0) + 1;

  if (isWaitingForChoice) {
    return;
  }

  completeAfterPlay(room, player);
}

function skipTurn(room, playerId) {
  const player = requireCurrentTurn(room, playerId);
  assertNoPendingChoice(room);

  if (room.turnState?.lateWindow) {
    passLate(room, playerId);
    return;
  }

  if (room.turnState?.primaryActionTaken) {
    if (room.turnState.playsRemaining > 0) {
      const passedPlays = room.turnState.playsRemaining;
      room.turnState.playsRemaining = 0;
      room.turnState.allowedColors = null;
      addLog(room, `${player.name} passed their remaining play${passedPlays === 1 ? "" : "s"}.`);
      continueAfterActionCleanup(room);
      return;
    }

    throw new Error("You already took an action this turn.");
  }

  const drawn = drawCard(room, player, 2);
  player.skippedTurns += 1;
  room.turnState.primaryActionTaken = true;
  room.turnState.playsTaken = MAX_TRAIT_PLAYS_PER_TURN;
  room.turnState.playsRemaining = 0;
  addLog(room, `${player.name} skipped and drew ${drawn} card${drawn === 1 ? "" : "s"}.`, player.id);
  addLog(room, `${player.name} skipped their play.`);

  if (queueHandLimitDiscard(room, player, { finishAfterChoice: "skipTurn" })) {
    return;
  }

  endTurn(room);
}

function passLate(room, playerId) {
  const player = requireCurrentTurn(room, playerId);
  assertNoPendingChoice(room);

  if (!room.turnState?.lateWindow) {
    throw new Error("There is no Late window to pass.");
  }

  addLog(room, `${player.name} passed the Late window.`);
  room.turnState.playsRemaining = 0;
  continueAfterActionCleanup(room);
}

function resolveChoice(room, playerId, choiceId, optionId) {
  const choice = room.pendingChoice;

  if (!choice) {
    throw new Error("There is no pending choice.");
  }

  if (choice.id !== choiceId) {
    throw new Error("That choice is no longer active.");
  }

  if (choice.playerId !== playerId) {
    throw new Error("That choice belongs to another player.");
  }

  const actor = requirePlayer(room, choice.actorId);
  const option = choice.choices.find((candidate) => candidate.id === optionId);

  if (!option) {
    throw new Error("That option is not available.");
  }

  clearPendingChoice(room);

  let followup = false;

  switch (choice.type) {
    case "discardCard":
      followup = applyDiscardChoice(room, choice, option, actor);
      break;
    case "faceDownHand":
      followup = applyFaceDownHandChoice(room, choice, option, actor);
      break;
    case "giveHandCard":
      followup = applyGiveHandCardChoice(room, choice, option, actor);
      break;
    case "handLimitDiscard":
      followup = applyHandLimitDiscardChoice(room, choice, option, actor);
      break;
    case "ageRansom":
      followup = applyAgeRansomChoice(room, choice, option, actor);
      break;
    case "publicTrait":
      followup = applyPublicTraitChoice(room, choice, option, actor);
      break;
    case "peekPlay":
      followup = applyPeekPlayChoice(room, choice, option, actor);
      break;
    case "attachHost":
      followup = applyAttachChoice(room, choice, option, actor);
      break;
    case "copyImmediate":
      followup = applyCopyImmediateChoice(room, choice, option, actor);
      break;
    case "targetPlayer":
      followup = applyTargetPlayerChoice(room, choice, option, actor);
      break;
    default:
      throw new Error("That choice type is not implemented.");
  }

  if (followup) {
    queueChoice(room, followup, { finishAfterChoice: choice.finishAfterChoice });
    return;
  }

  const pendingThen = applyThen(room, actor, choice.sourceCard, choice.params, {
    ...(choice.context || {}),
    finishAfterChoice: choice.finishAfterChoice
  });

  if (pendingThen) {
    return;
  }

  if (choice.finishAfterChoice === "actionCleanup") {
    continueAfterActionCleanup(room);
    return;
  }

  if (choice.finishAfterChoice === "skipTurn") {
    endTurn(room);
    return;
  }

  if (choice.finishAfterChoice === "stabilize") {
    completeStabilize(room);
    return;
  }

  if (choice.finishAfterChoice === "ageReveal") {
    beginTurn(room);
    return;
  }

  if (choice.finishAfterChoice === "play") {
    completeAfterPlay(room, actor);
  }
}

function discardCard(room, playerId, cardInstanceId) {
  const player = requireCurrentTurn(room, playerId);
  assertNoPendingChoice(room);

  if (!room.pendingDiscard || room.pendingDiscard.playerId !== playerId) {
    throw new Error("No discard is required right now.");
  }

  const cardIndex = player.hand.findIndex((card) => card.instanceId === cardInstanceId);

  if (cardIndex === -1) {
    throw new Error("That card is not in your hand.");
  }

  const [card] = player.hand.splice(cardIndex, 1);
  addToDiscard(room, card, player.id);
  room.pendingDiscard = null;
  addLog(room, `${player.name} discarded ${card.name}.`, player.id);
  addLog(room, `${player.name} discarded a card.`);
  endTurn(room);
}

function isAdjacentTo(player, card, targetName) {
  const index = player.board.findIndex((candidate) => candidate.instanceId === card.instanceId);

  if (index === -1) {
    return false;
  }

  return [player.board[index - 1], player.board[index + 1]].some((candidate) => candidate?.name === targetName);
}

function adjacentFoodCount(player, card) {
  const index = player.board.findIndex((candidate) => candidate.instanceId === card.instanceId);

  if (index === -1) {
    return 0;
  }

  return [player.board[index - 1], player.board[index + 1]].filter((candidate) => /food|ramen|chow|chicken|boba|kimchi/i.test(candidate?.name || candidate?.text || "")).length;
}

function scoreConditionBonus(room, player, card, params, baseScores) {
  if (params.per === "handCount3") {
    return Math.floor(player.hand.length / 3) * Number(params.amount || 1);
  }

  if (params.per === "ownColorBody2" || params.per === "ownColorGreen2") {
    return Math.floor(colorCount(player, "Green") / 2) * Number(params.amount || 1);
  }

  if (params.per?.startsWith("otherColor")) {
    const color = params.per.replace("otherColor", "");
    return Math.max(0, colorCount(player, color) - 1) * Number(params.amount || 1);
  }

  if (params.cond === "edgeOfPool") {
    const index = player.board.findIndex((candidate) => candidate.instanceId === card.instanceId);
    return index === 0 || index === player.board.length - 1 ? Number(params.amount || 0) : 0;
  }

  if (params.cond === "survivedWipe") {
    return player.flags.survivedWipe ? Number(params.amount || 0) : 0;
  }

  if (params.cond === "isPointLeader") {
    const highest = Math.max(...Object.values(baseScores));
    return baseScores[player.id] === highest ? Number(params.ifTrue || 0) : Number(params.ifFalse || 0);
  }

  if (params.cond === "coinFlip") {
    return Math.random() < 0.5 ? Number(params.ifTrue || 0) : Number(params.ifFalse || 0);
  }

  if (params.cond === "always") {
    return Number(params.amount || 0);
  }

  if (params.cond?.startsWith("adjacentTo:")) {
    return isAdjacentTo(player, card, params.cond.split(":")[1]) ? Number(params.amount || 0) : 0;
  }

  if (params.cond === "adjacentFoodCount") {
    return adjacentFoodCount(player, card) * Number(params.amount || 1);
  }

  if (params.cond === "leaderPenalty") {
    return Number(params.self || 0);
  }

  return 0;
}

function scoreEndEffect(room, player, card, effect, baseScores) {
  if (!effect) {
    return null;
  }

  const params = effect.params || {};

  if (effect.type === "scoreIfCondition") {
    const points = scoreConditionBonus(room, player, card, params, baseScores);
    return points ? { points, text: `${card.name}: ${points > 0 ? "+" : ""}${points}` } : null;
  }

  if (effect.type === "scoreForUniqueColors") {
    let points = 0;

    if (params.countColor) {
      const countColor = normalizeColor(params.countColor);
      points = room.players
        .flatMap((candidate) => candidate.board.map((candidateCard) => ({ player: candidate, card: candidateCard })))
        .filter((entry) => effectiveColor(entry.player, entry.card) === countColor).length;
      points = Math.min(points, Number(params.max || points));
    } else {
      points = uniqueColors(player) * Number(params.perColor || 1);
    }

    return points ? { points, text: `${card.name}: +${points} for color diversity` } : null;
  }

  if (effect.type === "scoreForDiscardPile") {
    const cards = discardCardsFor(room, player.id);
    let points = 0;

    if (params.mode === "uniqueColors") {
      points = new Set(cards.map((candidate) => normalizeColor(candidate.colorOverride || candidate.color))).size;
    } else if (params.mode === "uniqueNames") {
      points = new Set(cards.map((candidate) => candidate.name)).size;
      points = Math.min(points, Number(params.max || points));
    } else {
      points = Math.floor(cards.length / Number(params.div || 1)) * Number(params.perCard || 1);
      points = Math.min(points, Number(params.max || points));
    }

    return points ? { points, text: `${card.name}: +${points} from discard pile` } : null;
  }

  if (effect.type === "scoreForLowPoints") {
    const lowest = Math.min(...Object.values(baseScores));
    const points = baseScores[player.id] === lowest ? Number(params.amount || 0) : 0;
    return points ? { points, text: `${card.name}: +${points} for lowest Trait points` } : null;
  }

  if (effect.type === "scoreForOpponentParasites") {
    const count = room.players.flatMap((candidate) => candidate.board).filter((candidate) => candidate.parasiteOwnerId === player.id).length;
    const points = count * Number(params.perParasite || 1);
    return points ? { points, text: `${card.name}: +${points} for parasites placed` } : null;
  }

  if (effect.type === "scoreForFaceValue") {
    const value = Number(params.value || 0);
    const amount = Number(params.amount || 1);
    const count = player.board.filter((candidate) => Number(candidate.points || 0) === value).length;
    const points = count * amount;
    return points ? { points, text: `${card.name}: +${points} for face-value ${value} Traits` } : null;
  }

  if (effect.type === "scoreForBehindOpponents") {
    const amount = Number(params.amount || 1);
    const count = room.players.filter((candidate) => candidate.id !== player.id && baseScores[candidate.id] > baseScores[player.id]).length;
    const points = count * amount;
    return points ? { points, text: `${card.name}: +${points} for opponents ahead` } : null;
  }

  return null;
}

function worldsEndScore(room, player, baseScores) {
  const effect = room.currentAge?.isFinal ? room.currentAge.effect : null;

  if (effect?.type !== "worldsEndScore") {
    return null;
  }

  const params = effect.params || {};
  let points = 0;
  const labels = [];

  if (params.perColorPenalty) {
    const color = normalizeColor(params.perColorPenalty);
    const penalty = colorCount(player, color) * Number(params.amount || 1);

    if (penalty) {
      points -= penalty;
      labels.push(`-${penalty} for ${color} Traits`);
    }
  }

  if (params.perColorBonus) {
    const color = normalizeColor(params.perColorBonus);
    const bonus = colorCount(player, color) * Number(params.amount || 1);

    if (bonus) {
      points += bonus;
      labels.push(`+${bonus} for ${color} Traits`);
    }
  }

  if (params.mostTraitsPenalty) {
    const maxCount = Math.max(...room.players.map((candidate) => candidate.board.length));

    if (player.board.length === maxCount && maxCount > 0) {
      const penalty = Number(params.mostTraitsPenalty);
      points -= penalty;
      labels.push(`-${penalty} for the largest Trait Row`);
    }
  }

  return points ? { points, text: `World's End: ${labels.join(", ")}` } : null;
}

function finishGame(room) {
  if (!room.players.length) {
    room.phase = "gameOver";
    room.finalScores = [];
    return;
  }

  resolvePoison(room);

  const baseScores = Object.fromEntries(room.players.map((player) => [player.id, boardPoints(player, room)]));
  const scores = room.players.map((player) => {
    const breakdown = [`Trait points: ${baseScores[player.id]}`];
    let bonusTotal = Number(room.lockedBonuses[player.id] || 0);

    if (bonusTotal) {
      breakdown.push(`Age bonuses: +${bonusTotal}`);
    }

    const worldsEnd = worldsEndScore(room, player, baseScores);

    if (worldsEnd) {
      bonusTotal += worldsEnd.points;
      breakdown.push(worldsEnd.text);
    }

    player.board.forEach((card) => {
      [card.endEffect, card.passiveEffect].forEach((effect) => {
        const result = scoreEndEffect(room, player, card, effect, baseScores);

        if (result) {
          bonusTotal += result.points;
          breakdown.push(result.text);
        }
      });
    });

    return {
      playerId: player.id,
      name: player.name,
      baseScore: baseScores[player.id],
      bonusTotal,
      total: baseScores[player.id] + bonusTotal,
      breakdown,
      isWinner: false
    };
  });
  const winningScore = Math.max(...scores.map((score) => score.total));

  scores.forEach((score) => {
    score.isWinner = score.total === winningScore;
  });

  room.phase = "gameOver";
  room.turnState = null;
  room.pendingDiscard = null;
  room.pendingChoice = null;
  room.finalScores = scores;
  addLog(room, `The game ended. ${scores.filter((score) => score.isWinner).map((score) => score.name).join(", ")} won.`);
}

function newGame(room, playerId) {
  requireHost(room, playerId);

  room.phase = "lobby";
  room.traitDeck = [];
  room.discardPile = [];
  room.ageDeck = [];
  room.currentAge = null;
  room.ageIndex = 0;
  room.currentPlayerIndex = 0;
  room.playersActedThisAge = [];
  room.turnOrder = room.players.map((player) => player.id);
  room.turnState = null;
  room.pendingDiscard = null;
  room.pendingChoice = null;
  room.finalScores = null;
  room.lastPlayedTrait = null;
  room.revealedHands = {};
  room.lockedBonuses = {};
  room.nextChoiceId = 1;

  room.players.forEach((player) => {
    player.hand = [];
    player.board = [];
    player.genePoolSize = STARTING_GENE_POOL_SIZE;
    player.skippedTurns = 0;
    player.flags = {};
    player.isHost = player.id === room.hostId;
    player.hasActedThisAge = false;
  });

  addLog(room, `${findPlayer(room, playerId).name} reset the room.`);
}

function removePlayerFromRoom(room, playerId) {
  const index = room.players.findIndex((player) => player.id === playerId);

  if (index === -1) {
    return { deleted: false };
  }

  const [removed] = room.players.splice(index, 1);
  addLog(room, `${removed.name} left the room.`);

  if (!room.players.length) {
    return { deleted: true };
  }

  if (room.hostId === playerId) {
    room.hostId = room.players[0].id;
    addLog(room, `${room.players[0].name} is now host.`);
  }

  room.players.forEach((player) => {
    player.isHost = player.id === room.hostId;
  });

  room.turnOrder = currentTurnOrder(room);

  if (!currentPlayer(room)) {
    setCurrentPlayer(room, room.turnOrder[0]);
  }

  if (room.phase === "playing" && room.players.length < MIN_PLAYERS) {
    finishGame(room);
  }

  return { deleted: false };
}

function sanitizeLog(room, playerId) {
  return room.log
    .filter((entry) => !entry.privateFor || entry.privateFor === playerId)
    .map((entry) => ({
      id: entry.id,
      text: entry.text,
      isPrivate: Boolean(entry.privateFor)
    }));
}

function decorateCard(room, card, boardOwner = null) {
  const owner = card.parasiteOwnerId ? findPlayer(room, card.parasiteOwnerId) : null;
  const dynamic = boardOwner ? dynamicTraitValue(boardOwner, card, room) : null;
  const attachments = cardAttachments(card);
  const attachPoints = boardOwner ? attachmentPoints(boardOwner, card, room) : 0;

  return {
    ...card,
    color: normalizeColor(card.colorOverride || card.color),
    tags: [...(card.keywords || [])].filter(Boolean),
    effectivePoints: cardScoreForHost(card, boardOwner, room) + attachPoints,
    isDynamicValue: dynamic != null,
    isDoubled: Number(card.pointMultiplier || 1) > 1,
    status: card.status || {},
    parasiteOwnerName: owner?.name || null,
    attachments: attachments.map((att) => {
      const attDynamic = boardOwner ? dynamicTraitValue(boardOwner, att, room) : null;
      const attBase = attDynamic != null ? attDynamic : printedPoints(att);
      const bonus = Number(att.attachSpec?.valueBonus || 0);

      return {
        instanceId: att.instanceId,
        name: att.name,
        emoji: att.emoji,
        color: normalizeColor(att.colorOverride || att.color),
        points: printedPoints(att),
        protect: att.attachSpec?.protect || [],
        valueBonus: bonus,
        effectiveValue: attBase + bonus,
        isDynamicValue: attDynamic != null
      };
    })
  };
}

function sanitizePlayer(room, player, viewerId) {
  const isViewer = player.id === viewerId;
  const isRevealed = Boolean(room.revealedHands[player.id]);

  return {
    id: player.id,
    name: player.name,
    isHost: player.isHost,
    hand: isViewer || isRevealed ? player.hand.map((card) => decorateCard(room, card)) : [],
    isHandRevealed: isRevealed,
    handCount: player.hand.length,
    genePoolSize: Number(player.genePoolSize || STARTING_GENE_POOL_SIZE),
    handLimit: handLimitFor(player),
    board: player.board.map((card) => decorateCard(room, card, player)),
    shield: 0,
    hasActedThisAge: player.hasActedThisAge,
    currentBoardPoints: boardPoints(player, room)
  };
}

function decorateChoiceOption(room, choice, option, viewerId) {
  if (choice.type === "faceDownHand") {
    return {
      id: option.id,
      label: "Face-down card"
    };
  }

  if (choice.type === "targetPlayer") {
    return {
      id: option.id,
      label: option.label
    };
  }

  if (choice.type === "discardCard") {
    const card = room.discardPile.find((candidate) => candidate.instanceId === option.cardInstanceId);
    return card
      ? {
          id: option.id,
          card: decorateCard(room, card)
        }
      : null;
  }

  if (choice.type === "giveHandCard") {
    const actor = findPlayer(room, choice.actorId);
    const card = actor?.hand.find((candidate) => candidate.instanceId === option.cardInstanceId);
    return card
      ? {
          id: option.id,
          card: decorateCard(room, card)
        }
      : null;
  }

  if (choice.type === "handLimitDiscard") {
    const actor = findPlayer(room, choice.actorId);
    const card = actor?.hand.find((candidate) => candidate.instanceId === option.cardInstanceId);
    return card
      ? {
          id: option.id,
          card: decorateCard(room, card)
        }
      : null;
  }

  if (choice.type === "peekPlay") {
    const target = findPlayer(room, choice.targetId);
    const card = target?.hand.find((candidate) => candidate.instanceId === option.cardInstanceId);
    return card
      ? {
          id: option.id,
          card: decorateCard(room, card)
        }
      : null;
  }

  if (choice.type === "ageRansom") {
    if (choice.mode === "decide") {
      return { id: option.id, label: option.label || "Choose" };
    }

    const actor = findPlayer(room, choice.actorId);
    const card = actor?.hand.find((candidate) => candidate.instanceId === option.cardInstanceId);
    return card
      ? {
          id: option.id,
          card: decorateCard(room, card)
        }
      : null;
  }

  if (choice.type === "publicTrait" || choice.type === "attachHost" || choice.type === "copyImmediate") {
    const owner = findPlayer(room, option.ownerId);
    const card = owner?.board.find((candidate) => candidate.instanceId === option.cardInstanceId);
    return card
      ? {
          id: option.id,
          ownerId: owner.id,
          ownerName: owner.name,
          card: decorateCard(room, card, owner)
        }
      : null;
  }

  return viewerId === choice.playerId ? { id: option.id, label: option.label || "Choose" } : null;
}

function sanitizePendingChoice(room, viewerId) {
  const choice = room.pendingChoice;

  if (!choice) {
    return null;
  }

  const actor = findPlayer(room, choice.actorId);
  const isChooser = choice.playerId === viewerId;
  const isTarget = choice.targetId === viewerId;

  return {
    id: choice.id,
    type: choice.type,
    mode: choice.mode,
    prompt: choice.prompt,
    sourceCardName: choice.sourceCard?.name || "Effect",
    sourceCard: choice.sourceCard ? decorateCard(room, choice.sourceCard) : null,
    actorId: choice.actorId,
    actorName: actor?.name || "",
    targetId: choice.targetId || null,
    targetName: choice.targetName || "",
    isChooser,
    isTarget,
    choices: isChooser
      ? choice.choices.map((option) => decorateChoiceOption(room, choice, option, viewerId)).filter(Boolean)
      : []
  };
}

function sanitizeRoomForPlayer(room, playerId) {
  const viewer = findPlayer(room, playerId);
  const current = currentPlayer(room);

  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    youPlayerId: playerId,
    isHost: room.hostId === playerId,
    canStartGame: room.hostId === playerId && room.phase === "lobby" && room.players.length >= MIN_PLAYERS,
    players: room.players.map((player) => sanitizePlayer(room, player, playerId)),
    log: sanitizeLog(room, playerId),
    currentAge: room.currentAge,
    ageRules: room.currentAge?.rules || null,
    nextAgePreview: room.currentAge?.rules?.previewNextAge ? room.ageDeck[room.ageIndex] || null : null,
    ageIndex: room.ageIndex,
    ageDeckCount: room.ageDeck.length,
    currentPlayerId: current?.id || null,
    currentPlayerName: current?.name || "",
    isYourTurn: room.phase === "playing" && current?.id === playerId,
    drawPileCount: room.traitDeck.length,
    discardPileCount: room.discardPile.length,
    discardPile: room.discardPile.slice(-20).reverse().map((card) => decorateCard(room, card)),
    pendingDiscard: room.pendingDiscard?.playerId === playerId ? room.pendingDiscard : null,
    pendingChoice: sanitizePendingChoice(room, playerId),
    turnState: room.turnState,
    tiebreakRoll: room.tiebreakRoll || null,
    finalScores: room.finalScores,
    lastPlayedTrait: room.lastPlayedTrait?.card
      ? {
          seq: room.lastPlayedSeq || 0,
          playerId: room.lastPlayedTrait.playerId,
          playerName: findPlayer(room, room.lastPlayedTrait.playerId)?.name || "",
          isYou: room.lastPlayedTrait.playerId === playerId,
          card: decorateCard(room, room.lastPlayedTrait.card, findPlayer(room, room.lastPlayedTrait.playerId))
        }
      : null,
    connected: Boolean(viewer)
  };
}

module.exports = {
  createRoom,
  discardCard,
  joinRoom,
  newGame,
  passLate,
  playCard,
  removePlayerFromRoom,
  resolveChoice,
  sanitizeRoomForPlayer,
  skipTurn,
  startGame
};
