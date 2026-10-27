
import express from "express";
import path from "node:path";
import { createServer } from "node:http";
import { Server, Socket } from "socket.io";
import { randomBytes, randomInt } from "node:crypto";
import fs from "node:fs";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = Number(process.env.PORT) || 3000;
const SAVE_FILE = path.resolve(process.cwd(), "survival-poker-save.json");

type Suit = "♣" | "♦" | "♥" | "♠";
type Card = { id: string; rank: number; suit: Suit };
type Player = {
  id: string;
  token: string;
  nickname: string;
  points: number;
  hand: Card[];
  connected: boolean;
  joinedAt: number;
  eliminated: boolean;
  exchange: number[] | null;
  confirmed: boolean;
  vote: "end" | "continue" | null;
  disconnectTimer?: ReturnType<typeof setTimeout>;
};
type Room = {
  code: string;
  hostId: string;
  players: Player[];
  initialPoints: number;
  started: boolean;
  phase: "waiting" | "exchange" | "result" | "vote" | "ended";
  round: number;
  deck: Card[];
  discard: Card[];
  deadline: number | null;
  result: any;
  startingBalances: Record<string, number>;
  exchangeTimer?: ReturnType<typeof setTimeout>;
  nextTimer?: ReturnType<typeof setTimeout>;
  voteTimer?: ReturnType<typeof setTimeout>;
  feeApplied: boolean;
};

const rooms = new Map<string, Room>();

type MatchQueueEntry = {
  socket: Socket;
  nickname: string;
  initialPoints: number;
  token: string;
  joinedAt: number;
};
const matchmakingQueues = new Map<number, MatchQueueEntry[]>();
const SUITS: Suit[] = ["♣", "♦", "♥", "♠"];
const RANK_NAMES = [
  "", "", "2", "3", "4", "5", "6", "7",
  "8", "9", "10", "J", "Q", "K", "A"
];
const SUIT_ORDER: Record<Suit, number> = {
  "♣": 0, "♦": 1, "♥": 2, "♠": 3
};
const HAND_NAMES = [
  "ハイカード", "ワンペア", "ツーペア", "スリーカード",
  "ストレート", "フラッシュ", "フルハウス",
  "フォーカード", "ストレートフラッシュ", "ロイヤルフラッシュ"
];

function createMatchedRoom(group: MatchQueueEntry[]) {
  if (group.length !== 5) throw new Error("マッチング人数は5人である必要があります");

  const code = makeCode();
  const players: Player[] = group.map(entry => ({
    id: entry.socket.id,
    token: entry.token,
    nickname: entry.nickname,
    points: entry.initialPoints,
    hand: [],
    connected: true,
    joinedAt: entry.joinedAt,
    eliminated: false,
    exchange: null,
    confirmed: false,
    vote: null
  }));

  const r: Room = {
    code,
    hostId: players[0].id,
    players,
    initialPoints: group[0].initialPoints,
    started: true,
    phase: "waiting",
    round: 0,
    deck: [],
    discard: [],
    deadline: null,
    result: null,
    startingBalances: Object.fromEntries(players.map(p => [p.id, p.points])),
    feeApplied: false
  };

  rooms.set(code, r);

  for (const entry of group) {
    entry.socket.join(code);
    entry.socket.emit("session:token", { token: entry.token, code });
    entry.socket.emit("matchmaking:matched", { code, token: entry.token });
  }

  io.to(code).emit("game:started", { message: "5人そろいました！ゲーム開始！" });
  dealRound(r);
  updateRoom(r);
}

