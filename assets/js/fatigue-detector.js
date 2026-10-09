const round = (x, n) => {
  const f = 10 ** n;
  return Math.round(x * f) / f;
};

export class FatigueDetector {
  /**
   * @param {object} [opts]
   * @param {object} [opts.config]
   * @param {number} [opts.aspect=1]
   * @param {(info:object)=>void} [opts.onAlert]
   */
  constructor(opts = {}) {
    this.cfg = { ...(opts.config || {}) };

    if (!Object.keys(opts.config || {}).length) {
      throw new Error("Python config is required");
    }
    this.aspect = opts.aspect ?? 1;
    this.onAlert = opts.onAlert || null;
    this.resetAll();
  }

  // ---------- 狀態 ----------

  resetAll() {
    this.started = false;
    this.sessionId = null;
    this.earThreshold = this.cfg.EAR_CLOSED_THRESHOLD;
    this.marThreshold = this.cfg.YAWN_THRESHOLD;
    this.isCalibrating = false;
    this.isCalibrated = false;
    this.baselineEar = null;
    this.baselineMar = null;
    this.calEar = [];
    this.calMar = [];
    this.resetMetrics();
    this.logHistory = [];
    this.lastLogTime = 0;
  }

  resetMetrics() {
    this.faceCount = 0;
    this.leftEar = this.rightEar = this.ear = this.mar = null;
    this.blinkTimes = 0;
    this.yawnTimes = 0;
    this.isEyeClosed = false;
    this.eyeClosureStart = null;
    this.eyeClosureDur = 0;
    this.isYawning = false;
    this.yawnStart = null;
    this.yawnDur = 0;
    this.closureHistory = []; // {t, c}
    this.perclos = 0;
    this.fatigueLevel = "Normal";
    this.fatigueScore = 0;
    this.lastAlertTime = null;
    this.alertCount = 0;
    this.beepPending = false;
    this.startTime = null;
  }

  /** 對應 /start_detection：清空紀錄並開始 */
  start(t = performance.now() / 1000, sessionId = null) {
    this.sessionId = sessionId;
    this.logHistory = [];
    this.lastLogTime = 0;
    this.resetMetrics();
    this.isCalibrating = false;
    this.calEar = [];
    this.calMar = [];
    this.startTime = t;
    this.started = true;
  }

  /** 對應 /stop_detection */
  stop() {
    if (!this.started) return;
    this._log(
      {
        ear: this.ear,
        mar: this.mar,
        leftEar: this.leftEar,
        rightEar: this.rightEar,
      },
      "pause",
      Date.now() / 1000,
      true,
    );
    this.started = false;
    this.resetMetrics();
    this.cancelCalibration();
  }

  /**
   * 對應 /reset：清除紀錄與指標，不改變 started。
   * 與後端一致：門檻、baseline 與校準結果都保留（只有進行中的校準會被取消）。
   */
  reset(t = performance.now() / 1000) {
    const wasStarted = this.started;
    this.logHistory = [];
    this.lastLogTime = 0;
    this.resetMetrics();
    this.isCalibrating = false;
    this.calEar = [];
    this.calMar = [];
    if (wasStarted) this.startTime = t;
  }

  // ---------- 校準 ----------

  startCalibration() {
    if (!this.started) throw new Error("Detection not started");
    this.isCalibrating = true;
    this.isCalibrated = false;
    this.calEar = [];
    this.calMar = [];
  }

  cancelCalibration() {
    this.isCalibrating = false;
    this.calEar = [];
    this.calMar = [];
  }

  /** mode: "baseline" | "default" */
  selectCalibration(mode) {
    if (mode === "baseline") {
      if (!this.isCalibrated) throw new Error("Not calibrated yet");
      this.earThreshold = round(
        this.baselineEar * this.cfg.CALIBRATION_EAR_RATIO,
        4,
      );
      if (this.baselineMar !== null) {
        this.marThreshold = round(
          this.baselineMar + this.cfg.CALIBRATION_MAR_OFFSET,
          4,
        );
      }
    } else if (mode === "default") {
      this.earThreshold = this.cfg.EAR_CLOSED_THRESHOLD;
      this.marThreshold = this.cfg.YAWN_THRESHOLD;
    } else {
      throw new Error("Invalid mode");
    }
  }

  get calibrationProgress() {
    return { current: this.calEar.length, target: this.cfg.CALIBRATION_FRAMES };
  }

  _collectCalibration() {
    if (!this.isCalibrating) return;
    if (this.ear !== null) this.calEar.push(this.ear);
    if (this.mar !== null) this.calMar.push(this.mar);
    if (this.calEar.length >= this.cfg.CALIBRATION_FRAMES) {
      const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
      this.baselineEar = round(avg(this.calEar), 4);
      this.baselineMar = this.calMar.length ? round(avg(this.calMar), 4) : null;
      this.earThreshold = round(
        this.baselineEar * this.cfg.CALIBRATION_EAR_RATIO,
        4,
      );
      if (this.baselineMar !== null) {
        this.marThreshold = round(
          this.baselineMar + this.cfg.CALIBRATION_MAR_OFFSET,
          4,
        );
      }
      this.isCalibrated = true;
      this.isCalibrating = false;
    }
  }

