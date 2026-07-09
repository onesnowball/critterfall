import { useEffect, useMemo, useState } from "react";
import { SERVER_URL, socket } from "./socket";

const SAVED_NAME_KEY = "critterfall-player-name";

function getRoomCodeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return String(params.get("room") || "").trim().toUpperCase();
}

function getInviteLink(code) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", code);
  return url.toString();
}

function TraitCard({ card, actionLabel, onAction, disabled, subtle = false }) {
  const keywords = card.keywords || [];
  const tags = card.tags || [card.color].filter(Boolean);
  const colorClass = card.color ? ` color-pill--${card.color.toLowerCase()}` : "";

  return (
    <article className={`trait-card${subtle ? " trait-card--subtle" : ""}`}>
      <div className="trait-card__top">
        <span className="trait-card__emoji" aria-hidden="true">
          {card.emoji}
        </span>
        <div>
          <h4>{card.name}</h4>
          <p className="trait-card__tags">{tags.join(" | ")}</p>
        </div>
      </div>
      <p className="trait-card__text">{card.text}</p>
      <div className="trait-card__meta">
        {card.color ? <span className={`color-pill${colorClass}`}>{card.color}</span> : null}
        {keywords.map((keyword) => (
          <span key={`${card.instanceId}-${keyword}`} className="keyword-pill">
            {keyword}
          </span>
        ))}
        {card.status?.poisoned ? <span className="status-pill">Poison {card.status.poisoned}</span> : null}
        {card.parasiteOwnerName ? <span className="status-pill">Parasite by {card.parasiteOwnerName}</span> : null}
        <span className={`point-pill${card.effectivePoints < 0 ? " point-pill--negative" : ""}`}>
          {card.effectivePoints > 0 ? `+${card.effectivePoints}` : card.effectivePoints}
        </span>
        {card.isDoubled ? <span className="meta-pill">x2 this Age</span> : null}
      </div>
      {actionLabel ? (
        <button className="secondary-button" type="button" onClick={onAction} disabled={disabled}>
          {actionLabel}
        </button>
      ) : null}
    </article>
  );
}

