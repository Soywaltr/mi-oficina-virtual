/**
 * GameMap.jsx
 *
 * Multiplayer 2D office map — Phaser 3 + React + Socket.IO
 *
 * ┌─────────────────────────────────────────────┐
 * │  ARCHITECTURE                               │
 * │  CONFIG          → single source of truth   │
 * │  Helpers         → pure, stateless utils    │
 * │  OtherPlayersMap → remote-player lifecycle  │
 * │  OfficeScene     → Phaser.Scene subclass    │
 * │  GameMap         → React shell              │
 * └─────────────────────────────────────────────┘
 */

import React, { useEffect, useRef } from 'react';
import Phaser from 'phaser';

// ─────────────────────────────────────────────────────────────────────────────
// 1. CONFIGURATION  (single source of truth — never use magic numbers elsewhere)
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = Object.freeze({
  AVATARS:    ['Leo', 'Max', 'Noah', 'Nerf'],
  ACTIONS:    ['idle', 'run', 'sit', 'read', 'gift', 'lift', 'hit', 'throw', 'hurt'],
  DIRECTIONS: ['right', 'up', 'left', 'down'], // order MUST match spritesheet row order

  PLAYER: {
    SPEED:       180,
    SCALE:       2.5,
    BODY:        { w: 10, h: 10, offsetX: 3, offsetY: 22 },
    SPAWN:       { x: 300, y: 300 },
    DEPTH:       100,
  },

  CAMERA: {
    LERP:        0.1,
    ZOOM:        2,
    ZOOM_MIN:    1,
    ZOOM_MAX:    3,
    ZOOM_STEP:   0.001,
  },

  NAMETAG: {
    OFFSET_Y:    45,
    DEPTH:       101,
    PADDING:     { x: 12, y: 6 },
    GAP_DOT:     6,            // horizontal space reserved for the dot
    RADIUS:      6,
    DOT_RADIUS:  3,
    DOT_COLOR:   0x10b981,
    BG_ALPHA:    0.85,
    COLOR_LOCAL: 0x6366f1,
    COLOR_REMOTE:0x374151,
    FONT: {
      fontFamily: 'Inter, sans-serif',
      fontSize:   '11px',
      fontWeight: '600',
      color:      '#ffffff',
      resolution: 2,
    },
  },

  NEARBY_DISTANCE: 250,

  SOCKET: {
    THROTTLE_MS: 50,           // max 20 position updates / second
    EVENTS: Object.freeze({
      CURRENT_PLAYERS:    'currentPlayers',
      NEW_PLAYER:         'newPlayer',
      PLAYER_DISCONNECTED:'playerDisconnected',
      PLAYER_MOVED:       'playerMoved',
      PLAYER_MOVEMENT:    'playerMovement',
    }),
  },

  ASSETS: {
    MAP_KEY: 'mapa',
    MAP_URL: '/assets/mapa_oficina.json',
    TILESETS: [
      { tilesetName: 'tileset_oficina', key: 'tiles_muebles', url: '/assets/tileset_oficina.png' },
      { tilesetName: 'tileset_paredes', key: 'tiles_paredes', url: '/assets/tileset_paredes.png' },
    ],
    SPRITE_SUFFIX: '_16x16.png',
    FRAME:  { W: 16, H: 32 },
    ANIM_FPS: 6,
  },

  ACTION_KEYS: Object.freeze({
    sit:   'E',
    read:  'R',
    gift:  'F',
    lift:  'C',
    hit:   'V',
    throw: 'X',
  }),

  DOM: {
    CONTAINER_ID:    'phaser-container',
    TELEPORT_EVENT:  'teleportToCenter',
    CHAT_FOCUS:      'chatInputFocus',   // dispatched by React when chat input is focused
    CHAT_BLUR:       'chatInputBlur',    // dispatched by React when chat input loses focus
    RESIZE_DEBOUNCE: 50,
  },
});

