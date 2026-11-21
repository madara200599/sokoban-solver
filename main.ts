// Sokoban solver for make.fun sokoban-solver-01-run-20261121.
//
// Strategy: the levels are a hallway with one to four rooms off it, each room
// holding 3 or 4 boxes and as many goals, and a box pushed out of a room can
// never come back, so the rooms are independent problems. This program splits
// a level into its rooms (cut the hallway's dead squares out of the floor and
// take the remaining components that hold boxes), solves each room on its own
// with a push-based A* search, and concatenates the rooms' moves, walking the
// player between rooms along the hallway.
//
// The per-room search is A* over pushes: a state is the rooms' boxes plus the
// player's reachable region (named by its lowest square, so the player's exact
// square inside the region does not multiply the state space). The heuristic
// is the minimum assignment of boxes to goals by shortest-path distances on
// the open floor, which no push can beat by more than one, so it is admissible
// and the first solved state popped is push-optimal. Dead states are pruned
// with two sound rules: a box on a dead square (one from which no sequence of
// pushes, ignoring the other boxes, reaches any goal) and a frozen 2 x 2
// block of walls and boxes holding a box off its goal.
//
// Budgets are counted in search states, never in wall-clock time, so two runs
// over the same set always write the same bytes. Nothing here reads the clock,
// the environment as a source of variation, or any file outside /input.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets (search states). The whole set shares the total budget so one
// hard room can never starve the run past the wall budget.
const MAX_ROOM_STATES = 400_000;
const MAX_GREEDY_STATES = 200_000;
const MAX_WHOLE_STATES = 400_000;
const MAX_TOTAL_STATES = 2_500_000;

// [dx, dy, step letter, push letter]
const DIRS: Array<readonly [number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** The squares from which a box alone can be pushed onto some goal (pulled back from the goals over open floor). */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const size = wall.length;
  const live = new Uint8Array(size);
  const queue = goals.slice();
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= size) continue;
      const behind = y - d;
      if (behind < 0 || behind >= size) continue;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** The lowest square the player reaches from `from` with `occupied` in the way; marks the region in `seen` with `stamp`. */
function reachLow(level: Level, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the player's region from `from` touches any cell of `cells` (a Set of squares, e.g. the hallway). */
function regionTouches(level: Level, occupied: Uint8Array, from: number, cells: Set<number>): boolean {
  const { w, wall } = level;
  const seen = new Uint8Array(wall.length);
  const stack = [from];
  seen[from] = 1;
  for (let i = 0; i < stack.length; i++) {
    const p = stack[i]!;
    if (cells.has(p)) return true;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 0 && occupied[q] === 0 && !seen[q]) {
        seen[q] = 1;
        stack.push(q);
      }
    }
  }
  return false;
}

/** Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls and boxes with a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  const size = wall.length;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= size) continue;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (u first on ties). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const { w, wall } = level;
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array<string>(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= size) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/** Every permutation of 0..n-1 (rooms hold at most 4 boxes, so at most 24). */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const rec = (): void => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  return out;
}

interface SearchResult {
  pushes: number;
  moves: string;
  states: number;
}

/**
 * Push-optimal (A*) or greedy best-first search of `level`: {pushes, moves} or null when the search gives up
 * (budget spent) or the level has no solution. `requireExit` is the set of squares the player's region must touch
 * in a solved state (the hallway, so the player can walk on to the next room); empty means no such requirement.
 * `budget` is the run's shared remaining state budget; the search stops spending it, never the clock.
 */
