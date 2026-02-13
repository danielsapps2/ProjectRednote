type Tile = '.' | '#' | 'S' | 'G' | '^' | '~' | '*';

type Room = {
  name: string;
  width: number;
  height: number;
  rows: Tile[][];
  spawn: { x: number; y: number };
  goal: { x: number; y: number };
};

type Vec2 = { x: number; y: number };

type HazardBeam = {
  x: number;
  y: number;
  horizontal: boolean;
  phase: number;
};

const TILE_SIZE = 32;
const GRAVITY = 1600;
const MOVE_ACCEL = 2400;
const DRAG = 1800;
const MAX_SPEED_X = 290;
const JUMP_IMPULSE = 540;
const BUFFER_TIME = 0.15;
const COYOTE_TIME = 0.12;
const PULSE_COOLDOWN = 1;

const palette = {
  bg1: '#11152d',
  bg2: '#181d38',
  solid: '#353f84',
  player: '#8df0ff',
  playerAura: '#43d0ff',
  goal: '#5dff9b',
  spike: '#ff6f91',
  dust: '#e4f1ff',
  pulse: '#b688ff',
  beam: '#ffb347'
};

class LevelCodec {
  static parseLevels(source: string): Room[] {
    return source
      .split(/\n\s*===\s*\n/g)
      .map((raw) => raw.trim())
      .filter(Boolean)
      .map((chunk, index) => this.parseRoom(chunk, index));
  }

  private static parseRoom(chunk: string, index: number): Room {
    const lines = chunk.split('\n').map((line) => line.trimEnd());
    const nameLine = lines.find((line) => line.startsWith('name='));
    const name = nameLine?.split('=')[1]?.trim() ?? `Room ${index + 1}`;

    const mapStart = lines.findIndex((line) => line.trim() === 'map:');
    if (mapStart === -1) {
      throw new Error(`Room ${name} missing map section`);
    }

    const mapRows = lines.slice(mapStart + 1).filter(Boolean);
    const width = mapRows[0]?.length ?? 0;
    const rows = mapRows.map((r) => r.split('') as Tile[]);

    let spawn: Vec2 | null = null;
    let goal: Vec2 | null = null;

    rows.forEach((row, y) => {
      row.forEach((tile, x) => {
        if (tile === 'S') spawn = { x, y };
        if (tile === 'G') goal = { x, y };
      });
    });

    if (!spawn || !goal) {
      throw new Error(`Room ${name} must contain S and G`);
    }

    return {
      name,
      width,
      height: rows.length,
      rows,
      spawn,
      goal
    };
  }

  static generateProcedural(seed: number, roomCount = 6): Room[] {
    const random = mulberry32(seed);
    const rooms: Room[] = [];

    for (let i = 0; i < roomCount; i++) {
      const w = 28;
      const h = 15;
      const rows = Array.from({ length: h }, (_, y) =>
        Array.from({ length: w }, (_, x): Tile => (x === 0 || x === w - 1 || y === 0 || y === h - 1 ? '#' : '.'))
      );

      // platform stripes
      for (let y = 3; y < h - 2; y += 3) {
        const spanStart = 2 + Math.floor(random() * 8);
        const spanEnd = w - 3 - Math.floor(random() * 8);
        for (let x = spanStart; x < spanEnd; x++) {
          if (random() > 0.15) rows[y][x] = '#';
        }
      }

      // hazards + phase glyph beams
      const hazards = 10 + Math.floor(random() * 10);
      for (let n = 0; n < hazards; n++) {
        const x = 2 + Math.floor(random() * (w - 4));
        const y = 2 + Math.floor(random() * (h - 4));
        const roll = random();
        rows[y][x] = roll > 0.6 ? '^' : roll > 0.3 ? '~' : '*';
      }

      rows[1][1] = 'S';
      rows[h - 2][w - 2] = 'G';
      rooms.push({
        name: `Generated ${i + 1}`,
        width: w,
        height: h,
        rows,
        spawn: { x: 1, y: 1 },
        goal: { x: w - 2, y: h - 2 }
      });
    }

    return rooms;
  }

