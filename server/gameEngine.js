const { AGE_CARDS, TRAIT_CARDS } = require("./cards");

const HAND_SIZE = 5;
const HAND_LIMIT = 8;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
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

function createTraitDeck() {
  const deck = [];

  TRAIT_CARDS.forEach((card) => {
    for (let copyIndex = 0; copyIndex < card.quantity; copyIndex += 1) {
      deck.push({
        ...card,
        tags: [...card.tags],
        immediateEffect: clone(card.immediateEffect),
        endEffect: clone(card.endEffect),
        passiveEffect: clone(card.passiveEffect),
        pointMultiplier: 1,
        instanceId: `${card.id}-${copyIndex}-${Math.random().toString(36).slice(2, 9)}`
      });
    }
  });

  return shuffle(deck);
}

function addLog(room, text, privateFor = null) {
  room.log.push({
    id: room.nextLogId,
    text,
    privateFor
  });
  room.nextLogId += 1;

  if (room.log.length > 100) {
    room.log = room.log.slice(-100);
  }
}

function createPlayer(id, name, isHost = false) {
  return {
    id,
    name: cleanName(name),
    hand: [],
    board: [],
    skippedTurns: 0,
    shield: 0,
    extraPlays: 0,
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
    ageDeck: AGE_CARDS.map((age) => ({ ...age, effect: clone(age.effect) })),
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
    doubleNextTraitAvailable: false,
    lastPlayedTrait: null
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

function setCurrentPlayer(room, playerId) {
  const index = room.players.findIndex((player) => player.id === playerId);
  room.currentPlayerIndex = index === -1 ? 0 : index;
}

function printedPoints(card) {
  return Number(card.points || 0) * Number(card.pointMultiplier || 1);
}

function decorateCard(card) {
  return {
    ...card,
    effectivePoints: printedPoints(card),
    isDoubled: Number(card.pointMultiplier || 1) > 1
  };
}

function boardPoints(player) {
  return player.board.reduce((total, card) => total + printedPoints(card), 0);
}

function drawCard(room, player, count = 1) {
  let drawn = 0;

  while (drawn < count) {
    if (!room.traitDeck.length) {
      room.traitDeck = shuffle(room.discardPile);
      room.discardPile = [];
    }

    if (!room.traitDeck.length) {
      break;
    }

    player.hand.push(room.traitDeck.pop());
    drawn += 1;
  }

  return drawn;
}

function discardRandomCard(room, player) {
  if (!player.hand.length) {
    return null;
  }

  const cardIndex = Math.floor(Math.random() * player.hand.length);
  const [card] = player.hand.splice(cardIndex, 1);
  room.discardPile.push(card);
  return card;
}

function spendShield(player) {
  if (player.shield <= 0) {
    return false;
  }

  player.shield -= 1;
  return true;
}

function blockWithShield(room, player, reason) {
  if (!spendShield(player)) {
    return false;
  }

  addLog(room, `${player.name} spent 1 shield to block ${reason}.`);
  return true;
}

function lowestBoardCardIndex(player) {
  if (!player.board.length) {
    return -1;
  }

  let lowestIndex = 0;
  let lowestPoints = printedPoints(player.board[0]);

  player.board.forEach((card, index) => {
    const points = printedPoints(card);

    if (points < lowestPoints) {
      lowestPoints = points;
      lowestIndex = index;
    }
  });

  return lowestIndex;
}

function removeBoardCardAt(room, player, cardIndex) {
  if (cardIndex < 0) {
    return null;
  }

  const [card] = player.board.splice(cardIndex, 1);

  if (card) {
    room.discardPile.push(card);
  }

  return card || null;
}

function nextOpponent(room, playerId, predicate = () => true) {
  const order = currentTurnOrder(room);
  const startIndex = Math.max(0, order.indexOf(playerId));

  for (let offset = 1; offset <= order.length; offset += 1) {
    const candidate = findPlayer(room, order[(startIndex + offset) % order.length]);

    if (candidate && candidate.id !== playerId && predicate(candidate)) {
      return candidate;
    }
  }

  return null;
}

function orderedPlayers(room) {
  return currentTurnOrder(room).map((id) => findPlayer(room, id)).filter(Boolean);
}

function autoDiscardToLimit(room, player) {
  while (player.hand.length > HAND_LIMIT) {
    const card = discardRandomCard(room, player);
    addLog(room, `${player.name} discarded ${card.name} down to the hand limit.`, player.id);
    addLog(room, `${player.name} discarded down to the hand limit.`);
  }
}

function drawAndLog(room, player, amount, sourceText = "drew") {
  const drawn = drawCard(room, player, amount);
  addLog(room, `${player.name} ${sourceText} ${drawn} card${drawn === 1 ? "" : "s"}.`, player.id);
  return drawn;
}

function revealAge(room) {
  room.currentAge = room.ageDeck[room.ageIndex] || null;
  room.ageIndex += 1;
  room.doubleNextTraitAvailable = false;
  room.playersActedThisAge = [];
  room.players.forEach((player) => {
    player.hasActedThisAge = false;
  });

  if (!room.currentAge) {
    finishGame(room);
    return;
  }

  room.turnOrder = room.players.map((player) => player.id);

  if (room.currentAge.effect?.type === "reverseTurnOrder") {
    room.turnOrder.reverse();
  }

  setCurrentPlayer(room, room.turnOrder[0]);
  addLog(room, `Age revealed: ${room.currentAge.name}. ${room.currentAge.text}`);
  applyAgeEffect(room);
  beginTurn(room);
}

function applyAgeEffect(room) {
  const effect = room.currentAge?.effect || { type: "none" };

  switch (effect.type) {
    case "everyoneDraws":
      room.players.forEach((player) => {
        drawAndLog(room, player, effect.amount || 1);
        autoDiscardToLimit(room, player);
      });
      addLog(room, `Everyone drew ${effect.amount || 1} card${(effect.amount || 1) === 1 ? "" : "s"}.`);
      break;

    case "lowestScoreDraws": {
      const target = orderedPlayers(room).reduce((lowest, player) => {
        if (!lowest) {
          return player;
        }

        return boardPoints(player) < boardPoints(lowest) ? player : lowest;
      }, null);

      if (target) {
        drawAndLog(room, target, effect.amount || 1);
        autoDiscardToLimit(room, target);
        addLog(room, `${target.name} had the smallest board and drew cards.`);
      }
      break;
    }

    case "highestScoreDiscardsRandom": {
      const target = orderedPlayers(room).reduce((highest, player) => {
        if (!highest) {
          return player;
        }

        return boardPoints(player) > boardPoints(highest) ? player : highest;
      }, null);

      if (target?.hand.length) {
        if (blockWithShield(room, target, "a random discard")) {
          break;
        }

        const discarded = discardRandomCard(room, target);
        addLog(room, `${target.name} discarded ${discarded.name}.`, target.id);
        addLog(room, `${target.name} had the highest board and discarded a card.`);
      }
      break;
    }

    case "shieldStorm":
      room.players.forEach((player) => {
        player.shield += effect.amount || 1;
      });
      addLog(room, `Everyone gained ${effect.amount || 1} shield.`);
      break;

    case "reverseTurnOrder":
      addLog(room, "Turn order is reversed for this Age.");
      break;

    case "allPlayersDiscardRandom":
      room.players.forEach((player) => {
        if (!player.hand.length) {
          return;
        }

        if (effect.shieldable && blockWithShield(room, player, "a random discard")) {
          return;
        }

        const discarded = discardRandomCard(room, player);
        addLog(room, `${player.name} discarded ${discarded.name}.`, player.id);
        addLog(room, `${player.name} discarded a random card.`);
      });
      break;

    case "doubleNextTraitPointsThisAge":
      room.doubleNextTraitAvailable = true;
      addLog(room, "The next Trait played this Age will have double printed points.");
      break;

    case "destroyLowestPointTrait":
      room.players.forEach((player) => {
        const cardIndex = lowestBoardCardIndex(player);

        if (cardIndex === -1) {
          return;
        }

        if (effect.shieldable && blockWithShield(room, player, "trait destruction")) {
          return;
        }

        const destroyed = removeBoardCardAt(room, player, cardIndex);
        addLog(room, `${player.name} lost ${destroyed.name}.`);
      });
      break;

    case "finalScoring":
    case "none":
    default:
      break;
  }
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

  room.turnState = {
    primaryActionTaken: false,
    playsRemaining: 1
  };
  room.pendingDiscard = null;

  drawAndLog(room, player, 1, "drew to start their turn");
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
  room.ageDeck = AGE_CARDS.map((age) => ({ ...age, effect: clone(age.effect) }));
  room.currentAge = null;
  room.ageIndex = 0;
  room.currentPlayerIndex = 0;
  room.turnOrder = room.players.map((player) => player.id);
  room.playersActedThisAge = [];
  room.turnState = null;
  room.pendingDiscard = null;
  room.finalScores = null;
  room.doubleNextTraitAvailable = false;
  room.lastPlayedTrait = null;

  room.players.forEach((player) => {
    player.hand = [];
    player.board = [];
    player.skippedTurns = 0;
    player.shield = 0;
    player.extraPlays = 0;
    player.flags = {};
    player.hasActedThisAge = false;
    drawCard(room, player, HAND_SIZE);
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

function applyImmediateEffect(room, player, effect, sourceCard, context = {}) {
  const activeEffect = effect || { type: "none" };

  switch (activeEffect.type) {
    case "draw":
      drawAndLog(room, player, activeEffect.amount || 1);
      break;

    case "discardRandomOpponent": {
      const target = nextOpponent(room, player.id, (candidate) => candidate.hand.length > 0);

      if (!target) {
        break;
      }

      if (blockWithShield(room, target, `${sourceCard.name}'s discard`)) {
        break;
      }

      const discarded = discardRandomCard(room, target);
      addLog(room, `${sourceCard.name} made ${target.name} discard ${discarded.name}.`, target.id);
      addLog(room, `${player.name}'s ${sourceCard.name} made ${target.name} discard a card.`);
      break;
    }

    case "stealRandom": {
      const target = nextOpponent(room, player.id, (candidate) => candidate.hand.length > 0);

      if (!target) {
        break;
      }

      const cardIndex = Math.floor(Math.random() * target.hand.length);
      const [stolen] = target.hand.splice(cardIndex, 1);
      player.hand.push(stolen);
      addLog(room, `${player.name} stole ${stolen.name} from ${target.name}.`, player.id);
      addLog(room, `${player.name} stole ${stolen.name} from you.`, target.id);
      addLog(room, `${player.name} stole a random card from ${target.name}.`);
      break;
    }

    case "gainShield":
      player.shield += activeEffect.amount || 1;
      addLog(room, `${player.name} gained ${activeEffect.amount || 1} shield.`);
      break;

    case "playExtra":
      room.turnState.playsRemaining += activeEffect.amount || 1;
      addLog(room, `${player.name} can play ${activeEffect.amount || 1} extra Trait this turn.`);
      break;

    case "copyLastPlayed":
      if (context.previousTrait?.immediateEffect) {
        applyImmediateEffect(room, player, context.previousTrait.immediateEffect, context.previousTrait, {
          previousTrait: null
        });
      }
      break;

    case "destroyOwnForDraw": {
      const cardIndex = lowestBoardCardIndex(player);
      const destroyed = removeBoardCardAt(room, player, cardIndex);

      if (destroyed) {
        addLog(room, `${player.name} destroyed their own ${destroyed.name}.`);
      }

      drawAndLog(room, player, activeEffect.amount || 1);
      break;
    }

    case "destroyOpponentTrait": {
      const target = nextOpponent(room, player.id, (candidate) => candidate.board.length > 0);

      if (!target) {
        break;
      }

      if (blockWithShield(room, target, `${sourceCard.name}'s destruction`)) {
        break;
      }

      const destroyed = removeBoardCardAt(room, target, lowestBoardCardIndex(target));
      addLog(room, `${player.name}'s ${sourceCard.name} destroyed ${target.name}'s ${destroyed.name}.`);
      break;
    }

    case "swapHands": {
      const target = nextOpponent(room, player.id);

      if (!target) {
        break;
      }

      [player.hand, target.hand] = [target.hand, player.hand];
      addLog(room, `${player.name} swapped hands with ${target.name}.`);
      break;
    }

    case "everyoneDraws":
      room.players.forEach((candidate) => {
        drawAndLog(room, candidate, activeEffect.amount || 1);
        autoDiscardToLimit(room, candidate);
      });
      addLog(room, `Everyone drew ${activeEffect.amount || 1} card${(activeEffect.amount || 1) === 1 ? "" : "s"}.`);
      break;

    case "rummage":
      drawAndLog(room, player, activeEffect.draw || 1);

      for (let count = 0; count < (activeEffect.discard || 1); count += 1) {
        const discarded = discardRandomCard(room, player);

        if (discarded) {
          addLog(room, `${player.name} rummaged away ${discarded.name}.`, player.id);
          addLog(room, `${player.name} rummaged away a card.`);
        }
      }
      break;

    case "reviveFromDiscard": {
      if (!room.discardPile.length) {
        break;
      }

      const cardIndex = Math.floor(Math.random() * room.discardPile.length);
      const [revived] = room.discardPile.splice(cardIndex, 1);
      player.hand.push(revived);
      addLog(room, `${player.name} revived ${revived.name} from the discard pile.`, player.id);
      addLog(room, `${player.name} revived a card from the discard pile.`);
      break;
    }

    case "peekOpponentHand": {
      const target = nextOpponent(room, player.id);
      const names = target?.hand.length ? target.hand.map((card) => card.name).join(", ") : "no cards";
      addLog(room, `${target?.name || "The next opponent"} has: ${names}.`, player.id);
      addLog(room, `${player.name} peeked at an opponent hand.`);
      break;
    }

    case "composite":
      (activeEffect.effects || []).forEach((subEffect) => {
        applyImmediateEffect(room, player, subEffect, sourceCard, context);
      });
      break;

    case "none":
    default:
      break;
  }
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
  const previousTrait = room.lastPlayedTrait;

  if (room.doubleNextTraitAvailable) {
    card.pointMultiplier = 2;
    room.doubleNextTraitAvailable = false;
    addLog(room, `${card.name} mutated to double printed points.`);
  }

  player.board.push(card);
  room.turnState.primaryActionTaken = true;
  addLog(room, `${player.name} played ${card.name}.`);
  applyImmediateEffect(room, player, card.immediateEffect, card, { previousTrait });
  room.lastPlayedTrait = card;
  autoDiscardToLimit(room, player);

  room.turnState.playsRemaining -= 1;

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
  room.discardPile.push(card);
  room.pendingDiscard = null;
  addLog(room, `${player.name} discarded ${card.name}.`, player.id);
  addLog(room, `${player.name} discarded a card.`);
  endTurn(room);
}

function uniqueTagCount(player) {
  return new Set(player.board.flatMap((card) => card.tags)).size;
}

function tagCount(player, tag) {
  return player.board.filter((card) => card.tags.includes(tag)).length;
}

function hasNegativeToPositive(player) {
  return player.board.some((card) => card.endEffect?.type === "negativeToPositive");
}

function baseScoreFor(player) {
  const flipNegatives = hasNegativeToPositive(player);
  let converted = 0;
  const total = player.board.reduce((sum, card) => {
    const points = printedPoints(card);

    if (points < 0 && flipNegatives) {
      converted += Math.abs(points) - points;
      return sum + Math.abs(points);
    }

    return sum + points;
  }, 0);

  return { total, converted };
}

function endEffectBonuses(player) {
  const breakdown = [];
  let total = 0;

  player.board.forEach((card) => {
    const effect = card.endEffect;

    if (!effect) {
      return;
    }

    switch (effect.type) {
      case "tagBonus": {
        const points = tagCount(player, effect.tag) * effect.amount;

        if (points) {
          total += points;
          breakdown.push(`${card.name}: +${points} for ${effect.tag} traits`);
        }
        break;
      }

      case "uniqueTagBonus":
        if (uniqueTagCount(player) >= effect.threshold) {
          total += effect.amount;
          breakdown.push(`${card.name}: +${effect.amount} for ${uniqueTagCount(player)} unique tags`);
        }
        break;

      case "negativeToPositive": {
        const converted = baseScoreFor(player).converted;

        if (converted) {
          breakdown.push(`${card.name}: negative traits count as positive`);
        }
        break;
      }

      case "pairBonus":
        if (tagCount(player, effect.tag) >= 2) {
          total += effect.amount;
          breakdown.push(`${card.name}: +${effect.amount} for a ${effect.tag} pair`);
        }
        break;

      case "handBonus": {
        const points = player.hand.length * effect.amount;

        if (points) {
          total += points;
          breakdown.push(`${card.name}: +${points} for cards in hand`);
        }
        break;
      }

      case "boardSizeBonus": {
        const points = player.board.length * effect.amount;

        if (points) {
          total += points;
          breakdown.push(`${card.name}: +${points} for board size`);
        }
        break;
      }

      case "shieldBonus": {
        const points = player.shield * effect.amount;

        if (points) {
          total += points;
          breakdown.push(`${card.name}: +${points} for unused shields`);
        }
        break;
      }

      default:
        break;
    }
  });

  if (!breakdown.length) {
    breakdown.push("No end-effect bonuses.");
  }

  return { breakdown, total };
}

function finishGame(room) {
  if (!room.players.length) {
    room.phase = "gameOver";
    room.finalScores = [];
    return;
  }

  const scores = room.players.map((player) => {
    const base = baseScoreFor(player);
    const bonus = endEffectBonuses(player);

    return {
      playerId: player.id,
      name: player.name,
      baseScore: base.total,
      bonusTotal: bonus.total,
      total: base.total + bonus.total,
      breakdown: [`Board Traits: ${base.total}`, ...bonus.breakdown],
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
  room.ageDeck = AGE_CARDS.map((age) => ({ ...age, effect: clone(age.effect) }));
  room.currentAge = null;
  room.ageIndex = 0;
  room.currentPlayerIndex = 0;
  room.playersActedThisAge = [];
  room.turnOrder = room.players.map((player) => player.id);
  room.turnState = null;
  room.pendingDiscard = null;
  room.finalScores = null;
  room.doubleNextTraitAvailable = false;
  room.lastPlayedTrait = null;

  room.players.forEach((player) => {
    player.hand = [];
    player.board = [];
    player.skippedTurns = 0;
    player.shield = 0;
    player.extraPlays = 0;
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

function sanitizePlayer(player, viewerId) {
  const isViewer = player.id === viewerId;

  return {
    id: player.id,
    name: player.name,
    isHost: player.isHost,
    hand: isViewer ? player.hand.map(decorateCard) : [],
    handCount: player.hand.length,
    board: player.board.map(decorateCard),
    shield: player.shield,
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
    players: room.players.map((player) => sanitizePlayer(player, playerId)),
    log: sanitizeLog(room, playerId),
    currentAge: room.currentAge,
    ageIndex: room.ageIndex,
    currentPlayerId: current?.id || null,
    currentPlayerName: current?.name || "",
    isYourTurn: room.phase === "playing" && current?.id === playerId,
    drawPileCount: room.traitDeck.length,
    discardPileCount: room.discardPile.length,
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