const token = localStorage.getItem('authToken');
if (!token) {
    window.location.href = '/'; // O manejar con React Router
    return;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. PURE UTILITY FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rate-limits `fn` to at most once every `ms` milliseconds.
 * @template {(...args: any[]) => void} T
 * @param {T} fn
 * @param {number} ms
 * @returns {T}
 */
function throttle(fn, ms) {
  let lastCall = 0;
  return (...args) => {
    const now = Date.now();
    if (now - lastCall >= ms) { lastCall = now; fn(...args); }
  };
}

/** Returns `name` if it is a known avatar, otherwise the first avatar. */
const safeAvatar = (name) =>
  CONFIG.AVATARS.includes(name) ? name : CONFIG.AVATARS[0];

/** Returns `name` if it is a known action, otherwise 'idle'. */
const safeAction = (name) =>
  CONFIG.ACTIONS.includes(name) ? name : 'idle';

/** Returns `name` if it is a known direction, otherwise 'down'. */
const safeDirection = (name) =>
  CONFIG.DIRECTIONS.includes(name) ? name : 'down';

/**
 * Number of sprite-sheet frames allocated to each direction row.
 * Returns 1 for static / missing sheets (safe fallback).
 * @param {Phaser.Scene} scene
 * @param {string} sheetKey
 */
function framesPerDirection(scene, sheetKey) {
  if (!scene.textures.exists(sheetKey)) return 1;
  return Math.max(1, Math.floor((scene.textures.get(sheetKey).frameTotal - 1) / 4));
}

/**
 * Builds a labelled name-tag container positioned at (x, y).
 * Pure factory — no side-effects on external state.
 * @param {Phaser.Scene} scene
 * @param {number}       x
 * @param {number}       y
 * @param {string}       label
 * @param {number}       [bgColor]
 * @returns {Phaser.GameObjects.Container}
 */
function createNameTag(scene, x, y, label, bgColor = CONFIG.NAMETAG.COLOR_LOCAL) {
  const cfg = CONFIG.NAMETAG;
  const container = scene.add.container(x, y).setDepth(cfg.DEPTH);

  const text = scene.add.text(0, 0, label, cfg.FONT);

  const bgW = cfg.PADDING.x * 2 + cfg.GAP_DOT + text.width;
  const bgH = cfg.PADDING.y  + Math.max(text.height, 6);

  const bg  = scene.add.graphics();
  bg.fillStyle(bgColor, cfg.BG_ALPHA);
  bg.fillRoundedRect(-bgW / 2, -bgH, bgW, bgH, cfg.RADIUS);

  const dot = scene.add.graphics();
  dot.fillStyle(cfg.DOT_COLOR, 1);
  dot.fillCircle(-bgW / 2 + 9, -bgH / 2, cfg.DOT_RADIUS);

  text.setPosition(-bgW / 2 + 15, -bgH / 2 - text.height / 2);
  container.add([bg, dot, text]);
  return container;
}

/**
 * Registers directional animations for every avatar × action combination.
 * Idempotent: silently skips keys that already exist.
 * @param {Phaser.Scene} scene
 */
function registerAnimations(scene) {
  CONFIG.AVATARS.forEach(avatar => {
    CONFIG.ACTIONS.forEach(action => {
      const sheet = `${avatar}_${action}`;
      if (!scene.textures.exists(sheet)) return;

      const fpd = framesPerDirection(scene, sheet);
      const fps = fpd > 1 ? CONFIG.ASSETS.ANIM_FPS : 1;

      CONFIG.DIRECTIONS.forEach((dir, rowIndex) => {
        const key = `${sheet}_${dir}`;
        if (scene.anims.exists(key)) return; // idempotent

        scene.anims.create({
          key,
          frames:    scene.anims.generateFrameNumbers(sheet, {
            start: rowIndex * fpd,
            end:   (rowIndex + 1) * fpd - 1,
          }),
          frameRate: fps,
          repeat:    -1,
        });
      });
    });
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// 3. OTHER-PLAYERS MANAGER
//    Encapsulates the full lifecycle of remote-player visuals so that
//    OfficeScene never manipulates sprite/nameTag objects directly.
// ─────────────────────────────────────────────────────────────────────────────

class OtherPlayersMap {
  /** @param {Phaser.Scene} scene */
  constructor(scene) {
    this._scene   = scene;
    /** @type {Record<string, { sprite: Phaser.GameObjects.Sprite, nameTag: Phaser.GameObjects.Container }>} */
    this._players = {};
  }

  /**
   * Spawns (or replaces) a remote player.
   * @param {{ playerId: string, avatar: string, x: number, y: number, direction: string, currentAction: string, userName: string }} info
   * @param {string} localSocketId  — skipped to avoid rendering self
   */
  add(info, localSocketId) {
    if (!info?.playerId || info.playerId === localSocketId) return;
    this.remove(info.playerId); // destroy stale entry first

    const scene  = this._scene;
    const av     = safeAvatar(info.avatar);
    const action = safeAction(info.currentAction);
    const dir    = safeDirection(info.direction);
    const sheet  = `${av}_${action}`;

    const rowIndex   = CONFIG.DIRECTIONS.indexOf(dir);
    const fpd        = framesPerDirection(scene, sheet);
    const startFrame = Math.max(0, rowIndex) * fpd;

    // Fall back to spawn point if the server hasn't sent coordinates yet.
    // Without this, players with missing x/y spawn at (0, 0), which is
    // off-screen at zoom 2x, making them invisible from the other PC.
    const spawnX = info.x ?? CONFIG.PLAYER.SPAWN.x;
    const spawnY = info.y ?? CONFIG.PLAYER.SPAWN.y;

    const sprite = scene.add.sprite(spawnX, spawnY, sheet, startFrame);
    sprite.setScale(CONFIG.PLAYER.SCALE).setDepth(CONFIG.PLAYER.DEPTH);

    const animKey = `${sheet}_${dir}`;
    if (scene.anims.exists(animKey)) sprite.anims.play(animKey, true);

    const nameTag = createNameTag(
      scene,
      spawnX,
      spawnY - CONFIG.NAMETAG.OFFSET_Y,
      info.userName || 'Usuario',
      CONFIG.NAMETAG.COLOR_REMOTE,
    );

    this._players[info.playerId] = { sprite, nameTag };
  }

  /**
   * Repositions and re-animates an existing remote player.
   * @param {{ playerId: string, avatar: string, x: number, y: number, direction: string, currentAction: string }} info
   */
  update(info) {
    const entry = this._players[info?.playerId];
    if (!entry) return;

    const av      = safeAvatar(info.avatar);
    const action  = safeAction(info.currentAction);
    const dir     = safeDirection(info.direction);

    entry.sprite.setPosition(info.x, info.y);
    entry.nameTag.setPosition(info.x, info.y - CONFIG.NAMETAG.OFFSET_Y);

    const animKey = `${av}_${action}_${dir}`;
    if (this._scene.anims.exists(animKey)) entry.sprite.anims.play(animKey, true);
  }

  /** Destroys visuals for a single disconnected player. */
  remove(playerId) {
    const entry = this._players[playerId];
    if (!entry) return;
    entry.sprite.destroy();
    entry.nameTag.destroy();
    delete this._players[playerId];
  }

  /** Destroys all remote-player visuals (used on reconnect / scene shutdown). */
  clear() {
    Object.keys(this._players).forEach(id => this.remove(id));
  }

  /**
   * Returns ids of remote players within `maxDist` pixels of (x, y).
   * @param {number} x
   * @param {number} y
   * @param {number} maxDist
   * @returns {string[]}
   */
  nearbyIds(x, y, maxDist) {
    return Object.entries(this._players)
      .filter(([, e]) => Phaser.Math.Distance.Between(x, y, e.sprite.x, e.sprite.y) < maxDist)
      .map(([id]) => id);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// 4. PHASER SCENE
//    Extends Phaser.Scene properly instead of using an inline object literal.
//    Internal methods are prefixed with _ to signal private intent.
// ─────────────────────────────────────────────────────────────────────────────

class OfficeScene extends Phaser.Scene {
  /**
   * @param {React.MutableRefObject<{ socket: any, userName: string, avatar: string, onNearbyUpdate: Function }>} propsRef
   */
  constructor(propsRef) {
    super({ key: 'OfficeScene' });
    this._propsRef     = propsRef;
    this._others       = null;
    this._walls        = null;
    this._emitMovement = null;   // throttled
    this._oldState     = null;
    this._lastNearby   = [];
    this._onTeleport   = null;
    this.currentAction = 'idle';
    this.lastDirection = 'down';
  }

  /** Live access to the latest React props via ref. */
  get _p() { return this._propsRef.current; }

  // ── 4a. PRELOAD ────────────────────────────────────────────────────────────

  preload() {
    const { MAP_KEY, MAP_URL, TILESETS, SPRITE_SUFFIX, FRAME } = CONFIG.ASSETS;

    this.load.tilemapTiledJSON(MAP_KEY, MAP_URL);
    TILESETS.forEach(ts => this.load.image(ts.key, ts.url));

    CONFIG.AVATARS.forEach(av =>
      CONFIG.ACTIONS.forEach(action =>
        this.load.spritesheet(
          `${av}_${action}`,
          `/assets/${av}_${action}${SPRITE_SUFFIX}`,
          { frameWidth: FRAME.W, frameHeight: FRAME.H },
        )
      )
    );

    // Non-fatal: log missing assets without crashing the scene
    this.load.on('loaderror', (file) =>
      console.warn(`[GameMap] Asset failed to load → key:"${file.key}"  url:"${file.url}"`)
    );
  }

  // ── 4b. CREATE ─────────────────────────────────────────────────────────────

  create() {
    this._buildMap();
    registerAnimations(this);
    this._buildLocalPlayer();
    this._buildCamera();
    this._buildInput();
    this._buildSocketBridge();
    this._buildTeleportBridge();

    // Throttled emitter — cap outgoing position updates to the configured rate
    this._emitMovement = throttle(
      (payload) => this._p.socket?.emit(CONFIG.SOCKET.EVENTS.PLAYER_MOVEMENT, payload),
      CONFIG.SOCKET.THROTTLE_MS,
    );
  }

  _buildMap() {
    const { MAP_KEY, TILESETS } = CONFIG.ASSETS;
    const map = this.make.tilemap({ key: MAP_KEY });

    const tilesets = TILESETS.map(ts => map.addTilesetImage(ts.tilesetName, ts.key));
    map.layers.forEach((layerData, i) =>
      map.createLayer(layerData.name, tilesets, 0, 0).setDepth(i)
    );

    this._walls = this.physics.add.staticGroup();
    const colLayer = map.getObjectLayer('Colisiones');
    if (colLayer?.objects) {
      colLayer.objects.forEach(obj => {
        const zone = this.add.zone(
          obj.x + obj.width  / 2,
          obj.y + obj.height / 2,
          obj.width,
          obj.height,
        );
        this.physics.add.existing(zone, true);
        this._walls.add(zone);
      });
    }
  }

  _buildLocalPlayer() {
    const { SPAWN, SCALE, BODY } = CONFIG.PLAYER;
    const av  = safeAvatar(this._p.avatar);
    const fpd = framesPerDirection(this, `${av}_idle`);

    this.player = this.physics.add.sprite(SPAWN.x, SPAWN.y, `${av}_idle`, 3 * fpd);
    this.player.setScale(SCALE).setDepth(CONFIG.PLAYER.DEPTH);
    this.player.body.setSize(BODY.w, BODY.h);
    this.player.body.setOffset(BODY.offsetX, BODY.offsetY);

    this.physics.add.collider(this.player, this._walls);

    this.nameTag = createNameTag(
      this,
      SPAWN.x,
      SPAWN.y - CONFIG.NAMETAG.OFFSET_Y,
      this._p.userName ?? '',
    );

    this._others = new OtherPlayersMap(this);
  }

  _buildCamera() {
    const { LERP, ZOOM, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } = CONFIG.CAMERA;

    this.isFollowingPlayer = true;
    this.isDraggingCamera  = false;
    this._ptrDownX         = 0;   // click origin for drag-threshold detection
    this._ptrDownY         = 0;

    this.cameras.main.startFollow(this.player, true, LERP, LERP).setZoom(ZOOM);

    // Record where the pointer went down — do NOT stop follow here.
    // Stopping follow on every pointerdown caused the camera to snap back
    // the moment the user started walking after a plain click.
    this.input.on('pointerdown', (pointer) => {
      this._ptrDownX        = pointer.x;
      this._ptrDownY        = pointer.y;
      this.isDraggingCamera = false;
    });

    this.input.on('pointerup', () => {
      this.isDraggingCamera = false;
    });

    this.input.on('pointermove', (pointer) => {
      if (!pointer.isDown) return;

      const dx = pointer.x - pointer.prevPosition.x;
      const dy = pointer.y - pointer.prevPosition.y;

      // Enter drag mode only after moving >5px — a plain click never triggers this
      if (!this.isDraggingCamera) {
        const movedX = Math.abs(pointer.x - this._ptrDownX);
        const movedY = Math.abs(pointer.y - this._ptrDownY);
        if (movedX < 5 && movedY < 5) return;

        this.isDraggingCamera  = true;
        this.isFollowingPlayer = false;
        this.cameras.main.stopFollow();
      }

      const zoom = this.cameras.main.zoom;
      this.cameras.main.scrollX -= dx / zoom;
      this.cameras.main.scrollY -= dy / zoom;
    });

    this.input.on('wheel', (_p, _go, _dx, deltaY) => {
      this.cameras.main.setZoom(
        Phaser.Math.Clamp(this.cameras.main.zoom - deltaY * ZOOM_STEP, ZOOM_MIN, ZOOM_MAX),
      );
    });
  }

  _buildInput() {
    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd    = this.input.keyboard.addKeys('W,S,A,D');

    // Build action-key map from config so adding new emotes only requires
    // updating CONFIG.ACTION_KEYS — no changes here.
    this.actionKeys = Object.fromEntries(
      Object.entries(CONFIG.ACTION_KEYS).map(([action, code]) => [
        action,
        this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes[code]),
      ])
    );

    // When a React text input (chat) gains focus, tell Phaser to stop consuming
    // keyboard events. Without this, Phaser calls preventDefault() on WASD and
    // arrow keys, so they never reach the browser input — only non-captured keys
    // (like ".") appear, which is why the user saw only dots when typing.
    this._onChatFocus = () => this.input?.keyboard?.disableGlobalCapture();
    this._onChatBlur  = () => this.input?.keyboard?.enableGlobalCapture();
    window.addEventListener(CONFIG.DOM.CHAT_FOCUS, this._onChatFocus);
    window.addEventListener(CONFIG.DOM.CHAT_BLUR,  this._onChatBlur);
  }

  _buildSocketBridge() {
    const { socket } = this._p;
    if (!socket) return;

    const EV = CONFIG.SOCKET.EVENTS;

    socket.on(EV.CURRENT_PLAYERS, (players) => {
      this._others.clear();
      Object.values(players).forEach(info => this._others.add(info, socket.id));
    });

    socket.on(EV.NEW_PLAYER,          (info) => this._others.add(info, socket.id));
    socket.on(EV.PLAYER_DISCONNECTED, (id)   => this._others.remove(id));
    socket.on(EV.PLAYER_MOVED,        (info) => this._others.update(info));
  }

  _buildTeleportBridge() {
    this._onTeleport = () => this._teleportToSpawn();
    window.addEventListener(CONFIG.DOM.TELEPORT_EVENT, this._onTeleport);
  }

  // ── 4c. UPDATE ─────────────────────────────────────────────────────────────

  update() {
    if (!this.player?.body) return;

    const [action, dir] = this._resolveInput();
    this.currentAction  = action;
    this.lastDirection  = dir;

    this._playAnimation(safeAvatar(this._p.avatar), action, dir);
    this.nameTag?.setPosition(this.player.x, this.player.y - CONFIG.NAMETAG.OFFSET_Y);
    this._broadcastIfChanged();
    this._checkNearby();
  }

  /**
   * Reads keyboard state, moves the physics body, returns [action, direction].
   * Keeping all movement logic in one place makes it easy to swap input schemes.
   * @returns {[string, string]}
   */
  _resolveInput() {
    const { left, right, up, down } = this.cursors;
    const { A, D, W, S }            = this.wasd;

    const goLeft  = left.isDown  || A.isDown;
    const goRight = right.isDown || D.isDown;
    const goUp    = up.isDown    || W.isDown;
    const goDown  = down.isDown  || S.isDown;
    const moving  = goLeft || goRight || goUp || goDown;

    let action = this.currentAction;
    let dir    = this.lastDirection;

    this.player.body.setVelocity(0);

    if (moving) {
      action = 'run';

      if      (goLeft)  { this.player.body.setVelocityX(-CONFIG.PLAYER.SPEED); dir = 'left';  }
      else if (goRight) { this.player.body.setVelocityX( CONFIG.PLAYER.SPEED); dir = 'right'; }

      if      (goUp)    { this.player.body.setVelocityY(-CONFIG.PLAYER.SPEED); dir = 'up';    }
      else if (goDown)  { this.player.body.setVelocityY( CONFIG.PLAYER.SPEED); dir = 'down';  }

      // Normalize diagonal speed
      this.player.body.velocity.normalize().scale(CONFIG.PLAYER.SPEED);

      // Resume camera follow on first movement after manual drag
      if (!this.isFollowingPlayer) {
        this.isFollowingPlayer = true;
        this.cameras.main.startFollow(this.player, true, CONFIG.CAMERA.LERP, CONFIG.CAMERA.LERP);
      }
    } else {
      if (action === 'run') action = 'idle';

      // Emote toggle — check all keys to preserve original multi-key behaviour
      for (const [emote, key] of Object.entries(this.actionKeys)) {
        if (Phaser.Input.Keyboard.JustDown(key)) {
          action = action === emote ? 'idle' : emote;
        }
      }
    }

    return [action, dir];
  }

  /** Plays the best available animation, falling back to idle for the same direction. */
  _playAnimation(av, action, dir) {
    const primary  = `${av}_${action}_${dir}`;
    const fallback = `${av}_idle_${dir}`;

    if      (this.anims.exists(primary))  this.player.anims.play(primary,  true);
    else if (this.anims.exists(fallback)) this.player.anims.play(fallback, true);
  }

  /** Emits a position update only when something actually changed. */
  _broadcastIfChanged() {
    const { x, y }   = this.player;
    const { currentAction: action, lastDirection: dir } = this;

    if (
      this._oldState               &&
      this._oldState.x      === x  &&
      this._oldState.y      === y  &&
      this._oldState.action === action &&
      this._oldState.dir    === dir
    ) return;

    this._oldState = { x, y, action, dir };
    this._emitMovement?.({
      x, y,
      direction:     dir,
      currentAction: action,
      avatar:        safeAvatar(this._p.avatar),
    });
  }

  /** Fires onNearbyUpdate only when the nearby-player set changes. */
  _checkNearby() {
    const { onNearbyUpdate } = this._p;
    if (!onNearbyUpdate) return;

    const { x, y } = this.player;
    const nearby   = this._others.nearbyIds(x, y, CONFIG.NEARBY_DISTANCE);

    if (JSON.stringify(nearby) !== JSON.stringify(this._lastNearby)) {
      this._lastNearby = nearby;
      onNearbyUpdate(nearby);
    }
  }

  _teleportToSpawn() {
    const { x, y } = CONFIG.PLAYER.SPAWN;
    this.player.setPosition(x, y);
    this.cameras.main.centerOn(x, y);
    this.isFollowingPlayer = true;
    this.cameras.main.startFollow(this.player, true, CONFIG.CAMERA.LERP, CONFIG.CAMERA.LERP);

    this._emitMovement?.({
      x, y,
      direction:     this.lastDirection,
      currentAction: this.currentAction,
      avatar:        safeAvatar(this._p.avatar),
    });
  }

  // ── 4d. SHUTDOWN ───────────────────────────────────────────────────────────
  // Called by Phaser when the scene is stopped or the game is destroyed.

  shutdown() {
    // Remove DOM event listeners
    if (this._onTeleport) {
      window.removeEventListener(CONFIG.DOM.TELEPORT_EVENT, this._onTeleport);
    }
    if (this._onChatFocus) {
      window.removeEventListener(CONFIG.DOM.CHAT_FOCUS, this._onChatFocus);
      window.removeEventListener(CONFIG.DOM.CHAT_BLUR,  this._onChatBlur);
    }

    // Destroy all remote player visuals
    this._others?.clear();

    // Unregister socket listeners by exact event name (avoids touching other components)
    const { socket } = this._p;
    if (socket) {
      Object.values(CONFIG.SOCKET.EVENTS)
        .filter(ev => ev !== CONFIG.SOCKET.EVENTS.PLAYER_MOVEMENT)
        .forEach(ev => socket.off(ev));
    }
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// 5. REACT COMPONENT
//    Responsible only for: mounting the Phaser.Game instance, keeping the
//    propsRef current, and tearing everything down on unmount.
// ─────────────────────────────────────────────────────────────────────────────

export default function GameMap({ socket, userName, avatar, onNearbyUpdate }) {
  const gameRef  = useRef(null);
  const propsRef = useRef({ socket, userName, avatar, onNearbyUpdate });

  // Sync latest props into the ref without rebuilding the Phaser game
  useEffect(() => {
    propsRef.current = { socket, userName, avatar, onNearbyUpdate };
  }, [socket, userName, avatar, onNearbyUpdate]);

  // Mount the Phaser game exactly once per component lifecycle
  useEffect(() => {
    if (gameRef.current || !socket) return;

    const scene = new OfficeScene(propsRef);

    gameRef.current = new Phaser.Game({
      type:            Phaser.AUTO,
      width:           '100%',
      height:          '100%',
      parent:          CONFIG.DOM.CONTAINER_ID,
      pixelArt:        true,
      roundPixels:     true,
      backgroundColor: '#4a7c3f',
      scale: {
        mode:   Phaser.Scale.RESIZE,
        parent: CONFIG.DOM.CONTAINER_ID,
        width:  '100%',
        height: '100%',
      },
      physics: {
        default: 'arcade',
        arcade:  { gravity: { y: 0 }, debug: false },
      },
      scene,
    });

    // Debounced responsive resize
    let resizeTimer;
    const container = document.getElementById(CONFIG.DOM.CONTAINER_ID);
    const observer  = new ResizeObserver(([entry]) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        gameRef.current?.scale.resize(
          entry.contentRect.width,
          entry.contentRect.height,
        );
      }, CONFIG.DOM.RESIZE_DEBOUNCE);
    });
    if (container) observer.observe(container);

    return () => {
      clearTimeout(resizeTimer);
      observer.disconnect();
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — intentionally runs once

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 0 }}>
      <div id={CONFIG.DOM.CONTAINER_ID} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}