  // ---------- 指標計算 ----------

  _dist(a, b) {
    return Math.hypot((a.x - b.x) * this.aspect, a.y - b.y);
  }

  _calcEar(lm, idx) {
    const [p1, p2, p3, p4, p5, p6] = idx.map((i) => lm[i]);
    const h = this._dist(p1, p4);
    if (h === 0) return 0;
    return (this._dist(p2, p6) + this._dist(p3, p5)) / (2 * h);
  }

  _calcMar(lm) {
    const m = this.cfg.MAR_POINTS;
    const h = this._dist(lm[m.left], lm[m.right]);
    if (h === 0) return 0;
    return this._dist(lm[m.top], lm[m.bottom]) / h;
  }

  // ---------- 狀態更新 ----------

  _updateState(t) {
    const { ear, mar } = this;
    const closed = ear !== null && ear < this.earThreshold;

    // PERCLOS：最近 WINDOWS_SEC 秒內「閉眼樣本 / 全部樣本」
    this.closureHistory.push({ t, c: closed ? 1 : 0 });
    const cutoff = t - this.cfg.WINDOWS_SEC;
    while (this.closureHistory.length && this.closureHistory[0].t < cutoff) {
      this.closureHistory.shift();
    }
    const n = this.closureHistory.length;
    this.perclos = n
      ? round(this.closureHistory.reduce((s, h) => s + h.c, 0) / n, 4)
      : 0;

    // 閉眼 / 眨眼
    if (closed) {
      if (!this.isEyeClosed) {
        this.isEyeClosed = true;
        this.eyeClosureStart = t;
      }
      this.eyeClosureDur = round(t - this.eyeClosureStart, 3);
    } else {
      if (
        this.isEyeClosed &&
        this.eyeClosureDur >= this.cfg.BLINK_MIN_DURATION
      ) {
        this.blinkTimes += 1;
      }
      this.eyeClosureDur = 0;
      this.isEyeClosed = false;
      this.eyeClosureStart = null;
    }

    // 打哈欠
    if (mar !== null && mar > this.marThreshold) {
      if (!this.isYawning) {
        this.isYawning = true;
        this.yawnStart = t;
      }
      this.yawnDur = round(t - this.yawnStart, 3);
    } else {
      if (this.isYawning) {
        const dur = t - (this.yawnStart ?? t);
        if (dur >= this.cfg.YAWN_MIN_DURATION) this.yawnTimes += 1;
      }
      this.yawnDur = 0;
      this.isYawning = false;
      this.yawnStart = null;
    }
  }

  _updateFatigue(t) {
    const c = this.cfg;
    const elapsedMin = Math.max((t - this.startTime) / 60, 1 / 60);
    const yawnRate = this.yawnTimes / elapsedMin;

    const perclosScore = Math.min(this.perclos / c.PERCLOS_SEVERE_RATIO, 1);
    const closureScore = Math.min(
      this.eyeClosureDur / c.EYE_CLOSURE_MIN_DURATION,
      1,
    );
    const yawnScore = Math.min(yawnRate / c.YAWN_RATE_SEVERE_PER_MIN, 1);

    const score =
      (perclosScore * c.FATIGUE_WEIGHT_PERCLOS +
        closureScore * c.FATIGUE_WEIGHT_EYE_CLOSURE +
        yawnScore * c.FATIGUE_WEIGHT_YAWN) *
      100;

    this.fatigueScore = round(Math.min(score, 100), 1);
    this.fatigueLevel =
      this.fatigueScore >= c.FATIGUE_SCORE_SEVERE
        ? "Severe"
        : this.fatigueScore >= c.FATIGUE_SCORE_MILD
          ? "Mild"
          : "Normal";
  }

  _checkAlert(t) {
    if (this.fatigueLevel !== "Severe") return;
    if (
      this.lastAlertTime !== null &&
      t - this.lastAlertTime < this.cfg.ALERT_COOLDOWN_SECONDS
    )
      return;
    this.lastAlertTime = t;
    this.alertCount += 1;
    this.beepPending = true;
    if (this.onAlert)
      this.onAlert({
        score: this.fatigueScore,
        level: this.fatigueLevel,
        count: this.alertCount,
      });
  }

