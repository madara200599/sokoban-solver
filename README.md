[![sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/madara200599/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/madara200599/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# Sokoban solver

A push-optimal Sokoban solver for the make.fun `sokoban-solver-01-run-20261121` bounty. One program (`main.ts`, Node 22, stdlib only) answers a whole set of 5 levels in a single run, writing the player's moves to `/output/<id>/solution.txt` for each.

## How it works

The levels are a hallway with one to four rooms off it, and a box pushed out of a room can never come back, so the rooms are independent problems:

1. **Split into rooms.** The dead squares of the player's row (the hallway: a box there reaches no goal) are cut out of the floor; each remaining floor component holding boxes is a room, with its own boxes, goals and door.
2. **Solve each room push-optimally.** A push-based A* search: a state is the room's boxes plus the player's reachable region (named by its lowest square). The heuristic is the minimum assignment of boxes to goals by shortest-path distances on the open floor, which no push can beat by more than one, so the first solved state popped is push-optimal. Dead states are pruned with two sound rules: boxes on dead squares (no push sequence, ignoring the other boxes, reaches a goal) and frozen 2×2 blocks of walls and boxes holding a box off its goal.
3. **Concatenate.** The rooms' move strings are joined, walking the player between rooms along the hallway; the walk to each push is the shortest path around walls and boxes.

Budgets are counted in search states, never in wall-clock time, so two runs over the same set always write the same bytes. A greedy best-first fallback and a whole-level search cover rooms the A* gives up on, so every instance is always answered.

## Measured practice-set score

Run on the kit's practice set (`practice/input`, scored against `practice/reference`):

| instance | pushes | P* | points |
|----------|--------|----|--------|
| i001 | 13 | 13 | 1000 |
| i002 | 16 | 16 | 1000 |
| i003 | 29 | 29 | 1000 |
| i004 | 47 | 47 | 1000 |
| i005 | 60 | 60 | 1000 |
| **total** | | | **5000 / 5000 — score 1,000,000** |

Every instance is solved at exactly its push-optimal count. The whole set takes ~0.3 s; the hardest single room expands 1,952 states (cap 400,000). The house baseline (plain A* over moves, 200,000 expansions a level) scores 200,000 on the same set — it solves only i001 and gives up on i002–i005.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Entered via referral code r7k9dyj1
