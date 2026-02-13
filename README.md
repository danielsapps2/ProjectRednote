# Gravity Glyphs

Gravity Glyphs is a browser-first 2D puzzle platformer inspired by gravity-flip games, but with its own twist:

- **Space** flips gravity instantly.
- **Shift** (or **X**) fires a **phase pulse** that rotates nearby moving hazard beams.
- Levels are authored in a tiny text format and can also be procedurally generated.

## Controls

- `A/D` or `←/→`: move
- `W` or `↑`: jump
- `Space`: flip gravity
- `Shift` or `X`: phase pulse
- `R`: respawn room
- `N`: skip to next room

## Run locally

```bash
npm install
npm run dev
```

Open the shown local URL in your browser.

## Level text format

Rooms are split by `===` and require both `S` (spawn) and `G` (goal).

```txt
name=My Puzzle
map:
############################
#S.........................#
#............^.............#
#..............*...........#
#......................G...#
############################
===
name=Second Puzzle
map:
...
```

### Tile legend

- `#`: solid wall
- `.`: empty
- `S`: player spawn
- `G`: goal portal
- `^`: always-on spike
- `~`: blinking spike
- `*`: phase beam node (generated into moving hazard beam)

The `LevelCodec` in `src/main.ts` supports:

- `parseLevels(text)`
- `encodeLevels(rooms)`
- `generateProcedural(seed, roomCount)`

So user-generated text puzzles can be loaded directly, and generated rooms can be serialized/deserialized using the same pipeline.