function PlayerBoard({ player, isCurrent, isMe }) {
  return (
    <section className={`panel board-panel${isCurrent ? " board-panel--current" : ""}`}>
      <div className="board-panel__header">
        <div>
          <h3>
            {player.name}
            {isMe ? " (You)" : ""}
          </h3>
          <p>
            {player.handCount} card{player.handCount === 1 ? "" : "s"} in hand
          </p>
        </div>
        <div className="board-panel__stats">
          {player.isHost ? <span className="meta-pill">Host</span> : null}
          {player.hasActedThisAge ? <span className="meta-pill">Acted</span> : null}
          <span className="meta-pill">Gene Pool {player.currentBoardPoints}</span>
        </div>
      </div>
      <h4>Gene Pool</h4>
      <div className="board-traits">
        {player.board.length ? (
          player.board.map((card) => <TraitCard key={card.instanceId} card={card} subtle />)
        ) : (
          <p className="empty-state">No Traits played yet.</p>
        )}
      </div>
      {!isMe && player.hand.length ? (
        <div className="revealed-hand">
          <h4>Revealed Hand</h4>
          <div className="board-traits">
            {player.hand.map((card) => (
              <TraitCard key={card.instanceId} card={card} subtle />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function LogPanel({ log }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <h3>Action Log</h3>
      </div>
      <div className="log-list">
        {log.length ? (
          log
            .slice()
            .reverse()
            .map((entry) => (
              <div key={entry.id} className={`log-entry${entry.isPrivate ? " log-entry--private" : ""}`}>
                {entry.isPrivate ? <span className="meta-pill">Private</span> : null}
                <span>{entry.text}</span>
              </div>
            ))
        ) : (
          <p className="empty-state">No actions yet.</p>
        )}
      </div>
    </section>
  );
}

function ScoreBreakdown({ finalScores, isHost, onNewGame }) {
  const winners = finalScores.filter((entry) => entry.isWinner).map((entry) => entry.name);

  return (
    <section className="panel panel--hero">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Apocalypse Report</p>
          <h2>{winners.length > 1 ? `Winners: ${winners.join(", ")}` : `Winner: ${winners[0]}`}</h2>
        </div>
        <button className="primary-button" type="button" onClick={onNewGame} disabled={!isHost}>
          {isHost ? "New Game" : "Host Starts New Game"}
        </button>
      </div>
      <div className="score-grid">
        {finalScores.map((entry) => (
          <article key={entry.playerId} className={`score-card${entry.isWinner ? " score-card--winner" : ""}`}>
            <div className="score-card__header">
              <div>
                <h3>{entry.name}</h3>
                <p>
                  Base {entry.baseScore}, Bonus {entry.bonusTotal}
                </p>
              </div>
              <strong>{entry.total}</strong>
            </div>
            <ul className="breakdown-list">
              {entry.breakdown.map((line) => (
                <li key={`${entry.playerId}-${line}`}>{line}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

function App() {
  const [playerName, setPlayerName] = useState(() => localStorage.getItem(SAVED_NAME_KEY) || "");
  const [joinCode, setJoinCode] = useState(() => getRoomCodeFromUrl());
  const [roomState, setRoomState] = useState(null);
  const [status, setStatus] = useState(socket.connected ? "Connected" : "Connecting");
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [shareStatus, setShareStatus] = useState("");

  useEffect(() => {
    const handleConnect = () => setStatus("Connected");
    const handleDisconnect = () => setStatus("Disconnected");
    const handleStateUpdate = (nextState) => {
      setRoomState(nextState);
      setJoinCode(nextState.code || "");
      setError("");
      setBusyAction("");

      if (nextState.code) {
        window.history.replaceState(null, "", getInviteLink(nextState.code));
      }
    };
    const handleActionError = (message) => {
      setError(message);
      setBusyAction("");
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("stateUpdate", handleStateUpdate);
    socket.on("actionError", handleActionError);

    if (!socket.connected) {
      socket.connect();
    }

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("stateUpdate", handleStateUpdate);
      socket.off("actionError", handleActionError);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(SAVED_NAME_KEY, playerName);
  }, [playerName]);

  const me = useMemo(() => {
    if (!roomState) {
      return null;
    }

    return roomState.players.find((player) => player.id === roomState.youPlayerId) || null;
  }, [roomState]);

  const hand = me?.hand || [];
  const isPlaying = roomState?.phase === "playing";
  const isLobby = roomState?.phase === "lobby";
  const isGameOver = roomState?.phase === "gameOver";

  async function emitAction(eventName, payload = {}) {
    if (!socket.connected) {
      socket.connect();
    }

    return new Promise((resolve) => {
      socket.emit(eventName, payload, (response) => {
        resolve(response || { ok: true });
      });
    });
  }

  async function createRoom() {
    const trimmedName = playerName.trim();

    if (!trimmedName) {
      setError("Add a player name before creating a room.");
      return;
    }

    setBusyAction("createRoom");
    const response = await emitAction("createRoom", { name: trimmedName });

    if (!response.ok) {
      setError(response.message || "Could not create room.");
      setBusyAction("");
    }
  }

  async function joinRoom() {
    const trimmedName = playerName.trim();
    const trimmedCode = joinCode.trim().toUpperCase();

    if (!trimmedName) {
      setError("Add a player name before joining a room.");
      return;
    }

    if (!trimmedCode) {
      setError("Enter a room code to join.");
      return;
    }

    setBusyAction("joinRoom");
    const response = await emitAction("joinRoom", { name: trimmedName, code: trimmedCode });

    if (!response.ok) {
      setError(response.message || "Could not join that room.");
      setBusyAction("");
    }
  }

  async function copyInviteLink() {
    if (!roomState?.code) {
      return;
    }

    const inviteLink = getInviteLink(roomState.code);

    try {
      await navigator.clipboard.writeText(inviteLink);
      setShareStatus("Invite link copied.");
    } catch (_error) {
      setShareStatus(inviteLink);
    }
  }

  async function startMatch() {
    setBusyAction("startGame");
    const response = await emitAction("startGame");

    if (!response.ok) {
      setError(response.message || "Could not start the game.");
      setBusyAction("");
    }
  }

  async function playTrait(cardInstanceId) {
    const response = await emitAction("playCard", { cardInstanceId });

    if (!response.ok) {
      setError(response.message || "Could not play that card.");
    }
  }

  async function skipCurrentTurn() {
    const response = await emitAction("skipTurn");

    if (!response.ok) {
      setError(response.message || "Could not skip your turn.");
    }
  }

  async function discardFromHand(cardInstanceId) {
    const response = await emitAction("discardCard", { cardInstanceId });

    if (!response.ok) {
      setError(response.message || "Could not discard that card.");
    }
  }

  async function resetRoom() {
    setBusyAction("newGame");
    const response = await emitAction("newGame");

    if (!response.ok) {
      setError(response.message || "Could not reset the room.");
      setBusyAction("");
    }
  }

  const canSkip =
    roomState?.isYourTurn &&
    !roomState?.pendingDiscard &&
    roomState?.turnState &&
    !roomState.turnState.primaryActionTaken;

  const extraTurnText =
    roomState?.isYourTurn && roomState?.turnState?.playsRemaining > 1
      ? `${roomState.turnState.playsRemaining} plays left this turn`
      : roomState?.isYourTurn && roomState?.turnState?.playsRemaining === 1
        ? "1 play left this turn"
        : "";

  if (!roomState) {
    return (
      <main className="app-shell">
        <section className="panel panel--hero landing-panel">
          <div>
            <p className="eyebrow">Local Multiplayer Evolution Game</p>
            <h1>Critterfall</h1>
            <p className="lede">
              Build a public Gene Pool, steal questionable organs, poison rivals, survive randomized Ages,
              then see whose weird little creature scores the most before the world goes quiet.
            </p>
          </div>
          <div className="hero-actions">
            <label className="field">
              <span>Player name</span>
              <input
                type="text"
                value={playerName}
                maxLength={24}
                onChange={(event) => setPlayerName(event.target.value)}
                placeholder="Mia"
              />
            </label>
            <div className="split-fields">
              <button className="primary-button" type="button" onClick={createRoom} disabled={busyAction === "createRoom"}>
                {busyAction === "createRoom" ? "Creating..." : "Create Room"}
              </button>
              <input
                type="text"
                value={joinCode}
                maxLength={6}
                onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                placeholder="ROOM"
              />
              <button className="secondary-button" type="button" onClick={joinRoom} disabled={busyAction === "joinRoom"}>
                {busyAction === "joinRoom" ? "Joining..." : "Join Room"}
              </button>
            </div>
            <div className="status-strip">
              <span className="meta-pill">{status}</span>
              <span className="meta-pill">Socket: {SERVER_URL}</span>
            </div>
            {error ? <p className="error-text">{error}</p> : null}
          </div>
        </section>

        <section className="info-grid">
          <article className="panel">
            <h3>How It Works</h3>
            <p>Create a room, share the room code or invite link, then build public Gene Pools across randomized Ages.</p>
          </article>
          <article className="panel">
            <h3>Public Gene Pools</h3>
            <p>Played Traits are public with full text, color, keywords, poison, Dominant, and Parasite status.</p>
          </article>
          <article className="panel">
            <h3>Private Hands</h3>
            <p>Hands stay private unless a reveal effect exposes every card with full text.</p>
          </article>
        </section>
      </main>
    );
  }

  if (isLobby) {
    return (
      <main className="app-shell">
        <section className="panel panel--hero">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Lobby</p>
              <h1>Room {roomState.code}</h1>
              <p className="lede">Share this code with your friend, then start when 2 to 6 players are in.</p>
            </div>
            <div className="status-strip">
              <span className="meta-pill">{status}</span>
              {roomState.isHost ? <span className="meta-pill">You are host</span> : null}
            </div>
          </div>

          <div className="lobby-grid">
            <article className="panel panel--nested">
              <h3>Players</h3>
              <div className="player-list">
                {roomState.players.map((player) => (
                  <div key={player.id} className="player-row">
                    <span>
                      {player.name}
                      {player.id === roomState.youPlayerId ? " (You)" : ""}
                    </span>
                    {player.isHost ? <span className="meta-pill">Host</span> : null}
                  </div>
                ))}
              </div>
            </article>

            <article className="panel panel--nested">
              <h3>Ready Check</h3>
              <p>{roomState.players.length} player(s) joined.</p>
              <div className="invite-actions">
                <button className="secondary-button" type="button" onClick={copyInviteLink}>
                  Copy Invite Link
                </button>
                {shareStatus ? <p className="muted-text">{shareStatus}</p> : null}
              </div>
              <button
                className="primary-button"
                type="button"
                onClick={startMatch}
                disabled={!roomState.canStartGame || busyAction === "startGame"}
              >
                {busyAction === "startGame" ? "Starting..." : "Start Game"}
              </button>
              {!roomState.canStartGame ? (
                <p className="muted-text">The host can start once at least two players have joined.</p>
              ) : null}
            </article>
          </div>

          {error ? <p className="error-text">{error}</p> : null}
        </section>

        <LogPanel log={roomState.log} />
      </main>
    );
  }

  if (isPlaying) {
    return (
      <main className="app-shell">
        <section className="panel panel--hero">
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                Age {roomState.currentAge?.number} of {roomState.ageDeckCount || roomState.currentAge?.total || 9}
              </p>
              <h1>
                {roomState.currentAge?.emoji} {roomState.currentAge?.name}
              </h1>
              <p className="lede">{roomState.currentAge?.text}</p>
            </div>
            <div className="status-strip">
              <span className="meta-pill">Room {roomState.code}</span>
              <span className="meta-pill">Deck {roomState.drawPileCount}</span>
              <span className="meta-pill">Discard {roomState.discardPileCount}</span>
            </div>
          </div>

          <div className="turn-banner">
            <strong>{roomState.isYourTurn ? "Your turn" : `${roomState.currentPlayerName}'s turn`}</strong>
            {extraTurnText ? <span className="meta-pill">{extraTurnText}</span> : null}
            {roomState.pendingDiscard ? <span className="meta-pill">{roomState.pendingDiscard.reason}</span> : null}
          </div>

          <div className="action-row">
            <button className="secondary-button" type="button" onClick={skipCurrentTurn} disabled={!canSkip}>
              Skip and Draw 2
            </button>
            <span className="muted-text">
              Dominant Traits resist stealing and destruction. Poison resolves when the Age stabilizes.
            </span>
          </div>

          {error ? <p className="error-text">{error}</p> : null}
        </section>

        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Your Hand</h2>
              <p>Play one Trait, then draw back up toward 5 cards.</p>
            </div>
            <span className="meta-pill">
              {hand.length} card{hand.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="hand-grid">
            {hand.length ? (
              hand.map((card) => (
                <TraitCard
                  key={card.instanceId}
                  card={card}
                  actionLabel={roomState.pendingDiscard ? "Discard" : "Play Trait"}
                  onAction={() =>
                    roomState.pendingDiscard ? discardFromHand(card.instanceId) : playTrait(card.instanceId)
                  }
                  disabled={
                    roomState.pendingDiscard
                      ? !roomState.isYourTurn
                      : !roomState.isYourTurn || Boolean(roomState.pendingDiscard)
                  }
                />
              ))
            ) : (
              <p className="empty-state">Your hand is empty.</p>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Discard Pile</h2>
              <p>Public zone. Some Traits can revive or play from here.</p>
            </div>
            <span className="meta-pill">
              {roomState.discardPileCount} card{roomState.discardPileCount === 1 ? "" : "s"}
            </span>
          </div>
          <div className="discard-grid">
            {roomState.discardPile?.length ? (
              roomState.discardPile.map((card) => <TraitCard key={card.instanceId} card={card} subtle />)
            ) : (
              <p className="empty-state">Nothing discarded yet.</p>
            )}
          </div>
        </section>

        <section className="board-grid">
          {roomState.players.map((player) => (
            <PlayerBoard
              key={player.id}
              player={player}
              isCurrent={player.id === roomState.currentPlayerId}
              isMe={player.id === roomState.youPlayerId}
            />
          ))}
        </section>

        <LogPanel log={roomState.log} />
      </main>
    );
  }

  if (isGameOver) {
    return (
      <main className="app-shell">
        <ScoreBreakdown finalScores={roomState.finalScores || []} isHost={roomState.isHost} onNewGame={resetRoom} />

        <section className="board-grid">
          {roomState.players.map((player) => (
            <PlayerBoard
              key={player.id}
              player={player}
              isCurrent={false}
              isMe={player.id === roomState.youPlayerId}
            />
          ))}
        </section>

        <LogPanel log={roomState.log} />
      </main>
    );
  }

  return null;
}

export default App;
