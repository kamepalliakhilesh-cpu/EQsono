/**
 * sonora. - Mobile Receiver Application Client
 * Continuous Ring-Buffer Playback Engine with 4-point Hermite Cubic Fractional Resampling,
 * Proportional-Integral Phase-Locked Loop (PLL), Packet Loss Concealment (PLC),
 * and off-main-thread AudioWorklet execution (with seamless HTTP LAN fallback).
 */

(function () {
  let ws = null;
  let ntpSync = null;
  let audioCtx = null;
  let gainNode = null;
  let workletNode = null;
  let fallbackScriptNode = null;
  let ringEngine = null;
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

  // Persistent Device ID
  let deviceId = localStorage.getItem('sonora_dev_id');
  if (!deviceId) {
    deviceId = 'phone_' + Math.random().toString(36).substring(2, 8);
    localStorage.setItem('sonora_dev_id', deviceId);
  }

  // Pre-allocated decode scratch buffer (zero GC per packet)
  const decodeScratch = new Float32Array(4096);
  let lastAuraUpdateMs = 0;
  let streamActiveTimer = null;

  /**
   * Continuous Circular Ring Buffer + 4-Point Hermite Cubic Resampler + Smooth PLL
   * Used directly by the HTTP LAN fallback ScriptProcessorNode so non-HTTPS mobile
   * connections enjoy the exact same zero-boundary, click-free audio as AudioWorklet.
   */
  class ContinuousRingPlayer {
    constructor(contextSampleRate) {
      this.contextSampleRate = contextSampleRate;
      this.RING_SIZE = 131072;
      this.RING_MASK = this.RING_SIZE - 1;
      this.ring = new Float32Array(this.RING_SIZE);

      this.writeSamples = 0;
      this.readSamples = 0;
      this.isPlaying = false;

      this.streamSampleRate = contextSampleRate;
      this.lastSeq = null;
      this.latestEndPlayTimeMs = 0;
      this.latestWriteAnchor = 0;

      this.smoothedErrorMs = 0;
      this.driftIntegral = 0;
      this.lastOutSample = 0;
      this.fadeRemaining = 0;
      this.fadeTotal = 128;
      this.fadeStartSample = 0;
    }

    reset() {
      this.writeSamples = 0;
      this.readSamples = 0;
      this.isPlaying = false;
      this.lastSeq = null;
      this.smoothedErrorMs = 0;
      this.driftIntegral = 0;
      this.fadeStartSample = this.lastOutSample;
      this.fadeRemaining = this.fadeTotal;
    }

    ingestPacket(samples, numSamples, targetPlayTimeMs, seq, pktSampleRate) {
      if (!samples || numSamples <= 0) return;

      if (pktSampleRate && pktSampleRate !== this.streamSampleRate) {
        this.streamSampleRate = pktSampleRate;
        this.reset();
      }

      if (this.lastSeq !== null) {
        const seqDelta = (seq - this.lastSeq) & 0xffff;
        if (seqDelta === 0 || seqDelta > 60000) {
          return;
        }
        if (seqDelta > 1 && seqDelta <= 5) {
          const missingPackets = seqDelta - 1;
          const missingSamples = missingPackets * numSamples;
          const prevIdx = (this.writeSamples - 1) & this.RING_MASK;
          const baseVal = this.writeSamples > 0 ? this.ring[prevIdx] : 0;
          for (let m = 0; m < missingSamples; m++) {
            const decay = Math.exp(-m / (numSamples * 0.5));
            this.ring[(this.writeSamples + m) & this.RING_MASK] = baseVal * decay;
          }
          this.writeSamples += missingSamples;
        } else if (seqDelta > 5) {
          this.reset();
        }
      }

      this.lastSeq = seq;

      if (this.writeSamples - this.readSamples > this.RING_SIZE - numSamples - 2048) {
        this.readSamples = this.writeSamples - Math.floor(this.streamSampleRate * 0.18);
        this.smoothedErrorMs = 0;
        this.driftIntegral = 0;
      }

      for (let i = 0; i < numSamples; i++) {
        this.ring[(this.writeSamples + i) & this.RING_MASK] = samples[i];
      }
      this.writeSamples += numSamples;
      this.latestWriteAnchor = this.writeSamples;
      this.latestEndPlayTimeMs = targetPlayTimeMs + ((numSamples / this.streamSampleRate) * 1000);
    }

    render(outCh, nowMasterMs, outputLatencyMs, speakerDelayMs) {
      const len = outCh.length;
      const ratio = this.streamSampleRate / this.contextSampleRate;
      const minPreRollSamples = Math.floor(this.streamSampleRate * 0.045);

      const desiredPlayTimeMs = nowMasterMs + outputLatencyMs - speakerDelayMs;
      const idealReadSamples = this.latestWriteAnchor -
        (((this.latestEndPlayTimeMs - desiredPlayTimeMs) / 1000) * this.streamSampleRate);

      if (!this.isPlaying) {
        if (this.writeSamples < minPreRollSamples || idealReadSamples < 0) {
          outCh.fill(0);
          this.lastOutSample = 0;
          return;
        }
        const availableFromIdeal = this.writeSamples - idealReadSamples;
        if (availableFromIdeal < minPreRollSamples) {
          outCh.fill(0);
          this.lastOutSample = 0;
          return;
        }
        this.readSamples = Math.max(1, idealReadSamples);
        this.isPlaying = true;
        this.smoothedErrorMs = 0;
        this.driftIntegral = 0;
        this.fadeStartSample = this.lastOutSample;
        this.fadeRemaining = this.fadeTotal;
      }

      if (this.writeSamples - this.readSamples < len * ratio + 4) {
        for (let i = 0; i < len; i++) {
          this.lastOutSample *= 0.92;
          outCh[i] = this.lastOutSample;
        }
        this.isPlaying = false;
        return;
      }

      const rawErrorSamples = idealReadSamples - this.readSamples;
      const rawErrorMs = (rawErrorSamples / this.streamSampleRate) * 1000;
      this.smoothedErrorMs = (this.smoothedErrorMs * 0.92) + (rawErrorMs * 0.08);

      if (Math.abs(this.smoothedErrorMs) > 120) {
        const targetRead = Math.max(1, Math.min(this.writeSamples - minPreRollSamples, idealReadSamples));
        this.readSamples = targetRead;
        this.smoothedErrorMs = 0;
        this.driftIntegral = 0;
        this.fadeStartSample = this.lastOutSample;
        this.fadeRemaining = this.fadeTotal;
      }

      let rateAdj = 0;
      if (Math.abs(this.smoothedErrorMs) > 0.8) {
        this.driftIntegral = Math.max(-0.001, Math.min(0.001, this.driftIntegral + this.smoothedErrorMs * 0.000002));
        rateAdj = (this.smoothedErrorMs * 0.00012) + this.driftIntegral;
        rateAdj = Math.max(-0.0035, Math.min(0.0035, rateAdj));
      }

      const step = ratio * (1.0 + rateAdj);
      const ring = this.ring;
      const mask = this.RING_MASK;
      let rPos = this.readSamples;

      for (let i = 0; i < len; i++) {
        const idx = rPos | 0;
        const frac = rPos - idx;

        const s0 = ring[(idx - 1) & mask];
        const s1 = ring[idx & mask];
        const s2 = ring[(idx + 1) & mask];
        const s3 = ring[(idx + 2) & mask];

        const c0 = s1;
        const c1 = 0.5 * (s2 - s0);
        const c2 = s0 - 2.5 * s1 + 2.0 * s2 - 0.5 * s3;
        const c3 = 0.5 * (s3 - s0) + 1.5 * (s1 - s2);
        let sample = ((c3 * frac + c2) * frac + c1) * frac + c0;

        if (this.fadeRemaining > 0) {
          const alpha = 1.0 - (this.fadeRemaining / this.fadeTotal);
          const w = 0.5 * (1.0 - Math.cos(Math.PI * alpha));
          sample = (this.fadeStartSample * (1.0 - w)) + (sample * w);
          this.fadeRemaining--;
        }

        outCh[i] = sample;
        this.lastOutSample = sample;
        rPos += step;
      }

      this.readSamples = rPos;
    }
  }

  // DOM Elements
  const joinScreen = document.getElementById('joinScreen');
  const activeScreen = document.getElementById('activeScreen');
  const joinForm = document.getElementById('joinForm');
  const roomCodeInput = document.getElementById('roomCodeInput');
  const btnActivateSpeaker = document.getElementById('btnActivateSpeaker');
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
  const btnJoinRoom = document.getElementById('btnJoinRoom');
  const activeRoomEyebrow = document.getElementById('activeRoomEyebrow');

  let initialCode = new URLSearchParams(window.location.search).get('code');
  if (!initialCode) {
    const pathMatch = window.location.pathname.match(/\/join\/([^/]+)/);
    if (pathMatch) initialCode = decodeURIComponent(pathMatch[1]);
  }
  if (initialCode) {
    roomCodeInput.value = initialCode.trim();
    setTimeout(() => {
      joinForm.dispatchEvent(new Event('submit', { cancelable: true }));
    }, 120);
  }

  function getDeviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Pixel/i.test(ua)) return 'Google Pixel';
    if (/Samsung|SM-/i.test(ua)) return 'Samsung Galaxy';
    if (/OnePlus/i.test(ua)) return 'OnePlus';
    if (/iQOO|vivo/i.test(ua)) return 'iQOO / Vivo';
    if (/Android/i.test(ua)) return 'Android Device';
    return 'Mobile Speaker';
  }

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

  function pushWorkletSyncConfig() {
    if (!workletNode || !audioCtx) return;
    const localNow = (window.performance && performance.timeOrigin)
      ? (performance.timeOrigin + performance.now())
      : Date.now();
    const contextBaseEpochMs = localNow - (audioCtx.currentTime * 1000);
    const outLatMs = (audioCtx.outputLatency || audioCtx.baseLatency || 0) * 1000;
    workletNode.port.postMessage({
      type: 'SYNC_CONFIG',
      ntpOffsetMs: ntpSync ? ntpSync.offset : 0,
      perSpeakerDelayMs,
      outputLatencyMs: outLatMs,
      contextBaseEpochMs
    });
  }

  function resetPlaybackStream() {
    if (workletNode) {
      workletNode.port.postMessage({ type: 'RESET' });
    }
    if (ringEngine) {
      ringEngine.reset();
    }
  }

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
    resetPlaybackStream();
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

      if (ntpSync) ntpSync.stop();
      ntpSync = new NtpSync(socket, (stats) => {
        if (detailRtt) detailRtt.textContent = `${stats.rtt}ms`;
        if (detailOffset) detailOffset.textContent = `${Math.abs(Math.round(stats.offset))}ms`;

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

        pushWorkletSyncConfig();

        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'TELEMETRY',
            rtt: stats.rtt,
            offset: stats.offset
          }));
        }
      });
      ntpSync.start();

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
          if (Number.isFinite(msg.delayMs)) {
            perSpeakerDelayMs = msg.delayMs;
            pushWorkletSyncConfig();
          }
          if (msg.roomName && detailRoomName) detailRoomName.textContent = msg.roomName;
          if (typeof msg.hostOnline === 'boolean') updateHostStatusUi(msg.hostOnline);
        } else if (msg.type === 'HOST_STATUS') {
          updateHostStatusUi(Boolean(msg.online));
          if (!msg.online) resetPlaybackStream();
        } else if (msg.type === 'ROLE_ASSIGNED') {
          updateRole(msg.role, msg.channelIndex);
        } else if (msg.type === 'SET_SPEAKER_DELAY') {
          perSpeakerDelayMs = msg.delayMs || 0;
          pushWorkletSyncConfig();
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
    const prevChannel = myChannelIndex;
    currentRole = role;
    if (channelIndex !== undefined) {
      myChannelIndex = channelIndex;
    }
    const formatted = role ? role.replace(/_/g, ' ') : 'SPEAKER';
    if (activeChannelRoleText) activeChannelRoleText.textContent = formatted;
    if (detailChannelRole) detailChannelRole.textContent = formatted;

    if (prevChannel !== myChannelIndex) {
      resetPlaybackStream();
    }
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

  async function unlockAudio() {
    if (isAudioUnlocked) {
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
      audioCtx = new AudioContextClass({ latencyHint: 'interactive' });

      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      gainNode = audioCtx.createGain();
      const initialVol = speakerVolume ? parseFloat(speakerVolume.value) : 1.0;
      gainNode.gain.value = initialVol;
      gainNode.connect(audioCtx.destination);

      // Prefer off-main-thread AudioWorklet when available (HTTPS or localhost)
      let useWorklet = false;
      if (audioCtx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        try {
          await audioCtx.audioWorklet.addModule('/js/receiver-worklet-processor.js');
          workletNode = new AudioWorkletNode(audioCtx, 'sonora-receiver-processor', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1]
          });
          workletNode.connect(gainNode);
          useWorklet = true;
          pushWorkletSyncConfig();
        } catch (wErr) {
          console.warn('Receiver AudioWorklet fallback to ContinuousRingPlayer:', wErr);
        }
      }

      if (!useWorklet) {
        // Plain HTTP LAN fallback: single persistent continuous ring buffer node (zero per-packet node creation)
        ringEngine = new ContinuousRingPlayer(audioCtx.sampleRate);
        fallbackScriptNode = audioCtx.createScriptProcessor(1024, 0, 1);
        fallbackScriptNode.onaudioprocess = (e) => {
          const outCh = e.outputBuffer.getChannelData(0);
          if (!ringEngine) {
            outCh.fill(0);
            return;
          }
          const nowMaster = ntpSync
            ? ntpSync.now()
            : ((window.performance && performance.timeOrigin) ? (performance.timeOrigin + performance.now()) : Date.now());
          const outLatMs = ((audioCtx.outputLatency || audioCtx.baseLatency || 0) * 1000) +
            ((1024 / audioCtx.sampleRate) * 1000);
          ringEngine.render(outCh, nowMaster, outLatMs, perSpeakerDelayMs);
        };
        fallbackScriptNode.connect(gainNode);
      }

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

      btnActivateSpeaker.classList.remove('unlocking');
      btnActivateSpeaker.classList.add('playing');
      btnActivateSpeaker.innerHTML = SPEAKER_ACTIVE_SVG;
      btnActivateSpeaker.setAttribute('aria-label', 'Mute speaker');
      btnActivateSpeaker.setAttribute('aria-pressed', 'false');

      audioActivationStatus.textContent = hostOnline ? 'Active · Listening for broadcast' : 'Host disconnected · Waiting for host...';

      acquireWakeLock();
      resetPlaybackStream();
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

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      acquireWakeLock();
      if (audioCtx && audioCtx.state === 'suspended' && isAudioUnlocked) {
        await audioCtx.resume();
      }
      resetPlaybackStream();
      pushWorkletSyncConfig();
    }
  });

  function playTone(freq, dur) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    g.gain.setValueAtTime(0.35, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    osc.connect(g);
    g.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  }

  /**
   * Decodes incoming binary audio frame and feeds the Continuous Ring Buffer Engine
   */
  function handleAudioPacket(arrayBuffer) {
    const headerSize = 16;
    if (arrayBuffer.byteLength <= headerSize) return;

    const view = new DataView(arrayBuffer);
    const targetPlayTime = view.getFloat64(0, true);
    const seq = view.getUint16(8, true);
    const channelId = view.getUint8(10);
    const flags = view.getUint8(11);
    const targetSampleRate = view.getUint32(12, true) || 48000;
    const isAdpcm = (flags & 0x01) !== 0;

    if (channelId !== 255 && (myChannelIndex === -1 || channelId !== myChannelIndex)) {
      return;
    }

    const payloadByteLength = arrayBuffer.byteLength - headerSize;
    if (payloadByteLength <= 0) return;

    let numSamples = 0;

    if (isAdpcm) {
      if (typeof AudioCodec === 'undefined' || payloadByteLength <= 4) return;
      numSamples = (payloadByteLength - 4) * 2;
      if (numSamples <= 0 || numSamples > decodeScratch.length) return;
      AudioCodec.decodeImaAdpcm(
        new Uint8Array(arrayBuffer),
        headerSize,
        numSamples,
        decodeScratch
      );
    } else {
      numSamples = payloadByteLength >> 1;
      if (numSamples <= 0 || numSamples > decodeScratch.length) return;
      const invScale = 1.0 / 32768.0;
      for (let i = 0; i < numSamples; i++) {
        decodeScratch[i] = view.getInt16(headerSize + (i << 1), true) * invScale;
      }
    }

    if (workletNode) {
      const slice = decodeScratch.slice(0, numSamples);
      workletNode.port.postMessage(
        {
          type: 'PACKET',
          samples: slice,
          numSamples,
          targetPlayTime,
          seq,
          sampleRate: targetSampleRate
        },
        [slice.buffer]
      );
    } else if (ringEngine) {
      ringEngine.ingestPacket(decodeScratch, numSamples, targetPlayTime, seq, targetSampleRate);
    }

    // Throttled UI aura activity indicator (runs at most once every 250ms to avoid DOM GC jitter)
    const now = performance.now();
    if (now - lastAuraUpdateMs > 250) {
      lastAuraUpdateMs = now;
      const wrapper = btnActivateSpeaker ? btnActivateSpeaker.parentElement : null;
      if (wrapper) {
        wrapper.classList.add('active-stream');
        if (streamActiveTimer) clearTimeout(streamActiveTimer);
        streamActiveTimer = setTimeout(() => {
          wrapper.classList.remove('active-stream');
        }, 600);
      }
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