function processMatchmakingQueue(initialPoints: number) {
  let queue = matchmakingQueues.get(initialPoints);
  if (!queue || queue.length < 5) return;

  while (queue.length >= 5) {
    const shuffled = [...queue];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const group = shuffled.slice(0, 5);
    const groupIds = new Set(group.map(entry => entry.socket.id));
    queue = queue.filter(entry => !groupIds.has(entry.socket.id));

    if (queue.length > 0) {
      matchmakingQueues.set(initialPoints, queue);
    } else {
      matchmakingQueues.delete(initialPoints);
    }

    createMatchedRoom(group);
  }
}
function makeCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "";
  do {
    value = Array.from(
      { length: 6 },
      () => chars[randomInt(chars.length)]
    ).join("");
  } while (rooms.has(value));
  return value;
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function makeDeck(): Card[] {
  const deck: Card[] = [];
  for (let pack = 0; pack < 3; pack++) {
    for (const suit of SUITS) {
      for (let rank = 2; rank <= 14; rank++) {
        deck.push({
          id: `${pack}-${suit}-${rank}-${randomBytes(3).toString("hex")}`,
          rank,
          suit
        });
      }
    }
  }
  return shuffle(deck);
}

function evaluate(hand: Card[]) {
  const ranks = hand.map(c => c.rank).sort((a, b) => b - a);
  const counts = new Map<number, number>();
  ranks.forEach(n => counts.set(n, (counts.get(n) || 0) + 1));

  const groups = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || b[0] - a[0]
  );
  const flush = hand.every(c => c.suit === hand[0].suit);
  const unique = [...new Set(ranks)].sort((a, b) => b - a);

  let straightHigh = 0;
  if (unique.length === 5 && unique[0] - unique[4] === 4) {
    straightHigh = unique[0];
  }
  if (unique.join(",") === "14,5,4,3,2") straightHigh = 5;

  let category = 0;
  let tie: number[] = [];

  if (flush && straightHigh === 14) {
    category = 9; tie = [14];
  } else if (flush && straightHigh) {
    category = 8; tie = [straightHigh];
  } else if (groups[0][1] === 4) {
    category = 7; tie = [groups[0][0], groups[1][0]];
  } else if (groups[0][1] === 3 && groups[1][1] === 2) {
    category = 6; tie = [groups[0][0], groups[1][0]];
  } else if (flush) {
    category = 5; tie = ranks;
  } else if (straightHigh) {
    category = 4; tie = [straightHigh];
  } else if (groups[0][1] === 3) {
    category = 3;
    tie = [
      groups[0][0],
      ...groups.slice(1).map(x => x[0]).sort((a, b) => b - a)
    ];
  } else if (groups[0][1] === 2 && groups[1][1] === 2) {
    category = 2;
    tie = [
      Math.max(groups[0][0], groups[1][0]),
      Math.min(groups[0][0], groups[1][0]),
      groups[2][0]
    ];
  } else if (groups[0][1] === 2) {
    category = 1;
    tie = [
      groups[0][0],
      ...groups.slice(1).map(x => x[0]).sort((a, b) => b - a)
    ];
  } else {
    category = 0; tie = ranks;
  }

  return { category, tie, name: HAND_NAMES[category] };
}

function compareHands(a: Card[], b: Card[]): number {
  const x = evaluate(a);
  const y = evaluate(b);

  if (x.category !== y.category) return x.category - y.category;

  for (let i = 0; i < Math.max(x.tie.length, y.tie.length); i++) {
    const diff = (x.tie[i] || 0) - (y.tie[i] || 0);
    if (diff !== 0) return diff;
  }

  const sa = [...a].sort(
    (u, v) => v.rank - u.rank || SUIT_ORDER[v.suit] - SUIT_ORDER[u.suit]
  );
  const sb = [...b].sort(
    (u, v) => v.rank - u.rank || SUIT_ORDER[v.suit] - SUIT_ORDER[u.suit]
  );

  for (let i = 0; i < 5; i++) {
    if (sa[i].rank !== sb[i].rank) return sa[i].rank - sb[i].rank;
  }
  for (let i = 0; i < 5; i++) {
    if (SUIT_ORDER[sa[i].suit] !== SUIT_ORDER[sb[i].suit]) {
      return SUIT_ORDER[sa[i].suit] - SUIT_ORDER[sb[i].suit];
    }
  }
  return 0;
}