function searchPushes(
  level: Level,
  maxStates: number,
  budget: { left: number },
  greedy: boolean,
  requireExit: Set<number>,
): SearchResult | null {
  const { w, wall, goals, boxes } = level;
  const size = wall.length;
  const n = boxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  if (boxes.some((b) => !live[b])) return null;
  if (solved(boxes)) return { pushes: 0, moves: '', states: 0 };

  // Shortest-path distance from every goal to every square, over the open floor alone.
  const distToGoal: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(size).fill(-1);
    const q = [g];
    dist[g] = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const p = q[qi]!;
      for (const [dx, dy] of DIRS) {
        const nb = p + dy * w + dx;
        if (nb < 0 || nb >= size || wall[nb] || dist[nb] !== -1) continue;
        dist[nb] = dist[p]! + 1;
        q.push(nb);
      }
    }
    distToGoal.push(dist);
  }
  // Heuristic: with few boxes, the minimum assignment of boxes to goals;
  // with many, the sum of each box's nearest goal. Both are lower bounds on
  // the pushes still needed, so A* stays optimal.
  const useAssignment = n <= 5;
  const perms = useAssignment ? permutations(n) : [];
  const hCache = new Map<number, number>();
  const boxKey = (bs: number[]): number => {
    let k = 0;
    for (const b of bs) k = k * size + b;
    return k;
  };
  const heuristic = (bs: number[]): number => {
    const k = boxKey(bs);
    const cached = hCache.get(k);
    if (cached !== undefined) return cached;
    let best = Infinity;
    if (useAssignment) {
      for (const perm of perms) {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const d = distToGoal[perm[i]!]![bs[i]!]!;
          if (d < 0) {
            s = Infinity;
            break;
          }
          s += d;
        }
        if (s < best) best = s;
      }
    } else {
      best = 0;
      for (const b of bs) {
        let m = Infinity;
        for (let gi = 0; gi < n; gi++) {
          const d = distToGoal[gi]![b]!;
          if (d >= 0 && d < m) m = d;
        }
        if (m === Infinity) {
          best = Infinity;
          break;
        }
        best += m;
      }
    }
    hCache.set(k, best);
    return best;
  };

  // A state's key: the region's lowest square and the boxes' squares. Exact as
  // a number while size ** (n + 1) stays under 2 ** 53, else as a string.
  const numericKeys = size ** (n + 1) < 2 ** 53;
  const keyOf = (bs: number[], low: number): number | string => {
    if (!numericKeys) return `${low}|${bs.join(',')}`;
    let k = low;
    for (const b of bs) k = k * size + b;
    return k;
  };

  // Two stamp arrays: `seen` marks the region of the state being expanded (a
  // push is possible only from inside it), `mark` the region of each state a
  // push makes (its key's lowest square). Sharing one array would let a child's
  // region overwrite its parent's and wrongly kill the parent's other pushes.
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const occupied = new Uint8Array(size);

  // The states in the order found: boxes, the player's square after the pushes
  // that made them, parent, and the push (box square before, direction) that made them.
  const sBoxes: number[][] = [boxes.slice()];
  const sPlayer: number[] = [level.player];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sDir: number[] = [-1];
  const sG: number[] = [0];
  const sKey: Array<number | string> = [];

  for (const b of boxes) occupied[b] = 1;
  const startLow = reachLow(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of boxes) occupied[b] = 0;
  sKey.push(keyOf(boxes, startLow));
  const best = new Map<number | string, number>([[sKey[0]!, 0]]);

  // The open list: a heap on (f, h, insertion order), so ties always break the same way.
  const heap: Array<[number, number, number, number]> = [];
  const heapLess = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      const tmp = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        const tmp = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };

  let seq = 0;
  const h0 = heuristic(boxes);
  if (h0 === Infinity) return null;
  heapPush([greedy ? h0 : h0, h0, seq++, 0]);
  let created = 1;

  while (heap.length > 0) {
    const [, , , s] = heapPop();
    if (best.get(sKey[s]!) !== sG[s]) continue; // a better copy of this state was found since
    const bs = sBoxes[s]!;
    if (solved(bs)) {
      if (requireExit.size === 0) return finish(s, created);
      for (const b of bs) occupied[b] = 1;
      const canLeave = regionTouches(level, occupied, sPlayer[s]!, requireExit);
      for (const b of bs) occupied[b] = 0;
      // Solved but shut in: keep searching for a solution that lets the player out.
      if (canLeave) return finish(s, created);
    }
    for (const b of bs) occupied[b] = 1;
    reachLow(level, occupied, sPlayer[s]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi]!;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di]!;
        const d = dy * w + dx;
        const t = b + d;
        if (t < 0 || t >= size) continue;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = bs.slice();
          next[bi] = t;
          next.sort((a, x) => a - x);
          key = keyOf(next, reachLow(level, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null) continue;
        const g2 = sG[s]! + 1;
        const prevG = best.get(key);
        if (prevG !== undefined && prevG <= g2) continue;
        if (created >= maxStates || budget.left <= 0) {
          for (const x of bs) occupied[x] = 0;
          return null;
        }
        const h2 = heuristic(next);
        if (h2 === Infinity) continue;
        best.set(key, g2);
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(s);
        sFrom.push(b);
        sDir.push(di);
        sG.push(g2);
        sKey.push(key);
        created++;
        budget.left--;
        heapPush([greedy ? h2 : g2 + h2, h2, seq++, sBoxes.length - 1]);
      }
    }
    for (const b of bs) occupied[b] = 0;
  }
  return null;

  function finish(found: number, states: number): SearchResult {
    const path: number[] = [];
    for (let s = found; s > 0; s = sParent[s]!) path.push(s);
    path.reverse();
    let moves = '';
    let player = level.player;
    let curBoxes = boxes.slice();
    for (const s of path) {
      const nextBoxes = sBoxes[s]!;
      const from = sFrom[s]!;
      const di = sDir[s]!;
      const [dx, dy, , pushLetter] = DIRS[di]!;
      const d = dy * w + dx;
      for (const b of curBoxes) occupied[b] = 1;
      moves += walkTo(level, occupied, player, from - d);
      for (const b of curBoxes) occupied[b] = 0;
      moves += pushLetter;
      player = from;
      curBoxes = nextBoxes;
    }
    return { pushes: path.length, moves, states };
  }
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  door: number;
}

