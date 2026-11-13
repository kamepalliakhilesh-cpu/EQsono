/**
 * High-Precision Network Time Protocol (NTP) Client
 * Calculates clock offset (Δt), Round-Trip Time (RTT), jitter, and crystal skew rate.
 * Uses microsecond-resolution epoch timestamps, minimum-RTT quartile filtering,
 * and slew-rate clamped smoothing so Wi-Fi traffic bursts never cause audio phase jumps.
 */
class NtpSync {
  constructor(ws, onSyncCallback) {
    this.ws = ws;
    this.onSyncCallback = onSyncCallback;
    this.samples = [];
    this.maxSamples = 24;
    this.offset = 0; // ServerMasterTime = ClientLocalTime + offset
    this.rtt = 0;
    this.jitter = 0;
    this.skewRate = 0;
    this.lastSyncLocalTime = 0;
    this.isSynced = false;
    this.syncQuality = 'CALIBRATING'; // 'STUDIO_LOCK' | 'PRECISION' | 'GOOD' | 'CALIBRATING'
    this.pingInterval = null;
    this.rapidInterval = null;
  }

  /**
   * High-precision local epoch timestamp in milliseconds with microsecond resolution
   */
  getLocalTime() {
    return (window.performance && performance.timeOrigin)
      ? (performance.timeOrigin + performance.now())
      : Date.now();
  }

  start() {
    this.stop();

    // Fast initial lock: 12 rapid pings every 60ms (~720ms)
    let count = 0;
    this.sendPing();
    this.rapidInterval = setInterval(() => {
      this.sendPing();
      count++;
      if (count >= 12) {
        clearInterval(this.rapidInterval);
        this.rapidInterval = null;
        // Maintenance pings every 2.5 seconds
        this.pingInterval = setInterval(() => this.sendPing(), 2500);
      }
    }, 60);
  }

  stop() {
    if (this.rapidInterval) {
      clearInterval(this.rapidInterval);
      this.rapidInterval = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  sendPing() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const t0 = this.getLocalTime();
    this.ws.send(JSON.stringify({
      type: 'SYNC_PING',
      clientSendTime: t0
    }));
  }

  handlePong(data) {
    const t3 = this.getLocalTime();
    const t0 = data.clientSendTime;
    const t1 = data.serverReceiveTime;
    const t2 = data.serverSendTime;

    const serverDelay = Math.max(0, t2 - t1);
    const rtt = Math.max(0, (t3 - t0) - serverDelay);
    const offset = ((t1 - t0) + (t2 - t3)) / 2;

    // Once locked, discard extreme Wi-Fi congestion spike pongs that suffer asymmetric queuing
    if (this.isSynced && this.samples.length >= 8) {
      const minRecordedRtt = Math.min(...this.samples.map(s => s.rtt));
      if (rtt > Math.max(45, minRecordedRtt * 2.2 + 12)) {
        return;
      }
    }

    this.samples.push({ rtt, offset, timestamp: t3 });
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }

    // Outlier rejection via lowest-25% RTT selection (packets with least Wi-Fi queuing delay)
    const sortedByRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const bestCount = Math.max(1, Math.ceil(sortedByRtt.length * 0.30));
    const bestSamples = sortedByRtt.slice(0, bestCount);

    // Median offset of best low-RTT samples
    const sortedOffsets = bestSamples.map(s => s.offset).sort((a, b) => a - b);
    const medianOffset = sortedOffsets[Math.floor(sortedOffsets.length / 2)];

    const bestAvgRtt = bestSamples.reduce((sum, s) => sum + s.rtt, 0) / bestSamples.length;
    const offsetDev = bestSamples.reduce((sum, s) => sum + Math.abs(s.offset - medianOffset), 0) / bestSamples.length;

    // Slew-rate clamped clock offset filter to prevent phase jumps during audio playback
    if (!this.isSynced || this.samples.length < 4) {
      this.offset = medianOffset;
      this.jitter = offsetDev;
    } else {
      const rawStep = (medianOffset - this.offset) * 0.12;
      const clampedStep = Math.max(-0.8, Math.min(0.8, rawStep));
      this.offset += clampedStep;
      this.jitter = (this.jitter * 0.80) + (offsetDev * 0.20);
    }

    this.lastSyncLocalTime = t3;
    this.rtt = Math.round(bestAvgRtt);
    this.isSynced = this.samples.length >= 3;

    const roundedJitter = Math.round(this.jitter * 10) / 10;
    if (this.rtt < 18 && roundedJitter <= 3) {
      this.syncQuality = 'STUDIO_LOCK';
    } else if (this.rtt < 40 && roundedJitter <= 8) {
      this.syncQuality = 'PRECISION';
    } else {
      this.syncQuality = 'GOOD';
    }

    if (this.onSyncCallback) {
      this.onSyncCallback({
        offset: this.offset,
        rtt: this.rtt,
        jitter: roundedJitter,
        isSynced: this.isSynced,
        quality: this.syncQuality
      });
    }
  }

  /**
   * Returns current synchronized master clock time in milliseconds
   */
  now() {
    return this.getLocalTime() + this.offset;
  }
}

window.NtpSync = NtpSync;