  static encodeLevels(rooms: Room[]): string {
    return rooms
      .map((room) => {
        const map = room.rows.map((row) => row.join('')).join('\n');
        return `name=${room.name}\nmap:\n${map}`;
      })
      .join('\n===\n');
  }
}

class Game {
  private ctx: CanvasRenderingContext2D;
  private status: HTMLElement;
  private rooms: Room[] = [];
  private roomIndex = 0;
  private room!: Room;
  private beams: HazardBeam[] = [];
  private keys = new Set<string>();
  private justPressed = new Set<string>();
  private player = {
    pos: { x: 0, y: 0 },
    vel: { x: 0, y: 0 },
    w: 22,
    h: 26,
    grounded: false,
    gravityDir: 1 as 1 | -1,
    jumpBuffer: 0,
    coyote: 0,
    pulseCooldown: 0,
    squash: 0,
    deaths: 0
  };
  private particles: Array<{ pos: Vec2; vel: Vec2; life: number; maxLife: number; color: string }> = [];
  private shake = 0;
  private win = false;
  private roomStartMs = performance.now();

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    const status = document.getElementById('status');
    if (!status) throw new Error('status element missing');
    this.status = status;

    addEventListener('keydown', (e) => {
      if (!this.keys.has(e.code)) this.justPressed.add(e.code);
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));

