/**
 * sonora. - Mobile Receiver Application Client
 * High-precision multi-device audio sync, sample-accurate scheduled playback,
 * master clock phase locking, continuous crystal drift compensation,
 * channel isolation matrix, jitter buffer queue, and wake-lock retention.
 */

(function () {
  let ws = null;
  let ntpSync = null;
  let audioCtx = null;
  let gainNode = null;
  let isAudioUnlocked = false;
  let currentRole = 'FRONT_LEFT';
  let myChannelIndex = -1;
  let perSpeakerDelayMs = 0;
  let wakeLock = null;
  let roomCode = '';
  let joinRejected = false;
  let hasRegistered = false;
  let hostOnline = true;
  let reconnectTimer = null;

  // Jitter Buffer & Seamless Audio Scheduler State
  let packetQueue = [];
  let isPreRolling = true;
  let scheduledUntil = 0;
  let drainTimer = null;
  const PRE_ROLL_PACKETS = 2; // ~43ms pre-roll cushion (fits cleanly inside 150ms buffer)

  // Persistent Device ID
  let deviceId = localStorage.getItem('sonora_dev_id');
  if (!deviceId) {
    deviceId = 'phone_' + Math.random().toString(36).substring(2, 8);
    localStorage.setItem('sonora_dev_id', deviceId);
  }

  // PLC and PI Filter State
  let lastSeq = null;
  let lastAudioBuffer = null;
  let driftIntegral = 0;
  let streamActiveTimer = null;

  // DOM Elements
  const joinScreen = document.getElementById('joinScreen');
  const activeScreen = document.getElementById('activeScreen');
  const joinForm = document.getElementById('joinForm');
  const roomCodeInput = document.getElementById('roomCodeInput');
  const btnActivateSpeaker = document.getElementById('btnActivateSpeaker');
  const playIconSvg = document.getElementById('playIconSvg');
  const audioActivationStatus = document.getElementById('audioActivationStatus');
  const activeChannelRoleText = document.getElementById('activeChannelRoleText');
  const syncQualityPill = document.getElementById('syncQualityPill');
  const speakerVolume = document.getElementById('speakerVolume');
  const speakerVolumeVal = document.getElementById('speakerVolumeVal');
  const detailRoomName = document.getElementById('detailRoomName');
  const detailChannelRole = document.getElementById('detailChannelRole');
  const detailRtt = document.getElementById('detailRtt');
  const detailOffset = document.getElementById('detailOffset');
  const btnLeaveRoom = document.getElementById('btnLeaveRoom');
  const joinError = document.getElementById('joinError');

  // Pre-fill and auto-connect when arriving from the host QR code / invite link.
  let initialCode = new URLSearchParams(window.location.search).get('code');
  if (!initialCode) {
    const pathMatch = window.location.pathname.match(/\/join\/([^/]+)/);
    if (pathMatch) initialCode = decodeURIComponent(pathMatch[1]);
  }
  if (initialCode) {
    roomCodeInput.value = initialCode.trim();
    // Seamless 1-tap onboarding: Auto-submit room join so mobile users go straight to audio activation
    setTimeout(() => {
      joinForm.dispatchEvent(new Event('submit', { cancelable: true }));
    }, 120);
  }

  // Friendly Device Name
  function getDeviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Pixel/i.test(ua)) return 'Google Pixel';
    if (/Samsung|SM-/i.test(ua)) return 'Samsung Galaxy';
    if (/Android/i.test(ua)) return 'Android Device';
    return 'Mobile Speaker';
  }

  const btnJoinRoom = document.getElementById('btnJoinRoom');
  const activeRoomEyebrow = document.getElementById('activeRoomEyebrow');

  function setJoinSubmitting(submitting) {
    if (!btnJoinRoom) return;
    btnJoinRoom.disabled = submitting;
    const label = btnJoinRoom.querySelector('span');
    if (label) label.textContent = submitting ? 'Connecting...' : 'Connect speaker';
  }

  function updateHostStatusUi(online) {
    hostOnline = online;
    if (activeRoomEyebrow) {
      activeRoomEyebrow.textContent = online ? 'Connected speaker' : 'Host offline — waiting';
    }
    if (!online && audioActivationStatus && isAudioUnlocked && !btnActivateSpeaker.classList.contains('muted')) {
      audioActivationStatus.textContent = 'Host disconnected · Waiting for host...';
    } else if (online && audioActivationStatus && isAudioUnlocked && !btnActivateSpeaker.classList.contains('muted')) {
      audioActivationStatus.textContent = 'Active · Listening for broadcast';
    }
  }

  // Join Room Form Submit
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = roomCodeInput.value.trim();
    if (!code) {
      if (joinError) {
        joinError.textContent = 'Enter the room code shown on the host.';
        joinError.classList.add('visible');
      }
      return;
    }

    roomCode = code;
    joinRejected = false;
    hasRegistered = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (joinError) {
      joinError.textContent = '';
      joinError.classList.remove('visible');
    }

    setJoinSubmitting(true);
    connectWs();
  });

  btnLeaveRoom.addEventListener('click', () => {
    joinRejected = true;
    hasRegistered = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ntpSync) {
      ntpSync.stop();
      ntpSync = null;
    }
    if (ws) ws.close();
    stopDrainLoop();
    packetQueue = [];
    isPreRolling = true;
    scheduledUntil = 0;
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
    setJoinSubmitting(false);
    activeScreen.classList.remove('visible');
    joinScreen.style.display = 'block';
  });

  function connectWs() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const socket = new WebSocket(wsUrl);
    ws = socket;
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
      if (socket !== ws) {
        socket.close();
        return;
      }

      // Resume the scheduler if the page was already unlocked earlier.
      if (isAudioUnlocked) startDrainLoop();

      // Start High-Precision NTP Sync
      if (ntpSync) ntpSync.stop();
      ntpSync = new NtpSync(socket, (stats) => {
        if (detailRtt) detailRtt.textContent = `${stats.rtt}ms`;
        if (detailOffset) detailOffset.textContent = `${Math.abs(Math.round(stats.offset))}ms`;

        // Update real-time sync quality pill using NtpSync quality tier and jitter/RTT
        if (syncQualityPill && stats) {
          const syncErrorMs = Math.max(0.2, stats.jitter || (stats.rtt / 2));
          if (stats.quality === 'STUDIO_LOCK') {
            syncQualityPill.className = 'sync-quality-pill tier-studio';
            syncQualityPill.textContent = `Phase lock · ±${syncErrorMs.toFixed(1)}ms`;
          } else if (stats.quality === 'PRECISION') {
            syncQualityPill.className = 'sync-quality-pill tier-precision';
            syncQualityPill.textContent = `Precision sync · ±${syncErrorMs.toFixed(1)}ms`;
          } else {
            syncQualityPill.className = 'sync-quality-pill tier-good';
            syncQualityPill.textContent = `Wi-Fi buffer · ±${syncErrorMs.toFixed(1)}ms`;
          }
        }

        // Send telemetry back to host
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'TELEMETRY',
            rtt: stats.rtt,
            offset: stats.offset
          }));
        }
      });
      ntpSync.start();

      // Register with host (room code is validated by the server)
      socket.send(JSON.stringify({
        type: 'REGISTER',
        role: 'RECEIVER',
        deviceId,
        roomCode,
        info: {
          name: getDeviceName(),
          ua: navigator.userAgent
        }
      }));
    };

    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        if (!isAudioUnlocked || !audioCtx) return;
        handleAudioPacket(event.data);
        return;
      }

      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'SYNC_PONG') {
          if (ntpSync) ntpSync.handlePong(msg);
        } else if (msg.type === 'REGISTERED') {
          hasRegistered = true;
          setJoinSubmitting(false);
          joinScreen.style.display = 'none';
          activeScreen.classList.add('visible');

          if (msg.channelIndex !== undefined) myChannelIndex = msg.channelIndex;
          if (msg.role) updateRole(msg.role, msg.channelIndex);
          if (Number.isFinite(msg.delayMs)) perSpeakerDelayMs = msg.delayMs;
          if (msg.roomName && detailRoomName) detailRoomName.textContent = msg.roomName;
          if (typeof msg.hostOnline === 'boolean') updateHostStatusUi(msg.hostOnline);
        } else if (msg.type === 'HOST_STATUS') {
          updateHostStatusUi(Boolean(msg.online));
        } else if (msg.type === 'ROLE_ASSIGNED') {
          updateRole(msg.role, msg.channelIndex);
        } else if (msg.type === 'SET_SPEAKER_DELAY') {
          perSpeakerDelayMs = msg.delayMs || 0;
        } else if (msg.type === 'TRIGGER_PING') {
          triggerPingFeedback(msg.role, msg.silentAudio);
        } else if (msg.type === 'ROOM_UPDATED') {
          if (msg.roomName && detailRoomName) detailRoomName.textContent = msg.roomName;
        } else if (msg.type === 'JOIN_REJECTED' || msg.type === 'ROOM_FULL') {
          joinRejected = true;
          hasRegistered = false;
          setJoinSubmitting(false);
          if (joinError) {
            joinError.textContent = msg.reason || 'Could not join this room.';
            joinError.classList.add('visible');
          }
          activeScreen.classList.remove('visible');
          joinScreen.style.display = 'block';
          socket.close();
        }
      } catch (e) {
        console.error('Failed to parse WS msg:', e);
      }
    };

    socket.onclose = () => {
      // Ignore close events from sockets that have already been replaced.
      if (socket !== ws) return;
      if (ntpSync) {
        ntpSync.stop();
        ntpSync = null;
      }
      if (!hasRegistered && !joinRejected) {
        setJoinSubmitting(false);
        if (joinError) {
          joinError.textContent = 'Could not connect to host server. Check Wi-Fi and try again.';
          joinError.classList.add('visible');
        }
        return;
      }
      if (!joinRejected && activeScreen.classList.contains('visible')) {
        if (activeRoomEyebrow) activeRoomEyebrow.textContent = 'Reconnecting...';
        reconnectTimer = setTimeout(connectWs, 2000);
      }
    };
  }

  function updateRole(role, channelIndex) {
    currentRole = role;
    if (channelIndex !== undefined) {
      myChannelIndex = channelIndex;
    }
    const formatted = role ? role.replace(/_/g, ' ') : 'SPEAKER';
    if (activeChannelRoleText) activeChannelRoleText.textContent = formatted;
    if (detailChannelRole) detailChannelRole.textContent = formatted;

    // Reset buffer queue on role change for clean channel transition
    packetQueue = [];
    isPreRolling = true;
    scheduledUntil = 0;
  }

  const SPEAKER_ACTIVE_SVG = `
    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
    </svg>
  `;

  const SPEAKER_MUTED_SVG = `
    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
      <line x1="23" y1="9" x2="17" y2="15"></line>
      <line x1="17" y1="9" x2="23" y2="15"></line>
    </svg>
  `;

  let receiverToastTimer = null;
  function showReceiverToast(msg) {
    const toast = document.getElementById('receiverToast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('visible');
    if (receiverToastTimer) clearTimeout(receiverToastTimer);
    receiverToastTimer = setTimeout(() => {
      toast.classList.remove('visible');
    }, 3500);
  }

  // Tactile Mobile Audio Unlocking & Mute Toggle
  async function unlockAudio() {
    if (isAudioUnlocked) {
      // Toggle mute/unmute on subsequent taps so the button never feels dead
      if (gainNode && audioCtx) {
        const isMuted = gainNode.gain.value === 0;
        const targetVol = speakerVolume ? parseFloat(speakerVolume.value) : 1.0;
        const newGain = isMuted ? (targetVol || 1.0) : 0;
        gainNode.gain.setValueAtTime(newGain, audioCtx.currentTime);

        if (isMuted) {
          btnActivateSpeaker.classList.add('playing');
          btnActivateSpeaker.classList.remove('muted');
          btnActivateSpeaker.innerHTML = SPEAKER_ACTIVE_SVG;
          btnActivateSpeaker.setAttribute('aria-label', 'Mute speaker');
          btnActivateSpeaker.setAttribute('aria-pressed', 'false');
          audioActivationStatus.textContent = hostOnline ? 'Active · Synced speaker' : 'Host disconnected · Waiting for host...';
        } else {
          btnActivateSpeaker.classList.remove('playing');
          btnActivateSpeaker.classList.add('muted');
          btnActivateSpeaker.innerHTML = SPEAKER_MUTED_SVG;
          btnActivateSpeaker.setAttribute('aria-label', 'Unmute speaker');
          btnActivateSpeaker.setAttribute('aria-pressed', 'true');
          audioActivationStatus.textContent = 'Muted (Tap to unmute)';
        }
      }
      return;
    }

    try {
      btnActivateSpeaker.classList.add('unlocking');
      audioActivationStatus.textContent = 'Initializing speaker...';

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      // Do NOT pass latencyHint: 'playback' on mobile as it causes iOS/Android to route to background media player!
      audioCtx = new AudioContextClass({ latencyHint: 'interactive' });

      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      // Warm up mobile DAC
      const dummyBuffer = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
      const dummySource = audioCtx.createBufferSource();
      dummySource.buffer = dummyBuffer;
      dummySource.connect(audioCtx.destination);
      dummySource.start(0);

      // Keep mobile Web Audio thread alive and primed (prevents mobile DAC sleeping)
      try {
        const silentOsc = audioCtx.createOscillator();
        const silentGain = audioCtx.createGain();
        silentGain.gain.value = 0.00001;
        silentOsc.connect(silentGain);
        silentGain.connect(audioCtx.destination);
        silentOsc.start();
      } catch (e) {}

      gainNode = audioCtx.createGain();
      const initialVol = speakerVolume ? parseFloat(speakerVolume.value) : 1.0;
      gainNode.gain.value = initialVol;
      gainNode.connect(audioCtx.destination);

      if (speakerVolume) {
        speakerVolume.addEventListener('input', (e) => {
          const v = parseFloat(e.target.value);
          if (speakerVolumeVal) speakerVolumeVal.textContent = `${Math.round(v * 100)}%`;
          if (gainNode && audioCtx && !btnActivateSpeaker.classList.contains('muted')) {
            gainNode.gain.setValueAtTime(v, audioCtx.currentTime);
          }
        });
      }

      isAudioUnlocked = true;
      startDrainLoop();

      btnActivateSpeaker.classList.remove('unlocking');
      btnActivateSpeaker.classList.add('playing');
      btnActivateSpeaker.innerHTML = SPEAKER_ACTIVE_SVG;
      btnActivateSpeaker.setAttribute('aria-label', 'Mute speaker');
      btnActivateSpeaker.setAttribute('aria-pressed', 'false');

      audioActivationStatus.textContent = hostOnline ? 'Active · Listening for broadcast' : 'Host disconnected · Waiting for host...';

      // Keep screen awake
      acquireWakeLock();

      // Reset playback queues
      packetQueue = [];
      isPreRolling = true;
      scheduledUntil = 0;

      // Success confirmation chime
      playTone(523.25, 0.15);
    } catch (err) {
      btnActivateSpeaker.classList.remove('unlocking');
      audioActivationStatus.textContent = 'Tap to retry';
      showReceiverToast('Could not initialize audio: ' + err.message);
    }
  }

  btnActivateSpeaker.addEventListener('click', unlockAudio);

  async function acquireWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
      } catch (wErr) {
        console.warn('Wake Lock error:', wErr);
      }
    }
  }

  // Re-acquire wakeLock and resume audio context if app is backgrounded and resumed
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      acquireWakeLock();
      if (audioCtx && audioCtx.state === 'suspended' && isAudioUnlocked) {
        await audioCtx.resume();
      }
      // Re-arm pre-roll after background pause
      packetQueue = [];
      isPreRolling = true;
      scheduledUntil = 0;
    }
  });

  function playTone(freq, dur) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    g.gain.setValueAtTime(0.4, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    osc.connect(g);
    g.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  }

  /**
   * Sample-Accurate Master Clock Audio Scheduler with Jitter Buffer
   * Synchronizes playback across multiple devices using NTP master timestamps.
   * Stitches chunks seamlessly end-to-end to completely eliminate clicks, pops, and stutter.
   * Smooth boundary micro-fade to eliminate turn-on clicks on mobile DACs
   */
  function applyBoundaryFadeIn(buffer, numSamples = 64) {
    const data = buffer.getChannelData(0);
    const count = Math.min(numSamples, data.length);
    for (let i = 0; i < count; i++) {
      const w = 0.5 * (1 - Math.cos(Math.PI * i / count));
      data[i] *= w;
    }
  }

  /**
   * Sample-Accurate Master Clock Audio Scheduler with Jitter Buffer,
   * Packet Loss Concealment (PLC), and Proportional-Integral Drift Steering.
   */
  function handleAudioPacket(arrayBuffer) {
    const headerSize = 16;
    if (arrayBuffer.byteLength <= headerSize) return;

    const view = new DataView(arrayBuffer);
    const targetPlayTime = view.getFloat64(0, true); // Target master timestamp (epoch ms)
    const seq = view.getUint16(8, true);
    const channelId = view.getUint8(10);
    const flags = view.getUint8(11);
    const targetSampleRate = view.getUint32(12, true) || 44100;
    const isAdpcm = (flags & 0x01) !== 0;

    // Channel Isolation: drop non-broadcast packets until this speaker has a channel,
    // and always drop packets intended for a different channel.
    if (channelId !== 255 && (myChannelIndex === -1 || channelId !== myChannelIndex)) {
      return;
    }

    const payloadByteLength = arrayBuffer.byteLength - headerSize;
    if (payloadByteLength <= 0) return;

    let numSamples;
    let audioBuffer;

    if (isAdpcm) {
      if (typeof AudioCodec === 'undefined' || payloadByteLength <= 4) return;
      numSamples = (payloadByteLength - 4) * 2;
      if (numSamples <= 0) return;
      audioBuffer = audioCtx.createBuffer(1, numSamples, targetSampleRate);
      AudioCodec.decodeImaAdpcm(
        new Uint8Array(arrayBuffer),
        headerSize,
        numSamples,
        audioBuffer.getChannelData(0)
      );
    } else {
      numSamples = payloadByteLength / 2;
      if (numSamples <= 0 || !Number.isInteger(numSamples)) return;
      const int16View = new Int16Array(arrayBuffer, headerSize, numSamples);
      audioBuffer = audioCtx.createBuffer(1, numSamples, targetSampleRate);
      const channelData = audioBuffer.getChannelData(0);
      for (let i = 0; i < numSamples; i++) {
        channelData[i] = int16View[i] / 32768.0;
      }
    }

    const duration = numSamples / targetSampleRate;

    // Packet Loss Concealment (PLC) for transient 1-packet drop over Wi-Fi
    if (lastAudioBuffer && lastSeq !== null && seq === ((lastSeq + 2) & 0xffff)) {
      const plcDuration = lastAudioBuffer.length / targetSampleRate;
      const plcBuffer = audioCtx.createBuffer(1, lastAudioBuffer.length, targetSampleRate);
      const prevData = lastAudioBuffer.getChannelData(0);
      const plcData = plcBuffer.getChannelData(0);
      for (let i = 0; i < plcData.length; i++) {
        plcData[i] = prevData[i] * Math.exp(-i / (plcData.length * 0.35)) * 0.5;
      }
      packetQueue.push({
        targetPlayTime: targetPlayTime - (plcDuration * 1000),
        buffer: plcBuffer,
        duration: plcDuration,
        seq: (lastSeq + 1) & 0xffff
      });
    }
    lastSeq = seq;
    lastAudioBuffer = audioBuffer;

    // Visual ripple aura animation trigger on audio activity
    const wrapper = btnActivateSpeaker ? btnActivateSpeaker.parentElement : null;
    if (wrapper) {
      wrapper.classList.add('active-stream');
      if (streamActiveTimer) clearTimeout(streamActiveTimer);
      streamActiveTimer = setTimeout(() => {
        wrapper.classList.remove('active-stream');
      }, 500);
    }

    // Push into jitter queue
    packetQueue.push({
      targetPlayTime,
      buffer: audioBuffer,
      duration,
      seq
    });

    // Guard against queue bloating if the network stalled: keep only the
    // freshest packets so we do not build an ever-growing latency backlog.
    if (packetQueue.length > 25) {
      packetQueue.splice(0, packetQueue.length - PRE_ROLL_PACKETS);
      isPreRolling = true;
      scheduledUntil = 0;
      driftIntegral = 0;
    }

    // Drain and schedule packets into Web Audio graph
    drainAudioQueue();
  }

  // Keep draining independently of packet arrival. This prevents a buffered
  // burst (e.g. a channel-test tone) from stalling after the last packet lands.
  function startDrainLoop() {
    if (drainTimer) return;
    drainTimer = setInterval(() => {
      if (isAudioUnlocked && audioCtx) drainAudioQueue();
    }, 50);
  }

  function stopDrainLoop() {
    if (drainTimer) {
      clearInterval(drainTimer);
      drainTimer = null;
    }
  }

  function drainAudioQueue() {
    if (!audioCtx || !isAudioUnlocked) return;
    const curAudioTime = audioCtx.currentTime;
    const outLat = audioCtx.outputLatency || audioCtx.baseLatency || 0;

    // 1. PRE-ROLL PHASE: Build initial jitter cushion (PRE_ROLL_PACKETS = 2 chunks ~43ms)
    if (isPreRolling) {
      const nowMaster = ntpSync
        ? ntpSync.now()
        : ((window.performance && performance.timeOrigin) ? (performance.timeOrigin + performance.now()) : Date.now());

      // Drop stale packets already past target playback + output latency while preserving cushion
      const minPlayableMaster = nowMaster + (outLat * 1000) + 15;
      while (
        packetQueue.length > PRE_ROLL_PACKETS &&
        (packetQueue[0].targetPlayTime + perSpeakerDelayMs) < minPlayableMaster
      ) {
        packetQueue.shift();
      }
      while (
        packetQueue.length &&
        (packetQueue[0].targetPlayTime + perSpeakerDelayMs) < nowMaster - 350
      ) {
        packetQueue.shift();
      }

      const readyImmediate = packetQueue.length === 1 &&
        (packetQueue[0].targetPlayTime + perSpeakerDelayMs - nowMaster) <= (outLat * 1000) + 45;
      if (packetQueue.length < PRE_ROLL_PACKETS && !readyImmediate) {
        return; // Still buffering cushion
      }

      const first = packetQueue.shift();
      const timeUntilTargetSec = (first.targetPlayTime + perSpeakerDelayMs - nowMaster) / 1000;
      const startTime = curAudioTime + Math.max(0.025, timeUntilTargetSec - outLat);

      applyBoundaryFadeIn(first.buffer, 64);

      const source = audioCtx.createBufferSource();
      source.buffer = first.buffer;
      source.connect(gainNode);
      source.start(startTime);

      scheduledUntil = startTime + first.duration;
      isPreRolling = false;
      driftIntegral = 0;
    }

    // 2. CONTINUOUS SCHEDULING: Stitch consecutive chunks seamlessly end-to-end
    while (packetQueue.length > 0) {
      // Buffer comfortably up to 400ms into the Web Audio graph to absorb network jitter
      if (scheduledUntil > curAudioTime + 0.400) {
        break;
      }

      const packet = packetQueue.shift();

      // If scheduled position fell slightly behind current audio time (transient underrun),
      // DO NOT wipe the queue! Catch up scheduledUntil smoothly with a tiny fade-in.
      if (scheduledUntil < curAudioTime) {
        scheduledUntil = curAudioTime + 0.025;
        applyBoundaryFadeIn(packet.buffer, 64);
      }

      const nowMaster = ntpSync
        ? ntpSync.now()
        : ((window.performance && performance.timeOrigin) ? (performance.timeOrigin + performance.now()) : Date.now());
      const idealCtxTime = curAudioTime + ((packet.targetPlayTime + perSpeakerDelayMs - nowMaster) / 1000) - outLat;
      const drift = scheduledUntil - idealCtxTime;

      // Resync smoothly only if massive drift occurred (e.g. phone was locked for seconds)
      if (Math.abs(drift) > 0.300) {
        scheduledUntil = Math.max(curAudioTime + 0.025, idealCtxTime);
        applyBoundaryFadeIn(packet.buffer, 64);
        driftIntegral = 0;
      }

      // Proportional-Integral (PI) clock-steering filter:
      // converges faster (±0.8%) when drift > 15ms, then locks inaudibly (±0.15%)
      driftIntegral = Math.max(-0.03, Math.min(0.03, driftIntegral + drift * 0.03));
      const rateLimit = Math.abs(drift) > 0.015 ? 0.008 : 0.0015;
      const rateAdjustment = (drift * 0.08) + (driftIntegral * 0.025);
      const rate = Math.max(1.0 - rateLimit, Math.min(1.0 + rateLimit, 1.0 + rateAdjustment));

      const source = audioCtx.createBufferSource();
      source.buffer = packet.buffer;
      source.playbackRate.value = rate;
      source.connect(gainNode);
      source.start(scheduledUntil);

      // Advance schedule seamlessly: buffer N+1 starts at the exact sample buffer N finishes
      scheduledUntil += (packet.duration / rate);
    }
  }

  function triggerPingFeedback(role, silentAudio = false) {
    document.body.classList.add('ping-active');
    if ('vibrate' in navigator) {
      navigator.vibrate([200, 100, 200]);
    }
    if (!silentAudio && audioCtx && isAudioUnlocked) {
      playTone(1200, 0.4);
    }
    setTimeout(() => {
      document.body.classList.remove('ping-active');
    }, 1200);
  }
})();
