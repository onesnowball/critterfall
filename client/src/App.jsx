import { useEffect, useMemo, useRef, useState } from "react";
import artManifest from "./artManifest.json";

const ART_IDS = new Set(artManifest);
import { SERVER_URL, socket } from "./socket";

const SAVED_NAME_KEY = "critterfall-player-name";
const GUIDE_SEEN_KEY = "critterfall-field-guide-seen";
const SAVED_CLIENT_ID_KEY = "critterfall-client-id";

function getClientId() {
  const existing = localStorage.getItem(SAVED_CLIENT_ID_KEY);

  if (existing) {
    return existing;
  }

  const nextId =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(SAVED_CLIENT_ID_KEY, nextId);
  return nextId;
}

function getRoomCodeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return String(params.get("room") || "").trim().toUpperCase();
}

function getInviteLink(code) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", code);
  return url.toString();
}

function colorKey(color) {
  return String(color || "colorless").toLowerCase();
}

function formatPoints(value) {
  const numericValue = Number(value || 0);
  return numericValue > 0 ? `+${numericValue}` : String(numericValue);
}

function useAnimatedNumber(value, duration = 650) {
  const target = Number(value || 0);
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef(null);

  useEffect(() => {
    const from = fromRef.current;

    if (from === target) {
      return undefined;
    }

    const start = performance.now();

    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (target - from) * eased));

      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);

  return display;
}