    this.bootstrapLevels();
    this.loadRoom(0);
  }

  private bootstrapLevels(): void {
    const handcrafted = `name=Warmup Drift\nmap:\n############################\n#S..#......................#\n#...#...........###........#\n#...#....^..................#\n#...##########......###.....#\n#.............~.............#\n#......#####................#\n#..................*........#\n#..............########.....#\n#..............#.......#....#\n#....^.........#.......#....#\n#..............#.......#..G.#\n#..............#########....#\n#...........................#\n############################\n===\nname=Glyph Symphony\nmap:\n############################\n#S....#....................#\n#.....#....######..........#\n#..^..#..........#.........#\n#.#######....~...#.........#\n#.......#........#...#######\n#.......#....#####.........#\n#...*........#.............#\n#.......######.............#\n#.............#######......#\n#.............#.....#......#\n#......^......#..G..#......#\n#.............#.....#......#\n#.............#######......#\n############################`;

    const base = LevelCodec.parseLevels(handcrafted);
    const generated = LevelCodec.generateProcedural(1337, 8);
    const serialized = LevelCodec.encodeLevels(generated);

    this.rooms = [...base, ...LevelCodec.parseLevels(serialized)];
  }

  private loadRoom(index: number): void {
    this.roomIndex = (index + this.rooms.length) % this.rooms.length;
    this.room = this.rooms[this.roomIndex];
    this.roomStartMs = performance.now();

    this.player.pos.x = this.room.spawn.x * TILE_SIZE + TILE_SIZE / 2;
    this.player.pos.y = this.room.spawn.y * TILE_SIZE + TILE_SIZE / 2;
    this.player.vel.x = 0;
    this.player.vel.y = 0;
    this.player.gravityDir = 1;
    this.player.pulseCooldown = 0;

    this.beams = [];
    for (let y = 0; y < this.room.height; y++) {
      for (let x = 0; x < this.room.width; x++) {
        const tile = this.room.rows[y][x];
        if (tile === '*') {
          this.beams.push({ x, y, horizontal: (x + y) % 2 === 0, phase: Math.random() * Math.PI * 2 });
          this.room.rows[y][x] = '.';
        }
      }
    }

    this.status.textContent = `Room ${this.roomIndex + 1}/${this.rooms.length}: ${this.room.name}`;
  }

  step(dt: number): void {
    const p = this.player;
    p.jumpBuffer = Math.max(0, p.jumpBuffer - dt);
    p.coyote = Math.max(0, p.coyote - dt);
    p.pulseCooldown = Math.max(0, p.pulseCooldown - dt);
    p.squash = Math.max(0, p.squash - dt * 5);

    if (this.justPressed.has('Space')) {
      p.gravityDir *= -1;
      p.squash = 1;
      this.emitBurst({ x: p.pos.x, y: p.pos.y }, 14, palette.pulse, 340);
      this.shake = Math.max(this.shake, 10);
    }

    if (this.justPressed.has('KeyX') || this.justPressed.has('ShiftLeft')) {
      this.activatePulse();
    }

    if (this.justPressed.has('ArrowUp') || this.justPressed.has('KeyW')) {
      p.jumpBuffer = BUFFER_TIME;
    }

    if (this.justPressed.has('KeyR')) {
      this.respawn();
    }

    if (this.justPressed.has('KeyN')) {
      this.loadRoom(this.roomIndex + 1);
    }

    const axis = (this.keys.has('ArrowRight') || this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('ArrowLeft') || this.keys.has('KeyA') ? 1 : 0);

    if (axis !== 0) {
      p.vel.x += axis * MOVE_ACCEL * dt;
      p.vel.x = clamp(p.vel.x, -MAX_SPEED_X, MAX_SPEED_X);
    } else {
      const drag = DRAG * dt;
      if (Math.abs(p.vel.x) <= drag) p.vel.x = 0;
      else p.vel.x -= Math.sign(p.vel.x) * drag;
    }

    p.vel.y += GRAVITY * p.gravityDir * dt;

    if (p.jumpBuffer > 0 && p.coyote > 0) {
      p.vel.y = -p.gravityDir * JUMP_IMPULSE;
      p.jumpBuffer = 0;
      p.coyote = 0;
      this.emitBurst({ x: p.pos.x, y: p.pos.y + (p.gravityDir > 0 ? p.h / 2 : -p.h / 2) }, 7, palette.dust, 220);
      this.shake = Math.max(this.shake, 3);
    }

    p.pos.x += p.vel.x * dt;
    this.solveX();
    p.pos.y += p.vel.y * dt;
    this.solveY();

    this.updateBeams(dt);
    this.updateParticles(dt);

    this.checkTileInteractions();
    this.justPressed.clear();
  }

  private activatePulse(): void {
    const p = this.player;
    if (p.pulseCooldown > 0) return;
    p.pulseCooldown = PULSE_COOLDOWN;
    this.emitBurst({ ...p.pos }, 28, palette.pulse, 380);
    this.shake = Math.max(this.shake, 14);

    // unique mechanic: pulse rotates dynamic beams and disarms nearby spikes briefly by phase shift
    this.beams.forEach((beam) => {
      const dx = beam.x * TILE_SIZE + TILE_SIZE / 2 - p.pos.x;
      const dy = beam.y * TILE_SIZE + TILE_SIZE / 2 - p.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 220) {
        beam.horizontal = !beam.horizontal;
        beam.phase += Math.PI / 2;
      }
    });
  }

  private checkTileInteractions(): void {
    const p = this.player;
    const tx = Math.floor(p.pos.x / TILE_SIZE);
    const ty = Math.floor(p.pos.y / TILE_SIZE);
    const tile = this.room.rows[ty]?.[tx];

    if (tile === 'G') {
      const roomTime = ((performance.now() - this.roomStartMs) / 1000).toFixed(1);
      this.status.textContent = `Cleared ${this.room.name} in ${roomTime}s. [N] next room`;
      this.emitBurst({ ...p.pos }, 40, palette.goal, 450);
      this.shake = Math.max(this.shake, 12);
      this.loadRoom(this.roomIndex + 1);
      return;
    }

    if (tile === '^' || tile === '~') {
      const armed = tile === '^' || Math.sin(performance.now() / 400 + tx + ty) > 0;
      if (armed) this.respawn();
    }

    const touchingBeam = this.beams.some((beam) => {
      const bx = beam.x * TILE_SIZE + TILE_SIZE / 2;
      const by = beam.y * TILE_SIZE + TILE_SIZE / 2;
      const amp = 14;
      const offset = Math.sin(performance.now() / 300 + beam.phase) * amp;

      const ex = bx + (beam.horizontal ? offset : 0);
      const ey = by + (beam.horizontal ? 0 : offset);
      return Math.hypot(p.pos.x - ex, p.pos.y - ey) < 18;
    });

    if (touchingBeam) this.respawn();
  }

  private respawn(): void {
    this.player.deaths += 1;
    this.status.textContent = `${this.room.name} — deaths: ${this.player.deaths} (R to reset, N to skip)`;
    this.emitBurst({ ...this.player.pos }, 26, '#ff5f7a', 420);
    this.shake = Math.max(this.shake, 16);
    this.player.pos.x = this.room.spawn.x * TILE_SIZE + TILE_SIZE / 2;
    this.player.pos.y = this.room.spawn.y * TILE_SIZE + TILE_SIZE / 2;
    this.player.vel.x = 0;
    this.player.vel.y = 0;
  }

  private solveX(): void {
    const p = this.player;
    const halfW = p.w / 2;
    const halfH = p.h / 2;

    const minX = Math.floor((p.pos.x - halfW) / TILE_SIZE);
    const maxX = Math.floor((p.pos.x + halfW) / TILE_SIZE);
    const minY = Math.floor((p.pos.y - halfH) / TILE_SIZE);
    const maxY = Math.floor((p.pos.y + halfH) / TILE_SIZE);

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (this.room.rows[y]?.[x] !== '#') continue;

        const tileLeft = x * TILE_SIZE;
        const tileRight = tileLeft + TILE_SIZE;
        const tileTop = y * TILE_SIZE;
        const tileBottom = tileTop + TILE_SIZE;

        const playerLeft = p.pos.x - halfW;
        const playerRight = p.pos.x + halfW;
        const playerTop = p.pos.y - halfH;
        const playerBottom = p.pos.y + halfH;

        const overlapX = Math.min(playerRight, tileRight) - Math.max(playerLeft, tileLeft);
        const overlapY = Math.min(playerBottom, tileBottom) - Math.max(playerTop, tileTop);

        // Require true AABB overlap on both axes; touching an edge is not a collision.
        if (overlapX > 0 && overlapY > 0) {
          if (p.vel.x > 0) p.pos.x = tileLeft - halfW;
          else if (p.vel.x < 0) p.pos.x = tileRight + halfW;
          else p.pos.x += p.pos.x < tileLeft + TILE_SIZE / 2 ? -overlapX : overlapX;
          p.vel.x = 0;
        }
      }
    }
  }

  private solveY(): void {
    const p = this.player;
    const halfW = p.w / 2;
    const halfH = p.h / 2;

    const minX = Math.floor((p.pos.x - halfW) / TILE_SIZE);
    const maxX = Math.floor((p.pos.x + halfW) / TILE_SIZE);
    const minY = Math.floor((p.pos.y - halfH) / TILE_SIZE);
    const maxY = Math.floor((p.pos.y + halfH) / TILE_SIZE);

    p.grounded = false;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (this.room.rows[y]?.[x] !== '#') continue;

        const tileLeft = x * TILE_SIZE;
        const tileRight = tileLeft + TILE_SIZE;
        const tileTop = y * TILE_SIZE;
        const tileBottom = tileTop + TILE_SIZE;

        const playerLeft = p.pos.x - halfW;
        const playerRight = p.pos.x + halfW;
        const playerTop = p.pos.y - halfH;
        const playerBottom = p.pos.y + halfH;

        const overlapX = Math.min(playerRight, tileRight) - Math.max(playerLeft, tileLeft);
        const overlapY = Math.min(playerBottom, tileBottom) - Math.max(playerTop, tileTop);

        if (overlapX > 0 && overlapY > 0) {
          if (p.vel.y > 0) p.pos.y = tileTop - halfH;
          else if (p.vel.y < 0) p.pos.y = tileBottom + halfH;
          else p.pos.y += p.pos.y < tileTop + TILE_SIZE / 2 ? -overlapY : overlapY;

          const standingOnSurface =
            (p.gravityDir === 1 && p.vel.y >= 0) ||
            (p.gravityDir === -1 && p.vel.y <= 0);

          p.vel.y = 0;
          if (standingOnSurface) {
            p.grounded = true;
            p.coyote = COYOTE_TIME;
          }
        }
      }
    }
  }

  private updateBeams(dt: number): void {
    this.beams.forEach((beam) => {
      beam.phase += dt * 3;
    });
  }

  private emitBurst(origin: Vec2, count: number, color: string, speed: number): void {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const magnitude = (0.35 + Math.random() * 0.65) * speed;
      this.particles.push({
        pos: { ...origin },
        vel: { x: Math.cos(angle) * magnitude, y: Math.sin(angle) * magnitude },
        life: 0.5 + Math.random() * 0.45,
        maxLife: 0.5 + Math.random() * 0.45,
        color
      });
    }
  }

  private updateParticles(dt: number): void {
    this.particles = this.particles.filter((p) => {
      p.life -= dt;
      if (p.life <= 0) return false;
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      p.vel.x *= 0.96;
      p.vel.y *= 0.96;
      return true;
    });

    this.shake = Math.max(0, this.shake - dt * 40);
  }

  draw(): void {
    const { ctx } = this;
    const shakeX = (Math.random() - 0.5) * this.shake;
    const shakeY = (Math.random() - 0.5) * this.shake;

    ctx.save();
    ctx.translate(shakeX, shakeY);

    const g = ctx.createLinearGradient(0, 0, 0, this.canvas.height);
    g.addColorStop(0, palette.bg2);
    g.addColorStop(1, palette.bg1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    for (let y = 0; y < this.room.height; y++) {
      for (let x = 0; x < this.room.width; x++) {
        const tile = this.room.rows[y][x];
        const px = x * TILE_SIZE;
        const py = y * TILE_SIZE;

        if (tile === '#') {
          ctx.fillStyle = palette.solid;
          ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
          ctx.fillStyle = 'rgba(255,255,255,0.06)';
          ctx.fillRect(px + 2, py + 2, TILE_SIZE - 4, 4);
        } else if (tile === 'G') {
          const pulse = 0.6 + Math.sin(performance.now() / 200) * 0.25;
          ctx.fillStyle = `rgba(93,255,155,${pulse})`;
          ctx.beginPath();
          ctx.arc(px + TILE_SIZE / 2, py + TILE_SIZE / 2, 10 + pulse * 4, 0, Math.PI * 2);
          ctx.fill();
        } else if (tile === '^' || tile === '~') {
          const armed = tile === '^' || Math.sin(performance.now() / 400 + x + y) > 0;
          ctx.fillStyle = armed ? palette.spike : '#684154';
          ctx.beginPath();
          ctx.moveTo(px + 4, py + TILE_SIZE - 5);
          ctx.lineTo(px + TILE_SIZE / 2, py + 6);
          ctx.lineTo(px + TILE_SIZE - 4, py + TILE_SIZE - 5);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    this.beams.forEach((beam) => {
      const cx = beam.x * TILE_SIZE + TILE_SIZE / 2;
      const cy = beam.y * TILE_SIZE + TILE_SIZE / 2;
      const offset = Math.sin(performance.now() / 300 + beam.phase) * 14;
      const ex = cx + (beam.horizontal ? offset : 0);
      const ey = cy + (beam.horizontal ? 0 : offset);

      ctx.strokeStyle = 'rgba(255,179,71,0.4)';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ex, ey);
      ctx.stroke();

      ctx.fillStyle = palette.beam;
      ctx.beginPath();
      ctx.arc(ex, ey, 6, 0, Math.PI * 2);
      ctx.fill();
    });

    this.particles.forEach((particle) => {
      const alpha = particle.life / particle.maxLife;
      ctx.fillStyle = `${particle.color}${Math.floor(alpha * 255)
        .toString(16)
        .padStart(2, '0')}`;
      ctx.fillRect(particle.pos.x - 2, particle.pos.y - 2, 4, 4);
    });

    const p = this.player;
    const stretch = p.squash * 0.2;
    const w = p.w * (1 + stretch);
    const h = p.h * (1 - stretch);

    ctx.fillStyle = palette.playerAura;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.arc(p.pos.x, p.pos.y, 18 + Math.sin(performance.now() / 60) * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.fillStyle = palette.player;
    roundRect(ctx, p.pos.x - w / 2, p.pos.y - h / 2, w, h, 5);
    ctx.fill();

    ctx.fillStyle = '#0d1e26';
    const eyeY = p.pos.y + (p.gravityDir > 0 ? -4 : 4);
    ctx.fillRect(p.pos.x - 5, eyeY, 4, 4);
    ctx.fillRect(p.pos.x + 1, eyeY, 4, 4);

    ctx.restore();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const canvas = document.getElementById('game') as HTMLCanvasElement;
const game = new Game(canvas);

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(1 / 30, (now - last) / 1000);
  last = now;
  game.step(dt);
  game.draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
