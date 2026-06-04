/**
 * App.jsx — Space Town virtual office
 *
 * ┌──────────────────────────────────────────────────────┐
 * │  ARCHITECTURE                                        │
 * │  CONFIG           → all constants & event names      │
 * │  CLR              → design-token colour map          │
 * │  socket           → module-level IO singleton        │
 * │                                                      │
 * │  useGlobalStyles  → CSS/font injection (once)        │
 * │  useAudioLevel    → rAF volume loop, proper cleanup  │
 * │  useMediaDevices  → camera/mic lifecycle             │
 * │  usePeerSession   → PeerJS + socket event lifecycle  │
 * │  useScreenShare   → screen capture, proximity calls  │
 * │  useChat          → room messaging                   │
 * │  useReactions     → ephemeral emoji reactions        │
 * │                                                      │
 * │  AvatarSprite     → pixel-art reused across views    │
 * │  AudioVisualizer  → animated volume bars             │
 * │  VideoPlayer      → single video tile                │
 * │  SessionEndedScreen                                  │
 * │  Sidebar          → online players panel             │
 * │  LobbyScreen      → pre-join device check           │
 * │  OfficeScreen     → map + video + controls           │
 * │  App              → root orchestrator                │
 * └──────────────────────────────────────────────────────┘
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import Peer from 'peerjs';
import Login from './Login';
import GameMap from './GameMap';
import {
  Mic, MicOff, Video, VideoOff, MonitorUp, Smile,
  MessageSquare, MapPin, PhoneOff, Send, ZoomIn, ZoomOut,
  Maximize, Menu, ChevronLeft,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// 1. CONFIGURATION  (single source of truth — no magic strings elsewhere)
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = Object.freeze({
  SOCKET_URL: import.meta.env.VITE_SOCKET_URL,
  AVATARS:    ['Leo', 'Max', 'Noah', 'Nerf'],
  EMOJIS:     ['👍', '❤️', '😂', '👏', '🎉', '🤔'],

  REACTION_TTL_MS:      3000,
  DEVICE_SWAP_DELAY_MS: 50,

  /** Passed to getDisplayMedia */
  SCREEN_CONSTRAINTS: {
    video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    audio: false,
  },

  ZOOM: Object.freeze({ DEFAULT: 1, STEP: 0.2, MIN: 0.5 }),

  /** Socket event names */
  EV: Object.freeze({
    CONNECT:           'connect',
    DISCONNECT:        'disconnect',
    JOIN_OFFICE:       'joinOffice',
    CURRENT_PLAYERS:   'currentPlayers',
    NEW_PLAYER:        'newPlayer',
    PEER_DISCONNECTED: 'peerDisconnected',
    CAMERA_UPDATE:     'actualizarCamara',
    CAMERA_STATE:      'estadoCamara',
    CHAT:              'chatMessage',
    REACTION:          'reaction',
    SEND_REACTION:     'sendReaction',
  }),

  /** PeerJS call metadata — identifies call type on the answering side */
  PEER_TIPO: Object.freeze({ SCREEN: 'pantalla', CAM: 'camara' }),
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. DESIGN TOKENS
// ─────────────────────────────────────────────────────────────────────────────