function ScorePop({ value, max = 30 }) {
  const numeric = Number(value || 0);
  const display = useAnimatedNumber(numeric);
  const prevRef = useRef(numeric);
  const [delta, setDelta] = useState(null);
  const [bumping, setBumping] = useState(false);

  useEffect(() => {
    const change = numeric - prevRef.current;
    prevRef.current = numeric;

    if (change === 0) {
      return undefined;
    }

    setDelta({ change, key: `${Date.now()}-${Math.random()}` });
    setBumping(true);
    const clearBump = setTimeout(() => setBumping(false), 460);
    const clearDelta = setTimeout(() => setDelta(null), 1100);

    return () => {
      clearTimeout(clearBump);
      clearTimeout(clearDelta);
    };
  }, [numeric]);

  const pct = Math.max(0, Math.min(100, (numeric / max) * 100));

  return (
    <div className={`score-pop${bumping ? " score-pop--bump" : ""}`}>
      <div className="score-pop__row">
        <span className="score-pop__label">Points</span>
        <span className="score-pop__value">{display}</span>
        {delta ? (
          <span key={delta.key} className={`score-pop__delta score-pop__delta--${delta.change > 0 ? "up" : "down"}`}>
            {delta.change > 0 ? "+" : ""}
            {delta.change}
          </span>
        ) : null}
      </div>
      <div className="score-pop__bar" aria-hidden="true">
        <span className="score-pop__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ageRuleLabels(rules) {
  if (!rules) {
    return [];
  }

  const labels = [];

  if (rules.bannedColors?.length) {
    labels.push(`No ${rules.bannedColors.join(" or ")} Traits`);
  }
  if (rules.maxFaceValuePlay != null) {
    labels.push(`Face value ≤ ${rules.maxFaceValuePlay}`);
  }
  if (rules.ignoreTraitActions) {
    labels.push("Trait actions ignored");
  }
  if (rules.effectlessChain) {
    labels.push("Effectless combo");
  }
  if (rules.endWithHandSize != null) {
    labels.push(`End turn with ${rules.endWithHandSize} cards`);
  }
  if (rules.noSameColorAsLast) {
    labels.push("No repeat colors");
  }
  if (rules.lockTraitRow) {
    labels.push("Trait Rows locked");
  }
  if (rules.freeHeroic) {
    labels.push("Play requirements waived");
  }
  if (rules.previewNextAge) {
    labels.push("Next Age revealed");
  }

  return labels;
}

function playConditionLabel(card) {
  const condition = card.playCondition;

  if (!condition) {
    return null;
  }

  if (condition.minColorCount) {
    const { color, count } = condition.minColorCount;
    return `Needs ${count} ${color}`;
  }

  if (condition.maxFaceValue != null) {
    return `Value ≤ ${condition.maxFaceValue} only`;
  }

  return null;
}

function CardArt({ card }) {
  const [failed, setFailed] = useState(false);
  const hasArt = card.id && ART_IDS.has(card.id);
  const src = hasArt ? `${import.meta.env.BASE_URL}art/${card.id}.webp` : null;

  if (!src || failed) {
    return (
      <span className="trait-card__emoji" aria-hidden="true">
        {card.emoji}
      </span>
    );
  }

  return (
    <span className="trait-card__art" aria-hidden="true">
      <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
    </span>
  );
}

function TraitCard({ card, actionLabel, onAction, disabled, subtle = false }) {
  const keywords = card.keywords || [];
  const points = card.effectivePoints ?? card.points ?? 0;
  const keywordKey = card.instanceId || card.id || card.name;
  const conditionLabel = playConditionLabel(card);
  const attachments = card.attachments || [];
  const isProtected = attachments.some((att) => (att.protect || []).length > 0);
  const classNames = [
    "trait-card",
    "trait-card--enter",
    `trait-card--color-${colorKey(card.color)}`,
    subtle ? "trait-card--subtle" : "",
    keywords.includes("Dominant") ? "trait-card--dominant" : "",
    keywords.includes("Late") ? "trait-card--late" : "",
    card.status?.poisoned ? "trait-card--poisoned" : "",
    card.parasiteOwnerName ? "trait-card--parasite" : "",
    attachments.length ? "trait-card--attached" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={classNames}>
      <div className="trait-card__top">
        <CardArt card={card} />
        <div className="trait-card__title">
          <h4>{card.name}</h4>
          <span
            className={`face-value${points < 0 ? " face-value--negative" : ""}${card.isDynamicValue ? " face-value--dynamic" : ""}`}
            title={card.isDynamicValue ? "This value changes with the game state" : undefined}
          >
            {card.isDynamicValue ? "~" : ""}
            {formatPoints(points)}
          </span>
        </div>
      </div>
      <p className="trait-card__text">{card.text}</p>
      <div className="trait-card__meta">
        {keywords.map((keyword) => (
          <span key={`${keywordKey}-${keyword}`} className="keyword-pill">
            {keyword}
          </span>
        ))}
        {conditionLabel ? <span className="meta-pill meta-pill--condition">{conditionLabel}</span> : null}
        {card.isDynamicValue ? <span className="meta-pill meta-pill--dynamic">Dynamic</span> : null}
        {card.status?.poisoned ? <span className="status-pill">Poison {card.status.poisoned}</span> : null}
        {card.parasiteOwnerName ? <span className="status-pill">Parasite by {card.parasiteOwnerName}</span> : null}
        {card.isDoubled ? <span className="meta-pill">x2 this Age</span> : null}
        {isProtected ? <span className="meta-pill meta-pill--protected">Protected</span> : null}
      </div>
      {attachments.length ? (
        <div className="trait-card__attachments">
          {attachments.map((att) => (
            <span
              key={att.instanceId}
              className={`attachment-chip attachment-chip--color-${colorKey(att.color)}`}
              title={
                (att.protect || []).length
                  ? `Cannot be ${att.protect.join(" / ")}`
                  : att.isDynamicValue
                    ? `Worth ${att.effectiveValue} right now (changes with the game)`
                    : att.effectiveValue
                      ? `${att.effectiveValue > 0 ? "+" : ""}${att.effectiveValue} value`
                      : att.name
              }
            >
              <span aria-hidden="true">{att.emoji}</span>
              {att.name}
              {att.effectiveValue ? (
                <strong>
                  {att.isDynamicValue ? "~" : att.effectiveValue > 0 ? "+" : ""}
                  {att.effectiveValue}
                </strong>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      {actionLabel ? (
        <button className="secondary-button" type="button" onClick={onAction} disabled={disabled}>
          {actionLabel}
        </button>
      ) : null}
    </article>
  );
}

function PlayerBoard({ player, isCurrent, isMe, dimmed = false }) {
  const classNames = [
    "panel",
    "board-panel",
    isCurrent ? "board-panel--current" : "",
    dimmed ? "board-panel--waiting" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={classNames}>
      {isCurrent ? <span className="turn-flag">▶ Playing</span> : null}
      <div className="board-panel__header">
        <div>
          <h3>
            {player.name}
            {isMe ? " (You)" : ""}
          </h3>
          <p>
            Hand {player.handCount}/{player.handLimit || player.genePoolSize || 5}
          </p>
        </div>
        <div className="board-panel__stats">
          {player.isHost ? <span className="meta-pill">Host</span> : null}
          {player.hasActedThisAge ? <span className="meta-pill">Acted</span> : null}
          <span className="meta-pill">Gene Pool {player.genePoolSize || 5}</span>
          <ScorePop value={player.currentBoardPoints} />
        </div>
      </div>
      <h4>Trait Row</h4>
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

function choiceActionLabel(choice) {
  if (choice.type === "faceDownHand") {
    return choice.mode === "discard" ? "Discard This" : "Take This";
  }

  if (choice.type === "giveHandCard") {
    return "Give This";
  }

  if (choice.type === "handLimitDiscard") {
    return "Discard This";
  }

  if (choice.type === "ageRansom") {
    return choice.mode === "discard" ? "Discard This" : "Choose";
  }

  if (choice.type === "peekPlay") {
    return "Take & Play";
  }

  if (choice.type === "attachHost") {
    return "Attach Here";
  }

  if (choice.type === "copyImmediate") {
    return "Copy This";
  }

  if (choice.type === "publicTrait") {
    if (choice.mode === "steal") {
      return "Steal This";
    }

    if (choice.mode === "poison") {
      return "Poison This";
    }

    return "Destroy This";
  }

  if (choice.type === "discardCard") {
    return choice.mode === "play" ? "Play This" : "Take This";
  }

  if (choice.type === "targetPlayer") {
    if (choice.mode === "swapHands") {
      return "Swap Here";
    }

    if (choice.mode === "placeParasite") {
      return "Place Here";
    }

    return "Choose";
  }

  return "Choose";
}

function PendingChoicePanel({ choice, onResolve }) {
  if (!choice) {
    return null;
  }

  if (!choice.isChooser) {
    return (
      <section className="panel choice-panel choice-panel--waiting">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Choice Pending</p>
            <h2>{choice.actorName} is choosing</h2>
            <p>{choice.isTarget ? "Your hidden cards are involved." : choice.prompt}</p>
          </div>
          <span className="meta-pill">Paused</span>
        </div>
      </section>
    );
  }

  const actionLabel = choiceActionLabel(choice);

  return (
    <section className="panel choice-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Resolve Effect</p>
          <h2>{choice.prompt}</h2>
          {choice.type === "faceDownHand" ? (
            <p>Pick one hidden slot. The card text stays secret until the effect resolves.</p>
          ) : null}
        </div>
        <span className="meta-pill">{choice.sourceCardName}</span>
      </div>
      <div className={choice.type === "faceDownHand" || choice.type === "targetPlayer" ? "choice-grid" : "hand-grid"}>
        {choice.choices.map((option, index) =>
          option.card ? (
            <TraitCard
              key={option.id}
              card={option.card}
              actionLabel={option.ownerName ? `${actionLabel} from ${option.ownerName}` : actionLabel}
              onAction={() => onResolve(choice.id, option.id)}
            />
          ) : (
            <button
              key={option.id}
              className={`choice-tile${choice.type === "faceDownHand" ? " choice-tile--facedown" : ""}`}
              type="button"
              onClick={() => onResolve(choice.id, option.id)}
            >
              <span>{option.label || `Option ${index + 1}`}</span>
              <strong>{choice.type === "faceDownHand" ? index + 1 : actionLabel}</strong>
            </button>
          )
        )}
      </div>
    </section>
  );
}

function AgeAnnouncement({ age }) {
  if (!age) {
    return null;
  }

  const hasArt = age.id && ART_IDS.has(age.id);

  return (
    <div className="age-backdrop" aria-hidden="true">
      <div className={`age-announcement${age.isCatastrophe ? " age-announcement--catastrophe" : ""}`}>
        {hasArt ? (
          <span className="age-announcement__art">
            <img src={`${import.meta.env.BASE_URL}art/${age.id}.webp`} alt="" />
          </span>
        ) : (
          <span className="age-announcement__emoji">{age.emoji}</span>
        )}
        <p className="eyebrow">{age.isCatastrophe ? "☄️ Catastrophe" : `Age ${age.number}`}</p>
        <h2>{age.name}</h2>
        <p className="age-announcement__sub">{age.text || (age.isCatastrophe ? "The world convulses…" : "A new Age dawns")}</p>
      </div>
    </div>
  );
}

function PlaySpotlight({ play }) {
  if (!play) {
    return null;
  }

  return (
    <div className="play-spotlight" key={play.key} aria-hidden="true">
      <div className={`play-spotlight__inner${play.isYou ? " play-spotlight__inner--you" : ""}`}>
        <p className="play-spotlight__who">
          <span className="play-spotlight__actor">{play.isYou ? "You" : play.playerName}</span> played
        </p>
        <div className="play-spotlight__card">
          <TraitCard card={play.card} subtle />
        </div>
      </div>
    </div>
  );
}

function TiebreakRoll({ roll }) {
  const [highlight, setHighlight] = useState(0);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!roll) {
      return undefined;
    }

    setSettled(false);
    const names = roll.candidates || [];
    const winnerIndex = Math.max(0, names.findIndex((candidate) => candidate.id === roll.winnerId));
    let tick = 0;
    // Spin through the names, decelerating, then land on the winner.
    const totalTicks = 16 + winnerIndex;
    let timer;

    const spin = () => {
      tick += 1;
      setHighlight((prev) => (prev + 1) % Math.max(1, names.length));

      if (tick >= totalTicks) {
        setHighlight(winnerIndex);
        setSettled(true);
        return;
      }

      const delay = 70 + Math.max(0, tick - 8) * 32;
      timer = window.setTimeout(spin, delay);
    };

    timer = window.setTimeout(spin, 70);
    return () => window.clearTimeout(timer);
  }, [roll?.seq]);

  if (!roll) {
    return null;
  }

  const names = roll.candidates || [];

  return (
    <div className="tiebreak" key={roll.seq} aria-live="polite">
      <div className={`tiebreak__inner${settled ? " tiebreak__inner--settled" : ""}`}>
        <p className="tiebreak__title">Tie-breaker roll</p>
        <p className="tiebreak__label">for {roll.label}</p>
        <div className="tiebreak__names">
          {names.map((candidate, index) => (
            <span
              key={candidate.id}
              className={`tiebreak__name${index === highlight ? " tiebreak__name--active" : ""}${
                settled && candidate.id === roll.winnerId ? " tiebreak__name--winner" : ""
              }`}
            >
              {candidate.name}
            </span>
          ))}
        </div>
        {settled ? <p className="tiebreak__result">🎲 {roll.winnerName} is chosen!</p> : null}
      </div>
    </div>
  );
}

function CatalogModal({ catalog, error, isOpen, activeTab, search, onOpen, onClose, onTabChange, onSearchChange }) {
  if (!isOpen) {
    return null;
  }

  const normalizedSearch = search.trim().toLowerCase();
  const traits = (catalog?.traits || []).filter((card) => {
    const haystack = `${card.name} ${card.color} ${card.text} ${(card.keywords || []).join(" ")}`.toLowerCase();
    return !normalizedSearch || haystack.includes(normalizedSearch);
  });
  const ages = (catalog?.ages || []).filter((age) => {
    const haystack = `${age.name} ${age.text}`.toLowerCase();
    return !normalizedSearch || haystack.includes(normalizedSearch);
  });

  return (
    <div className="catalog-backdrop" role="dialog" aria-modal="true" aria-label="Card Dictionary">
      <section className="panel catalog-modal">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Dictionary</p>
            <h2>Cards and Ages</h2>
          </div>
          <button className="secondary-button" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="catalog-toolbar">
          <div className="catalog-tabs" role="tablist" aria-label="Dictionary sections">
            <button
              className={`secondary-button${activeTab === "traits" ? " secondary-button--active" : ""}`}
              type="button"
              onClick={() => onTabChange("traits")}
            >
              Traits
            </button>
            <button
              className={`secondary-button${activeTab === "ages" ? " secondary-button--active" : ""}`}
              type="button"
              onClick={() => onTabChange("ages")}
            >
              Ages
            </button>
          </div>
          <input
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search"
          />
        </div>

        {error ? (
          <div className="catalog-empty">
            <p className="error-text">{error}</p>
            <button className="secondary-button" type="button" onClick={onOpen}>
              Retry
            </button>
          </div>
        ) : null}

        {!error && !catalog ? <p className="empty-state">Loading dictionary...</p> : null}

        {!error && catalog && activeTab === "traits" ? (
          <div className="catalog-grid">
            {traits.map((card) => (
              <TraitCard key={card.id} card={card} subtle />
            ))}
          </div>
        ) : null}

        {!error && catalog && activeTab === "ages" ? (
          <div className="age-dictionary-grid">
            {ages.map((age) => (
              <article key={age.id} className={`age-dictionary-card${age.isFinal ? " age-dictionary-card--final" : ""}`}>
                <div>
                  <span aria-hidden="true">{age.emoji}</span>
                  <h3>{age.name}</h3>
                </div>
                <p>{age.text}</p>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

const FIELD_GUIDE_PAGES = [
  {
    tab: "Welcome",
    emoji: "🌱",
    title: "Critterfall",
    subtitle: "A field guide to weird little creatures",
    color: "green",
    blocks: [
      { kind: "lede", text: "Grow the strangest, highest-scoring critter in the lobby before the world goes quiet." },
      { kind: "text", text: "Each turn you play a Trait from your hand into your public Trait Row. Traits give points, trigger effects, and stack into one glorious mutant." },
      { kind: "callout", emoji: "🏆", title: "How you win", text: "When the final Age is revealed, the world ends. Whoever's Trait Row scores the most points wins." }
    ]
  },
  {
    tab: "Your Turn",
    emoji: "🔄",
    title: "A Turn, Step by Step",
    subtitle: "Play, resolve, refill",
    color: "blue",
    blocks: [
      { kind: "steps", items: [
        { emoji: "🃏", title: "Play a Trait", text: "Choose one card from your hand and play it face-up into your Trait Row." },
        { emoji: "⚡", title: "Resolve its effect", text: "Immediate effects fire right away — draw, steal, destroy, attach, and more." },
        { emoji: "💧", title: "Stabilize", text: "At the END of your turn you draw back up toward your Gene Pool size. This happens once — not after every extra play." }
      ] },
      { kind: "callout", emoji: "➕", title: "Extra plays", text: "Some Traits let you play more Traits this turn. You only Stabilize once, when your whole turn is finished." }
    ]
  },
  {
    tab: "Colors",
    emoji: "🎨",
    title: "The Five Colors",
    subtitle: "Every Trait wears one",
    color: "purple",
    blocks: [
      { kind: "colorList", items: [
        { color: "green", emoji: "🌿", name: "Green", text: "Growth — drawing cards, gene pool, and going wide." },
        { color: "red", emoji: "🔥", name: "Red", text: "Aggression — destroying, poisoning, and stealing." },
        { color: "blue", emoji: "🌊", name: "Blue", text: "Control — hands, turn order, and disruption." },
        { color: "purple", emoji: "🔮", name: "Purple", text: "Scoring — traits that scale and count things up." },
        { color: "colorless", emoji: "⚪", name: "Colorless", text: "Neutral — flexible odds and ends." }
      ] },
      { kind: "callout", emoji: "🧮", title: "Colors count", text: "Some Traits score or trigger based on how many of a color sit in your Row — build combos on purpose." }
    ]
  },
  {
    tab: "Keywords",
    emoji: "📖",
    title: "Keyword Glossary",
    subtitle: "The words that bend the rules",
    color: "red",
    blocks: [
      { kind: "glossary", items: [
        { emoji: "👑", term: "Dominant", text: "A powerful Trait that resists being stolen or destroyed. Hard to remove — plan around it." },
        { emoji: "🦠", term: "Parasite", text: "Lives in an OPPONENT's Trait Row and is worth negative points to them. A gift nobody wants." },
        { emoji: "🌙", term: "Late", text: "Can only be played in the Late window at the end of your turn — save it for the right moment." },
        { emoji: "☠️", term: "Poison", text: "A poisoned Trait is destroyed when the Age Stabilizes. Tick, tick, tick." }
      ] }
    ]
  },
  {
    tab: "Ages",
    emoji: "🌋",
    title: "The Ages",
    subtitle: "The world keeps changing",
    color: "green",
    blocks: [
      { kind: "text", text: "Between rounds a new Age is revealed. Each Age has a global effect that hits every player — a shift in gene pools, a mass discard, or a wipe of high-value Traits." },
      { kind: "callout", emoji: "💥", title: "Catastrophes", text: "Some Ages are Catastrophes — brutal, board-changing events. Watch the Next Age preview and brace yourself." },
      { kind: "callout", emoji: "⏳", title: "The end of the world", text: "When the Age deck runs out, the final Age triggers scoring. Everything you built is tallied at once." }
    ]
  },
  {
    tab: "Scoring",
    emoji: "🏆",
    title: "Scoring & Winning",
    subtitle: "Count it all up",
    color: "purple",
    blocks: [
      { kind: "steps", items: [
        { emoji: "🔢", title: "Trait points", text: "Add up the points printed on every Trait in your Row." },
        { emoji: "📈", title: "Dynamic values", text: "Some Traits are worth more based on colors, hand size, or the state of the board at the end." },
        { emoji: "🎁", title: "End bonuses", text: "End-of-game effects add extra points on top." }
      ] },
      { kind: "callout", emoji: "👑", title: "Highest total wins", text: "Biggest score when the world ends takes the crown. Ties share the win." }
    ]
  }
];

function FieldGuideBlock({ block }) {
  if (block.kind === "lede") {
    return <p className="guide-lede">{block.text}</p>;
  }

  if (block.kind === "text") {
    return <p className="guide-text">{block.text}</p>;
  }

  if (block.kind === "callout") {
    return (
      <div className="guide-callout">
        <span className="guide-callout__emoji" aria-hidden="true">{block.emoji}</span>
        <div>
          <strong>{block.title}</strong>
          <p>{block.text}</p>
        </div>
      </div>
    );
  }

  if (block.kind === "steps") {
    return (
      <ol className="guide-steps">
        {block.items.map((item, index) => (
          <li key={item.title} className="guide-step">
            <span className="guide-step__num">{index + 1}</span>
            <span className="guide-step__emoji" aria-hidden="true">{item.emoji}</span>
            <div>
              <strong>{item.title}</strong>
              <p>{item.text}</p>
            </div>
          </li>
        ))}
      </ol>
    );
  }

  if (block.kind === "colorList") {
    return (
      <ul className="guide-colors">
        {block.items.map((item) => (
          <li key={item.name} className={`guide-color guide-color--${item.color}`}>
            <span className="guide-color__dot" aria-hidden="true">{item.emoji}</span>
            <div>
              <strong>{item.name}</strong>
              <p>{item.text}</p>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (block.kind === "glossary") {
    return (
      <dl className="guide-glossary">
        {block.items.map((item) => (
          <div key={item.term} className="guide-term">
            <dt>
              <span className="guide-term__emoji" aria-hidden="true">{item.emoji}</span>
              {item.term}
            </dt>
            <dd>{item.text}</dd>
          </div>
        ))}
      </dl>
    );
  }

  return null;
}

function FieldGuideModal({ isOpen, page, onClose, onGoto, onPrev, onNext }) {
  if (!isOpen) {
    return null;
  }

  const total = FIELD_GUIDE_PAGES.length;
  const current = Math.min(Math.max(page, 0), total - 1);
  const spread = FIELD_GUIDE_PAGES[current];

  return (
    <div className="guide-backdrop" role="dialog" aria-modal="true" aria-label="Field Guide">
      <section className={`guide-book guide-book--${spread.color}`}>
        <button className="guide-close" type="button" onClick={onClose} aria-label="Close Field Guide">
          ✕
        </button>

        <nav className="guide-tabs" aria-label="Field Guide chapters">
          {FIELD_GUIDE_PAGES.map((entry, index) => (
            <button
              key={entry.tab}
              type="button"
              className={`guide-tab${index === current ? " guide-tab--active" : ""}`}
              onClick={() => onGoto(index)}
            >
              <span aria-hidden="true">{entry.emoji}</span>
              {entry.tab}
            </button>
          ))}
        </nav>

        <div key={current} className="guide-page">
          <header className="guide-page__head">
            <span className="guide-page__emoji" aria-hidden="true">{spread.emoji}</span>
            <div>
              <h2>{spread.title}</h2>
              <p>{spread.subtitle}</p>
            </div>
          </header>

          <div className="guide-page__body">
            {spread.blocks.map((block, index) => (
              <FieldGuideBlock key={index} block={block} />
            ))}
          </div>
        </div>

        <footer className="guide-foot">
          <button className="secondary-button" type="button" onClick={onPrev} disabled={current === 0}>
            ← Back
          </button>
          <div className="guide-dots" aria-hidden="true">
            {FIELD_GUIDE_PAGES.map((entry, index) => (
              <span key={entry.tab} className={`guide-dot${index === current ? " guide-dot--active" : ""}`} />
            ))}
          </div>
          {current === total - 1 ? (
            <button className="primary-button" type="button" onClick={onClose}>
              Let's play! 🎉
            </button>
          ) : (
            <button className="primary-button" type="button" onClick={onNext}>
              Next →
            </button>
          )}
        </footer>
      </section>
    </div>
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
                  Trait {entry.baseScore}, Bonus {entry.bonusTotal}
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
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogTab, setCatalogTab] = useState("traits");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const [guidePage, setGuidePage] = useState(0);
  const [ageAnnouncement, setAgeAnnouncement] = useState(null);
  const [playSpotlight, setPlaySpotlight] = useState(null);
  const [tiebreak, setTiebreak] = useState(null);
  const lastPlaySeqRef = useRef(0);
  const lastPlayTimeRef = useRef(0);
  const tiebreakSeqRef = useRef(0);

  useEffect(() => {
    const handleConnect = () => {
      setStatus("Connected");

      const savedName = localStorage.getItem(SAVED_NAME_KEY) || "";
      const roomCode = getRoomCodeFromUrl();

      if (savedName && roomCode) {
        socket.emit("joinRoom", { name: savedName, code: roomCode, clientId: getClientId() }, (response) => {
          if (response && !response.ok) {
            setError(response.message || "Could not rejoin that room.");
          }
        });
      }
    };
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

    if (socket.connected) {
      handleConnect();
    } else {
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

  useEffect(() => {
    if (!isPlaying || !roomState?.currentAge?.id) {
      return undefined;
    }

    // If a Trait was just played in the same update that advanced the Age (the
    // last player's move), hold the Age banner briefly so that play is seen first.
    const sinceLastPlay = Date.now() - lastPlayTimeRef.current;
    const holdForLastPlay = sinceLastPlay < 900 ? 2400 : 0;

    const revealTimer = window.setTimeout(() => setAgeAnnouncement(roomState.currentAge), holdForLastPlay);
    const clearTimer = window.setTimeout(() => setAgeAnnouncement(null), holdForLastPlay + 3200);
    return () => {
      window.clearTimeout(revealTimer);
      window.clearTimeout(clearTimer);
    };
  }, [isPlaying, roomState?.currentAge?.id]);

  useEffect(() => {
    const lastPlay = roomState?.lastPlayedTrait;
    if (!isPlaying || !lastPlay?.seq) {
      return undefined;
    }
    if (lastPlay.seq === lastPlaySeqRef.current) {
      return undefined;
    }
    lastPlaySeqRef.current = lastPlay.seq;
    lastPlayTimeRef.current = Date.now();
    setPlaySpotlight({ ...lastPlay, key: lastPlay.seq });
    const timer = window.setTimeout(() => setPlaySpotlight(null), 3200);
    return () => window.clearTimeout(timer);
  }, [roomState?.lastPlayedTrait?.seq, isPlaying]);

  useEffect(() => {
    const roll = roomState?.tiebreakRoll;
    if (!isPlaying || !roll?.seq || roll.seq === tiebreakSeqRef.current) {
      return undefined;
    }
    tiebreakSeqRef.current = roll.seq;
    setTiebreak(roll);
    const timer = window.setTimeout(() => setTiebreak(null), 3600);
    return () => window.clearTimeout(timer);
  }, [roomState?.tiebreakRoll?.seq, isPlaying]);

  useEffect(() => {
    if (localStorage.getItem(GUIDE_SEEN_KEY)) {
      return;
    }
    setGuidePage(0);
    setGuideOpen(true);
  }, []);

  function openGuide() {
    setGuidePage(0);
    setGuideOpen(true);
  }

  function closeGuide() {
    setGuideOpen(false);
    try {
      localStorage.setItem(GUIDE_SEEN_KEY, "1");
    } catch (storageError) {
      // ignore storage failures (private mode)
    }
  }

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
    const response = await emitAction("createRoom", { name: trimmedName, clientId: getClientId() });

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
    const response = await emitAction("joinRoom", { name: trimmedName, code: trimmedCode, clientId: getClientId() });

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

  async function openCatalog() {
    setCatalogOpen(true);

    if (catalog) {
      return;
    }

    setCatalogError("");

    try {
      const response = await fetch(`${SERVER_URL}/api/catalog`);

      if (!response.ok) {
        throw new Error("Dictionary failed to load.");
      }

      setCatalog(await response.json());
    } catch (_error) {
      setCatalogError("Could not load the dictionary.");
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

  async function passLateWindow() {
    const response = await emitAction("passLate");

    if (!response.ok) {
      setError(response.message || "Could not pass the Late window.");
    }
  }

  async function resolvePendingChoice(choiceId, optionId) {
    const response = await emitAction("resolveChoice", { choiceId, optionId });

    if (!response.ok) {
      setError(response.message || "Could not resolve that choice.");
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
    !roomState?.pendingChoice &&
    !roomState?.pendingDiscard &&
    roomState?.turnState &&
    !roomState.turnState.primaryActionTaken;

  const isLateWindow = Boolean(roomState?.turnState?.lateWindow);
  const canPassLate = roomState?.isYourTurn && isLateWindow && !roomState?.pendingChoice && !roomState?.pendingDiscard;
  const isWaitingForChoice = Boolean(roomState?.pendingChoice);
  const allowedColors = roomState?.turnState?.allowedColors || [];
  const canEndTurn =
    roomState?.isYourTurn &&
    !isLateWindow &&
    !roomState?.pendingChoice &&
    !roomState?.pendingDiscard &&
    roomState?.turnState?.primaryActionTaken &&
    roomState.turnState.playsRemaining > 0;
  const canPlayTraitCard = (card) => {
    if (!roomState?.isYourTurn || roomState.pendingDiscard || roomState.pendingChoice) {
      return false;
    }

    if (isLateWindow && !card.keywords?.includes("Late")) {
      return false;
    }

    if (allowedColors.length && !allowedColors.includes(card.color)) {
      return false;
    }

    return true;
  };

  const extraTurnText =
    roomState?.isYourTurn && isLateWindow
      ? "Late window"
      : roomState?.isYourTurn && isWaitingForChoice
        ? "Choice pending"
        : roomState?.isYourTurn && allowedColors.length
          ? `Next play: ${allowedColors.join(" or ")} only`
          : roomState?.isYourTurn && roomState?.turnState?.playsRemaining > 1
            ? `${roomState.turnState.playsRemaining} plays left this turn`
            : roomState?.isYourTurn && roomState?.turnState?.playsRemaining === 1
              ? "1 play left this turn"
              : "";

  const catalogModal = (
    <CatalogModal
      catalog={catalog}
      error={catalogError}
      isOpen={catalogOpen}
      activeTab={catalogTab}
      search={catalogSearch}
      onOpen={openCatalog}
      onClose={() => setCatalogOpen(false)}
      onTabChange={setCatalogTab}
      onSearchChange={setCatalogSearch}
    />
  );

  const guideModal = (
    <FieldGuideModal
      isOpen={guideOpen}
      page={guidePage}
      onClose={closeGuide}
      onGoto={(index) => setGuidePage(index)}
      onPrev={() => setGuidePage((value) => Math.max(0, value - 1))}
      onNext={() => setGuidePage((value) => Math.min(FIELD_GUIDE_PAGES.length - 1, value + 1))}
    />
  );

  if (!roomState) {
    return (
      <main className="app-shell">
        <section className="panel panel--hero landing-panel">
          <div>
            <p className="eyebrow">Local Multiplayer Evolution Game</p>
            <h1>Critterfall</h1>
            <p className="lede">
              Grow your Gene Pool, build a public Trait Row, steal questionable organs, poison rivals, survive randomized Ages,
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
            <div className="split-fields">
              <button className="secondary-button" type="button" onClick={openGuide}>
                📖 Field Guide
              </button>
              <button className="secondary-button" type="button" onClick={openCatalog}>
                Card Dictionary
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
            <p>Create a room, share the room code or invite link, then build public Trait Rows across randomized Ages.</p>
          </article>
          <article className="panel">
            <h3>Public Trait Rows</h3>
            <p>Played Traits are public with full text, color, keywords, poison, Dominant, and Parasite status.</p>
          </article>
          <article className="panel">
            <h3>Private Hands</h3>
            <p>Hands stay private unless a reveal effect exposes every card with full text.</p>
          </article>
        </section>
        {catalogModal}
        {guideModal}
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
                <button className="secondary-button" type="button" onClick={openGuide}>
                  📖 Field Guide
                </button>
                <button className="secondary-button" type="button" onClick={openCatalog}>
                  Card Dictionary
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
        {catalogModal}
        {guideModal}
      </main>
    );
  }

  if (isPlaying) {
    return (
      <main className="app-shell">
        <AgeAnnouncement age={ageAnnouncement} />
        <PlaySpotlight play={playSpotlight} />
        <TiebreakRoll roll={tiebreak} />
        <section key={roomState.currentAge?.id || "age"} className="panel panel--hero age-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                Age {roomState.currentAge?.number} of {roomState.ageDeckCount || roomState.currentAge?.total || 9}
              </p>
              <h1>
                {roomState.currentAge?.emoji} {roomState.currentAge?.name}
              </h1>
              <p className="lede">{roomState.currentAge?.text}</p>
              {ageRuleLabels(roomState.ageRules).length ? (
                <div className="age-rules">
                  {ageRuleLabels(roomState.ageRules).map((label) => (
                    <span key={label} className="rule-pill">
                      {label}
                    </span>
                  ))}
                </div>
              ) : null}
              {roomState.nextAgePreview ? (
                <p className="next-age-preview">
                  Next Age: {roomState.nextAgePreview.emoji} <strong>{roomState.nextAgePreview.name}</strong> — {roomState.nextAgePreview.text}
                </p>
              ) : null}
            </div>
            <div className="status-strip">
              <span className="meta-pill">Room {roomState.code}</span>
              {roomState.currentAge?.isCatastrophe ? <span className="status-pill">Catastrophe</span> : null}
              <span className="meta-pill">Deck {roomState.drawPileCount}</span>
              <span className="meta-pill">Discard {roomState.discardPileCount}</span>
            </div>
          </div>

          <div
            key={roomState.currentPlayerId}
            className={`turn-banner${roomState.isYourTurn ? " turn-banner--you" : " turn-banner--waiting"}`}
          >
            <span className="turn-banner__pulse" aria-hidden="true" />
            <span className="turn-banner__icon" aria-hidden="true">
              {roomState.isYourTurn ? "🎯" : "⏳"}
            </span>
            <strong className="turn-banner__label">
              {roomState.isYourTurn ? "Your turn!" : `${roomState.currentPlayerName}'s turn`}
            </strong>
            {extraTurnText ? <span className="meta-pill">{extraTurnText}</span> : null}
            {roomState.pendingDiscard ? <span className="meta-pill">{roomState.pendingDiscard.reason}</span> : null}
            {roomState.pendingChoice ? <span className="meta-pill">Resolving {roomState.pendingChoice.sourceCardName}</span> : null}
          </div>

          <div className="action-row">
            <button
              className="secondary-button"
              type="button"
              onClick={canPassLate ? passLateWindow : skipCurrentTurn}
              disabled={canPassLate ? false : !(canSkip || canEndTurn)}
            >
              {canPassLate ? "Pass Late" : canEndTurn ? "End Turn" : "Skip and Draw 2"}
            </button>
            <button className="secondary-button" type="button" onClick={openGuide}>
              📖 Field Guide
            </button>
            <button className="secondary-button" type="button" onClick={openCatalog}>
              Dictionary
            </button>
            <span className="muted-text">
              {isLateWindow
                ? "Play a Late Trait now, or pass so the next player can act."
                : allowedColors.length
                  ? `Your next Trait must be ${allowedColors.join(" or ")}.`
                : "Dominant Traits resist stealing and destruction. Poison resolves when the Age stabilizes."}
            </span>
          </div>

          {error ? <p className="error-text">{error}</p> : null}
        </section>

        <PendingChoicePanel choice={roomState.pendingChoice} onResolve={resolvePendingChoice} />

        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Your Hand</h2>
              <p>Play one Trait, then draw back up toward your Gene Pool.</p>
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
                      : !canPlayTraitCard(card)
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
              dimmed={player.id !== roomState.currentPlayerId}
            />
          ))}
        </section>

        <LogPanel log={roomState.log} />
        {catalogModal}
        {guideModal}
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
        {catalogModal}
        {guideModal}
      </main>
    );
  }

  return null;
}

export default App;