function saveRooms() {
  try {
    const snapshot = [...rooms.values()].map(r => ({
      ...r,
      exchangeTimer: undefined,
      nextTimer: undefined,
      voteTimer: undefined,
      players: r.players.map(p => ({
        ...p,
        connected: false,
        disconnectTimer: undefined
      }))
    }));
    fs.writeFileSync(SAVE_FILE, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (error) {
    console.error("保存エラー:", error);
  }
}

function publicRoom(r: Room) {
  return {
    code: r.code,
    hostId: r.hostId,
    initialPoints: r.initialPoints,
    started: r.started,
    phase: r.phase,
    round: r.round,
    deadline: r.deadline,
    result: r.result,
    players: r.players.map(p => ({
      id: p.id,
      nickname: p.nickname,
      points: p.points,
      connected: p.connected,
      eliminated: p.eliminated,
      confirmed: p.confirmed,
      isHost: p.id === r.hostId
    })),
    survivorCount: r.players.filter(p => !p.eliminated).length
  };
}

function privateState(r: Room, p: Player) {
  return {
    room: publicRoom(r),
    hand: p.hand.map(c => ({
      id: c.id,
      rank: c.rank,
      rankName: RANK_NAMES[c.rank],
      suit: c.suit
    })),
    exchange: p.exchange,
    confirmed: p.confirmed,
    vote: p.vote,
    isHost: p.id === r.hostId,
    me: {
      id: p.id,
      nickname: p.nickname,
      points: p.points,
      eliminated: p.eliminated
    }
  };
}

function broadcast(r: Room) {
  io.to(r.code).emit("room:updated", publicRoom(r));
  saveRooms();
}

function sendPrivateStates(r: Room) {
  for (const p of r.players) {
    if (p.connected) io.to(p.id).emit("game:state", privateState(r, p));
  }
}

function updateRoom(r: Room) {
  broadcast(r);
  sendPrivateStates(r);
}

function alivePlayers(r: Room) {
  return r.players.filter(p => !p.eliminated);
}

function dealRound(r: Room) {
  const alive = alivePlayers(r);
  if (alive.length <= 1) {
    finishGame(r, alive[0]?.id || null, "最後の1人が残りました。");
    return;
  }

  r.round++;
  r.phase = "exchange";
  r.result = null;
  r.deck = makeDeck();
  r.discard = [];

  for (const p of alive) {
    p.hand = Array.from({ length: 5 }, () => r.deck.pop()!);
    p.exchange = null;
    p.confirmed = false;
    p.vote = null;
  }

  r.deadline = Date.now() + 30000;
  clearTimeout(r.exchangeTimer);
  r.exchangeTimer = setTimeout(() => {
    for (const p of alivePlayers(r)) {
      if (!p.confirmed) {
        p.exchange = [];
        p.confirmed = true;
      }
    }
    completeExchange(r);
  }, 30000);

  io.to(r.code).emit("game:notice", {
    message: `ラウンド${r.round}開始！交換するカードを選んでください（30秒）。`
  });
  updateRoom(r);
}

function completeExchange(r: Room) {
  if (r.phase !== "exchange") return;
  clearTimeout(r.exchangeTimer);

  const alive = alivePlayers(r);

  // 先に全員の捨て札を集め、交換選択が確定してから山札を補充する。
  for (const p of alive) {
    const indices = p.exchange || [];
    const oldHand = p.hand;
    p.hand = oldHand.filter((_, i) => !indices.includes(i));
    r.discard.push(...oldHand.filter((_, i) => indices.includes(i)));
  }

  const need = alive.reduce((n, p) => n + (p.exchange?.length || 0), 0);
  if (r.deck.length < need) {
    r.deck = shuffle([...r.deck, ...r.discard]);
    r.discard = [];
  }

  for (const p of alive) {
    for (let i = 0; i < (p.exchange?.length || 0); i++) {
      p.hand.push(r.deck.pop()!);
    }
  }

  r.phase = "result";
  r.deadline = Date.now() + 10000;

  const scored = alive.map(p => ({
    id: p.id,
    nickname: p.nickname,
    points: p.points,
    hand: p.hand.map(c => ({
      rank: c.rank,
      rankName: RANK_NAMES[c.rank],
      suit: c.suit
    })),
    rank: evaluate(p.hand)
  }));

  let weakest = alive[0];
  for (const p of alive.slice(1)) {
    if (compareHands(p.hand, weakest.hand) < 0) weakest = p;
  }

  const losers = alive.filter(p => compareHands(p.hand, weakest.hand) === 0);

  if (losers.length === alive.length) {
    r.result = {
      message: "全員同じ強さのため脱落なし。新しい手札で再戦します。",
      scored,
      eliminated: [],
      transfers: []
    };
  } else {
    const pool = losers.reduce((sum, p) => sum + p.points, 0);
    for (const p of losers) {
      p.eliminated = true;
      p.points = 0;
    }

    const survivors = alivePlayers(r).sort((a, b) => a.joinedAt - b.joinedAt);
    const each = Math.floor(pool / survivors.length);
    const remainder = pool % survivors.length;

    const transfers = survivors.map((p, i) => {
      const amount = each + (i < remainder ? 1 : 0);
      p.points += amount;
      return { nickname: p.nickname, amount };
    });

    r.result = {
      message: `最弱の${losers.map(p => p.nickname).join("、")}が脱落しました。`,
      scored,
      eliminated: losers.map(p => p.nickname),
      transfers
    };
  }

  updateRoom(r);
  io.to(r.code).emit("game:result", r.result);

  clearTimeout(r.nextTimer);
  r.nextTimer = setTimeout(() => advance(r), 10000);
}

function advance(r: Room) {
  if (r.phase === "ended") return;
  const alive = alivePlayers(r);

  if (alive.length <= 1) {
    finishGame(r, alive[0]?.id || null, "最後の1人が残りました。");
  } else if (alive.length === 2 || alive.length === 3) {
    startVote(r);
  } else {
    dealRound(r);
  }
}

function startVote(r: Room) {
  r.phase = "vote";
  r.deadline = Date.now() + 30000;

  for (const p of alivePlayers(r)) p.vote = null;

  io.to(r.code).emit("game:notice", {
    message: `残り${alivePlayers(r).length}人です。終了か続行かを投票してください。未投票は続行扱いです。`
  });

  updateRoom(r);
  clearTimeout(r.voteTimer);
  r.voteTimer = setTimeout(() => resolveVote(r), 30000);
}

function resolveVote(r: Room) {
  if (r.phase !== "vote") return;
  clearTimeout(r.voteTimer);

  const alive = alivePlayers(r).sort((a, b) => a.joinedAt - b.joinedAt);
  const ends = alive.filter(p => p.vote === "end").length;
  let end = false;
  let note = "";

  if (alive.length === 3) {
    end = ends >= 2;
    note = end ? "終了が多数決で決まりました。" : "続行が多数決で決まりました。";
  } else {
    const votes = alive.map(p => p.vote === "end");
    if (votes.every(Boolean)) {
      end = true;
      note = "両者が終了を選びました。";
    } else if (votes.every(v => !v)) {
      end = false;
      note = "両者が続行を選びました。";
    } else {
      end = randomInt(2) === 0;
      note = `意見が分かれたため抽選し、${end ? "終了" : "続行"}となりました。`;
    }
  }

  io.to(r.code).emit("game:notice", { message: note });
  if (end) finishGame(r, null, note);
  else dealRound(r);
}

function finishGame(r: Room, winnerId: string | null, reason: string) {
  if (r.phase === "ended") return;

  clearTimeout(r.exchangeTimer);
  clearTimeout(r.nextTimer);
  clearTimeout(r.voteTimer);

  r.phase = "ended";
  r.deadline = null;

  if (!r.feeApplied) {
    for (const p of alivePlayers(r)) {
      p.points -= Math.floor(p.points * 0.1);
    }
    r.feeApplied = true;
  }

  r.result = {
    message: reason,
    winner: r.players.find(p => p.id === winnerId)?.nickname || null,
    feeRate: "10%",
    players: r.players.map(p => ({
      nickname: p.nickname,
      points: p.points,
      eliminated: p.eliminated
    }))
  };

  updateRoom(r);
  io.to(r.code).emit("game:ended", r.result);

  r.nextTimer = setTimeout(() => {
    r.started = false;
    r.phase = "waiting";
    r.round = 0;
    r.result = null;
    r.feeApplied = false;

    for (const p of r.players) {
      p.points = r.initialPoints;
      p.hand = [];
      p.eliminated = false;
      p.exchange = null;
      p.confirmed = false;
      p.vote = null;
    }
    updateRoom(r);
  }, 30000);
}

function leavePlayer(r: Room, p: Player) {
  if (p.disconnectTimer) clearTimeout(p.disconnectTimer);

  if (r.phase === "waiting" || r.phase === "ended") {
    r.players = r.players.filter(x => x.id !== p.id);
  } else if (!p.eliminated) {
    p.eliminated = true;
    const pool = p.points;
    p.points = 0;

    const survivors = alivePlayers(r).sort((a, b) => a.joinedAt - b.joinedAt);
    if (survivors.length > 0) {
      const each = Math.floor(pool / survivors.length);
      const remainder = pool % survivors.length;
      survivors.forEach((x, i) => {
        x.points += each + (i < remainder ? 1 : 0);
      });
    }
  }

  if (r.hostId === p.id) {
    r.hostId = r.players.find(x => !x.eliminated)?.id || r.players[0]?.id || "";
  }

  if (r.players.length === 0) {
    rooms.delete(r.code);
    saveRooms();
    return;
  }

  if (
    r.phase === "exchange" &&
    alivePlayers(r).length > 0 &&
    alivePlayers(r).every(x => x.confirmed)
  ) {
    completeExchange(r);
  } else if (r.started && alivePlayers(r).length <= 1) {
    finishGame(r, alivePlayers(r)[0]?.id || null, "退出によりゲームが終了しました。");
  }

  updateRoom(r);
}

function restoreRooms() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));

    for (const old of saved) {
      const r: Room = {
        ...old,
        players: old.players.map((p: Player) => ({
          ...p,
          connected: false,
          disconnectTimer: undefined
        })),
        exchangeTimer: undefined,
        nextTimer: undefined,
        voteTimer: undefined
      };

      // サーバー再起動中の対戦は中止し、ポイントを初期値へ戻す。
      if (r.started && r.phase !== "waiting") {
        r.started = false;
        r.phase = "waiting";
        r.round = 0;
        r.result = null;
        r.deadline = null;

        for (const p of r.players) {
          p.points = r.initialPoints;
          p.hand = [];
          p.eliminated = false;
          p.exchange = null;
          p.confirmed = false;
          p.vote = null;
        }
      }

      rooms.set(r.code, r);
    }
  } catch (error) {
    console.error("保存データの読み込みに失敗:", error);
  }
}