interface Decomposition {
  rooms: Room[];
  hall: Set<number>;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a
 * box there reaches no goal) out of the floor, and each part left that holds a
 * box is a room, its squares, boxes, goals and door (the square opening onto
 * the hallway). Falls back to the player's column when the row cut fails, and
 * to null when the level is no set of rooms.
 */
function roomsOf(level: Level): Decomposition | null {
  const { w, h, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  for (const axis of [0, 1]) {
    const cut = new Uint8Array(wall.length);
    const hall = new Set<number>();
    if (axis === 0) {
      const row = Math.floor(player / w);
      for (let x = 0; x < w; x++) {
        const i = row * w + x;
        if (wall[i]) continue;
        hall.add(i);
        if (!live[i]) cut[i] = 1;
      }
    } else {
      const col = player % w;
      for (let y = 0; y < h; y++) {
        const i = y * w + col;
        if (wall[i]) continue;
        hall.add(i);
        if (!live[i]) cut[i] = 1;
      }
    }
    if (boxes.some((b) => cut[b])) continue;
    const part = new Int32Array(wall.length).fill(-1);
    const rooms: Room[] = [];
    for (let s = 0; s < wall.length; s++) {
      if (wall[s] || cut[s] || part[s] >= 0) continue;
      const squares = [s];
      part[s] = rooms.length;
      for (let i = 0; i < squares.length; i++) {
        for (const [dx, dy] of DIRS) {
          const q = squares[i]! + dy * w + dx;
          if (q < 0 || q >= wall.length) continue;
          if (!wall[q] && !cut[q] && part[q] < 0) {
            part[q] = rooms.length;
            squares.push(q);
          }
        }
      }
      rooms.push({ squares, boxes: [], goals: [], door: -1 });
    }
    let ok = true;
    for (const b of boxes) {
      if (part[b]! < 0) {
        ok = false;
        break;
      }
      rooms[part[b]!]!.boxes.push(b);
    }
    if (!ok) continue;
    for (const g of goals) {
      if (part[g]! < 0) {
        ok = false;
        break;
      }
      rooms[part[g]!]!.goals.push(g);
    }
    if (!ok) continue;
    if (rooms.some((r) => r.boxes.length !== r.goals.length)) continue;
    const withBoxes = rooms.filter((r) => r.boxes.length > 0);
    if (withBoxes.length === 0) continue;
    // Each room's door: its square next to a hallway square.
    for (const room of withBoxes) {
      for (const sq of room.squares) {
        for (const [dx, dy] of DIRS) {
          if (hall.has(sq + dy * w + dx)) {
            room.door = sq;
            break;
          }
        }
        if (room.door >= 0) break;
      }
      if (room.door < 0) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    return { rooms: withBoxes, hall };
  }
  return null;
}

/** The level solved room by room: each room's push-optimal solution in turn, the player walking on along the hallway. */
function solveByRooms(level: Level, budget: { left: number }): string | null {
  const decomp = roomsOf(level);
  if (decomp === null) return null;
  const { rooms, hall } = decomp;
  let moves = '';
  let player = level.player;
  const done: boolean[] = rooms.map(() => false);
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri]!;
    // The square outside the room's door, on the hallway, where the player enters from.
    let entry = -1;
    for (const [dx, dy] of DIRS) {
      const q = room.door + dy * level.w + dx;
      if (hall.has(q)) {
        entry = q;
        break;
      }
    }
    if (entry < 0) return null;
    // Walk the player to the door's outside square, around the boxes as they stand now.
    const occupied = new Uint8Array(level.wall.length);
    for (let oj = 0; oj < rooms.length; oj++) {
      for (const b of done[oj] ? rooms[oj]!.goals : rooms[oj]!.boxes) occupied[b] = 1;
    }
    try {
      moves += walkTo(level, occupied, player, entry);
    } catch {
      return null;
    }
    player = entry;
    // The room's own board: its squares plus the hallway, everything else wall, so the
    // search's flood fills stay small and the player never wanders into another room.
    const wall = new Uint8Array(level.wall.length).fill(1);
    for (const sq of room.squares) wall[sq] = 0;
    for (const sq of hall) wall[sq] = 0;
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const needExit = ri < rooms.length - 1;
    const exitReq = needExit ? hall : new Set<number>();
    let solved = searchPushes(sub, MAX_ROOM_STATES, budget, false, new Set<number>());
    if (solved !== null && needExit) {
      // The player must be able to leave the finished room for the next one.
      const end = endOf(level.w, player, solved.moves);
      const occ2 = new Uint8Array(level.wall.length);
      for (const g of room.goals) occ2[g] = 1;
      for (let oj = 0; oj < rooms.length; oj++) {
        if (oj === ri) continue;
        for (const b of done[oj] ? rooms[oj]!.goals : rooms[oj]!.boxes) occ2[b] = 1;
      }
      if (!regionTouches(level, occ2, end, hall)) {
        solved = searchPushes(sub, MAX_ROOM_STATES, budget, false, exitReq);
      }
    }
    if (solved === null) solved = searchPushes(sub, MAX_GREEDY_STATES, budget, true, exitReq);
    if (solved === null) return null;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    done[ri] = true;
  }
  return moves;
}

/** The moves for a level in XSB: '' when the level cannot be solved within budget (still a valid answer). */
function solve(text: string): string {
  const level = parseLevel(text);
  if (level.boxes.length === 0) return '';
  const budget = { left: MAX_TOTAL_STATES };
  try {
    const byRooms = solveByRooms(level, budget);
    if (byRooms !== null) return byRooms;
  } catch {
    // Fall through to the whole-level search.
  }
  try {
    const whole =
      searchPushes(level, MAX_WHOLE_STATES, budget, false, new Set<number>()) ??
      searchPushes(level, MAX_GREEDY_STATES, budget, true, new Set<number>());
    if (whole !== null) return whole.moves;
  } catch {
    // Give up on this level rather than on the whole set.
  }
  return '';
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