const CLR = Object.freeze({
  primary:      '#6366f1',
  primaryLight: '#eef2ff',
  primaryText:  '#4338ca',
  success:      '#10b981',
  danger:       '#ef4444',
  dark:         '#111827',
  dark2:        '#1f2124',
  border:       '#36393f',
  btn:          '#374151',
  text:         '#374151',
  muted:        '#6b7280',
  bgGray:       '#e5e7eb',
  bgLight:      '#f9fafb',
  white:        '#ffffff',
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. SOCKET SINGLETON  (module-level so it survives re-renders)
// ─────────────────────────────────────────────────────────────────────────────

const socket = io(CONFIG.SOCKET_URL);

// ─────────────────────────────────────────────────────────────────────────────
// 4. HOOKS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 4a. useGlobalStyles
 * Injects fonts, resets, and keyframes exactly once for the page lifetime.
 */
function useGlobalStyles() {
  useEffect(() => {
    document.body.style.margin = '0';
    document.body.style.fontFamily =
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

    const ID = 'spacetown-global-styles';
    if (document.getElementById(ID)) return;

    const el = document.createElement('style');
    el.id = ID;
    el.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
      * { font-family: 'Inter', system-ui, -apple-system, sans-serif !important; }
      input::placeholder { color: ${CLR.muted}; }
      @keyframes bounce {
        0%, 100% { transform: translate(-50%, -50%) scale(1); }
        50%       { transform: translate(-50%, -50%) scale(1.3); }
      }
      /* Sprite-sheet animation for lobby avatar.
         Uses steps(N) so each frame is held discretely — no interpolation.
         The end position is injected as a CSS custom property by AvatarSprite,
         so this single @keyframes works for any sprite with any number of frames. */
      @keyframes lobby-sprite {
        from { background-position-x: 0px; }
        to   { background-position-x: var(--sprite-end-x, -192px); }
      }
    `;
    document.head.appendChild(el);
    // No cleanup: styles must persist for the entire page lifetime.
  }, []);
}

/**
 * 4b. useAudioLevel
 * Runs an AudioContext + rAF loop to detect microphone volume in real time.
 * Properly cancels the animation frame and closes the context on cleanup.
 * @returns {number} volume 0–255
 */
function useAudioLevel(stream, isMuted) {
  const [level, setLevel] = useState(0);
  const rafRef = useRef(null);

  useEffect(() => {
    if (!stream || isMuted) { setLevel(0); return; }

    const ctx      = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(analyser);
    analyser.fftSize = 256;
    const data = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      analyser.getByteFrequencyData(data);
      setLevel(data.reduce((s, v) => s + v, 0) / data.length);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      ctx.close().catch(() => {});
    };
  }, [stream, isMuted]);

  return level;
}

/**
 * 4c. useMediaDevices
 * Owns the local camera/microphone stream lifecycle:
 *   - Requests initial permission
 *   - Enumerates devices
 *   - Hot-swaps individual tracks without dropping peer calls
 *   - Toggles audio / video enabled state
 *
 * `changeDevice(deviceId, kind, onTrackChanged)` fires the optional callback
 * after the swap so callers can replaceTrack on active PeerJS connections.
 */
function useMediaDevices() {
  const streamRef = useRef(null);
  const [activeStream,  setActiveStream]  = useState(null);
  const [devices,       setDevices]       = useState({ audio: [], video: [] });
  const [selectedAudio, setSelectedAudio] = useState('');
  const [selectedVideo, setSelectedVideo] = useState('');
  const [audioEnabled,  setAudioEnabled]  = useState(true);
  const [videoEnabled,  setVideoEnabled]  = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        streamRef.current = stream;
        setActiveStream(stream);
        const all = await navigator.mediaDevices.enumerateDevices();
        setDevices({
          audio: all.filter(d => d.kind === 'audioinput'),
          video: all.filter(d => d.kind === 'videoinput'),
        });
        setSelectedAudio(stream.getAudioTracks()[0]?.getSettings().deviceId ?? '');
        setSelectedVideo(stream.getVideoTracks()[0]?.getSettings().deviceId ?? '');
      } catch (err) {
        console.warn('[Media] Permission denied or hardware error:', err.name, err.message);
      }
    })();
  }, []);

  /**
   * Toggles the track on/off.
   * Returns the new `enabled` boolean so the caller can emit camera state
   * to the socket without this hook knowing about socket.
   */
  const toggle = useCallback((kind) => {
    const s = streamRef.current; if (!s) return undefined;
    const track = kind === 'audio' ? s.getAudioTracks()[0] : s.getVideoTracks()[0];
    if (!track) return undefined;
    track.enabled = !track.enabled;
    if (kind === 'audio') setAudioEnabled(track.enabled);
    else                  setVideoEnabled(track.enabled);
    return track.enabled;
  }, []);

  const changeDevice = useCallback(async (deviceId, kind, onTrackChanged) => {
    if (!streamRef.current) return;
    const isAudio = kind === 'audio';
    try {
      const ns       = await navigator.mediaDevices.getUserMedia({ [kind]: { deviceId: { exact: deviceId } } });
      const newTrack = isAudio ? ns.getAudioTracks()[0] : ns.getVideoTracks()[0];
      newTrack.enabled = isAudio ? audioEnabled : videoEnabled;

      const old = isAudio
        ? streamRef.current.getAudioTracks()[0]
        : streamRef.current.getVideoTracks()[0];
      if (old) { old.stop(); streamRef.current.removeTrack(old); }
      streamRef.current.addTrack(newTrack);

      // Force VideoPlayer to refresh srcObject (same stream object, different tracks)
      setActiveStream(null);
      setTimeout(() => setActiveStream(streamRef.current), CONFIG.DEVICE_SWAP_DELAY_MS);

      if (isAudio) setSelectedAudio(deviceId); else setSelectedVideo(deviceId);

      // Delegate track replacement in active calls to the caller
      onTrackChanged?.(kind, newTrack);
    } catch (err) {
      console.warn('[Media] Device switch failed:', err.name, err.message);
    }
  }, [audioEnabled, videoEnabled]);

  return {
    streamRef, activeStream,
    devices, selectedAudio, selectedVideo,
    audioEnabled, videoEnabled,
    toggle, changeDevice,
  };
}

/**
 * 4d. usePeerSession
 * Manages the entire PeerJS + socket lifecycle:
 *   - Creates Peer, emits joinOffice, handles currentPlayers / newPlayer
 *   - Answers and initiates video calls
 *   - Routes incoming screen-share calls via the `onIncomingScreen` callback
 *     (decouples from useScreenShare, avoids circular dependency)
 *   - Exposes `replaceTrack(kind, newTrack)` for device hot-swaps
 */
function usePeerSession({ active, userName, avatar, localStreamRef, onIncomingScreen }) {
  const peerRef     = useRef(null);
  const activeCalls = useRef({}); // peerId → PeerJS Call (camera stream)

  const [connected,     setConnected]     = useState(false);
  const [playersInfo,   setPlayersInfo]   = useState({});
  const [remoteStreams, setRemoteStreams] = useState({});
  const [peersMap,      setPeersMap]     = useState({});
  const [nearbyPlayers, setNearbyPlayers] = useState([]);
  const [cameraMuted,   setCameraMuted]  = useState({}); // playerId → bool

  /** Replaces a track in all active peer calls after a device swap. */
  const replaceTrack = useCallback((kind, newTrack) => {
    Object.values(activeCalls.current).forEach(call => {
      call.peerConnection?.getSenders()
        .find(s => s.track?.kind === kind)
        ?.replaceTrack(newTrack)
        .catch(err => console.warn('[PeerCall] replaceTrack failed:', err));
    });
  }, []);

  useEffect(() => {
    if (!active) return;

    // Use named handlers so socket.off() removes exactly these listeners
    const onConnect    = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    socket.on(CONFIG.EV.CONNECT,    onConnect);
    socket.on(CONFIG.EV.DISCONNECT, onDisconnect);

    const peer = new Peer();
    peerRef.current = peer;

    peer.on('error', err => console.warn('[Peer] Error:', err.type, err.message));

    peer.on('open', id => {
      socket.emit(CONFIG.EV.JOIN_OFFICE, { userName, avatar, peerId: id });
      // Add local player info immediately so the sidebar can show "Tú"
      setPlayersInfo(prev => ({ ...prev, [socket.id]: { userName, avatar, isMe: true } }));
    });

    const onCurrentPlayers = (players) => {
      setPlayersInfo(players);
      const peerIdMap = {};
      Object.values(players).forEach(p => {
        if (!p.peerId) return;
        peerIdMap[p.peerId] = p.playerId;
        if (p.playerId !== socket.id && localStreamRef.current) {
          const call = peer.call(p.peerId, localStreamRef.current, {
            metadata: { tipo: CONFIG.PEER_TIPO.CAM },
          });
          activeCalls.current[p.peerId] = call;
          call.on('stream', s => setRemoteStreams(prev => ({ ...prev, [p.peerId]: s })));
          call.on('error',  e => console.warn('[Call] Stream error:', e));
        }
      });
      setPeersMap(prev => ({ ...prev, ...peerIdMap }));
    };

    const onNewPlayer = (info) => {
      setPlayersInfo(prev => ({ ...prev, [info.playerId]: info }));
      if (info.peerId) setPeersMap(prev => ({ ...prev, [info.peerId]: info.playerId }));
    };

    const onPeerDisconnected = (peerId) => {
      setRemoteStreams(prev => { const n = { ...prev }; delete n[peerId]; return n; });
      delete activeCalls.current[peerId];
    };

    const onCameraUpdate = (data) =>
      setCameraMuted(prev => ({ ...prev, [data.playerId]: !data.videoHabilitado }));

    socket.on(CONFIG.EV.CURRENT_PLAYERS,   onCurrentPlayers);
    socket.on(CONFIG.EV.NEW_PLAYER,        onNewPlayer);
    socket.on(CONFIG.EV.PEER_DISCONNECTED, onPeerDisconnected);
    socket.on(CONFIG.EV.CAMERA_UPDATE,     onCameraUpdate);

    peer.on('call', call => {
      if (call.metadata?.tipo === CONFIG.PEER_TIPO.SCREEN) {
        // Incoming screen share — delegate to App via callback, no tight coupling
        call.answer();
        call.on('stream', stream => onIncomingScreen?.({ stream, peerId: call.peer }));
        call.on('close',  ()     => onIncomingScreen?.(null));
      } else {
        call.answer(localStreamRef.current);
        activeCalls.current[call.peer] = call;
        call.on('stream', s => setRemoteStreams(prev => ({ ...prev, [call.peer]: s })));
      }
    });

    return () => {
      // Remove exactly these handlers, leaving other listeners intact
      socket.off(CONFIG.EV.CONNECT,           onConnect);
      socket.off(CONFIG.EV.DISCONNECT,        onDisconnect);
      socket.off(CONFIG.EV.CURRENT_PLAYERS,   onCurrentPlayers);
      socket.off(CONFIG.EV.NEW_PLAYER,        onNewPlayer);
      socket.off(CONFIG.EV.PEER_DISCONNECTED, onPeerDisconnected);
      socket.off(CONFIG.EV.CAMERA_UPDATE,     onCameraUpdate);
      peer.destroy();
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    peerRef, replaceTrack, connected,
    playersInfo, remoteStreams, peersMap,
    nearbyPlayers, setNearbyPlayers,
    cameraMuted,
  };
}

/**
 * 4e. useScreenShare
 * Manages screen capture and proximity-gated peer calls:
 *   - Calls only nearby peers (opens/closes calls as proximity changes)
 *   - Stops if no one is nearby
 *   - Dismisses remote screen if the presenter moves away
 *
 * `pantallaGlobal` lives in App to avoid a circular dependency between
 * this hook (needs peerRef) and usePeerSession (needs onIncomingScreen).
 */
function useScreenShare({ active, nearbyPlayers, peersMap, peerRef, pantallaGlobal, setPantallaGlobal }) {
  const [myScreenStream, setMyScreenStream] = useState(null);
  const [zoom,           setZoom]           = useState(CONFIG.ZOOM.DEFAULT);
  const panRef        = useRef({ x: 0, y: 0 });
  const screenCalls   = useRef({});   // peerId → PeerJS Call (screen stream)
  const localScreenRef = useRef(null);

  const stopShare = useCallback(() => {
    localScreenRef.current?.getTracks().forEach(t => t.stop());
    Object.values(screenCalls.current).forEach(c => c.close());
    screenCalls.current  = {};
    localScreenRef.current = null;
    setMyScreenStream(null);
    setPantallaGlobal(null);
  }, [setPantallaGlobal]);

  // Open/close screen calls as nearby players change
  useEffect(() => {
    if (!active || !myScreenStream) return;
    if (nearbyPlayers.length === 0) { stopShare(); return; }

    const nearbyPeerIds = nearbyPlayers
      .map(pid => Object.keys(peersMap).find(k => peersMap[k] === pid))
      .filter(Boolean);

    // Close calls for players who left proximity
    Object.keys(screenCalls.current).forEach(pid => {
      if (!nearbyPeerIds.includes(pid)) {
        screenCalls.current[pid].close();
        delete screenCalls.current[pid];
      }
    });

    // Open calls for newly nearby players
    nearbyPeerIds.forEach(pid => {
      if (!screenCalls.current[pid] && peerRef.current) {
        screenCalls.current[pid] = peerRef.current.call(
          pid, myScreenStream, { metadata: { tipo: CONFIG.PEER_TIPO.SCREEN } }
        );
      }
    });
  }, [nearbyPlayers, myScreenStream, active, peersMap, stopShare]);

  /**
   * Mirrors the original call.on('stream') handler that did:
   *   setZoomPantalla(1); panRef.current = { x: 0, y: 0 };
   * Runs only when pantallaGlobal reference changes (new stream arrives),
   * not on every nearbyPlayers update.
   */
  useEffect(() => {
    if (!pantallaGlobal || pantallaGlobal.peerId === 'local') return;
    setZoom(CONFIG.ZOOM.DEFAULT);
    panRef.current = { x: 0, y: 0 };
  }, [pantallaGlobal]); // intentionally narrow — fires on stream arrival only

  // Stop watching a remote screen if the presenter leaves proximity
  useEffect(() => {
    if (!pantallaGlobal || pantallaGlobal.peerId === 'local') return;
    const presenterId = peersMap[pantallaGlobal.peerId];
    if (presenterId && !nearbyPlayers.includes(presenterId)) setPantallaGlobal(null);
  }, [nearbyPlayers, pantallaGlobal, peersMap, setPantallaGlobal]);

  const startShare = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(CONFIG.SCREEN_CONSTRAINTS);
      localScreenRef.current = stream;
      setMyScreenStream(stream);
      setPantallaGlobal({ stream, peerId: 'local' });
      setZoom(CONFIG.ZOOM.DEFAULT);
      panRef.current = { x: 0, y: 0 };
      stream.getVideoTracks()[0].onended = stopShare; // user closes browser picker
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        console.warn('[ScreenShare] Error starting capture:', err.name, err.message);
      }
    }
  }, [stopShare, setPantallaGlobal]);

  const resetView = useCallback((videoEl) => {
    setZoom(CONFIG.ZOOM.DEFAULT);
    panRef.current = { x: 0, y: 0 };
    if (videoEl) videoEl.style.transform = 'translate(0px, 0px) scale(1)';
  }, []);

  return { myScreenStream, zoom, setZoom, panRef, startShare, stopShare, resetView };
}

/**
 * 4f. useChat
 * Room-wide text messaging over socket.
 * Uses a named handler for precise socket.off cleanup.
 */
function useChat({ active, userName }) {
  const [messages,   setMessages]   = useState([]);
  const [currentMsg, setCurrentMsg] = useState('');
  const [isOpen,     setIsOpen]     = useState(false);

  useEffect(() => {
    if (!active) return;
    const onMessage = (data) => {
      // Server wraps messages as { playerId, msg: { text, userName, timestamp } }.
      // Unwrap so the messages array always contains flat { text, userName, timestamp }.
      const message = data?.msg ?? data;
      setMessages(prev => [...prev, message]);
      setIsOpen(true);
    };
    socket.on(CONFIG.EV.CHAT, onMessage);
    return () => socket.off(CONFIG.EV.CHAT, onMessage);
  }, [active]);

  const send = useCallback(() => {
    const text = currentMsg.trim(); if (!text) return;
    socket.emit(CONFIG.EV.CHAT, { text, userName, timestamp: Date.now() });
    setCurrentMsg('');
  }, [currentMsg, userName]);

  return { messages, currentMsg, setCurrentMsg, isOpen, setIsOpen, send };
}

/**
 * 4g. useReactions
 * Ephemeral emoji overlays that auto-clear after REACTION_TTL_MS.
 * Uses a named handler for precise socket.off cleanup.
 */
function useReactions({ active }) {
  const [reactions, setReactions] = useState({});

  useEffect(() => {
    if (!active) return;
    const onReaction = ({ playerId, emoji }) => {
      setReactions(prev => ({ ...prev, [playerId]: emoji }));
      setTimeout(() => {
        setReactions(prev => { const n = { ...prev }; delete n[playerId]; return n; });
      }, CONFIG.REACTION_TTL_MS);
    };
    socket.on(CONFIG.EV.REACTION, onReaction);
    return () => socket.off(CONFIG.EV.REACTION, onReaction);
  }, [active]);

  const send = useCallback(emoji => socket.emit(CONFIG.EV.SEND_REACTION, { emoji }), []);

  return { reactions, send };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 5a. AvatarSprite
 * Pixel-art avatar renderer with optional animation.
 *
 * When `animated=true`, loads the PNG once, reads its natural width/height to
 * calculate the exact frame and row count (each source frame is 16×32 px), then
 * animates through all frames of the bottom row (facing camera).
 * This auto-detection means it works for any sprite regardless of how many frames it has.
 */
const AvatarSprite = ({
  name,
  width      = 48,
  height     = 96,
  spriteSheet = 'idle',
  animated   = false,
}) => {
  // Start with a safe default; updated once the image loads.
  const [frames, setFrames] = useState(4);
  const [rows,   setRows]   = useState(4);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      // Source frame is 16×32 px; derive sheet dimensions from natural size.
      const detectedFrames = Math.max(1, Math.floor(img.naturalWidth  / 16));
      const detectedRows   = Math.max(1, Math.floor(img.naturalHeight / 32));
      setFrames(detectedFrames);
      setRows(detectedRows);
    };
    img.src = `/assets/${name}_${spriteSheet}_16x16.png`;
  }, [name, spriteSheet]);

  const sheetW  = frames * width;          // full sheet width at display scale
  const sheetH  = rows   * height;         // full sheet height at display scale
  const rowOffY = (rows - 1) * height;     // y-offset to the last (down-facing) row
  const endX    = -(frames * width);       // animation end: shift left by all frames

  return (
    <div style={{
      width:               `${width}px`,
      height:              `${height}px`,
      backgroundImage:     `url(/assets/${name}_${spriteSheet}_16x16.png)`,
      backgroundSize:      `${sheetW}px ${sheetH}px`,
      backgroundPosition:  `0px -${rowOffY}px`,
      backgroundRepeat:    'no-repeat',
      imageRendering:      'pixelated',
      flexShrink:          0,
      // CSS custom property carries the dynamic end-x into the @keyframes rule
      '--sprite-end-x':    `${endX}px`,
      ...(animated && {
        animation: `lobby-sprite ${frames * 0.12}s steps(${frames}) infinite`,
      }),
    }} />
  );
};

/**
 * 5b. AudioVisualizer
 * 5-bar equalizer that reflects real-time mic volume via useAudioLevel.
 */
const AudioVisualizer = ({ stream, isMuted }) => {
  const level  = useAudioLevel(stream, isMuted);
  const SCALES = [0.5, 0.8, 1.0, 0.8, 0.5];
  return (
    <div style={{ display: 'flex', gap: '3px', alignItems: 'flex-end', height: '16px', marginLeft: '10px' }}>
      {SCALES.map((scale, i) => (
        <div key={i} style={{
          width:           '4px',
          borderRadius:    '2px',
          transition:      'height 0.05s ease',
          backgroundColor: isMuted ? CLR.btn : CLR.success,
          height:          `${Math.max(4, (level / 255) * 16 * scale)}px`,
        }} />
      ))}
    </div>
  );
};

/**
 * 5c. VideoPlayer
 * Renders a single video tile.
 * Handles the srcObject assignment inside a useEffect so it runs
 * after the video element mounts and whenever the stream changes.
 */
const VideoPlayer = ({ stream, isNearby, videoOff, name, reaction }) => {
  const videoRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && stream && !videoOff) videoRef.current.srcObject = stream;
  }, [stream, videoOff]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: CLR.dark, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
      {videoOff || !stream
        ? <div style={{ color: CLR.muted, fontSize: '13px', fontWeight: '500' }}>Cámara apagada</div>
        : <video ref={videoRef} autoPlay playsInline muted={!isNearby}
                 style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
      }
      <div style={{ position: 'absolute', bottom: '6px', left: '6px', backgroundColor: 'rgba(0,0,0,0.6)', padding: '4px 10px', borderRadius: '6px', color: CLR.white, fontSize: '12px', fontWeight: '600', backdropFilter: 'blur(4px)' }}>
        {name}
      </div>
      {reaction && (
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', fontSize: '45px', animation: 'bounce 0.5s ease infinite', zIndex: 50 }}>
          {reaction}
        </div>
      )}
    </div>
  );
};

/**
 * 5d. SessionEndedScreen
 */
const SessionEndedScreen = () => (
  <div style={{ width: '100vw', height: '100vh', backgroundColor: CLR.bgGray, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
    <h1 style={{ color: CLR.dark, fontWeight: '700' }}>Has abandonado la oficina.</h1>
    <button onClick={() => window.location.reload()}
            style={{ marginTop: '20px', padding: '12px 24px', backgroundColor: '#3b82f6', border: 'none', borderRadius: '8px', color: CLR.white, cursor: 'pointer', fontWeight: 'bold' }}>
      Volver a entrar
    </button>
  </div>
);

/**
 * 5e. Sidebar
 * Online players panel — now rendered as an absolute overlay so toggling it
 * never changes the Phaser canvas size (which caused camera snapping).
 */
const Sidebar = ({ players, onClose }) => (
  <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '260px', height: '100%', backgroundColor: CLR.bgLight, borderRight: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', zIndex: 40, boxShadow: '4px 0 20px rgba(0,0,0,0.18)' }}>
    <div style={{ padding: '20px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ width: '32px', height: '32px', backgroundColor: CLR.primary, borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: CLR.white, fontWeight: 'bold', fontSize: '14px' }}>ST</div>
        <span style={{ fontSize: '16px', fontWeight: '700', color: CLR.dark }}>Space Town</span>
      </div>
      <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: CLR.muted }}>
        <ChevronLeft size={20} />
      </button>
    </div>
    <div style={{ padding: '20px', flex: 1, overflowY: 'auto', boxSizing: 'border-box' }}>
      <span style={{ fontSize: '12px', fontWeight: '700', color: CLR.muted, textTransform: 'uppercase', marginBottom: '15px', display: 'block' }}>
        Online ({players.length})
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {players.map(p => {
          const av = CONFIG.AVATARS.includes(p.avatar) ? p.avatar : CONFIG.AVATARS[0];
          return (
            <div key={p.playerId || 'me'} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ position: 'relative', width: '36px', height: '36px', backgroundColor: CLR.bgGray, borderRadius: '50%', overflow: 'hidden', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '4px' }}>
                <AvatarSprite name={av} width={24} height={48} />
                <div style={{ position: 'absolute', bottom: '2px', right: '2px', width: '8px', height: '8px', backgroundColor: CLR.success, borderRadius: '50%', border: '2px solid white' }} />
              </div>
              <span style={{ fontSize: '14px', fontWeight: '500', color: CLR.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {p.userName} {p.isMe && '(Tú)'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  </div>
);

/**
 * 5f. LobbyScreen
 * Pre-join device check and avatar selection.
 * Pure presentational — all callbacks come from App.
 */
const LobbyScreen = ({
  stream, audioEnabled, videoEnabled, onToggleAudio, onToggleVideo,
  devices, selectedAudio, selectedVideo, onChangeDevice,
  userName, onUserNameChange, selectedAvatar, onAvatarChange, onJoin,
}) => {
  const MIC_BTN_STYLE  = (active) => ({ width: '48px', height: '48px', borderRadius: '50%', border: 'none', backgroundColor: active ? 'rgba(31,33,36,0.7)' : CLR.danger, color: CLR.white, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', backdropFilter: 'blur(4px)' });
  const SELECT_STYLE   = { width: '100%', padding: '12px', borderRadius: '8px', border: '1px solid #d1d5db', backgroundColor: CLR.white, color: CLR.text, outline: 'none', cursor: 'pointer', fontWeight: '500' };

  return (
    <div style={{ width: '100vw', height: '100vh', backgroundColor: CLR.bgGray, display: 'flex', flexDirection: 'column' }}>

      {/* ── Header ── */}
      <div style={{ width: '100%', padding: '20px 40px', display: 'flex', alignItems: 'center', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '36px', height: '36px', backgroundColor: CLR.primary, borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: CLR.white, fontWeight: 'bold' }}>ST</div>
          <span style={{ fontSize: '20px', fontWeight: '700', color: CLR.dark, letterSpacing: '-0.5px' }}>Space Town</span>
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '60px', padding: '0 40px' }}>

        {/* Preview + device selectors */}
        <div style={{ width: '650px', position: 'relative' }}>
          <div style={{ width: '100%', height: '400px', backgroundColor: CLR.dark, borderRadius: '16px', overflow: 'hidden', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)', position: 'relative' }}>
            <VideoPlayer stream={stream} isNearby videoOff={!videoEnabled} name="Tú (Previa)" />
            <div style={{ position: 'absolute', bottom: '20px', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '15px' }}>
              <button onClick={onToggleAudio} style={MIC_BTN_STYLE(audioEnabled)}>{audioEnabled ? <Mic size={20}/> : <MicOff size={20}/>}</button>
              <button onClick={onToggleVideo} style={MIC_BTN_STYLE(videoEnabled)}>{videoEnabled ? <Video size={20}/> : <VideoOff size={20}/>}</button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '15px', marginTop: '20px' }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: '8px' }}>
                <label style={{ fontSize: '11px', fontWeight: '700', color: CLR.muted, letterSpacing: '0.5px' }}>MICRÓFONO</label>
                <AudioVisualizer stream={stream} isMuted={!audioEnabled} />
              </div>
              <select value={selectedAudio} onChange={e => onChangeDevice(e.target.value, 'audio')} style={SELECT_STYLE}>
                {devices.audio.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Predeterminado'}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: '700', color: CLR.muted, marginBottom: '8px', letterSpacing: '0.5px' }}>CÁMARA</label>
              <select value={selectedVideo} onChange={e => onChangeDevice(e.target.value, 'video')} style={SELECT_STYLE}>
                {devices.video.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Predeterminada'}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* Join form */}
        <div style={{ width: '420px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <h1 style={{ fontSize: '36px', margin: '0', color: CLR.dark, fontWeight: '700', lineHeight: '1.2', letterSpacing: '-1px' }}>Welcome to Space Town</h1>
          <input
            type="text" value={userName} onChange={e => onUserNameChange(e.target.value)}
            placeholder="Ej. Walter Peñaherrera"
            style={{ width: '100%', padding: '16px', borderRadius: '10px', border: '1px solid #d1d5db', fontSize: '16px', fontWeight: '500', boxSizing: 'border-box', outline: 'none', backgroundColor: '#f9fafb', color: CLR.dark, transition: '0.2s' }}
          />
          <div>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: '700', color: CLR.muted, marginBottom: '12px', letterSpacing: '0.5px' }}>ELIGE TU AVATAR</label>
            <div style={{ display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '10px' }}>
              {CONFIG.AVATARS.map(name => {
                const sel = name === selectedAvatar;
                return (
                  <button key={name} onClick={() => onAvatarChange(name)} style={{ flexShrink: 0, width: '90px', padding: '15px 5px', borderRadius: '12px', border: sel ? `2px solid ${CLR.primary}` : '1px solid #d1d5db', backgroundColor: sel ? CLR.primaryLight : CLR.white, cursor: 'pointer', transition: 'all 0.2s', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
                    {/* animated=true → auto-detects frame/row count from the PNG */}
                    <AvatarSprite name={name} width={48} height={96} spriteSheet="read" animated />
                    <span style={{ fontWeight: '600', fontSize: '13px', color: sel ? CLR.primaryText : CLR.text, width: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'center' }}>{name}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <button onClick={onJoin} disabled={!userName.trim()}
            style={{ width: '100%', padding: '16px', borderRadius: '10px', border: 'none', backgroundColor: userName.trim() ? CLR.primary : '#9ca3af', color: CLR.white, fontSize: '18px', fontWeight: '600', cursor: userName.trim() ? 'pointer' : 'not-allowed', marginTop: '10px', transition: '0.2s', boxShadow: userName.trim() ? '0 4px 14px rgba(99,102,241,0.4)' : 'none' }}>
            Join
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * 5g. OfficeScreen
 * Full in-office view: sidebar, game map, video grid, screen share,
 * control bar, chat panel, and reaction picker.
 * Owns only its own UI toggle state (sidebar, reaction menu).
 * All logic arrives through props from App.
 */
function OfficeScreen({
  userName, avatar,
  // Media
  activeStream, audioEnabled, videoEnabled, onToggle,
  // Peers
  playersInfo, remoteStreams, peersMap, nearbyPlayers, cameraMuted, onNearbyUpdate,
  // Screen share
  pantallaGlobal, myScreenStream, zoom, setZoom, panRef,
  startShare, stopShare, resetView,
  // Chat
  messages, currentMsg, setCurrentMsg, chatOpen, setChatOpen, onSendMessage,
  // Reactions
  reactions, onSendReaction,
  // Actions
  onLeave,
}) {
  const [sidebarOpen,      setSidebarOpen]      = useState(true);
  const [reactionMenuOpen, setReactionMenuOpen] = useState(false);

  const isDraggingScreen = useRef(false);
  const sharedVideoRef   = useRef(null);

  const TOOL_BTN = (active) => ({
    backgroundColor: active ? CLR.btn : CLR.danger, border: 'none', color: CLR.white,
    padding: '8px 12px', borderRadius: '8px', cursor: 'pointer', transition: '0.2s',
  });

  return (
    // position:relative container — Phaser canvas always fills 100vw/100vh.
    // The sidebar is an absolute overlay; toggling it never resizes the canvas.
    <div style={{ width: '100vw', height: '100vh', position: 'relative', backgroundColor: '#000', overflow: 'hidden' }}>

      {/* ── Sidebar (absolute overlay — does NOT push/resize the game) ── */}
      {sidebarOpen && <Sidebar players={Object.values(playersInfo)} onClose={() => setSidebarOpen(false)} />}

      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>

        {/* Sidebar open button (when closed) */}
        {!sidebarOpen && (
          <button onClick={() => setSidebarOpen(true)}
            style={{ position: 'absolute', top: '20px', left: '20px', zIndex: 30, backgroundColor: 'rgba(255,255,255,0.9)', border: '1px solid #d1d5db', borderRadius: '8px', padding: '8px', cursor: 'pointer', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
            <Menu size={20} color={CLR.text} />
          </button>
        )}

        {/* ── Game Map ── */}
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 1 }}>
          <GameMap socket={socket} userName={userName} avatar={avatar} onNearbyUpdate={onNearbyUpdate} />
        </div>

        {/* ── Screen share dimmer ── */}
        {pantallaGlobal && (
          <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 12, pointerEvents: 'none' }} />
        )}

        {/* ── Screen share view ── */}
        {pantallaGlobal && (
          <div style={{ position: 'absolute', top: '20px', left: '20px', right: '220px', bottom: '100px', backgroundColor: CLR.dark, borderRadius: '12px', zIndex: 15, border: `1px solid ${CLR.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 40px rgba(0,0,0,0.8)' }}>
            {/* Header bar */}
            <div style={{ padding: '10px 15px', backgroundColor: CLR.dark2, borderBottom: `1px solid ${CLR.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', zIndex: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ width: '8px', height: '8px', backgroundColor: CLR.success, borderRadius: '50%', boxShadow: `0 0 5px ${CLR.success}` }} />
                <span style={{ color: CLR.white, fontSize: '13px', fontWeight: '600' }}>
                  {pantallaGlobal.peerId === 'local' ? 'Estás compartiendo pantalla' : 'Viendo presentación'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '5px' }}>
                <button onClick={() => setZoom(z => z + CONFIG.ZOOM.STEP)}               style={{ background: 'none', border: 'none', color: CLR.muted, cursor: 'pointer', padding: '5px' }}><ZoomIn   size={18}/></button>
                <button onClick={() => setZoom(z => Math.max(CONFIG.ZOOM.MIN, z - CONFIG.ZOOM.STEP))} style={{ background: 'none', border: 'none', color: CLR.muted, cursor: 'pointer', padding: '5px' }}><ZoomOut  size={18}/></button>
                <button onClick={() => resetView(sharedVideoRef.current)}                style={{ background: 'none', border: 'none', color: CLR.muted, cursor: 'pointer', padding: '5px' }}><Maximize size={18}/></button>
              </div>
            </div>
            {/* Pannable / zoomable video */}
            <div
              onMouseDown={() => { isDraggingScreen.current = true;  }}
              onMouseUp={()   => { isDraggingScreen.current = false; }}
              onMouseLeave={() => { isDraggingScreen.current = false; }}
              onMouseMove={e => {
                if (!isDraggingScreen.current || !sharedVideoRef.current) return;
                panRef.current.x += e.movementX;
                panRef.current.y += e.movementY;
                sharedVideoRef.current.style.transform = `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${zoom})`;
              }}
              style={{ flex: 1, overflow: 'hidden', display: 'flex', justifyContent: 'center', alignItems: 'center', backgroundColor: '#000', cursor: 'grab' }}
            >
              <video
                ref={v => { sharedVideoRef.current = v; if (v && !v.srcObject) v.srcObject = pantallaGlobal.stream; }}
                autoPlay playsInline muted
                style={{ transform: `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${zoom})`, transition: 'none', objectFit: 'contain', maxWidth: '100%', maxHeight: '100%', pointerEvents: 'none' }}
              />
            </div>
          </div>
        )}

        {/* ── Video grid (local + nearby remotes) ── */}
        <div style={{ position: 'absolute', top: pantallaGlobal ? '20px' : 'auto', bottom: pantallaGlobal ? '100px' : '85px', right: pantallaGlobal ? '20px' : 'auto', left: pantallaGlobal ? 'auto' : '0', width: pantallaGlobal ? '180px' : '100%', display: 'flex', flexDirection: pantallaGlobal ? 'column' : 'row', justifyContent: pantallaGlobal ? 'flex-start' : 'center', gap: '15px', pointerEvents: 'none', zIndex: 20, maxHeight: pantallaGlobal ? 'calc(100vh - 120px)' : 'auto', overflowY: pantallaGlobal ? 'auto' : 'visible' }}>
          {/* Local tile */}
          <div style={{ pointerEvents: 'auto', width: pantallaGlobal ? '100%' : '170px', height: '125px', borderRadius: '12px', overflow: 'hidden', border: `2px solid ${CLR.primary}`, boxShadow: '0 10px 25px rgba(0,0,0,0.4)', flexShrink: 0 }}>
            <VideoPlayer stream={activeStream} isNearby videoOff={!videoEnabled} name={userName} reaction={reactions[socket.id]} />
          </div>
          {/* Remote tiles — all streams rendered; proximity controls opacity */}
          {Object.entries(remoteStreams).map(([peerId, stream]) => {
            const playerId = peersMap[peerId];
            const isNearby = nearbyPlayers.includes(playerId);
            return (
              <div
                key={peerId}
                style={{
                  pointerEvents: isNearby ? 'auto' : 'none',
                  width:         pantallaGlobal ? '100%' : '170px',
                  flexShrink:    0,
                  borderRadius:  '12px',
                  overflow:      'hidden',
                  border:        `2px solid ${CLR.success}`,
                  boxShadow:     '0 10px 25px rgba(0,0,0,0.4)',
                  // Smooth proximity fade: opacity + scale + collapse
                  opacity:       isNearby ? 1    : 0,
                  transform:     isNearby ? 'scale(1)' : 'scale(0.85)',
                  maxHeight:     isNearby ? '125px' : '0px',
                  // Two-phase timing: fade first, then collapse (or vice-versa)
                  transition:    isNearby
                    ? 'max-height 0.3s ease, opacity 0.4s ease 0.1s, transform 0.4s ease 0.1s'
                    : 'opacity 0.3s ease, transform 0.3s ease, max-height 0.35s ease 0.15s',
                }}
              >
                <VideoPlayer
                  stream={stream}
                  isNearby={isNearby}
                  videoOff={cameraMuted[playerId]}
                  name={playersInfo[playerId]?.userName || 'Usuario'}
                  reaction={reactions[playerId]}
                />
              </div>
            );
          })}
        </div>

        {/* ── Reaction emoji picker ── */}
        {reactionMenuOpen && (
          <div style={{ position: 'absolute', bottom: '80px', left: '50%', transform: 'translateX(-50%)', backgroundColor: CLR.dark2, border: `1px solid ${CLR.border}`, borderRadius: '12px', padding: '8px 12px', display: 'flex', gap: '4px', zIndex: 30, boxShadow: '0 10px 30px rgba(0,0,0,0.4)' }}>
            {CONFIG.EMOJIS.map(emoji => (
              <button key={emoji} onClick={() => { onSendReaction(emoji); setReactionMenuOpen(false); }}
                style={{ background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer', padding: '6px 8px', borderRadius: '8px', transition: '0.15s' }}>
                {emoji}
              </button>
            ))}
          </div>
        )}

        {/* ── Control bar ── */}
        <div style={{ position: 'absolute', bottom: '20px', left: '50%', transform: 'translateX(-50%)', zIndex: 20, display: 'flex', gap: '6px', padding: '8px', backgroundColor: 'rgba(31,33,36,0.85)', borderRadius: '12px', boxShadow: '0 10px 30px rgba(0,0,0,0.4)', border: `1px solid ${CLR.border}`, backdropFilter: 'blur(10px)' }}>
          <button onClick={() => onToggle('audio')} style={TOOL_BTN(audioEnabled)}>
            {audioEnabled ? <Mic size={18}/> : <MicOff size={18}/>}
          </button>
          <button onClick={() => onToggle('video')} style={TOOL_BTN(videoEnabled)}>
            {videoEnabled ? <Video size={18}/> : <VideoOff size={18}/>}
          </button>
          {(nearbyPlayers.length > 0 || myScreenStream) && (
            <button onClick={myScreenStream ? stopShare : startShare}
              style={{ ...TOOL_BTN(true), backgroundColor: myScreenStream ? CLR.success : CLR.btn }}>
              <MonitorUp size={18}/>
            </button>
          )}
          <div style={{ width: '1px', backgroundColor: '#4b5563', margin: '0 4px' }} />
          <button onClick={() => setReactionMenuOpen(o => !o)} style={TOOL_BTN(true)}><Smile size={18}/></button>
          <button onClick={() => setChatOpen(o => !o)}
            style={{ ...TOOL_BTN(true), backgroundColor: chatOpen ? CLR.success : CLR.btn }}>
            <MessageSquare size={18}/>
          </button>
          <button onClick={() => window.dispatchEvent(new CustomEvent('teleportToCenter'))} style={TOOL_BTN(true)}>
            <MapPin size={18}/>
          </button>
          <div style={{ width: '1px', backgroundColor: '#4b5563', margin: '0 4px' }} />
          <button onClick={onLeave} style={{ ...TOOL_BTN(true), backgroundColor: CLR.danger }}>
            <PhoneOff size={18}/>
          </button>
        </div>

        {/* ── Chat panel ── */}
        {chatOpen && (
          <div style={{ position: 'absolute', bottom: '80px', right: '20px', width: '300px', backgroundColor: CLR.dark2, border: `1px solid ${CLR.border}`, borderRadius: '12px', zIndex: 25, display: 'flex', flexDirection: 'column', boxShadow: '0 10px 30px rgba(0,0,0,0.4)' }}>
            <div style={{ padding: '12px 16px', borderBottom: `1px solid ${CLR.border}`, color: CLR.white, fontWeight: '600', fontSize: '14px' }}>Chat</div>
            <div style={{ overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '280px' }}>
              {messages.map((msg, i) => {
                // Defensive: try several common field names in case the server
                // uses different naming than our { text, userName } format.
                const who  = msg.userName || msg.user  || msg.nombre || msg.from  || '';
                const body = msg.text     || msg.message || msg.content || msg.mensaje || '';

                // If neither field resolved, the server format is unexpected —
                // log it so the developer can see the actual structure.
                if (!who && !body) console.warn('[Chat] Unknown message format:', msg);

                return (
                  <div key={i} style={{ color: '#d1d5db', fontSize: '13px' }}>
                    {who && (
                      <span style={{ color: CLR.primary, fontWeight: '600' }}>{who}: </span>
                    )}
                    {body || (
                      <span style={{ color: CLR.muted, fontStyle: 'italic', fontSize: '11px' }}>
                        {JSON.stringify(msg)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ padding: '8px', borderTop: `1px solid ${CLR.border}`, display: 'flex', gap: '8px' }}>
              <input
                value={currentMsg}
                onChange={e => setCurrentMsg(e.target.value)}
                onFocus={() => window.dispatchEvent(new CustomEvent('chatInputFocus'))}
                onBlur={()  => window.dispatchEvent(new CustomEvent('chatInputBlur'))}
                onKeyDown={e => {
                  // Stop Phaser from seeing this keydown (prevents WASD/arrows being
                  // consumed by the movement system while typing in the chat).
                  e.stopPropagation();
                  if (e.key === 'Enter') onSendMessage();
                }}
                placeholder="Escribe un mensaje..."
                style={{ flex: 1, padding: '8px', borderRadius: '6px', border: `1px solid ${CLR.border}`, backgroundColor: CLR.btn, color: CLR.white, fontSize: '13px', outline: 'none' }}
              />
              <button onClick={onSendMessage}
                style={{ padding: '8px', backgroundColor: CLR.primary, border: 'none', borderRadius: '6px', color: CLR.white, cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                <Send size={14}/>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. APP  (root orchestrator)
//    Composes all hooks and passes results down.
//    Contains no business logic itself — only wiring.
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  // 1. Estados de flujo: ¿Está logueado? ¿Está en la sala de espera?
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [inLobby, setInLobby] = useState(true);
  const [sessionEnded, setSessionEnded] = useState(false);

  // 2. Datos del usuario
  const [userName, setUserName] = useState('');
  const [selectedAvatar, setSelectedAvatar] = useState(CONFIG.AVATARS[0]);

  /**
   * pantallaGlobal lives here (not inside useScreenShare) to break the
   * circular dependency:  usePeerSession needs to write it (incoming call),
   * useScreenShare needs to read and write it (own share + proximity check).
   */
  const [pantallaGlobal, setPantallaGlobal] = useState(null);

  useGlobalStyles();

  // Verificamos si ya hay un token guardado al cargar la app
  useEffect(() => {
    const token = localStorage.getItem('authToken');
    if (token) {
      setIsLoggedIn(true);
    }
  }, []);

  const media = useMediaDevices();

  const peers = usePeerSession({
    active: isLoggedIn && !inLobby, // Solo activa los peers cuando ya está en la oficina
    userName,
    avatar: selectedAvatar,
    localStreamRef: media.streamRef,
    onIncomingScreen: setPantallaGlobal,
  });

  const screenShare = useScreenShare({
    active: isLoggedIn && !inLobby,
    nearbyPlayers: peers.nearbyPlayers,
    peersMap: peers.peersMap,
    peerRef: peers.peerRef,
    pantallaGlobal,
    setPantallaGlobal,
  });

  const chat = useChat({ active: isLoggedIn && !inLobby, userName });
  const reactions = useReactions({ active: isLoggedIn && !inLobby });

  /**
   * Central toggle handler
   */
  const handleToggle = useCallback((kind) => {
    const enabled = media.toggle(kind);
    if (kind === 'video' && !inLobby && enabled !== undefined) {
      socket.emit(CONFIG.EV.CAMERA_STATE, enabled);
    }
  }, [inLobby, media]);

  /** Tears down peer and socket before showing the ended screen. */
  const handleLeave = useCallback(() => {
    peers.peerRef.current?.destroy();
    socket.disconnect();
    localStorage.removeItem('authToken'); // Opcional: Cerrar sesión real al salir
    setSessionEnded(true);
  }, [peers.peerRef]);

  const handleDeviceChange = useCallback((deviceId, kind) => {
    media.changeDevice(deviceId, kind, peers.replaceTrack);
  }, [media, peers.replaceTrack]);


  // ─────────────────────────────────────────────────────────────────────────────
  // RENDERIZADO DEL FLUJO (Las "Pantallas")
  // ─────────────────────────────────────────────────────────────────────────────

  // Pantalla de Desconexión
  if (sessionEnded) return <SessionEndedScreen />;

  // Paso 1: Pantalla de Login
  if (!isLoggedIn) {
    return (
      <Login 
        onLoginSuccess={(nombreUsuario) => {
          setUserName(nombreUsuario); // Pre-llenamos el nombre en el Lobby
          setIsLoggedIn(true);
        }} 
      />
    );
  }

  // Paso 2: Sala de Espera (Lobby)
  if (inLobby) {
    return (
      <LobbyScreen
        stream={media.activeStream}
        audioEnabled={media.audioEnabled}
        videoEnabled={media.videoEnabled}
        onToggleAudio={() => handleToggle('audio')}
        onToggleVideo={() => handleToggle('video')}
        devices={media.devices}
        selectedAudio={media.selectedAudio}
        selectedVideo={media.selectedVideo}
        onChangeDevice={handleDeviceChange}
        userName={userName}
        onUserNameChange={setUserName}
        selectedAvatar={selectedAvatar}
        onAvatarChange={setSelectedAvatar}
        onJoin={() => setInLobby(false)} // Esto lo pasa a la Oficina
      />
    );
  }

  // Paso 3: La Oficina Virtual (GameMap + Video Calls)
  return (
    <OfficeScreen
      userName={userName}
      avatar={selectedAvatar}
      // Media
      activeStream={media.activeStream}
      audioEnabled={media.audioEnabled}
      videoEnabled={media.videoEnabled}
      onToggle={handleToggle}
      // Peers
      playersInfo={peers.playersInfo}
      remoteStreams={peers.remoteStreams}
      peersMap={peers.peersMap}
      nearbyPlayers={peers.nearbyPlayers}
      cameraMuted={peers.cameraMuted}
      onNearbyUpdate={peers.setNearbyPlayers}
      // Screen share
      pantallaGlobal={pantallaGlobal}
      myScreenStream={screenShare.myScreenStream}
      zoom={screenShare.zoom}
      setZoom={screenShare.setZoom}
      panRef={screenShare.panRef}
      startShare={screenShare.startShare}
      stopShare={screenShare.stopShare}
      resetView={screenShare.resetView}
      // Chat
      messages={chat.messages}
      currentMsg={chat.currentMsg}
      setCurrentMsg={chat.setCurrentMsg}
      chatOpen={chat.isOpen}
      setChatOpen={chat.setIsOpen}
      onSendMessage={chat.send}
      // Reactions
      reactions={reactions.reactions}
      onSendReaction={reactions.send}
      // Actions
      onLeave={handleLeave}
    />
  );
}