restoreRooms();

app.use(express.static(path.resolve(process.cwd(), "../client")));
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "SURVIVAL POKER B" });
});

io.on("connection", (socket: Socket) => {
  socket.on("matchmaking:join", (data: any, cb: any) => {
    const nickname = String(data?.nickname ?? "").trim();
    const initialPoints = Number(data?.initialPoints ?? 10000);

    if (!nickname || nickname.length > 20) {
      cb?.({ ok: false, error: "ニックネームは1～20文字で入力してください。" });
      return;
    }
    if (!Number.isInteger(initialPoints) || initialPoints < 5000 ||
        initialPoints > 50000 || initialPoints % 5000 !== 0) {
      cb?.({ ok: false, error: "初期ポイントは5,000～50,000の5,000刻みです。" });
      return;
    }

    const queue = matchmakingQueues.get(initialPoints) ?? [];
    if (queue.some(entry => entry.nickname.toLowerCase() === nickname.toLowerCase())) {
      cb?.({ ok: false, error: "同じ初期ポイントの待機列に同じニックネームがいます。" });
      return;
    }
    if ([...rooms.values()].some(room =>
      room.players.some(player =>
        player.connected && player.nickname.toLowerCase() === nickname.toLowerCase()
      )
    )) {
      cb?.({ ok: false, error: "このニックネームは現在ゲームで使用されています。" });
      return;
    }

    const entry: MatchQueueEntry = {
      socket,
      nickname,
      initialPoints,
      token: randomBytes(24).toString("hex"),
      joinedAt: Date.now()
    };

    queue.push(entry);
    matchmakingQueues.set(initialPoints, queue);
    cb?.({ ok: true, waiting: true, initialPoints, position: queue.length });
    socket.emit("matchmaking:waiting", {
      initialPoints,
      position: queue.length,
      needed: 5 - queue.length
    });

    processMatchmakingQueue(initialPoints);
  });

  socket.on("matchmaking:cancel", (_data: any, cb: any) => {
    let removed = false;
    for (const [points, queue] of matchmakingQueues) {
      const remaining = queue.filter(entry => entry.socket.id !== socket.id);
      if (remaining.length !== queue.length) {
        removed = true;
        if (remaining.length) matchmakingQueues.set(points, remaining);
        else matchmakingQueues.delete(points);
      }
    }
    cb?.({ ok: true, removed });
  });

  socket.on("room:create", (data: any, cb: any) => {
    const nickname = String(data?.nickname ?? "").trim();
    const initialPoints = Number(data?.initialPoints ?? 10000);

    if (!nickname || nickname.length > 20) {
      cb?.({ ok: false, error: "名前は1〜20文字で入力してください。" });
      return;
    }
    if (
      !Number.isInteger(initialPoints) ||
      initialPoints < 5000 ||
      initialPoints > 50000 ||
      initialPoints % 5000 !== 0
    ) {
      cb?.({ ok: false, error: "初期ポイントは5,000〜50,000の5,000刻みです。" });
      return;
    }

    const token = randomBytes(24).toString("hex");
    const p: Player = {
      id: socket.id, token, nickname, points: initialPoints,
      hand: [], connected: true, joinedAt: Date.now(),
      eliminated: false, exchange: null, confirmed: false, vote: null
    };
    const r: Room = {
      code: makeCode(), hostId: socket.id, players: [p],
      initialPoints, started: false, phase: "waiting", round: 0,
      deck: [], discard: [], deadline: null, result: null,
      startingBalances: { [socket.id]: initialPoints }, feeApplied: false
    };

    rooms.set(r.code, r);
    socket.join(r.code);
    socket.emit("session:token", { token, code: r.code });
    cb?.({ ok: true, code: r.code, token });
    updateRoom(r);
  });

  socket.on("room:join", (data: any, cb: any) => {
    const c = String(data?.code ?? "").trim().toUpperCase();
    const nickname = String(data?.nickname ?? "").trim();
    const r = rooms.get(c);

    if (!nickname || nickname.length > 20) {
      cb?.({ ok: false, error: "名前は1〜20文字で入力してください。" });
      return;
    }
    if (!r) {
      cb?.({ ok: false, error: "ルームが見つかりません。" });
      return;
    }
    if (r.started || r.phase !== "waiting") {
      cb?.({ ok: false, error: "ゲーム開始後は新しいプレイヤーとして参加できません。" });
      return;
    }
    if (r.players.length >= 6) {
      cb?.({ ok: false, error: "このルームは満員です。" });
      return;
    }
    if (r.players.some(p => p.nickname.toLowerCase() === nickname.toLowerCase())) {
      cb?.({ ok: false, error: "同じ名前のプレイヤーがいます。" });
      return;
    }

    const token = randomBytes(24).toString("hex");
    const p: Player = {
      id: socket.id, token, nickname, points: r.initialPoints,
      hand: [], connected: true, joinedAt: Date.now(),
      eliminated: false, exchange: null, confirmed: false, vote: null
    };
    r.players.push(p);
    socket.join(r.code);
    socket.emit("session:token", { token, code: r.code });
    cb?.({ ok: true, code: r.code, token });

    if (r.players.length === 6) {
      r.started = true;
      r.startingBalances = Object.fromEntries(r.players.map(x => [x.id, x.points]));
      io.to(r.code).emit("game:started", {
        message: "6人そろいました！ゲーム開始！"
      });
      dealRound(r);
    }

    updateRoom(r);
  });

  socket.on("session:resume", (data: any, cb: any) => {
    const r = rooms.get(String(data?.code ?? "").toUpperCase());
    const p = r?.players.find(x => x.token === data?.token);

    if (!r || !p) {
      cb?.({ ok: false, error: "再接続できません。ルームに入り直してください。" });
      return;
    }

    if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
    const oldId = p.id;
    p.id = socket.id;
    p.connected = true;
    if (r.hostId === oldId) r.hostId = socket.id;
    socket.join(r.code);
    cb?.({ ok: true, code: r.code });
    updateRoom(r);
  });

  socket.on("room:leave", () => {
    const r = [...rooms.values()].find(x => x.players.some(p => p.id === socket.id));
    const p = r && r.players.find(x => x.id === socket.id);
    if (r && p) leavePlayer(r, p);

    for (const c of [...socket.rooms]) {
      if (c !== socket.id) socket.leave(c);
    }
  });

  socket.on("exchange:confirm", (data: any, cb: any) => {
    const r = [...rooms.values()].find(x => x.players.some(p => p.id === socket.id));
    const p = r?.players.find(x => x.id === socket.id);

    if (!r || !p || r.phase !== "exchange" || p.eliminated) {
      cb?.({ ok: false, error: "今は交換できません。" });
      return;
    }
    if (p.confirmed) {
      cb?.({ ok: false, error: "すでに交換内容を確定しています。" });
      return;
    }

    const indices: number[] = Array.isArray(data?.indices)
      ? [...new Set(data.indices.filter(
          (n: any) => Number.isInteger(n) && n >= 0 && n < 5
        ))]
      : [];

    if (indices.length > 5) {
      cb?.({ ok: false, error: "交換は最大5枚です。" });
      return;
    }

    p.exchange = indices;
    p.confirmed = true;
    cb?.({ ok: true });
    updateRoom(r);

    if (alivePlayers(r).every(x => x.confirmed)) completeExchange(r);
  });

  socket.on("vote:cast", (data: any, cb: any) => {
    const r = [...rooms.values()].find(x => x.players.some(p => p.id === socket.id));
    const p = r?.players.find(x => x.id === socket.id);

    if (!r || !p || r.phase !== "vote" || p.eliminated) {
      cb?.({ ok: false, error: "今は投票できません。" });
      return;
    }
    if (p.vote !== null) {
      cb?.({ ok: false, error: "すでに投票済みです。" });
      return;
    }
    if (data?.vote !== "end" && data?.vote !== "continue") {
      cb?.({ ok: false, error: "投票内容が不正です。" });
      return;
    }

    p.vote = data.vote;
    cb?.({ ok: true });
    updateRoom(r);

    if (alivePlayers(r).every(x => x.vote !== null)) resolveVote(r);
  });

  socket.on("disconnect", () => {
    for (const [points, queue] of matchmakingQueues) {
      const remaining = queue.filter(entry => entry.socket.id !== socket.id);
      if (remaining.length !== queue.length) {
        if (remaining.length > 0) matchmakingQueues.set(points, remaining);
        else matchmakingQueues.delete(points);
      }
    }


    const r = [...rooms.values()].find(x => x.players.some(p => p.id === socket.id));
    const p = r?.players.find(x => x.id === socket.id);
    if (!r || !p) return;

    p.connected = false;
    if (p.disconnectTimer) clearTimeout(p.disconnectTimer);

    p.disconnectTimer = setTimeout(() => {
      const current = rooms.get(r.code);
      const player = current?.players.find(x => x.token === p.token);
      if (current && player && !player.connected) leavePlayer(current, player);
    }, 60000);

    updateRoom(r);
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`SURVIVAL POKER B server: http://localhost:${PORT}`);
});
