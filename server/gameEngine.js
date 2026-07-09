const { AGE_CARDS, TRAIT_CARDS } = require("./cards");

const STARTING_HAND_SIZE = 5;
const BASE_HAND_LIMIT = 5;
const MAX_TRAIT_PLAYS_PER_TURN = 3;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

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

function createCardInstance(card, copyIndex = 0) {
  return {
    ...clone(card),
    keywords: [...(card.keywords || [])],
    pointMultiplier: 1,
    status: {},
    ownerId: null,
    originalOwnerId: null,
    parasiteOwnerId: null,
    parasiteValue: null,
    token: false,
    instanceId: `${card.id}-${copyIndex}-${Math.random().toString(36).slice(2, 9)}`
  };
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
  const normalAges = AGE_CARDS.filter((age) => !age.isFinal);
  const totalAges = playerCount <= 3 ? 6 : playerCount === 4 ? 7 : 8;
  const chosen = shuffle(normalAges).slice(0, Math.max(1, totalAges - 1));
  const finalAge = shuffle(finalAges)[0] || normalAges[0];

  return [...chosen, finalAge].map((age, index, ages) => ({
    ...clone(age),
    number: index + 1,
    total: ages.length
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
    finalScores: null,
    log: [],
    nextLogId: 1,
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

function cardScoreForHost(card) {
  if (card.parasiteOwnerId) {
    return Number(card.parasiteValue ?? card.points ?? -1);
  }

  return printedPoints(card);
}

function boardPoints(player) {
  return player.board.reduce((total, card) => total + cardScoreForHost(card), 0);
}

function handLimitFor(player) {
  return (
    BASE_HAND_LIMIT +
    player.board.reduce((total, card) => {
      if (card.passiveEffect?.type !== "handLimitMod") {
        return total;
      }

      return total + Number(card.passiveEffect.params?.amount || 0);
    }, 0)
  );
}

function addToDiscard(room, card, discardedById = null) {
  const nextCard = {
    ...card,
    status: {},
    discardedById,
    parasiteOwnerId: null,
    parasiteValue: null
  };

  room.discardPile.push(nextCard);
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
  const targetSize = Math.min(STARTING_HAND_SIZE, handLimitFor(player));
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

function autoDiscardToLimit(room, player) {
  const limit = handLimitFor(player);

  while (player.hand.length > limit) {
    const card = discardCardFromHand(room, player);
    addLog(room, `${player.name} discarded ${card.name} down to the hand limit.`, player.id);
    addLog(room, `${player.name} discarded down to the hand limit.`);
  }
}

function resolveCount(room, player, value, fallback = 1) {
  if (typeof value === "number") {
    return value;
  }

  if (value === "toHand6") {
    return Math.max(0, 6 - player.hand.length);
  }

  if (value === "socialCount2") {
    return Math.floor(colorCount(player, "Social") / 2);
  }

  if (value === "bodyCount") {
    return colorCount(player, "Body");
  }

  return fallback;
}

function colorCount(player, color) {
  return player.board.filter((card) => effectiveColor(player, card) === color).length;
}

function uniqueColors(player) {
  return new Set(player.board.map((card) => effectiveColor(player, card))).size;
}

function effectiveColor(player, card) {
  if (card.colorOverride) {
    return card.colorOverride;
  }

  if (card.passiveEffect?.type === "copyTrait" && card.passiveEffect.params?.aspect === "colorOfLeftNeighbor") {
    const index = player.board.findIndex((candidate) => candidate.instanceId === card.instanceId);
    const left = index > 0 ? player.board[index - 1] : null;

    if (left) {
      return effectiveColor(player, left);
    }
  }

  return card.color || "Weird";
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
      return bestPlayers(opponents, (player) => player.hand.length, "desc");
    case "opponentHighestGenePoolPoints":
      return bestPlayers(opponents, boardPoints, "desc");
    case "opponentLowestGenePoolPoints":
      return bestPlayers(opponents, boardPoints, "asc");
    case "opponentLargestDiscard":
      return bestPlayers(opponents, (player) => discardCardsFor(room, player.id).length, "desc");
    case "opponentSmallestPool":
      return bestPlayers(opponents, (player) => player.board.length, "asc");
    case "anyPlayer":
      return players.filter((player) => player.board.length);
    default:
      return opponents.length ? [opponents[0]] : [];
  }
}

function bestPlayers(players, scorer, direction = "desc") {
  if (!players.length) {
    return [];
  }

  const sorted = [...players].sort((a, b) => {
    const diff = scorer(a) - scorer(b);
    return direction === "asc" ? diff : -diff;
  });

  return [sorted[0]];
}

function nonDominantBoardEntries(room, players, allowDominant = false) {
  return players.flatMap((player) =>
    player.board
      .map((card, index) => ({ player, card, index }))
      .filter((entry) => allowDominant || !isDominant(entry.card))
  );
}

function selectTraitEntry(room, players, fallback = "lowestPointNonDominantTrait", options = {}) {
  const entries = nonDominantBoardEntries(room, players, Boolean(options.allowDominant));

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

function removeBoardEntry(room, entry, reason = "destroyed") {
  if (!entry) {
    return null;
  }

  const [card] = entry.player.board.splice(entry.index, 1);

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

function selectDiscardCard(room, actor, params = {}) {
  const owner = params.owner || params.fromOwner || "self";
  let cards = room.discardPile.map((card, index) => ({ card, index }));

  if (owner === "self") {
    cards = cards.filter(({ card }) => (card.ownerId || card.originalOwnerId || card.discardedById) === actor.id);
  } else if (owner === "opponent") {
    cards = cards.filter(({ card }) => (card.ownerId || card.originalOwnerId || card.discardedById) !== actor.id);
  }

  if (!cards.length) {
    return null;
  }

  return cards[cards.length - 1];
}

function reviveOrPlayDiscard(room, actor, sourceCard, params = {}, mode = "revive") {
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
  if (!entry || isPoisonImmune(entry.card)) {
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

        if (!condition || (condition === "emptyHand" && player.hand.length === 0)) {
          const count = resolveCount(room, player, card.passiveEffect.params?.count, 1);
          drawCard(room, player, count);
          addLog(room, `${card.name} drew ${count} card${count === 1 ? "" : "s"} for ${player.name}.`, player.id);
        }
      }
    });

    autoDiscardToLimit(room, player);
  });

  room.revealedHands = {};
}

function applyThen(room, actor, sourceCard, params, context) {
  if (params?.then) {
    applyEffect(room, actor, params.then, sourceCard, context);
  }
}

function applyEffect(room, actor, effect, sourceCard = { name: "Effect" }, context = {}) {
  if (!effect || !actor) {
    return;
  }

  const params = effect.params || {};

  switch (effect.type) {
    case "draw": {
      const targets = targetPlayers(room, actor, params.target || "self");

      targets.forEach((target) => {
        const count = Math.min(resolveCount(room, target, params.count, 1), params.max || 99);
        const drawn = drawCard(room, target, count);
        addLog(room, `${target.name} drew ${drawn} card${drawn === 1 ? "" : "s"}.`, target.id);
      });
      break;
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

      applyThen(room, actor, sourceCard, params, context);
      break;
    }

    case "discardRandomOpponent": {
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

      applyThen(room, actor, sourceCard, params, context);
      break;
    }

    case "stealRandom": {
      const targets = targetPlayers(room, actor, params.target || "nextOpponent");

      targets.forEach((target) => {
        if (params.zone === "pool") {
          const entry = selectTraitEntry(room, [target], "randomNonDominantTrait");

          if (!entry) {
            return;
          }

          const [stolen] = target.board.splice(entry.index, 1);
          stolen.ownerId = actor.id;
          actor.board.push(stolen);
          addLog(room, `${actor.name} stole ${stolen.name} from ${target.name}'s Gene Pool.`);
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

      applyThen(room, actor, sourceCard, params, context);
      break;
    }

    case "stealChosenPublicTrait": {
      const target = targetPlayers(room, actor, params.target || "opponentHighestGenePoolPoints")[0];
      const entry = target ? selectTraitEntry(room, [target], params.fallback || "highestPointNonDominantTrait") : null;

      if (entry) {
        const [stolen] = entry.player.board.splice(entry.index, 1);
        stolen.ownerId = actor.id;
        actor.board.push(stolen);
        addLog(room, `${actor.name} stole ${stolen.name} from ${entry.player.name}'s Gene Pool.`);
      }
      break;
    }

    case "destroyOpponentTrait": {
      const target = targetPlayers(room, actor, params.target || "nextOpponent")[0];
      const entry = target ? selectTraitEntry(room, [target], params.fallback || "lowestPointNonDominantTrait") : null;
      removeBoardEntry(room, entry, "destroyed");
      break;
    }

    case "destroyOwnTrait": {
      const entry = selectTraitEntry(room, [actor], params.fallback || "lowestPointNonDominantTrait");
      removeBoardEntry(room, entry, "destroyed");
      applyThen(room, actor, sourceCard, params, context);
      break;
    }

    case "poison":
    case "delayedPoison": {
      const target = targetPlayers(room, actor, params.target || "nextOpponent")[0] || actor;
      const entry = selectTraitEntry(room, [target], params.fallback || "randomNonDominantTrait");
      poisonTrait(room, entry, effect.type === "delayedPoison" ? Number(params.turns || 2) : 1);
      applyThen(room, actor, sourceCard, params, context);
      break;
    }

    case "playExtra": {
      if (room.turnState) {
        const count = resolveCount(room, actor, params.count, 1);
        room.turnState.playsRemaining = Math.min(room.turnState.playsRemaining + count, MAX_TRAIT_PLAYS_PER_TURN);
        addLog(room, `${actor.name} may play ${count} extra Trait${count === 1 ? "" : "s"} this turn.`);
      }
      break;
    }

    case "reviveFromDiscard":
      reviveOrPlayDiscard(room, actor, sourceCard, params, "revived");
      applyThen(room, actor, sourceCard, params, context);
      break;

    case "playFromDiscard":
      reviveOrPlayDiscard(room, actor, sourceCard, params, "play");
      break;

    case "revealHandFullText": {
      targetPlayers(room, actor, params.target || "nextOpponent").forEach((target) => revealHand(room, actor, sourceCard, target));
      applyThen(room, actor, sourceCard, params, context);
      break;
    }

    case "reverseTurnOrder":
      room.turnOrder = currentTurnOrder(room).reverse();
      addLog(room, `${sourceCard.name} reversed turn order.`);
      applyThen(room, actor, sourceCard, params, context);
      break;

    case "skipNextPlayer": {
      targetPlayers(room, actor, params.target || "nextOpponent").forEach((target) => {
        target.hasActedThisAge = true;
        addLog(room, `${sourceCard.name} skipped ${target.name}'s next action this Age.`);
      });
      applyThen(room, actor, sourceCard, params, context);
      break;
    }

    case "swapHands": {
      const targets = targetPlayers(room, actor, params.target || "nextOpponent");

      if (params.mode === "rotate" || params.mode === "rotateLeft1" || params.target === "allPlayers") {
        const players = orderedPlayers(room);
        const hands = players.map((player) => player.hand);
        players.forEach((player, index) => {
          player.hand = hands[(index + 1) % hands.length] || [];
        });
        addLog(room, `${sourceCard.name} rotated everyone's hand.`);
      } else if (targets[0]) {
        [actor.hand, targets[0].hand] = [targets[0].hand, actor.hand];
        addLog(room, `${actor.name} swapped hands with ${targets[0].name}.`);
      }
      break;
    }

    case "copyImmediate": {
      if (context.copyDepth) {
        break;
      }

      const copySource = context.previousTrait || room.lastPlayedTrait?.card;

      if (copySource?.immediateEffect && copySource.instanceId !== sourceCard.instanceId) {
        addLog(room, `${sourceCard.name} copied ${copySource.name}.`);
        applyEffect(room, actor, copySource.immediateEffect, copySource, { copyDepth: 1 });
      }
      break;
    }

    case "copyTrait": {
      if (params.aspect === "recolorRandomAll") {
        const colors = ["Body", "Predatory", "Social", "Weird"];
        room.players.forEach((player) => {
          player.board.forEach((card) => {
            if (!isDominant(card)) {
              card.colorOverride = colors[Math.floor(Math.random() * colors.length)];
            }
          });
        });
        addLog(room, `${sourceCard.name} randomized Trait colors.`);
      } else if (params.aspect === "recolorAll") {
        room.players.forEach((player) => {
          player.board.forEach((card) => {
            if (!isDominant(card)) {
              card.colorOverride = params.to || "Weird";
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
          addLog(room, `${actor.name} copied ${entry.card.name} into their Gene Pool.`);
        }
      }
      break;
    }

    default:
      addLog(room, `${sourceCard.name} has an effect that is not implemented yet.`);
      break;
  }
}

function placeParasiteCard(room, actor, card) {
  const params = card.immediateEffect?.params || {};
  const target = targetPlayers(room, actor, params.target || "opponentHighestGenePoolPoints")[0];

  if (!target) {
    actor.board.push(card);
    addLog(room, `${actor.name} played ${card.name}.`);
    return;
  }

  card.ownerId = actor.id;
  card.originalOwnerId ||= actor.id;
  card.parasiteOwnerId = actor.id;
  card.parasiteValue = Number(params.value ?? card.points ?? -1);
  target.board.push(card);
  addLog(room, `${actor.name} placed ${card.name} into ${target.name}'s Gene Pool.`);
}

function applyAgeEffect(room) {
  const age = room.currentAge;
  const effect = age?.effect;

  if (!effect) {
    return;
  }

  const params = effect.params || {};
  addLog(room, `Age revealed: ${age.name}. ${age.text}`);

  switch (effect.type) {
    case "draw":
      room.players.forEach((player) => {
        if (params.condition === "ownBody2" && colorCount(player, "Body") < 2) {
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
        player.flags.extraPlayThisAge = Math.min(1 + Number(params.count || 1), MAX_TRAIT_PLAYS_PER_TURN - 1);
      });
      addLog(room, "Everyone gets an extra play this Age.");
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
}

function revealAge(room) {
  room.currentAge = room.ageDeck[room.ageIndex] || null;
  room.ageIndex += 1;
  room.playersActedThisAge = [];
  room.revealedHands = {};
  room.players.forEach((player) => {
    player.hasActedThisAge = false;
    player.flags.extraPlayThisAge ||= 0;
  });

  if (!room.currentAge) {
    finishGame(room);
    return;
  }

  setCurrentPlayer(room, currentTurnOrder(room)[0]);
  applyAgeEffect(room);
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
  player.flags.extraPlayThisAge = 0;
  room.turnState = {
    primaryActionTaken: false,
    playsTaken: 0,
    playsRemaining: Math.min(1 + extra, MAX_TRAIT_PLAYS_PER_TURN)
  };
  room.pendingDiscard = null;
  addLog(room, `${player.name}'s turn.`);
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

    if (room.currentAge?.isFinal) {
      finishGame(room);
    } else {
      revealAge(room);
    }
    return;
  }

  setCurrentPlayer(room, next.id);
  beginTurn(room);
}

function joinRoom(room, playerId, playerName) {
  if (room.phase !== "lobby") {
    throw new Error("That game has already started.");
  }

  if (room.players.length >= MAX_PLAYERS) {
    throw new Error("That room is full.");
  }

  if (findPlayer(room, playerId)) {
    throw new Error("You are already in this room.");
  }

  const player = createPlayer(playerId, playerName);
  room.players.push(player);
  room.turnOrder = room.players.map((candidate) => candidate.id);
  addLog(room, `${player.name} joined the room.`);
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
  room.finalScores = null;
  room.lastPlayedTrait = null;
  room.revealedHands = {};
  room.lockedBonuses = {};

  room.players.forEach((player) => {
    player.hand = [];
    player.board = [];
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

function playCard(room, playerId, cardInstanceId) {
  const player = requireCurrentTurn(room, playerId);

  if (!room.turnState || room.turnState.playsRemaining <= 0) {
    throw new Error("You cannot play another Trait this turn.");
  }

  const cardIndex = player.hand.findIndex((card) => card.instanceId === cardInstanceId);

  if (cardIndex === -1) {
    throw new Error("That card is not in your hand.");
  }

  const [card] = player.hand.splice(cardIndex, 1);
  const previousTrait = room.lastPlayedTrait?.card || null;
  card.ownerId = player.id;
  card.originalOwnerId ||= player.id;

  if (isParasite(card)) {
    placeParasiteCard(room, player, card);
  } else {
    player.board.push(card);
    addLog(room, `${player.name} played ${card.name}.`);
    applyEffect(room, player, card.immediateEffect, card, { previousTrait });
  }

  room.lastPlayedTrait = { card, playerId: player.id };
  room.turnState.primaryActionTaken = true;
  room.turnState.playsTaken += 1;
  room.turnState.playsRemaining -= 1;

  if (!player.flags.noDrawThisAge) {
    const drawn = drawToHandSize(room, player);

    if (drawn) {
      addLog(room, `${player.name} drew back up toward ${STARTING_HAND_SIZE}.`, player.id);
    }
  }

  autoDiscardToLimit(room, player);

  if (room.turnState.playsRemaining <= 0) {
    endTurn(room);
  }
}

function skipTurn(room, playerId) {
  const player = requireCurrentTurn(room, playerId);

  if (room.turnState?.primaryActionTaken) {
    throw new Error("You already took an action this turn.");
  }

  const drawn = drawCard(room, player, 2);
  player.skippedTurns += 1;
  room.turnState.primaryActionTaken = true;
  room.turnState.playsTaken = MAX_TRAIT_PLAYS_PER_TURN;
  room.turnState.playsRemaining = 0;
  addLog(room, `${player.name} skipped and drew ${drawn} card${drawn === 1 ? "" : "s"}.`, player.id);
  addLog(room, `${player.name} skipped their play.`);
  autoDiscardToLimit(room, player);
  endTurn(room);
}

function discardCard(room, playerId, cardInstanceId) {
  const player = requireCurrentTurn(room, playerId);

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

  if (params.per === "ownColorBody2") {
    return Math.floor(colorCount(player, "Body") / 2) * Number(params.amount || 1);
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
      points = room.players.flatMap((candidate) => candidate.board).filter((candidate) => candidate.color === params.countColor).length;
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
      points = new Set(cards.map((candidate) => candidate.color)).size;
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
    return points ? { points, text: `${card.name}: +${points} for lowest Gene Pool points` } : null;
  }

  if (effect.type === "scoreForOpponentParasites") {
    const count = room.players.flatMap((candidate) => candidate.board).filter((candidate) => candidate.parasiteOwnerId === player.id).length;
    const points = count * Number(params.perParasite || 1);
    return points ? { points, text: `${card.name}: +${points} for parasites placed` } : null;
  }

  return null;
}

function finishGame(room) {
  if (!room.players.length) {
    room.phase = "gameOver";
    room.finalScores = [];
    return;
  }

  resolvePoison(room);

  const baseScores = Object.fromEntries(room.players.map((player) => [player.id, boardPoints(player)]));
  const scores = room.players.map((player) => {
    const breakdown = [`Gene Pool: ${baseScores[player.id]}`];
    let bonusTotal = Number(room.lockedBonuses[player.id] || 0);

    if (bonusTotal) {
      breakdown.push(`Age bonuses: +${bonusTotal}`);
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
  room.finalScores = null;
  room.lastPlayedTrait = null;
  room.revealedHands = {};
  room.lockedBonuses = {};

  room.players.forEach((player) => {
    player.hand = [];
    player.board = [];
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

function decorateCard(room, card) {
  const owner = card.parasiteOwnerId ? findPlayer(room, card.parasiteOwnerId) : null;

  return {
    ...card,
    color: card.colorOverride || card.color,
    tags: [card.colorOverride || card.color, ...(card.keywords || [])].filter(Boolean),
    effectivePoints: cardScoreForHost(card),
    isDoubled: Number(card.pointMultiplier || 1) > 1,
    status: card.status || {},
    parasiteOwnerName: owner?.name || null
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
    board: player.board.map((card) => decorateCard(room, card)),
    shield: 0,
    hasActedThisAge: player.hasActedThisAge,
    currentBoardPoints: boardPoints(player)
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
    ageIndex: room.ageIndex,
    ageDeckCount: room.ageDeck.length,
    currentPlayerId: current?.id || null,
    currentPlayerName: current?.name || "",
    isYourTurn: room.phase === "playing" && current?.id === playerId,
    drawPileCount: room.traitDeck.length,
    discardPileCount: room.discardPile.length,
    discardPile: room.discardPile.slice(-20).reverse().map((card) => decorateCard(room, card)),
    pendingDiscard: room.pendingDiscard?.playerId === playerId ? room.pendingDiscard : null,
    turnState: room.turnState,
    finalScores: room.finalScores,
    connected: Boolean(viewer)
  };
}

module.exports = {
  createRoom,
  discardCard,
  joinRoom,
  newGame,
  playCard,
  removePlayerFromRoom,
  sanitizeRoomForPlayer,
  skipTurn,
  startGame
};
