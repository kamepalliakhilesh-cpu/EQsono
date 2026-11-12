/**
 * sonora. - Master Host Studio Application Controller
 * Coordinates audio capture, clock sync, adaptive spatial surround,
 * soundstage layout visualizer, device rack, and modal dialogues.
 */

(function () {
  let ws = null;
  let ntpSync = null;
  let audioEngine = null;
  let connectedDevices = [];
  let currentMode = 'STEREO'; // 'STEREO' | 'SURROUND'
  let currentSource = 'system'; // 'system' | 'file'
  let roomName = 'Studio room';
  let roomCode = '';
  let hostSecret = '';
  let receiverUrl = '';
  let hostReplaced = false;
  let isCloudRoom = false;
  let applyModeUi = null;
  let toastTimer = null;
  const deviceCustomRoles = {}; // deviceId -> manually chosen role
  const deviceDelays = {};      // deviceId -> per-speaker delay (ms)
  let lastRenderSignature = '';
  const overviewRowNodes = new Map();
  const manageRowNodes = new Map();

  // Navigation Tabs & Views
  const tabOverview = document.getElementById('tabOverview');
  const tabSpeakers = document.getElementById('tabSpeakers');
  const tabSettings = document.getElementById('tabSettings');
  const viewOverview = document.getElementById('viewOverview');
  const viewSpeakers = document.getElementById('viewSpeakers');
  const viewSettings = document.getElementById('viewSettings');

  // Topbar & Header Elements
  const topbarRoomName = document.getElementById('topbarRoomName');
  const popoverRoomCode = document.getElementById('popoverRoomCode');
  const roomMenuPopover = document.getElementById('roomMenuPopover');
  const btnNewRoom = document.getElementById('btnNewRoom');
  const btnGoRoomSettings = document.getElementById('btnGoRoomSettings');
  const networkStatusDot = document.getElementById('networkStatusDot');
  const networkStatusText = document.getElementById('networkStatusText');
  const httpsNoticeBanner = document.getElementById('httpsNoticeBanner');
  const btnDismissHttpsBanner = document.getElementById('btnDismissHttpsBanner');
  const hostToast = document.getElementById('hostToast');
  const sidebarSpeakerCount = document.getElementById('sidebarSpeakerCount');
  const statSpeakerCount = document.getElementById('statSpeakerCount');
  const statModeTitle = document.getElementById('statModeTitle');
  const statModeChip = document.getElementById('statModeChip');
  const statAudioStatus = document.getElementById('statAudioStatus');
  const statAudioDot = document.getElementById('statAudioDot');
  const miniEqualizer = document.getElementById('miniEqualizer');

  // Mode Toggles
  const btnModeStereo = document.getElementById('btnModeStereo');
  const btnModeSurround = document.getElementById('btnModeSurround');
  const btnModeStereo2 = document.getElementById('btnModeStereo2');
  const btnModeSurround2 = document.getElementById('btnModeSurround2');
  const stageModeDesc = document.getElementById('stageModeDesc');
  const stageMixTag = document.getElementById('stageMixTag');

  // Source Choice
  const choiceSystemAudio = document.getElementById('choiceSystemAudio');
  const choiceFileAudio = document.getElementById('choiceFileAudio');
  const choiceDemoAudio = document.getElementById('choiceDemoAudio');
  const demoSelectorBox = document.getElementById('demoSelectorBox');
  const filePlayerBox = document.getElementById('filePlayerBox');
  const fileSeekSlider = document.getElementById('fileSeekSlider');
  const fileCurrentTime = document.getElementById('fileCurrentTime');
  const fileDurationTime = document.getElementById('fileDurationTime');
  const btnFileLoop = document.getElementById('btnFileLoop');
  const btnChooseAnotherFile = document.getElementById('btnChooseAnotherFile');
  const dropOverlay = document.getElementById('dropOverlay');
  const mediaFileInput = document.getElementById('mediaFileInput');
  const activeSourceTitle = document.getElementById('activeSourceTitle');
  const activeSourceSubtitle = document.getElementById('activeSourceSubtitle');
  const sourceLiveDot = document.getElementById('sourceLiveDot');
  let activeDemoPreset = 'synthwave';

  // VU Meter Elements
  const vuFillL = document.getElementById('vuFillL');
  const vuFillR = document.getElementById('vuFillR');
  const vuPeakL = document.getElementById('vuPeakL');
  const vuPeakR = document.getElementById('vuPeakR');
  let peakHoldL = 0;
  let peakHoldR = 0;

  // Transport Player Elements
  const transportIcon = document.getElementById('transportIcon');
  const transportTitle = document.getElementById('transportTitle');
  const transportSubtitle = document.getElementById('transportSubtitle');
  const waveformContainer = document.getElementById('waveformContainer');
  const transportVolume = document.getElementById('transportVolume');
  const transportVolumeText = document.getElementById('transportVolumeText');
  const btnTransportPlay = document.getElementById('btnTransportPlay');
  const playButtonText = document.getElementById('playButtonText');

  // QR & Modals
  const addSpeakerModal = document.getElementById('addSpeakerModal');
  const btnAddSpeaker = document.getElementById('btnAddSpeaker');
  const btnAddSpeakerFromSpeakers = document.getElementById('btnAddSpeakerFromSpeakers');
  const btnCloseAddModal = document.getElementById('btnCloseAddModal');
  const modalQrImage = document.getElementById('modalQrImage');
  const stageQrImage = document.getElementById('stageQrImage');
  const btnModalCopyLink = document.getElementById('btnModalCopyLink');
  const btnCopyInviteLink = document.getElementById('btnCopyInviteLink');
  const roomCodeDisplay = document.getElementById('roomCodeDisplay');
  const modalRoomCode = document.getElementById('modalRoomCode');
  const linkJoinAsSpeaker = document.getElementById('linkJoinAsSpeaker');

  // Connection Guide Modal
  const guideModal = document.getElementById('guideModal');
  const btnOpenGuide = document.getElementById('btnOpenGuide');
  const btnOpenGoodToKnow = document.getElementById('btnOpenGoodToKnow');
  const btnCloseGuideModal = document.getElementById('btnCloseGuideModal');

  // Sound Test Modal
  const testSoundModal = document.getElementById('testSoundModal');
  const btnTestSound = document.getElementById('btnTestSound');
  const btnCloseTestModal = document.getElementById('btnCloseTestModal');

  // Speakers Lists
  const overviewEmptySpeakers = document.getElementById('overviewEmptySpeakers');
  const overviewSpeakersList = document.getElementById('overviewSpeakersList');
  const manageEmptySpeakers = document.getElementById('manageEmptySpeakers');
  const manageSpeakersList = document.getElementById('manageSpeakersList');
  const connectedHeadingCount = document.getElementById('connectedHeadingCount');
  const btnGoToSpeakers = document.getElementById('btnGoToSpeakers');
  const btnConnectPhoneOverview = document.getElementById('btnConnectPhoneOverview');
  const btnConnectPhoneManage = document.getElementById('btnConnectPhoneManage');

  // Room Settings
  const settingRoomName = document.getElementById('settingRoomName');
  const btnSaveRoomName = document.getElementById('btnSaveRoomName');
  const hostDelaySlider = document.getElementById('hostDelaySlider');
  const hostDelayValue = document.getElementById('hostDelayValue');
  const settingCodec = document.getElementById('settingCodec');

  function showToast(msg, isError = false) {
    if (!hostToast) return;
    hostToast.textContent = msg;
    hostToast.classList.toggle('error', Boolean(isError));
    hostToast.classList.add('visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      hostToast.classList.remove('visible');
    }, 3500);
  }

  function setNetworkStatus(state, label) {
    if (networkStatusDot) {
      networkStatusDot.classList.remove('live', 'reconnecting', 'offline');
      if (state) networkStatusDot.classList.add(state);
    }
    if (networkStatusText && label) {
      networkStatusText.textContent = label;
    }
  }

  // Initialize
  async function init() {
    if (httpsNoticeBanner && !window.isSecureContext) {
      httpsNoticeBanner.hidden = false;
    }
    if (btnDismissHttpsBanner && httpsNoticeBanner) {
      btnDismissHttpsBanner.addEventListener('click', () => {
        httpsNoticeBanner.hidden = true;
      });
    }

    setupNavigation();
    setupAudioEngine();
    setupModeToggle();
    setupAudioSources();
    setupTransport();
    setupModals();
    startWaveformAnimation();
    await loadServerInfo();
    setupWebSocket();
  }

  // View Navigation
  function setupNavigation() {
    function switchTab(viewId, activeBtn) {
      [viewOverview, viewSpeakers, viewSettings].forEach(v => {
        v.classList.remove('active-view');
        v.hidden = true;
      });
      [tabOverview, tabSpeakers, tabSettings].forEach(b => b.classList.remove('active'));

      const target = document.getElementById(viewId);
      if (target) {
        target.hidden = false;
        target.classList.add('active-view');
      }
      if (activeBtn) activeBtn.classList.add('active');
    }

    tabOverview.addEventListener('click', () => switchTab('viewOverview', tabOverview));
    tabSpeakers.addEventListener('click', () => switchTab('viewSpeakers', tabSpeakers));
    tabSettings.addEventListener('click', () => switchTab('viewSettings', tabSettings));

    btnGoToSpeakers.addEventListener('click', () => switchTab('viewSpeakers', tabSpeakers));

    if (btnGoRoomSettings) {
      btnGoRoomSettings.addEventListener('click', () => {
        if (roomMenuPopover && typeof roomMenuPopover.hidePopover === 'function') {
          try { roomMenuPopover.hidePopover(); } catch (e) {}
        }
        switchTab('viewSettings', tabSettings);
      });
    }

    if (btnNewRoom) {
      btnNewRoom.addEventListener('click', async () => {
        if (roomMenuPopover && typeof roomMenuPopover.hidePopover === 'function') {
          try { roomMenuPopover.hidePopover(); } catch (e) {}
        }
        try {
          btnNewRoom.disabled = true;
          const res = await fetch('/api/room/new', { method: 'POST' });
          const data = await res.json();
          if (data.roomCode && data.hostSecret) {
            roomCode = data.roomCode;
            hostSecret = data.hostSecret;
            localStorage.setItem('sonora_host_room', roomCode);
            localStorage.setItem('sonora_host_secret', hostSecret);
            await loadServerInfo();
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'REGISTER',
                role: 'HOST',
                roomCode,
                hostSecret
              }));
            }
            showToast(`New room created: ${roomCode}`);
          }
        } catch (err) {
          showToast('Could not create a new room: ' + err.message, true);
        } finally {
          btnNewRoom.disabled = false;
        }
      });
    }

    btnSaveRoomName.addEventListener('click', () => {
      roomName = settingRoomName.value.trim() || 'Studio room';
      settingRoomName.value = roomName;
      topbarRoomName.textContent = roomName;

      // Propagate the new name to every connected phone.
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'SET_ROOM_NAME', roomName }));
      }

      btnSaveRoomName.textContent = 'Saved';
      setTimeout(() => { btnSaveRoomName.textContent = 'Save'; }, 1500);
    });

    hostDelaySlider.addEventListener('input', (e) => {
      const ms = parseInt(e.target.value);
      hostDelayValue.textContent = `${ms}ms`;
      const stageCoord = document.querySelector('.stage-coordinate');
      if (stageCoord) stageCoord.textContent = `Buffer: ${ms}ms`;
      if (audioEngine) audioEngine.setBroadcastDelay(ms);
      localStorage.setItem('sonora_buffer_delay', ms);
    });

    // Profile presets (Wi-Fi, Public Internet WAN, High Jitter)
    document.querySelectorAll('.profile-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const d = parseInt(btn.dataset.delay);
        if (hostDelaySlider) {
          hostDelaySlider.value = d;
          hostDelaySlider.dispatchEvent(new Event('input'));
        }
      });
    });

    // Restore saved buffer delay (both UI and stage readout)
    const savedDelay = localStorage.getItem('sonora_buffer_delay');
    if (savedDelay && hostDelaySlider) {
      const parsedDelay = Math.max(60, Math.min(600, parseInt(savedDelay, 10) || 150));
      hostDelaySlider.value = String(parsedDelay);
      hostDelayValue.textContent = `${parsedDelay}ms`;
      const stageCoord = document.querySelector('.stage-coordinate');
      if (stageCoord) stageCoord.textContent = `Buffer: ${parsedDelay}ms`;
    }

    if (settingCodec) {
      settingCodec.addEventListener('change', (e) => {
        if (audioEngine) audioEngine.setCodec(e.target.value);
        localStorage.setItem('sonora_codec', e.target.value);
      });
    }
  }

  // WebSocket Connection
  function setupWebSocket() {
    if (hostReplaced) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const socket = new WebSocket(wsUrl);
    ws = socket;
    socket.binaryType = 'arraybuffer';

    socket.onopen = async () => {
      if (socket !== ws) {
        socket.close();
        return;
      }

      if (ntpSync) ntpSync.stop();
      ntpSync = new NtpSync(socket, null);
      ntpSync.start();

      if (!roomCode || !hostSecret) {
        await loadServerInfo();
      }

      if (socket.readyState !== WebSocket.OPEN || socket !== ws) return;

      if (roomCode && hostSecret) {
        socket.send(JSON.stringify({
          type: 'REGISTER',
          role: 'HOST',
          roomCode,
          hostSecret
        }));
      }

      if (audioEngine) {
        audioEngine.ws = socket;
        audioEngine.ntpSync = ntpSync;
      }
    };

    socket.onmessage = async (event) => {
      if (socket !== ws) return;
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'SYNC_PONG') {
          if (ntpSync) ntpSync.handlePong(msg);
        } else if (msg.type === 'HOST_REGISTERED') {
          setNetworkStatus('live', isCloudRoom ? 'Cloud relay active' : 'Local network active');
          if (msg.mode && applyModeUi) {
            const serverUiMode = msg.mode === 'DOLBY' ? 'SURROUND' : 'STEREO';
            if (serverUiMode !== currentMode) {
              applyModeUi(serverUiMode, false);
            }
          }
        } else if (msg.type === 'HOST_REJECTED') {
          // Room expired or secret invalid (e.g. server restarted): create fresh room
          localStorage.removeItem('sonora_host_room');
          localStorage.removeItem('sonora_host_secret');
          roomCode = '';
          hostSecret = '';
          await loadServerInfo();
          if (socket.readyState === WebSocket.OPEN && socket === ws && roomCode && hostSecret) {
            socket.send(JSON.stringify({
              type: 'REGISTER',
              role: 'HOST',
              roomCode,
              hostSecret
            }));
          }
        } else if (msg.type === 'HOST_REPLACED') {
          hostReplaced = true;
          setNetworkStatus('offline', 'Replaced by newer tab');
          showToast('Another tab took over this host session.', true);
          if (ntpSync) {
            ntpSync.stop();
            ntpSync = null;
          }
        } else if (msg.type === 'DEVICE_LIST') {
          const validIds = new Set(msg.devices.map(d => d.id));
          Object.keys(deviceCustomRoles).forEach(id => {
            if (!validIds.has(id)) delete deviceCustomRoles[id];
          });
          Object.keys(deviceDelays).forEach(id => {
            if (!validIds.has(id)) delete deviceDelays[id];
          });

          // Preserve the user's manual role and per-speaker delay choices.
          connectedDevices = msg.devices.map(dev => {
            if (deviceDelays[dev.id] === undefined && Number.isFinite(dev.delayMs)) {
              deviceDelays[dev.id] = dev.delayMs;
            } else if (deviceDelays[dev.id] !== undefined && dev.delayMs !== deviceDelays[dev.id]) {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                  type: 'SET_SPEAKER_DELAY',
                  deviceId: dev.id,
                  delayMs: deviceDelays[dev.id]
                }));
              }
            }
            return {
              ...dev,
              customRole: deviceCustomRoles[dev.id]
            };
          });

          if (msg.roomName) {
            roomName = msg.roomName;
            settingRoomName.value = roomName;
            topbarRoomName.textContent = roomName;
          }
          if (msg.roomCode) {
            roomCode = msg.roomCode;
            localStorage.setItem('sonora_host_room', roomCode);
            roomCodeDisplay.textContent = roomCode;
            modalRoomCode.textContent = roomCode;
            if (popoverRoomCode) popoverRoomCode.textContent = roomCode;
          }

          updateDeviceCounts(connectedDevices.length);
          applyAdaptiveSurroundRoles();
          renderSpeakersUI();
        }
      } catch (e) {
        console.error('Failed to parse WS msg:', e);
      }
    };

    socket.onclose = (ev) => {
      if (socket !== ws) return;
      if (ntpSync) {
        ntpSync.stop();
        ntpSync = null;
      }
      if (ev && ev.code === 4001) hostReplaced = true;
      if (!hostReplaced) {
        setNetworkStatus('reconnecting', 'Reconnecting...');
        setTimeout(setupWebSocket, 2000);
      } else {
        setNetworkStatus('offline', 'Session replaced');
      }
    };
  }

  function formatDuration(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const whole = Math.floor(sec);
    const m = Math.floor(whole / 60);
    const s = whole % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  let isSeekingFile = false;

  function setupAudioEngine() {
    audioEngine = new HostAudioEngine(ws, ntpSync);
    audioEngine.setMode(currentMode === 'STEREO' ? 'PARTY' : 'DOLBY');

    const savedDelay = parseInt(localStorage.getItem('sonora_buffer_delay') || '', 10);
    if (Number.isFinite(savedDelay) && savedDelay >= 60 && savedDelay <= 600) {
      audioEngine.setBroadcastDelay(savedDelay);
    }

    const savedVol = parseFloat(localStorage.getItem('sonora_laptop_volume') || '');
    const initialVol = Number.isFinite(savedVol) ? Math.max(0, Math.min(1.5, savedVol)) : parseFloat(transportVolume.value || '0.75');
    transportVolume.value = String(initialVol);
    transportVolumeText.textContent = `${Math.round(initialVol * 100)}%`;
    audioEngine.setLaptopVolume(initialVol);

    const savedCodec = localStorage.getItem('sonora_codec');
    if (savedCodec) audioEngine.setCodec(savedCodec);
    if (settingCodec) settingCodec.value = audioEngine.codec;

    audioEngine.onStreamEnded = (sourceType) => {
      setLiveStatus(false);
      if (sourceType === 'system') {
        activeSourceSubtitle.textContent = 'System sharing stopped';
        transportSubtitle.textContent = 'Ready to broadcast';
      } else if (sourceType === 'file') {
        activeSourceSubtitle.textContent = 'Playback finished';
        transportSubtitle.textContent = 'Click start to replay';
      }
    };
  }

  // Mode Switching (Stereo vs Surround)
  function setupModeToggle() {
    function setMode(mode, notifyServer = true) {
      currentMode = mode;
      const isStereo = mode === 'STEREO';

      // Update toggles
      btnModeStereo.classList.toggle('selected', isStereo);
      btnModeSurround.classList.toggle('selected', !isStereo);
      btnModeStereo2.classList.toggle('selected', isStereo);
      btnModeSurround2.classList.toggle('selected', !isStereo);

      // Update stat cards
      statModeTitle.textContent = isStereo ? 'Stereo' : 'Surround';
      statModeChip.textContent = isStereo ? 'All speakers' : '5.1 matrix';

      // Update stage footer
      stageModeDesc.textContent = isStereo
        ? 'All speakers play identical stereo channel'
        : 'Spatial channels routed to calibrated speaker positions';
      stageMixTag.textContent = isStereo ? 'Stereo' : '5.1 matrix';

      // Update engine & broadcast
      if (audioEngine) audioEngine.setMode(isStereo ? 'PARTY' : 'DOLBY');
      if (notifyServer && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'SET_MODE',
          mode: isStereo ? 'PARTY' : 'DOLBY'
        }));
      }

      applyAdaptiveSurroundRoles();
      renderSpeakersUI();
    }

    applyModeUi = setMode;
    btnModeStereo.addEventListener('click', () => setMode('STEREO', true));
    btnModeSurround.addEventListener('click', () => setMode('SURROUND', true));
    btnModeStereo2.addEventListener('click', () => setMode('STEREO', true));
    btnModeSurround2.addEventListener('click', () => setMode('SURROUND', true));
  }

  // Audio Source Selection & Ingestion
  function setupAudioSources() {
    function updateDemoTitles() {
      const titles = {
        'synthwave': 'Synthwave 80s',
        'spatial-orbit': 'Dolby 5.1 Orbit',
        'sync-pulse': 'Sync Calibration Pulse'
      };
      const sub = {
        'synthwave': 'Synthesized kick, snare, bassline & stereo pads',
        'spatial-orbit': 'Sweeps channels FL -> C -> FR -> SR -> SL -> Sub',
        'sync-pulse': 'Ultra-sharp 500ms acoustic sync calibration impulse'
      };
      activeSourceTitle.textContent = titles[activeDemoPreset] || 'Studio Demo Player';
      activeSourceSubtitle.textContent = sub[activeDemoPreset] || 'Built-in Web Audio generation';
      transportTitle.textContent = titles[activeDemoPreset] || 'Studio Demo Player';
      transportSubtitle.textContent = 'Multi-device synchronized generation';
    }

    function updateFilePlayerVisibility() {
      if (!filePlayerBox) return;
      const show = currentSource === 'file' && audioEngine && audioEngine.hasLoadedFile();
      filePlayerBox.style.display = show ? 'flex' : 'none';
    }

    async function loadAndPlayFile(file, sourceNote = 'Playing audio file') {
      await audioEngine.startFileAudio(file);
      activeSourceTitle.textContent = file.name;
      activeSourceSubtitle.textContent = sourceNote;
      transportTitle.textContent = file.name;
      transportSubtitle.textContent = 'Broadcasting to all speakers';
      updateFilePlayerVisibility();
      setLiveStatus(true);
    }

    choiceSystemAudio.addEventListener('click', () => {
      if (currentSource !== 'system' && audioEngine && audioEngine.isRunning) {
        audioEngine.stopCurrentSource();
        setLiveStatus(false);
      }
      currentSource = 'system';
      choiceSystemAudio.classList.add('selected');
      choiceFileAudio.classList.remove('selected');
      if (choiceDemoAudio) choiceDemoAudio.classList.remove('selected');
      if (demoSelectorBox) demoSelectorBox.style.display = 'none';
      if (filePlayerBox) filePlayerBox.style.display = 'none';
      if (!audioEngine || !audioEngine.isRunning) {
        activeSourceTitle.textContent = 'Your laptop audio';
        activeSourceSubtitle.textContent = 'Ready when you are';
        transportTitle.textContent = 'Laptop System Audio';
        transportSubtitle.textContent = 'Ready to broadcast';
        setLiveStatus(false);
      }
    });

    choiceFileAudio.addEventListener('click', () => {
      if (currentSource !== 'file' && audioEngine && audioEngine.isRunning) {
        audioEngine.stopCurrentSource();
        setLiveStatus(false);
      }
      currentSource = 'file';
      choiceFileAudio.classList.add('selected');
      choiceSystemAudio.classList.remove('selected');
      if (choiceDemoAudio) choiceDemoAudio.classList.remove('selected');
      if (demoSelectorBox) demoSelectorBox.style.display = 'none';
      updateFilePlayerVisibility();
      if (!audioEngine || !audioEngine.hasLoadedFile()) {
        mediaFileInput.click();
      } else {
        const state = audioEngine.getFilePlaybackState();
        if (state) {
          activeSourceTitle.textContent = state.name;
          transportTitle.textContent = state.name;
          setLiveStatus(audioEngine.isRunning);
        }
      }
    });

    if (choiceDemoAudio) {
      choiceDemoAudio.addEventListener('click', () => {
        if (currentSource !== 'demo' && audioEngine && audioEngine.isRunning) {
          audioEngine.stopCurrentSource();
          setLiveStatus(false);
        }
        currentSource = 'demo';
        choiceDemoAudio.classList.add('selected');
        choiceSystemAudio.classList.remove('selected');
        choiceFileAudio.classList.remove('selected');
        if (demoSelectorBox) demoSelectorBox.style.display = 'flex';
        if (filePlayerBox) filePlayerBox.style.display = 'none';
        updateDemoTitles();
      });
    }

    if (demoSelectorBox) {
      demoSelectorBox.querySelectorAll('.demo-pill').forEach(btn => {
        btn.addEventListener('click', async () => {
          demoSelectorBox.querySelectorAll('.demo-pill').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          activeDemoPreset = btn.getAttribute('data-demo');
          updateDemoTitles();
          if (audioEngine && audioEngine.isRunning && currentSource === 'demo') {
            await audioEngine.startDemoAudio(activeDemoPreset);
          }
        });
      });
    }

    if (btnChooseAnotherFile) {
      btnChooseAnotherFile.addEventListener('click', () => {
        mediaFileInput.click();
      });
    }

    if (btnFileLoop) {
      btnFileLoop.addEventListener('click', () => {
        if (!audioEngine) return;
        const nextLoop = !audioEngine.fileLoop;
        audioEngine.setFileLoop(nextLoop);
        btnFileLoop.classList.toggle('active', nextLoop);
        btnFileLoop.setAttribute('aria-pressed', String(nextLoop));
        btnFileLoop.textContent = nextLoop ? 'Loop: On' : 'Loop: Off';
      });
    }

    if (fileSeekSlider) {
      fileSeekSlider.addEventListener('pointerdown', () => { isSeekingFile = true; });
      fileSeekSlider.addEventListener('pointerup', () => { isSeekingFile = false; });
      fileSeekSlider.addEventListener('input', (e) => {
        if (!audioEngine) return;
        const state = audioEngine.getFilePlaybackState();
        if (state && state.duration > 0) {
          const targetSec = (parseFloat(e.target.value) / 100) * state.duration;
          if (fileCurrentTime) fileCurrentTime.textContent = formatDuration(targetSec);
        }
      });
      fileSeekSlider.addEventListener('change', (e) => {
        isSeekingFile = false;
        if (!audioEngine) return;
        const state = audioEngine.getFilePlaybackState();
        if (state && state.duration > 0) {
          const targetSec = (parseFloat(e.target.value) / 100) * state.duration;
          audioEngine.seekFileAudio(targetSec);
        }
      });
    }

    mediaFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      mediaFileInput.value = '';
      if (file) {
        try {
          await loadAndPlayFile(file, 'Playing audio file');
        } catch (err) {
          showToast('Could not play file: ' + err.message, true);
        }
      }
    });

    // Drag-and-drop audio file ingestion
    window.addEventListener('dragover', (e) => {
      const hasFiles = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
      if (!hasFiles) return;
      e.preventDefault();
      if (dropOverlay) dropOverlay.classList.add('drag-active');
    });

    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null && dropOverlay) {
        dropOverlay.classList.remove('drag-active');
      }
    });

    window.addEventListener('drop', async (e) => {
      const hasFiles = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0;
      if (!hasFiles) return;
      e.preventDefault();
      if (dropOverlay) dropOverlay.classList.remove('drag-active');
      const file = e.dataTransfer.files[0];
      if (file.type && !file.type.startsWith('audio/') && !file.type.startsWith('video/')) {
        showToast('Please drop an audio or video file (MP3, WAV, FLAC, M4A, OGG).', true);
        return;
      }

      currentSource = 'file';
      choiceFileAudio.classList.add('selected');
      choiceSystemAudio.classList.remove('selected');
      if (choiceDemoAudio) choiceDemoAudio.classList.remove('selected');
      if (demoSelectorBox) demoSelectorBox.style.display = 'none';

      try {
        await loadAndPlayFile(file, 'Playing dropped audio file');
      } catch (err) {
        showToast('Could not play dropped file: ' + err.message, true);
      }
    });
  }

  // Bottom Transport Player Controls
  function setupTransport() {
    btnTransportPlay.addEventListener('click', async () => {
      if (audioEngine.isRunning) {
        if (currentSource === 'file' && audioEngine.hasLoadedFile()) {
          await audioEngine.pauseFileAudio();
          activeSourceSubtitle.textContent = 'Paused';
          transportSubtitle.textContent = 'Paused — click resume to continue';
        } else {
          audioEngine.stopCurrentSource();
        }
        setLiveStatus(false);
      } else {
        try {
          btnTransportPlay.disabled = true;
          if (currentSource === 'demo') {
            await audioEngine.startDemoAudio(activeDemoPreset);
            setLiveStatus(true);
          } else if (currentSource === 'file') {
            if (audioEngine.hasLoadedFile()) {
              await audioEngine.resumeFileAudio();
              activeSourceSubtitle.textContent = 'Playing audio file';
              transportSubtitle.textContent = 'Broadcasting to all speakers';
              setLiveStatus(true);
            } else {
              mediaFileInput.click();
            }
          } else {
            await audioEngine.startSystemAudio();
            setLiveStatus(true);
            transportTitle.textContent = 'Live System Output';
            transportSubtitle.textContent = 'Synchronized across all phones';
          }
        } catch (err) {
          showToast('Could not start audio sharing: ' + err.message, true);
        } finally {
          btnTransportPlay.disabled = false;
        }
      }
    });

    transportVolume.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      transportVolumeText.textContent = `${Math.round(val * 100)}%`;
      if (audioEngine) audioEngine.setLaptopVolume(val);
      localStorage.setItem('sonora_laptop_volume', String(val));
    });
  }

  function setLiveStatus(isLive) {
    statAudioStatus.textContent = isLive ? 'Live playing' : 'Standing by';
    statAudioDot.classList.toggle('live', isLive);
    miniEqualizer.classList.toggle('live', isLive);
    sourceLiveDot.classList.toggle('live', isLive);
    transportIcon.classList.toggle('live', isLive);
    waveformContainer.classList.toggle('live', isLive);
    document.getElementById('stageContainer').classList.toggle('is-live', isLive);

    if (isLive) {
      btnTransportPlay.classList.add('stop-button');
      playButtonText.textContent = (currentSource === 'file' && audioEngine && audioEngine.hasLoadedFile())
        ? 'Pause broadcast'
        : 'Stop broadcast';
    } else {
      btnTransportPlay.classList.remove('stop-button');
      playButtonText.textContent = (currentSource === 'file' && audioEngine && audioEngine.hasLoadedFile())
        ? 'Resume broadcast'
        : 'Start broadcast';
    }
  }

  // Modals & Sound Test Suite (Native <dialog> with closedby="any" fallback)
  function setupModals() {
    const openDialog = (dlg) => {
      if (!dlg) return;
      if (typeof dlg.showModal === 'function') {
        if (!dlg.open) dlg.showModal();
      } else {
        dlg.setAttribute('open', '');
      }
    };

    const closeDialog = (dlg) => {
      if (!dlg) return;
      if (typeof dlg.close === 'function') {
        if (dlg.open) dlg.close();
      } else {
        dlg.removeAttribute('open');
      }
    };

    // Fallback light-dismiss for browsers lacking <dialog closedby="any"> (e.g. Safari)
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      const outside = (e, dialog) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
        let pressedOutside = false;
        dialog.addEventListener('pointerdown', (e) => { pressedOutside = outside(e, dialog); });
        dialog.addEventListener('pointerup', (e) => {
          if (pressedOutside && outside(e, dialog)) closeDialog(dialog);
        });
      }
    }

    const openAddModal = () => openDialog(addSpeakerModal);
    btnAddSpeaker.addEventListener('click', openAddModal);
    btnAddSpeakerFromSpeakers.addEventListener('click', openAddModal);
    btnConnectPhoneOverview.addEventListener('click', openAddModal);
    btnConnectPhoneManage.addEventListener('click', openAddModal);
    btnCloseAddModal.addEventListener('click', () => closeDialog(addSpeakerModal));

    // Sound Test Modal
    btnTestSound.addEventListener('click', () => openDialog(testSoundModal));
    btnCloseTestModal.addEventListener('click', () => closeDialog(testSoundModal));

    // Channel test buttons
    document.querySelectorAll('.ch-test-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const chId = parseInt(btn.dataset.channel, 10);
        const chName = btn.dataset.name;
        if (audioEngine) audioEngine.playChannelTest(chId, chName);

        // Ping matching speakers visually/haptically (in Stereo mode all speakers share ch 255)
        connectedDevices
          .filter(d => currentMode === 'STEREO' || d.channelIndex === chId)
          .forEach(d => pingSpeaker(d.id, true));
      });
    });

    // Connection guide
    const openGuide = () => openDialog(guideModal);
    btnOpenGuide.addEventListener('click', openGuide);
    btnOpenGoodToKnow.addEventListener('click', openGuide);
    btnCloseGuideModal.addEventListener('click', () => closeDialog(guideModal));

    // Copy invite link (prefer the LAN URL from the server, with legacy fallback)
    const copyLink = async () => {
      let url = receiverUrl;
      if (!url) {
        const fallback = new URL('/receiver', window.location.origin);
        if (roomCode) fallback.searchParams.set('code', roomCode);
        url = fallback.toString();
      }

      let copied = false;
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(url);
          copied = true;
        } catch (e) {}
      }

      if (!copied) {
        try {
          const temp = document.createElement('textarea');
          temp.value = url;
          temp.setAttribute('readonly', '');
          temp.style.position = 'fixed';
          temp.style.opacity = '0';
          document.body.appendChild(temp);
          temp.select();
          copied = document.execCommand('copy');
          document.body.removeChild(temp);
        } catch (e) {}
      }

      if (copied) {
        btnCopyInviteLink.querySelector('span').textContent = 'Link copied!';
        btnModalCopyLink.querySelector('span').textContent = 'Link copied!';
        setTimeout(() => {
          btnCopyInviteLink.querySelector('span').textContent = 'Copy invite link';
          btnModalCopyLink.querySelector('span').textContent = 'Copy invite link';
        }, 2000);
      } else {
        showToast(`Copy link manually: ${url}`, true);
      }
    };

    btnCopyInviteLink.addEventListener('click', copyLink);
    btnModalCopyLink.addEventListener('click', copyLink);
  }

  async function loadServerInfo(requestedIp) {
    try {
      const savedRoom = localStorage.getItem('sonora_host_room') || '';
      const savedSecret = localStorage.getItem('sonora_host_secret') || '';
      const params = new URLSearchParams();
      if (savedRoom) params.set('room', savedRoom);
      if (savedSecret) params.set('hostSecret', savedSecret);
      if (requestedIp) params.set('ip', requestedIp);
      const queryStr = params.toString() ? `?${params.toString()}` : '';

      const res = await fetch(`/api/info${queryStr}`);
      const data = await res.json();

      isCloudRoom = Boolean(data.isCloud);
      if (ws && ws.readyState === WebSocket.OPEN && !hostReplaced) {
        setNetworkStatus('live', isCloudRoom ? 'Cloud relay active' : 'Local network active');
      }

      if (data.qrCodeDataUrl) {
        modalQrImage.src = data.qrCodeDataUrl;
        stageQrImage.src = data.qrCodeDataUrl;
      }
      if (data.receiverUrl) {
        receiverUrl = data.receiverUrl;
        if (linkJoinAsSpeaker) linkJoinAsSpeaker.href = data.receiverUrl;
      }
      if (data.hostSecret) {
        hostSecret = data.hostSecret;
        localStorage.setItem('sonora_host_secret', hostSecret);
      }
      if (data.roomCode) {
        roomCode = data.roomCode;
        localStorage.setItem('sonora_host_room', roomCode);
        roomCodeDisplay.textContent = roomCode;
        modalRoomCode.textContent = roomCode;
        if (popoverRoomCode) popoverRoomCode.textContent = roomCode;
      }
      if (data.roomName) {
        roomName = data.roomName;
        settingRoomName.value = roomName;
        topbarRoomName.textContent = roomName;
      }

      // Render Network Interface switcher if multiple IPs exist (e.g. Wi-Fi and Mobile Hotspot)
      const networkBox = document.getElementById('modalNetworkSelect');
      const networkChips = document.getElementById('networkChips');
      if (networkBox && networkChips) {
        if (data.allIps && data.allIps.length > 1) {
          networkBox.style.display = 'block';
          networkChips.replaceChildren();
          data.allIps.forEach(net => {
            const btn = document.createElement('button');
            btn.type = 'button';
            const isCurrent = net.address === data.localIp;
            btn.className = 'stat-chip';
            btn.style.cursor = 'pointer';
            btn.style.borderColor = isCurrent ? 'var(--accent-teal, #2dd4bf)' : 'var(--border-subtle)';
            btn.style.color = isCurrent ? 'var(--accent-teal, #2dd4bf)' : 'var(--text-secondary)';
            btn.textContent = `${net.type}: ${net.address}`;
            btn.addEventListener('click', () => loadServerInfo(net.address));
            networkChips.appendChild(btn);
          });
        } else {
          networkBox.style.display = 'none';
        }
      }
    } catch (e) {
      console.warn('Could not load server info:', e);
    }
  }

  // Update counts
  function updateDeviceCounts(count) {
    sidebarSpeakerCount.textContent = count;
    statSpeakerCount.textContent = count;
    connectedHeadingCount.textContent = count;
  }

  /**
   * Adaptive Placement Engine:
   * Maps connected speakers to optimal acoustic slots around the room
   */
  function applyAdaptiveSurroundRoles() {
    const count = connectedDevices.length;

    connectedDevices.forEach((dev, idx) => {
      let role = 'STEREO_SPEAKER';
      let chIdx = 255;
      let color = '#2dd4bf';

      if (currentMode === 'SURROUND') {
        if (dev.customRole) {
          const channelMap = { FRONT_LEFT: 1, FRONT_RIGHT: 2, CENTER: 3, SUBWOOFER: 4, REAR_LEFT: 5, REAR_RIGHT: 6 };
          role = dev.customRole;
          chIdx = channelMap[dev.customRole] || 255;
        } else if (count === 1) {
          role = 'FRONT_RIGHT';
          chIdx = 2;
        } else if (count === 2) {
          role = idx === 0 ? 'FRONT_LEFT' : 'FRONT_RIGHT';
          chIdx = idx === 0 ? 1 : 2;
        } else if (count === 3) {
          const roles = ['FRONT_LEFT', 'FRONT_RIGHT', 'SUBWOOFER'];
          const channels = [1, 2, 4];
          role = roles[idx];
          chIdx = channels[idx];
        } else if (count >= 4) {
          const roles = ['FRONT_LEFT', 'FRONT_RIGHT', 'REAR_LEFT', 'REAR_RIGHT', 'SUBWOOFER', 'CENTER'];
          const channels = [1, 2, 5, 6, 4, 3];
          role = roles[idx % roles.length];
          chIdx = channels[idx % channels.length];
        }
      }

      const roleChanged = dev.role !== role || dev.channelIndex !== chIdx;
      dev.role = role;
      dev.channelIndex = chIdx;
      dev.color = color;

      if (roleChanged && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'ASSIGN_ROLE',
          deviceId: dev.id,
          role,
          channelIndex: chIdx,
          color
        }));
      }
    });

    // Notify host audio engine of active destination channels to save bandwidth and CPU
    if (audioEngine) {
      if (currentMode === 'STEREO') {
        audioEngine.setActiveChannels([255]);
      } else {
        const activeChs = connectedDevices
          .map(d => d.channelIndex)
          .filter(ch => ch > 0 && ch <= 6);
        audioEngine.setActiveChannels(activeChs.length > 0 ? activeChs : [1, 2]);
      }
    }

    updateStageSlots();
  }

  /**
   * Updates the 6 spatial Soundstage slots on the room arena by speaker role
   */
  function updateStageSlots() {
    const slots = [
      { role: 'FRONT_LEFT',  code: 'FL',  defaultLabel: 'Front Left',   nodeId: 'slotNodeFL',  labelId: 'slotLabelFL' },
      { role: 'CENTER',      code: 'C',   defaultLabel: 'Center',       nodeId: 'slotNodeC',   labelId: 'slotLabelC' },
      { role: 'FRONT_RIGHT', code: 'FR',  defaultLabel: 'Front Right',  nodeId: 'slotNodeFR',  labelId: 'slotLabelFR' },
      { role: 'SUBWOOFER',   code: 'LFE', defaultLabel: 'Subwoofer',    nodeId: 'slotNodeLFE', labelId: 'slotLabelLFE' },
      { role: 'REAR_LEFT',   code: 'SL',  defaultLabel: 'Surround L',   nodeId: 'slotNodeSL',  labelId: 'slotLabelSL' },
      { role: 'REAR_RIGHT',  code: 'SR',  defaultLabel: 'Surround R',   nodeId: 'slotNodeSR',  labelId: 'slotLabelSR' }
    ];

    if (currentMode === 'STEREO') {
      const stereoOrder = ['FRONT_LEFT', 'FRONT_RIGHT', 'REAR_LEFT', 'REAR_RIGHT', 'CENTER', 'SUBWOOFER'];
      slots.forEach(s => {
        const orderIdx = stereoOrder.indexOf(s.role);
        const node = document.getElementById(s.nodeId);
        const label = document.getElementById(s.labelId);
        if (!node || !label) return;
        const parent = node.parentElement;
        const dev = connectedDevices[orderIdx];
        if (dev) {
          parent.classList.add('has-device');
          node.textContent = `#${orderIdx + 1}`;
          if (orderIdx === stereoOrder.length - 1 && connectedDevices.length > stereoOrder.length) {
            label.textContent = `${dev.name} (+${connectedDevices.length - stereoOrder.length})`;
          } else {
            label.textContent = dev.name;
          }
        } else {
          parent.classList.remove('has-device');
          node.textContent = s.code;
          label.textContent = s.defaultLabel;
        }
      });
      return;
    }

    slots.forEach(s => {
      const node = document.getElementById(s.nodeId);
      const label = document.getElementById(s.labelId);
      if (!node || !label) return;
      const parent = node.parentElement;
      const matching = connectedDevices.filter(d => d.role === s.role);
      if (matching.length > 0) {
        parent.classList.add('has-device');
        node.textContent = matching.length > 1 ? `${s.code}×${matching.length}` : s.code;
        label.textContent = matching.length > 1
          ? `${matching[0].name} (+${matching.length - 1})`
          : `${s.defaultLabel} · ${matching[0].name}`;
      } else {
        parent.classList.remove('has-device');
        node.textContent = s.code;
        label.textContent = s.defaultLabel;
      }
    });
  }

  function createDeviceIconEl() {
    const wrap = document.createElement('div');
    wrap.className = 'device-icon';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('aria-hidden', 'true');
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '5');
    rect.setAttribute('y', '2');
    rect.setAttribute('width', '14');
    rect.setAttribute('height', '20');
    rect.setAttribute('rx', '2');
    rect.setAttribute('ry', '2');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '12');
    line.setAttribute('y1', '18');
    line.setAttribute('x2', '12.01');
    line.setAttribute('y2', '18');
    svg.appendChild(rect);
    svg.appendChild(line);
    wrap.appendChild(svg);
    return wrap;
  }

  /**
   * Render Connected Speakers in bottom section & Speakers tab
   */
  function renderSpeakersUI() {
    const hasDevices = connectedDevices.length > 0;

    overviewEmptySpeakers.style.display = hasDevices ? 'none' : 'flex';
    overviewSpeakersList.style.display = hasDevices ? 'flex' : 'none';
    manageEmptySpeakers.style.display = hasDevices ? 'none' : 'flex';

    if (!hasDevices) {
      lastRenderSignature = '';
      overviewRowNodes.clear();
      manageRowNodes.clear();
      overviewSpeakersList.replaceChildren();
      manageSpeakersList.replaceChildren(manageEmptySpeakers);
      return;
    }

    // Rebuild only when mode/membership/roles/names change. Telemetry-only updates
    // (RTT/offset) are patched into the existing nodes so the delay sliders
    // and role dropdowns are never reset while the user is editing them.
    const signature = `${currentMode}::` + connectedDevices
      .map(d => `${d.id}|${d.role}|${d.name}`)
      .join('~');

    if (signature === lastRenderSignature) {
      updateSpeakerTelemetry();
      return;
    }
    lastRenderSignature = signature;

    overviewRowNodes.clear();
    manageRowNodes.clear();
    overviewSpeakersList.replaceChildren();
    manageSpeakersList.replaceChildren();

    const roleOptions = [
      ['FRONT_LEFT', 'Front Left'],
      ['FRONT_RIGHT', 'Front Right'],
      ['CENTER', 'Center Dialogue'],
      ['SUBWOOFER', 'Subwoofer (LFE)'],
      ['REAR_LEFT', 'Surround Left'],
      ['REAR_RIGHT', 'Surround Right']
    ];

    connectedDevices.forEach((dev, idx) => {
      const num = `${idx + 1}`;
      const roleText = dev.role.replace(/_/g, ' ');
      const savedDelay = deviceDelays[dev.id] || 0;

      // Overview row (DOM nodes only, no innerHTML with device data)
      const row1 = document.createElement('div');
      row1.className = 'speaker-row';

      const num1 = document.createElement('span');
      num1.className = 'speaker-number';
      num1.textContent = num;

      const info1 = document.createElement('div');
      info1.className = 'speaker-info';
      const name1 = document.createElement('strong');
      name1.textContent = dev.name;
      const rttSpan = document.createElement('span');
      rttSpan.className = 'status active dev-rtt';
      rttSpan.style.fontSize = '9px';
      const rttDot = document.createElement('i');
      const rttText = document.createTextNode(` Live synced (Ping: ${Math.round(dev.rtt || 0)}ms)`);
      rttSpan.append(rttDot, rttText);
      info1.append(name1, rttSpan);

      const chip = document.createElement('span');
      chip.className = 'stat-chip';
      chip.style.fontSize = '9px';
      chip.style.padding = '4px 8px';
      chip.style.borderColor = 'var(--accent-teal, #2dd4bf)';
      chip.style.color = 'var(--accent-teal, #2dd4bf)';
      chip.textContent = roleText;

      const pingBtn1 = document.createElement('button');
      pingBtn1.className = 'btn-locate';
      pingBtn1.type = 'button';
      pingBtn1.textContent = 'Ping';
      pingBtn1.addEventListener('click', () => pingSpeaker(dev.id));

      row1.append(num1, createDeviceIconEl(), info1, chip, pingBtn1);
      overviewRowNodes.set(dev.id, rttText);
      overviewSpeakersList.appendChild(row1);

      // Manage speakers detailed row
      const row2 = document.createElement('div');
      row2.className = 'speaker-row detailed';

      const num2 = document.createElement('span');
      num2.className = 'speaker-number';
      num2.textContent = num;

      const info2 = document.createElement('div');
      info2.className = 'speaker-info';
      const name2 = document.createElement('strong');
      name2.textContent = dev.name;
      const offsetSpan = document.createElement('span');
      offsetSpan.className = 'dev-offset';
      offsetSpan.style.fontSize = '10px';
      offsetSpan.style.color = 'var(--text-secondary, #93939f)';
      offsetSpan.textContent = `Clock Offset: ${Math.abs(Math.round(dev.offset || 0))}ms`;
      info2.append(name2, offsetSpan);

      const select = document.createElement('select');
      select.className = 'role-selector';
      if (currentMode === 'STEREO') {
        const stereoOpt = document.createElement('option');
        stereoOpt.value = 'STEREO_SPEAKER';
        stereoOpt.textContent = 'Stereo (All)';
        stereoOpt.selected = true;
        select.appendChild(stereoOpt);
        select.disabled = true;
        select.title = 'Switch to Surround (5.1) mode to assign spatial channels';
        select.setAttribute('aria-label', 'Speaker channel (Stereo all speakers)');
      } else {
        select.setAttribute('aria-label', `Assign spatial channel for ${dev.name}`);
        roleOptions.forEach(([val, labelText]) => {
          const opt = document.createElement('option');
          opt.value = val;
          opt.textContent = labelText;
          if (dev.role === val) opt.selected = true;
          select.appendChild(opt);
        });
        select.addEventListener('change', (e) => {
          dev.customRole = e.target.value;
          deviceCustomRoles[dev.id] = dev.customRole;
          applyAdaptiveSurroundRoles();
          renderSpeakersUI();
        });
      }

      const delayWrap = document.createElement('div');
      delayWrap.className = 'delay-control';
      const delayTitle = document.createElement('span');
      delayTitle.textContent = 'Delay:';
      const delaySlider = document.createElement('input');
      delaySlider.type = 'range';
      delaySlider.className = 'delay-slider';
      delaySlider.min = '0';
      delaySlider.max = '150';
      delaySlider.step = '5';
      delaySlider.value = String(savedDelay);
      const delayLbl = document.createElement('span');
      delayLbl.className = 'delay-lbl';
      delayLbl.textContent = `+${savedDelay}ms`;

      delaySlider.addEventListener('input', (e) => {
        delayLbl.textContent = `+${e.target.value}ms`;
      });
      delaySlider.addEventListener('change', (e) => {
        const delayMs = parseInt(e.target.value, 10) || 0;
        deviceDelays[dev.id] = delayMs;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'SET_SPEAKER_DELAY',
            deviceId: dev.id,
            delayMs
          }));
        }
      });
      delayWrap.append(delayTitle, delaySlider, delayLbl);

      const pingBtn2 = document.createElement('button');
      pingBtn2.className = 'btn-locate';
      pingBtn2.type = 'button';
      pingBtn2.textContent = 'Ping';
      pingBtn2.addEventListener('click', () => pingSpeaker(dev.id));

      row2.append(num2, createDeviceIconEl(), info2, select, delayWrap, pingBtn2);
      manageRowNodes.set(dev.id, offsetSpan);
      manageSpeakersList.appendChild(row2);
    });
  }

  function updateSpeakerTelemetry() {
    connectedDevices.forEach(dev => {
      const rttTextNode = overviewRowNodes.get(dev.id);
      if (rttTextNode) {
        rttTextNode.nodeValue = ` Live synced (Ping: ${Math.round(dev.rtt || 0)}ms)`;
      }

      const offsetEl = manageRowNodes.get(dev.id);
      if (offsetEl) {
        offsetEl.textContent = `Clock Offset: ${Math.abs(Math.round(dev.offset || 0))}ms`;
      }
    });
  }

  function pingSpeaker(deviceId, silentAudio = false) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'PING_DEVICE',
        deviceId,
        silentAudio
      }));
    }
  }

  // Real-time animated Waveform Bars, Dual Stereo VU Meters, File Progress, and Arena Pulses
  function startWaveformAnimation() {
    const bars = waveformContainer.querySelectorAll('i');

    function update() {
      requestAnimationFrame(update);
      const isLive = audioEngine && audioEngine.isRunning;
      const stageNodes = document.querySelectorAll('.stage-speaker .speaker-node');

      if (audioEngine && audioEngine.hasLoadedFile && audioEngine.hasLoadedFile()) {
        const state = audioEngine.getFilePlaybackState();
        if (state && !isSeekingFile && fileSeekSlider) {
          const pct = state.duration > 0 ? (state.currentTime / state.duration) * 100 : 0;
          fileSeekSlider.value = String(Math.min(100, Math.max(0, pct)));
          if (fileCurrentTime) fileCurrentTime.textContent = formatDuration(state.currentTime);
          if (fileDurationTime) fileDurationTime.textContent = formatDuration(state.duration);
        }
      }

      if (isLive && audioEngine.analyser) {
        const freqData = new Uint8Array(bars.length);
        audioEngine.analyser.getByteFrequencyData(freqData);
        bars.forEach((bar, idx) => {
          const val = freqData[idx] || 10;
          const height = Math.max(4, (val / 255) * 32);
          bar.style.height = `${height}px`;
        });

        // Query real-time stereo levels from DSP engine
        const levels = audioEngine.getAudioLevels ? audioEngine.getAudioLevels() : null;
        if (levels) {
          // VU Meter Ballistics
          const pctL = Math.min(100, levels.leftPeak * 115);
          const pctR = Math.min(100, levels.rightPeak * 115);

          if (vuFillL) vuFillL.style.width = `${pctL}%`;
          if (vuFillR) vuFillR.style.width = `${pctR}%`;

          peakHoldL = Math.max(pctL, peakHoldL - 1.2);
          peakHoldR = Math.max(pctR, peakHoldR - 1.2);

          if (vuPeakL) vuPeakL.style.left = `${Math.min(98, peakHoldL)}%`;
          if (vuPeakR) vuPeakR.style.left = `${Math.min(98, peakHoldR)}%`;

          // Stage Arena Speaker Pulse Animation
          const energy = levels.energy;
          stageNodes.forEach(node => {
            if (node.parentElement && node.parentElement.classList.contains('has-device')) {
              if (energy > 0.08) {
                node.classList.add('audio-pulse');
              } else {
                node.classList.remove('audio-pulse');
              }
            } else {
              node.classList.remove('audio-pulse');
            }
          });
        }
      } else {
        bars.forEach((bar) => { bar.style.height = '4px'; });
        if (vuFillL) vuFillL.style.width = '0%';
        if (vuFillR) vuFillR.style.width = '0%';
        if (vuPeakL) vuPeakL.style.left = '0%';
        if (vuPeakR) vuPeakR.style.left = '0%';
        stageNodes.forEach(node => node.classList.remove('audio-pulse'));
      }
    }
    update();
  }

  window.addEventListener('DOMContentLoaded', init);
})();