  /**
   * 每個影片幀呼叫一次。
   * @param {Array<{x:number,y:number,z:number}>|null} landmarks  result.faceLandmarks[0]（沒偵測到臉就傳 null）
   * @param {number} [t]  秒，預設 performance.now()/1000
   * @returns 目前狀態快照（未 start 時回傳 null）
   */
  update(landmarks, t = performance.now() / 1000) {
    if (!this.started) return null;

    if (landmarks && landmarks.length) {
      this.faceCount = 1;
      this.leftEar = round(
        this._calcEar(landmarks, this.cfg.LEFT_EAR_POINTS),
        4,
      );
      this.rightEar = round(
        this._calcEar(landmarks, this.cfg.RIGHT_EAR_POINTS),
        4,
      );
      this.ear = round((this.leftEar + this.rightEar) / 2, 4);
      this.mar = round(this._calcMar(landmarks), 4);

      this._updateState(t);
      this._collectCalibration();
      this._updateFatigue(t);
      this._checkAlert(t);
    } else {
      this.faceCount = 0;
      this.leftEar = this.rightEar = this.ear = this.mar = null;
    }

    this._log(
      {
        ear: this.ear,
        mar: this.mar,
        leftEar: this.leftEar,
        rightEar: this.rightEar,
      },
      "data",
      Date.now() / 1000,
    );
    return this.snapshot();
  }

  snapshot() {
    return {
      sessionId: this.sessionId,
      faces: this.faceCount,
      leftEar: this.leftEar,
      rightEar: this.rightEar,
      ear: this.ear,
      mar: this.mar,
      blinkTimes: this.blinkTimes,
      yawnTimes: this.yawnTimes,
      eyeClosureDur: this.eyeClosureDur,
      yawnDur: this.yawnDur,
      perclos: this.perclos,
      fatigueScore: this.fatigueScore,
      fatigueLevel: this.fatigueLevel,
      earThreshold: this.earThreshold,
      marThreshold: this.marThreshold,
      baselineEar: this.baselineEar,
      baselineMar: this.baselineMar,
      isCalibrating: this.isCalibrating,
      isCalibrated: this.isCalibrated,
    };
  }

  /**
   * @param {{fps?:number, latency?:number}} [extra]
   */
  toApiData(extra = {}) {
    const s = this.snapshot();
    return {
      session_id: s.sessionId,
      fps: extra.fps ?? 0,
      latency: extra.latency ?? 0,
      faces: s.faces,
      left_ear: s.leftEar,
      right_ear: s.rightEar,
      ear: s.ear,
      mar: s.mar,
      blink_times: s.blinkTimes,
      yawn_times: s.yawnTimes,
      eye_closure_dur: s.eyeClosureDur,
      yawn_dur: s.yawnDur,
      perclos: s.perclos,
      fatigue_level: s.fatigueLevel,
      fatigue_score: s.fatigueScore,
      ear_threshold: s.earThreshold,
      mar_threshold: s.marThreshold,
      default_ear_threshold: this.cfg.EAR_CLOSED_THRESHOLD,
      default_mar_threshold: this.cfg.YAWN_THRESHOLD,
      baseline_ear_threshold: s.baselineEar,
      baseline_mar_threshold: s.baselineMar,
    };
  }

  // ---------- 日誌 / CSV ----------

  _log(m, event, wallSec, force = false) {
    if (event === "data" && !force) {
      if (wallSec - this.lastLogTime < this.cfg.LOG_INTERVAL_SEC) return;
      this.lastLogTime = wallSec;
    }
    this.logHistory.push({
      sessionId: this.sessionId,
      timestamp: wallSec,
      event,
      ear: m.ear,
      mar: m.mar,
      leftEar: m.leftEar,
      rightEar: m.rightEar,
      blinkTimes: this.blinkTimes,
      yawnTimes: this.yawnTimes,
      perclos: this.perclos,
      faces: this.faceCount,
      fatigueLevel: this.fatigueLevel,
      fatigueScore: this.fatigueScore,
      isBeep: this.beepPending ? 1 : 0,
    });
    this.beepPending = false;
  }

  exportCSV() {
    const header = [
      "session_id",
      "datetime",
      "event",
      "ear",
      "mar",
      "left_ear",
      "right_ear",
      "blink_times",
      "yawn_times",
      "perclos",
      "faces",
      "fatigue_level",
      "fatigue_score",
      "is_beep",
    ];

    const pad = (n) => String(n).padStart(2, "0");

    const fmt = (sec) => {
      const d = new Date(sec * 1000);
      return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      );
    };

    const cell = (v) => (v === null || v === undefined ? "" : v);

    const rows = this.logHistory.map((r) =>
      [
        r.sessionId,
        fmt(r.timestamp),
        r.event,
        r.ear,
        r.mar,
        r.leftEar,
        r.rightEar,
        r.blinkTimes,
        r.yawnTimes,
        r.perclos,
        r.faces,
        r.fatigueLevel,
        r.fatigueScore,
        r.isBeep,
      ]
        .map(cell)
        .join(","),
    );

    return [header.join(","), ...rows].join("\r\n");
  }

  downloadCSV(filename) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const name =
      filename ||
      `log_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.csv`;
    const blob = new Blob(["\ufeff" + this.exportCSV()], {
      type: "text/csv;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
