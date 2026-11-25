/**
 * Iris Water — Frontend Console Controller
 */

(() => {
  "use strict";

  // 1. API Configuration, SSL & Auto-Discovery
  const isHttps = window.location.protocol === "https:";
  const isFileOrigin = window.location.protocol === "file:";
  const API_BASE = isFileOrigin ? "http://127.0.0.1:8000" : window.location.origin;
  const WS_PROTOCOL = isHttps ? "wss:" : "ws:";
  const WS_BASE = API_BASE.replace(/^https?:/, WS_PROTOCOL);

  const AUTH_STORAGE_KEY = "fall_stroke_auth_token";
  const REFRESH_STORAGE_KEY = "fall_stroke_refresh_token";

  function getSavedToken() {
    try {
      return localStorage.getItem(AUTH_STORAGE_KEY) || "";
    } catch (_) {
      return "";
    }
  }

  function saveAuthToken(token) {
    try {
      localStorage.setItem(AUTH_STORAGE_KEY, token);
    } catch (_) {}
  }

  function clearAuthToken() {
    try {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      localStorage.removeItem(REFRESH_STORAGE_KEY);
    } catch (_) {}
  }

  function saveRefreshToken(token) {
    try {
      if (token) localStorage.setItem(REFRESH_STORAGE_KEY, token);
    } catch (_) {}
  }

  function getRefreshToken() {
    try {
      return localStorage.getItem(REFRESH_STORAGE_KEY) || "";
    } catch (_) {
      return "";
    }
  }

  // Access tokens are short-lived (security.yaml): renew silently with the refresh token.
  // Concurrent 401s share one refresh request.
  let refreshInFlight = null;
  function refreshAccessToken() {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return Promise.resolve(false);
    if (!refreshInFlight) {
      refreshInFlight = fetch(`${API_BASE}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      })
        .then(async (res) => {
          if (!res.ok) {
            if (res.status === 401) clearAuthToken();
            return false;
          }
          const json = await res.json();
          saveAuthToken(json.access_token);
          return true;
        })
        .catch(() => false)
        .finally(() => { refreshInFlight = null; });
    }
    return refreshInFlight;
  }

  // Helper for MJPEG stream URL with cache-buster and token parameter
  function buildMjpegUrl() {
    const token = getSavedToken();
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
    return `${API_BASE}/stream/mjpeg?t=${Date.now()}${tokenParam}`;
  }

  function getWsUrl() {
    const token = getSavedToken();
    return `${WS_BASE}/ws/alerts${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  }

  // Wrapper around native fetch that automatically injects JWT Bearer token
  async function apiFetch(url, options = {}) {
    const opts = { ...options };
    const headers = new Headers(opts.headers || {});
    const token = getSavedToken();
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    opts.headers = headers;

    let res = await fetch(url, opts);
    const isAuthCall = url.includes("/api/auth/");
    if (res.status === 401 && !isAuthCall && token && await refreshAccessToken()) {
      headers.set("Authorization", `Bearer ${getSavedToken()}`);
      res = await fetch(url, { ...opts, headers });
    }
    if (res.status === 401 && !isAuthCall) {
      handleAuthRequired();
    }
    return res;
  }

  // State
  let soundEnabled = true;
  let isCameraRunning = false;
  let alertCount = 0;
  let wsConnection = null;
  let wsReconnectTimer = null;

  // DOM Elements
  const elBackendDot = document.getElementById("backend-status-dot");
  const elBackendText = document.getElementById("backend-status-text");
  const elWsDot = document.getElementById("ws-status-dot");
  const elWsText = document.getElementById("ws-status-text");
  const elClock = document.getElementById("digital-clock");

  const elKpiFps = document.getElementById("kpi-fps");
  const elKpiTracks = document.getElementById("kpi-tracks");
  const elKpiRisk = document.getElementById("kpi-risk");
  const elKpiRiskState = document.getElementById("kpi-risk-state");
  const elKpiRiskMeter = document.getElementById("kpi-risk-meter");

  const elTelemCpu = document.getElementById("telem-cpu");
  const elTelemRam = document.getElementById("telem-ram");
  const elTelemGpu = document.getElementById("telem-gpu");

  const elVideoStream = document.getElementById("live-video-stream");
  const elOfflineOverlay = document.getElementById("stream-offline-overlay");

  // Camera Management DOM Elements
  const elCameraTypeSelect = document.getElementById("camera-type-select");
  const elGroupWebcamDevice = document.getElementById("group-webcam-device");
  const elWebcamDeviceSelect = document.getElementById("webcam-device-select");
  const elBtnScanWebcams = document.getElementById("btn-scan-webcams");

  const elGroupRtspPreset = document.getElementById("group-rtsp-preset");
  const elRtspPresetSelect = document.getElementById("rtsp-preset-select");
  const elGroupRtspUrlRow = document.getElementById("group-rtsp-url-row");
  const elRtspUrlInput = document.getElementById("rtsp-url-input");
  const elRtspUsernameInput = document.getElementById("rtsp-username-input");
  const elRtspPasswordInput = document.getElementById("rtsp-password-input");
  const elBtnTestRtsp = document.getElementById("btn-test-rtsp");
  const elBtnDiscoverCameras = document.getElementById("btn-discover-cameras");
  const elCamDiscoverResults = document.getElementById("cam-discover-results");

  const elGroupVideoPreset = document.getElementById("group-video-preset");
  const elVideoPresetSelect = document.getElementById("video-preset-select");
  const elGroupVideoCustomRow = document.getElementById("group-video-custom-row");
  const elCustomVideoPathInput = document.getElementById("custom-video-path-input");

  const elBtnApplyCamera = document.getElementById("btn-apply-camera");
  const elBtnApplyTxt = document.getElementById("btn-apply-txt");
  const elCamSpinner = document.getElementById("cam-spinner");
  const elBtnSaveCameraDefault = document.getElementById("btn-save-camera-default");
  const elBtnCameraToggle = document.getElementById("btn-camera-toggle");
  const elBtnCamToggleIcon = document.getElementById("btn-cam-toggle-icon");
  const elBtnCamToggleTxt = document.getElementById("btn-cam-toggle-txt");
  const elBtnRefreshStream = document.getElementById("btn-refresh-stream");

  const elCamToastFeedback = document.getElementById("cam-toast-feedback");
  const elCamActiveStatusPill = document.getElementById("cam-active-status-pill");
  const elCamActiveNameTxt = document.getElementById("cam-active-name-txt");
  const elHudCamName = document.getElementById("hud-cam-name");

  const elEmergencyBar = document.getElementById("emergency-alert-bar");
  const elBtnDismissAlert = document.getElementById("btn-dismiss-alert");
  const elAlertBarTitle = document.getElementById("alert-bar-title");
  const elAlertBarDesc = document.getElementById("alert-bar-desc");

  const elAlertsFeed = document.getElementById("alerts-feed");
  const elEmptyPlaceholder = document.getElementById("empty-alerts-placeholder");
  const elAlertsCountBadge = document.getElementById("alerts-count-badge");
  const elBtnTestChime = document.getElementById("btn-test-chime");
  const elBtnClearTemp = document.getElementById("btn-clear-temp");
  const elBtnClearPermanent = document.getElementById("btn-clear-permanent");
  const elBtnSoundToggle = document.getElementById("btn-sound-toggle");
  const elBtnFullscreen = document.getElementById("btn-fullscreen");
  const elPersonTableBody = document.getElementById("person-table-body");

  // Video container & operational alert visuals
  const elVideoContainer = document.getElementById("video-container");
  const elVideoCard = document.querySelector(".video-card") || document.getElementById("video-card");
  const elVideoFallBadge = document.getElementById("video-fall-badge");
  const elVideoFallText = document.getElementById("video-fall-text");
  const elKpiFoam = document.getElementById("kpi-foam");
  const elKpiColor = document.getElementById("kpi-color");
  const elKpiDebris = document.getElementById("kpi-debris");

  // Authentication Modal DOM Elements
  const elAuthModalBackdrop = document.getElementById("auth-modal-backdrop");
  const elAuthModalTitle = document.getElementById("auth-modal-title");
  const elAuthModalSubtitle = document.getElementById("auth-modal-subtitle");
  const elAuthForm = document.getElementById("auth-form");
  const elAuthUsername = document.getElementById("auth-username-input");
  const elAuthPassword = document.getElementById("auth-password-input");
  const elAuthError = document.getElementById("auth-error-msg");
  const elBtnAuthSubmit = document.getElementById("btn-auth-submit");
  const elAuthSubmitTxt = document.getElementById("auth-submit-txt");

  let isSetupMode = false;
  let isDashboardInitialized = false;

  // Web Audio API Synthesizer for Multi-harmonic Emergency Alarm Chimes & Horn
  let audioCtx = null;
  let alarmChimeInterval = null;
  let alarmChimeTimeout = null;
  let sirenInterval = null;
  let sirenTimeout = null;
  let borderFlashTimeout = null;

  function initAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
      }
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
  }

  // Tự động mở khóa AudioContext khi người dùng chạm hoặc click bất kỳ đâu
  ["click", "keydown", "touchstart", "pointerdown"].forEach((evt) => {
    window.addEventListener(evt, () => initAudioContext(), { passive: true });
  });

  // Tạo âm chuông kim loại vang đa hòa âm (Metallic Chime Bell Harmonic Synthesis)
  function playBellChimeTone(freq, duration = 0.55, gainLevel = 0.5) {
    if (!soundEnabled) return;
    initAudioContext();
    if (!audioCtx) return;

    try {
      const now = audioCtx.currentTime;

      // 1. Tần số cơ bản (Fundamental Sine Tone)
      const osc1 = audioCtx.createOscillator();
      const gain1 = audioCtx.createGain();
      osc1.type = "sine";
      osc1.frequency.setValueAtTime(freq, now);
      gain1.gain.setValueAtTime(gainLevel, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + duration);
      osc1.connect(gain1);
      gain1.connect(audioCtx.destination);
      osc1.start(now);
      osc1.stop(now + duration);

      // 2. Họa âm quãng 8 (Octave Overtone - tạo âm vang chuông thật)
      const osc2 = audioCtx.createOscillator();
      const gain2 = audioCtx.createGain();
      osc2.type = "sine";
      osc2.frequency.setValueAtTime(freq * 2.015, now);
      gain2.gain.setValueAtTime(gainLevel * 0.45, now);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + duration * 0.75);
      osc2.connect(gain2);
      gain2.connect(audioCtx.destination);
      osc2.start(now);
      osc2.stop(now + duration * 0.75);

      // 3. Họa âm ánh kim bậc cao (Triangle Shimmer)
      const osc3 = audioCtx.createOscillator();
      const gain3 = audioCtx.createGain();
      osc3.type = "triangle";
      osc3.frequency.setValueAtTime(freq * 3.01, now);
      gain3.gain.setValueAtTime(gainLevel * 0.25, now);
      gain3.gain.exponentialRampToValueAtTime(0.001, now + duration * 0.45);
      osc3.connect(gain3);
      gain3.connect(audioCtx.destination);
      osc3.start(now);
      osc3.stop(now + duration * 0.45);

    } catch (e) {
      console.warn("[Dashboard] Bell chime error:", e);
    }
  }

  // Phát tiếng còi báo động khẩn cấp
  function playSirenBeep(freq, duration = 0.22) {
    if (!soundEnabled) return;
    initAudioContext();
    if (!audioCtx) return;
    try {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = "sawtooth"; // Tiếng còi cứu thương khẩn cấp
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);

      gain.gain.setValueAtTime(0.35, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch (e) {
      console.warn("[Dashboard] Audio error:", e);
    }
  }

  // 1. Chuỗi chuông báo động ngã khẩn cấp (Fall Risk Urgent Alarm Chime: C6 -> A5 -> F6 -> C6 + horn)
  function playFallAlarmChimeSequence() {
    const notes = [1046.5, 880.0, 1396.9, 1046.5];
    notes.forEach((freq, idx) => {
      setTimeout(() => {
        if (!soundEnabled) return;
        playBellChimeTone(freq, 0.45, 0.5);
      }, idx * 140);
    });

    setTimeout(() => {
      if (!soundEnabled) return;
      playSirenBeep(960, 0.25);
    }, 600);
  }

  // 2. Chuỗi chuông báo hành vi bất thường (Abnormal Behavior Warning Chime: Đinh - Đoong)
  function playAbnormalWarningChimeSequence() {
    playBellChimeTone(880.0, 0.6, 0.45);
    setTimeout(() => {
      if (!soundEnabled) return;
      playBellChimeTone(659.25, 0.8, 0.5);
    }, 240);
  }

  // Bộ phát âm thanh chuông cảnh báo ra loa
  function triggerAlarmChime(type = "fall") {
    if (!soundEnabled) return;
    initAudioContext();
    stopContinuousAlarm();

    if (type === "fall") {
      // Chuông báo té ngã: Kêu dồn dập mỗi 1.4 giây
      playFallAlarmChimeSequence();
      alarmChimeInterval = setInterval(() => {
        if (!soundEnabled) {
          stopContinuousAlarm();
          return;
        }
        playFallAlarmChimeSequence();
      }, 1400);

      // Tự động dừng sau 10 giây nếu chưa có ai nhấn xác nhận
      alarmChimeTimeout = setTimeout(() => {
        stopContinuousAlarm();
      }, 10000);
    } else {
      // Chuông báo hành vi bất thường: Kêu nhắc nhở mỗi 2.2 giây
      playAbnormalWarningChimeSequence();
      alarmChimeInterval = setInterval(() => {
        if (!soundEnabled) {
          stopContinuousAlarm();
          return;
        }
        playAbnormalWarningChimeSequence();
      }, 2200);

      alarmChimeTimeout = setTimeout(() => {
        stopContinuousAlarm();
      }, 7000);
    }

    // Dự phòng âm thanh bằng thẻ HTML5 <audio>
    const elAudio = document.getElementById("alert-sound");
    if (elAudio) {
      try {
        elAudio.currentTime = 0;
        elAudio.play().catch(() => {});
      } catch (_) {}
    }
  }

  function stopContinuousAlarm() {
    if (alarmChimeInterval) {
      clearInterval(alarmChimeInterval);
      alarmChimeInterval = null;
    }
    if (alarmChimeTimeout) {
      clearTimeout(alarmChimeTimeout);
      alarmChimeTimeout = null;
    }
    if (sirenInterval) {
      clearInterval(sirenInterval);
      sirenInterval = null;
    }
    if (sirenTimeout) {
      clearTimeout(sirenTimeout);
      sirenTimeout = null;
    }
  }

  function clearEmergencyVisuals() {
    if (elVideoContainer) elVideoContainer.classList.remove("fall-emergency-border");
    if (elVideoCard) elVideoCard.classList.remove("fall-emergency-border");
    if (elVideoFallBadge) elVideoFallBadge.style.display = "none";
    if (borderFlashTimeout) {
      clearTimeout(borderFlashTimeout);
      borderFlashTimeout = null;
    }
  }

  // 2. Clock updater
  const elVideoOverlayTs = document.getElementById("video-overlay-ts");
  const pad2 = (n) => String(n).padStart(2, "0");
  function updateClock() {
    const now = new Date();
    elClock.textContent = now.toTimeString().split(" ")[0];
    if (elVideoOverlayTs) {
      // Local date-time on the live video, e.g. 2026-10-04 15:42:08
      elVideoOverlayTs.textContent =
        `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ` +
        `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    }
  }
  setInterval(updateClock, 1000);
  updateClock();

  // 3. WebSocket Alerts Listener
  function connectAlertsWebSocket() {
    if (wsConnection) {
      try { wsConnection.close(); } catch (_) {}
    }

    elWsDot.className = "badge-dot dot-warning";
    elWsText.textContent = "Cảnh báo…";

    try {
      wsConnection = new WebSocket(getWsUrl());

      wsConnection.onopen = () => {
        elWsDot.className = "badge-dot dot-online";
        elWsText.textContent = "Cảnh báo";
        if (wsReconnectTimer) {
          clearTimeout(wsReconnectTimer);
          wsReconnectTimer = null;
        }
      };

      wsConnection.onmessage = (event) => {
        try {
          const alertData = JSON.parse(event.data);
          handleIncomingAlert(alertData);
        } catch (err) {
          console.error("[Dashboard] Error parsing WebSocket message:", err);
        }
      };

      wsConnection.onclose = (evt) => {
        elWsDot.className = "badge-dot dot-offline";
        elWsText.textContent = "Mất kết nối";
        if (evt && evt.code === 4001) {
          handleAuthRequired();
        } else {
          scheduleWsReconnect();
        }
      };

      wsConnection.onerror = () => {
        elWsDot.className = "badge-dot dot-offline";
        elWsText.textContent = "Mất kết nối";
      };
    } catch (e) {
      console.warn("[Dashboard] WebSocket init failed, will retry:", e);
      scheduleWsReconnect();
    }
  }

  function scheduleWsReconnect() {
    if (!wsReconnectTimer) {
      wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        connectAlertsWebSocket();
      }, 3000);
    }
  }

  // WWTP event labels (UI) — map cả event WWTP lẫn alert pipeline cũ
  const WWTP_EVENT_LABELS = {
    foam_coverage: "Bọt mặt bể",
    water_color: "Màu nước",
    water_clarity: "Độ trong nước",
    foreign_object: "Dị vật",
    overflow: "Tràn bể",
    person_zone: "Người trong khu vực",
    system_error: "Lỗi hệ thống",
    fall: "Bất thường quan sát",
    stroke_warning: "Bất thường quan sát",
    possible_medical_emergency: "Bất thường quan sát",
  };

  function wwtpEventLabel(eventType, fallback) {
    if (eventType && WWTP_EVENT_LABELS[eventType]) return WWTP_EVENT_LABELS[eventType];
    return fallback || "Sự cố vận hành";
  }

  function isHighPriorityAlert(alert, primaryAction, riskScore) {
    const eventType = alert.event_type || "";
    if (["foam_coverage", "foreign_object", "overflow", "system_error"].includes(eventType)) return true;
    if (eventType === "fall" || eventType === "stroke_warning") return true;
    return (
      primaryAction === "falling" ||
      primaryAction === "stumbling" ||
      primaryAction === "lying" ||
      primaryAction === "immobile" ||
      riskScore >= 0.70 ||
      (alert.evidence?.drop_severity_score && alert.evidence.drop_severity_score > 0.35)
    );
  }

  // 4. Handle Incoming Alert
  function handleIncomingAlert(alert) {
    const personId = alert.person_id ?? "N/A";
    const primaryAction = (alert.evidence?.primary_action ?? alert.action ?? "").toLowerCase();
    const riskScore = typeof alert.risk_score === "number" ? alert.risk_score : 0.95;
    const fromExtraCamera = Boolean(alert.camera_id);
    const cameraLabel = alert.camera_name || "Bể sinh học 01";
    const eventType = alert.event_type || "";
    const highPriority = isHighPriorityAlert(alert, primaryAction, riskScore);
    const typeLabel = wwtpEventLabel(eventType, primaryAction ? primaryAction.toUpperCase() : "Sự cố vận hành");

    if (elEmergencyBar) elEmergencyBar.style.display = "block";
    if (elAlertBarTitle) elAlertBarTitle.textContent = "Cần kiểm tra hiện trường";
    if (elAlertBarDesc) {
      elAlertBarDesc.textContent = `${typeLabel} tại ${cameraLabel}. Vui lòng kiểm tra hiện trường và bấm «Xác nhận đã kiểm tra».`;
    }

    if (fromExtraCamera) flashExtraCameraTile(alert.camera_id);
    if (!fromExtraCamera && elVideoContainer) elVideoContainer.classList.add("fall-emergency-border");
    if (!fromExtraCamera && elVideoCard) elVideoCard.classList.add("fall-emergency-border");
    if (!fromExtraCamera && elVideoFallBadge) {
      elVideoFallBadge.style.display = "flex";
      if (elVideoFallText) {
        elVideoFallText.textContent = `${typeLabel.toUpperCase()} — kiểm tra hiện trường (${cameraLabel})`;
      }
    }

    if (borderFlashTimeout) clearTimeout(borderFlashTimeout);
    borderFlashTimeout = setTimeout(() => {
      clearEmergencyVisuals();
    }, 10000);

    triggerAlarmChime(highPriority ? "fall" : "abnormal");

    const elIncTs = document.getElementById("incident-timestamp-txt");
    const elIncConf = document.getElementById("incident-confidence-txt");
    const elIncStatus = document.getElementById("incident-status-tag");
    const elIncCam = document.getElementById("incident-cam-title");

    if (elIncTs) elIncTs.textContent = `${new Date().toLocaleTimeString()} - ${new Date().toLocaleDateString("vi-VN")}`;
    if (elIncConf) elIncConf.textContent = `${(riskScore * 100).toFixed(0)}%`;
    if (elIncCam) elIncCam.textContent = cameraLabel;
    if (elIncStatus) {
      elIncStatus.textContent = "Đang xử lý";
      elIncStatus.style.background = "#fef2f2";
      elIncStatus.style.borderColor = "#fecaca";
      elIncStatus.style.color = "#dc2626";
    }

    const elAlertsTbody = document.getElementById("alerts-table-body");
    if (elAlertsTbody) {
      const tr = document.createElement("tr");
      tr.className = "alert-row-highlight";
      tr.innerHTML = `
        <td><span class="id-tag">#${String(alertCount + 1).padStart(3, "0")}</span></td>
        <td>${new Date().toLocaleTimeString()}</td>
        <td><span class="badge-type-danger">${escapeHtml(typeLabel)}</span></td>
        <td>${escapeHtml(cameraLabel)}</td>
        <td><span class="badge-state-pending">Đang xử lý</span></td>
      `;
      elAlertsTbody.prepend(tr);
    }

    renderAlertCard(alert, true);
    // dị vật module chưa live — không tăng KPI giả

    updateRiskKpi(riskScore, highPriority ? "Cao" : "Theo dõi");
    const elTotalAlerts = document.getElementById("stat-total-alerts-count");
    if (elTotalAlerts) elTotalAlerts.textContent = alertCount;
  }

  // Fall clips are recorded for a few seconds after the alert, then kept for 7 days at most
  async function toggleAlertClip(card, eventId, btn) {
    const row = btn.parentElement;
    const existing = row.querySelector(".alert-item-clip, .alert-item-clip-note");
    if (existing) {
      row.querySelectorAll(".alert-item-clip, .alert-item-clip-note").forEach((el) => el.remove());
      btn.textContent = "Xem clip bằng chứng";
      return;
    }
    const token = getSavedToken();
    const url = `${API_BASE}/events/${encodeURIComponent(eventId)}/clip${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    btn.disabled = true;
    try {
      const res = await apiFetch(`${API_BASE}/events/${encodeURIComponent(eventId)}`);
      const info = res.ok ? await res.json() : null;
      if (!info || !info.clip_available) {
        const msg = info
          ? "Đoạn video đang được ghi (hoặc đã hết hạn lưu 7 ngày). Vui lòng thử lại sau vài giây."
          : "Không tìm thấy sự kiện này trên máy chủ.";
        const note = document.createElement("div");
        note.className = "alert-item-clip-note";
        note.textContent = msg;
        row.appendChild(note);
        return;
      }
      const video = document.createElement("video");
      video.className = "alert-item-clip";
      video.src = url;
      video.controls = true;
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      row.appendChild(video);
      const note = document.createElement("div");
      note.className = "alert-item-clip-note";
      note.textContent = "Clip minh chứng — tự xóa sau 7 ngày.";
      row.appendChild(note);
      btn.textContent = "Đóng video";
    } catch (e) {
      console.warn("[Dashboard] Không tải được đoạn video:", e);
    } finally {
      btn.disabled = false;
    }
  }

  function renderAlertCard(alert, isNew = false) {
    if (elEmptyPlaceholder) {
      elEmptyPlaceholder.style.display = "none";
    }

    alertCount++;
    if (elAlertsCountBadge) elAlertsCountBadge.textContent = String(alertCount);

    const card = document.createElement("div");
    const isAlarmCard = (alert.evidence?.level === "alarm") || ["foam_coverage", "overflow", "foreign_object"].includes(alert.event_type || "");
    card.className = isAlarmCard ? "alert-item is-alarm" : "alert-item";

    const eventId = alert.event_id || `evt_${Date.now()}_trk${alert.person_id}`;
    card.dataset.eventId = eventId;
    card.dataset.eventType = alert.event_type || "";

    const timestamp = alert.timestamp ? new Date(alert.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
    const action = alert.evidence?.primary_action || alert.event_type || "su_co";
    const typeLabel = wwtpEventLabel(alert.event_type, action);
    const metrics = alert.evidence || {};
    const coverageRaw = metrics.coverage_pct;
    const coverage = coverageRaw != null
      ? `${Number(coverageRaw) > 1 ? Number(coverageRaw).toFixed(1) : (Number(coverageRaw) * 100).toFixed(0)}%`
      : null;
    const cameraLabel = alert.camera_name || alert.source_name || alert.source || "Camera bể";

    card.innerHTML = `
      <div class="alert-item-header">
        <div class="alert-item-title">
          <span>!</span>
          <span>${escapeHtml(typeLabel)} · ${escapeHtml(String(cameraLabel))}</span>
        </div>
        <div class="alert-item-header-actions">
          <span class="alert-item-time">${timestamp}</span>
          <div class="alert-menu-wrapper">
            <button type="button" class="btn-alert-menu" title="Tùy chọn" aria-label="Tùy chọn">⋮</button>
            <div class="alert-menu-dropdown">
              <button type="button" class="dropdown-item btn-delete-single-perm" title="Xóa cảnh báo này">
                Xóa
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="alert-item-msg">
        ${escapeHtml(alert.message || "Phát hiện bất thường trên mặt bể. Vui lòng kiểm tra hiện trường.")}
      </div>
      <div class="alert-item-meta">
        ${coverage ? `<span class="meta-field">Độ phủ bọt: <strong>${coverage}</strong></span>` : ""}
      </div>
      ${alert.clip_path ? `
      <div class="alert-item-clip-row">
        <button type="button" class="btn-alert-clip">Xem clip</button>
      </div>` : ""}
    `;

    const btnClip = card.querySelector(".btn-alert-clip");
    if (btnClip) {
      btnClip.addEventListener("click", () => toggleAlertClip(card, eventId, btnClip));
    }

    // 3-Dots dropdown and individual permanent delete listener
    const btnMenu = card.querySelector(".btn-alert-menu");
    const dropdownMenu = card.querySelector(".alert-menu-dropdown");
    const btnDelete = card.querySelector(".btn-delete-single-perm");

    if (btnMenu && dropdownMenu) {
      btnMenu.addEventListener("click", (evt) => {
        evt.stopPropagation();
        // Close other open dropdowns
        document.querySelectorAll(".alert-menu-dropdown.show").forEach((el) => {
          if (el !== dropdownMenu) el.classList.remove("show");
        });
        document.querySelectorAll(".btn-alert-menu.active").forEach((el) => {
          if (el !== btnMenu) el.classList.remove("active");
        });

        dropdownMenu.classList.toggle("show");
        btnMenu.classList.toggle("active");
      });
    }

    if (btnDelete) {
      btnDelete.addEventListener("click", async (evt) => {
        evt.stopPropagation();
        dropdownMenu.classList.remove("show");
        btnMenu.classList.remove("active");

        const ok = window.confirm(`Bán có chắc muốn xóa vĩnh viễn cảnh báo này khỏi hệ thống không?`);
        if (!ok) return;

        await deleteSingleAlertPermanently(eventId, card);
      });
    }

    if (elAlertsFeed) {
      if (isNew) elAlertsFeed.insertBefore(card, elAlertsFeed.firstChild);
      else elAlertsFeed.appendChild(card);
    }
  }

  const elKpiFoamLevel = document.getElementById("kpi-foam-level");

  function currentLang() {
    return document.documentElement.getAttribute("data-lang") === "en" ? "en" : "vi";
  }

  function foamLevelLabel(level) {
    const isEn = currentLang() === "en";
    if (level === "alarm") return isEn ? "Critical Alarm" : "Ưu tiên hiện trường";
    if (level === "warn") return isEn ? "Attention" : "Cần chú ý";
    if (level === "error") return isEn ? "Measure Error" : "Chưa đo được";
    if (level === "normal") return isEn ? "Stable" : "Ổn định";
    return level || "—";
  }

  function applyFoamMetricTone(level) {
    const el = document.getElementById("kpi-foam-metric");
    if (!el) return;
    el.classList.remove("is-warn", "is-alarm", "is-error");
    if (level === "warn") el.classList.add("is-warn");
    else if (level === "alarm") el.classList.add("is-alarm");
    else if (level === "error") el.classList.add("is-error");
  }

  function applyFoamSnapshot(foam) {
    const elStateBanner = document.getElementById("foam-state-banner");
    const elLatency = document.getElementById("foam-latency-txt");
    const elSegHint = document.getElementById("seg-empty-hint");
    const elRoiTag = document.getElementById("roi-assumption-tag");

    if (!foam) {
      if (elKpiFoam) elKpiFoam.textContent = "—";
      if (elKpiFoamLevel) elKpiFoamLevel.textContent = "Đang chờ đo";
      if (elStateBanner) elStateBanner.textContent = "Đang chờ đo";
      applyFoamMetricTone("normal");
      return;
    }
    const last = foam.last;
    const elAvg = document.getElementById("foam-avg-pct");
    const elMax = document.getElementById("foam-max-pct");
    const elLevel = document.getElementById("foam-level-txt");
    const elPreview = document.getElementById("foam-preview-img");
    const elStatus = document.getElementById("foam-monitor-status");
    const elPill = document.getElementById("foam-monitor-pill");
    const elAction = document.getElementById("foam-ops-action");
    const elInsight = document.getElementById("foam-ops-insight");

    if (elPill) {
      elPill.textContent = foam.enabled ? "Đang theo dõi" : "Đã tắt";
    }

    if (foam.error) {
      if (elKpiFoam) elKpiFoam.textContent = "—";
      if (elKpiFoamLevel) elKpiFoamLevel.textContent = "Chưa đo được";
      if (elStateBanner) elStateBanner.textContent = "Chưa đo được";
      applyFoamMetricTone("error");
      if (elStatus) elStatus.textContent = "Không đo được mức bọt. Kiểm tra camera và thử lại.";
      return;
    }

    if (!last || last.roi_required) {
      if (elKpiFoam) elKpiFoam.textContent = "—";
      const waitMsg = last && last.roi_required ? "Chờ chọn vùng nước" : (foam.enabled ? "Đang chờ hình…" : "Đã tắt");
      if (elKpiFoamLevel) elKpiFoamLevel.textContent = waitMsg;
      if (elStateBanner) elStateBanner.textContent = waitMsg;
      applyFoamMetricTone("normal");
      if (elStatus) {
        elStatus.textContent = last && last.roi_required
          ? "Chưa chọn vùng mặt nước — Hãy vẽ 1 ô chữ nhật trên video."
          : (foam.enabled
            ? "Đang chờ hình từ camera. Hãy bật camera hoặc chọn video mẫu."
            : "Theo dõi mặt bể đang tắt.");
      }
      if (last && last.roi_required) {
        const elSegHint = document.getElementById("seg-empty-hint");
        if (elSegHint) {
          elSegHint.style.display = "flex";
          elSegHint.innerHTML = '<span class="vi">Chưa chọn vùng nước — Kéo chuột vẽ ô chữ nhật ở khung hình</span><span class="en">No water region — Draw a rectangle on the video frame</span>';
        }
      }
      return;
    }

    const cov = last.coverage_pct;
    const level = last.level || "—";
    if (elKpiFoam) elKpiFoam.textContent = last.ok === false ? "—" : `${cov}%`;
    if (elKpiFoamLevel) {
      elKpiFoamLevel.textContent = foamLevelLabel(level);
      elKpiFoamLevel.classList.remove("is-warn", "is-alarm");
      if (level === "warn") elKpiFoamLevel.classList.add("is-warn");
      else if (level === "alarm") elKpiFoamLevel.classList.add("is-alarm");
    }
    if (elStateBanner) elStateBanner.textContent = `${foamLevelLabel(level)} · Bọt phủ ${cov}%`;
    applyFoamMetricTone(level);

    // Cập nhật thước đo vật lý (Physical Ruler 0% -> 100%)
    const elRulerFill = document.getElementById("foam-ruler-fill");
    if (elRulerFill) {
      const pctClamp = Math.max(0, Math.min(100, Number(cov) || 0));
      elRulerFill.style.width = `${pctClamp}%`;
      elRulerFill.classList.remove("is-warn", "is-alarm");
      if (level === "warn") elRulerFill.classList.add("is-warn");
      else if (level === "alarm") elRulerFill.classList.add("is-alarm");
    }

    const kpiTileFoam = document.getElementById("kpi-tile-foam");
    if (kpiTileFoam) {
      kpiTileFoam.classList.remove("is-warn", "is-alarm");
      if (level === "warn") kpiTileFoam.classList.add("is-warn");
      else if (level === "alarm") kpiTileFoam.classList.add("is-alarm");
    }

    if (elAvg) elAvg.textContent = last.ok === false ? "—" : `${cov}%`;
    if (elMax) elMax.textContent = `${foam.session_max_pct ?? cov}%`;
    if (elLevel) elLevel.textContent = foamLevelLabel(level);
    if (elLatency) elLatency.textContent = last.latency_ms != null ? `${last.latency_ms} ms` : "—";
    if (elRoiTag && Array.isArray(last.roi_box)) {
      elRoiTag.textContent = "Khung bể chữ nhật";
    }

    if (elPreview && last.overlay_path) {
      const cacheBust = last.ts ? `&t=${Math.floor(last.ts * 1000)}` : "";
      elPreview.src = `${API_BASE}/api/vision/foam/overlay?path=${encodeURIComponent(last.overlay_path)}${cacheBust}`;
      if (elSegHint) elSegHint.style.display = "none";
    } else if (elPreview && last.preview_data_url) {
      elPreview.src = last.preview_data_url;
      if (elSegHint) elSegHint.style.display = "none";
    }

    if (elStatus) {
      elStatus.textContent = last.error
        ? "Không đo được mức bọt lúc này."
        : `Tỷ lệ bọt phủ ${cov}% · ${foamLevelLabel(level)}`;
    }
    if (elInsight) {
      elInsight.classList.remove("is-normal", "is-warn", "is-alarm", "is-error");
      if (level === "alarm") elInsight.classList.add("is-alarm");
      else if (level === "warn") elInsight.classList.add("is-warn");
      else if (level === "error") elInsight.classList.add("is-error");
      else if (level === "normal") elInsight.classList.add("is-normal");
    }
    if (elAction) {
      if (level === "alarm") {
        elAction.textContent = `Ưu tiên hiện trường — độ phủ bọt ${cov}%. Kiểm tra hệ thống sục khí, van phun dập bọt và tải đầu vào.`;
      } else if (level === "warn") {
        elAction.textContent = `Cần chú ý — độ phủ bọt ${cov}% (từ 25%). Theo dõi sát bùn vi sinh và ghi nhật ký ca.`;
      } else if (level === "error") {
        elAction.textContent = "Không đo được — kiểm tra camera đang xem và thử lại.";
      } else if (level === "normal") {
        elAction.textContent = `Ổn định — độ phủ bọt ${cov}%, hệ thống sục khí và bùn hoạt tính làm việc bình thường.`;
      }
    }

    // Cập nhật toàn bộ thông số Hóa lý, Sinh học, Kịch bản và 4 Tasks thử nghiệm
    applyWastewaterAnalysis(last);
  }

  function applyStageBadgeTone(el, tone) {
    if (!el) return;
    el.classList.remove("is-normal", "is-warn", "is-alarm");
    if (tone === "warn") el.classList.add("is-warn");
    else if (tone === "alarm") el.classList.add("is-alarm");
    else if (tone === "normal") el.classList.add("is-normal");
  }

  function applyWastewaterAnalysis(sample) {
    if (!sample) return;
    const cov = sample.coverage_pct ?? 0;
    const water = sample.water || {};
    const sludge = sample.sludge || {};
    const debris = sample.debris || {};
    const scenarios = Array.isArray(sample.scenarios) ? sample.scenarios : [];

    // 1. KPI Ribbon updates
    const elBubbleTex = document.getElementById("kpi-bubble-texture");
    if (elBubbleTex && sludge.bubble_state) {
      elBubbleTex.textContent = sludge.bubble_state;
    }

    if (elKpiColor) {
      elKpiColor.textContent = water.pigment_label || "Đang phân tích…";
    }
    const elSwatch = document.getElementById("kpi-water-swatch");
    if (elSwatch && water.hex_color) {
      elSwatch.style.background = water.hex_color;
    }
    const elLightCond = document.getElementById("kpi-lighting-cond");
    if (elLightCond && water.lighting) {
      elLightCond.textContent = `${water.lighting.condition} · Đã tự động cân bằng sáng`;
    }
    const kpiTileWater = document.getElementById("kpi-tile-water");
    if (kpiTileWater) {
      kpiTileWater.classList.remove("is-warn", "is-alarm");
      if (water.status === "warn") kpiTileWater.classList.add("is-warn");
      else if (water.status === "alarm") kpiTileWater.classList.add("is-alarm");
    }

    const elClarityScore = document.getElementById("kpi-clarity-score");
    const elReflBadge = document.getElementById("kpi-reflection-badge");
    const elClarityDesc = document.getElementById("kpi-clarity-desc");
    if (elClarityScore && water.clarity_score != null) {
      elClarityScore.textContent = `${water.clarity_score}%`;
    }
    if (elReflBadge && water.reflection_score != null) {
      elReflBadge.textContent = `Phản xạ: ${water.reflection_score}%`;
    }
    if (elClarityDesc && water.clarity_label) {
      elClarityDesc.textContent = water.clarity_label;
    }

    const elSludgeDisp = document.getElementById("kpi-sludge-dispersion");
    const elSludgeClusters = document.getElementById("kpi-sludge-clusters");
    const elSludgeFloc = document.getElementById("kpi-sludge-floc");
    if (elSludgeDisp && sludge.dispersion_pct != null) {
      elSludgeDisp.textContent = `${sludge.dispersion_pct}%`;
    }
    if (elSludgeClusters && sludge.cluster_count != null) {
      elSludgeClusters.textContent = `${sludge.cluster_count} cụm bông`;
    }
    if (elSludgeFloc && sludge.floc_label) {
      elSludgeFloc.textContent = sludge.floc_label;
    }

    if (elKpiDebris) {
      const cnt = debris.count ?? 0;
      elKpiDebris.textContent = cnt > 0 ? `Có ${cnt} rác/dị vật nổi` : "Không có rác nổi";
    }
    const elOilSheen = document.getElementById("kpi-oil-sheen");
    if (elOilSheen && debris.oil_sheen_pct != null) {
      elOilSheen.textContent = `Váng dầu: ${debris.oil_sheen_pct}%`;
    }
    const elDebrisSum = document.getElementById("kpi-debris-summary");
    if (elDebrisSum && debris.summary) {
      elDebrisSum.textContent = debris.summary;
    }
    const kpiTileDebris = document.getElementById("kpi-tile-debris");
    if (kpiTileDebris) {
      kpiTileDebris.classList.remove("is-warn", "is-alarm");
      if (debris.level === "warn") kpiTileDebris.classList.add("is-warn");
      else if (debris.level === "alarm") kpiTileDebris.classList.add("is-alarm");
    }

    // 2. Bảng Công đoạn Hóa lý (2.1.A)
    const elPhysColor = document.getElementById("phys-water-color");
    const elPhysClarity = document.getElementById("phys-water-clarity");
    const elPhysFloc = document.getElementById("phys-floating-floc");
    const elPhysSettling = document.getElementById("phys-settling-floc");
    const elPhysDebris = document.getElementById("phys-large-debris");

    if (elPhysColor) {
      elPhysColor.textContent = water.pigment_label || "—";
      applyStageBadgeTone(elPhysColor, water.status || "normal");
    }
    if (elPhysClarity) {
      elPhysClarity.textContent = water.clarity_score != null
        ? `Độ trong ${water.clarity_score}% · Phản xạ ${water.reflection_score}%`
        : "—";
      applyStageBadgeTone(elPhysClarity, (water.clarity_score ?? 60) < 30 ? "warn" : "normal");
    }
    if (elPhysFloc) {
      elPhysFloc.textContent = sludge.floc_label || "—";
      applyStageBadgeTone(elPhysFloc, sample.level || "normal");
    }
    if (elPhysSettling) {
      const cScore = water.clarity_score ?? 65;
      if (cScore < 30) {
        elPhysSettling.textContent = "Cảnh báo cặn nổi tràn sang bể sinh học";
        applyStageBadgeTone(elPhysSettling, "alarm");
      } else if (cScore < 55) {
        elPhysSettling.textContent = "Lắng trung bình — Theo dõi bông cặn";
        applyStageBadgeTone(elPhysSettling, "warn");
      } else {
        elPhysSettling.textContent = "Bông cặn lắng tốt — Không tràn muối/KL";
        applyStageBadgeTone(elPhysSettling, "normal");
      }
    }
    if (elPhysDebris) {
      elPhysDebris.textContent = debris.count > 0
        ? `${debris.count} dị vật nổi · Váng dầu ${debris.oil_sheen_pct}%`
        : `An toàn (Váng dầu ${debris.oil_sheen_pct ?? 0}%)`;
      applyStageBadgeTone(elPhysDebris, debris.level || "normal");
    }

    // 3. Bảng Công đoạn Sinh học (2.1.B)
    const elBioSludge = document.getElementById("bio-sludge-state");
    const elBioBubble = document.getElementById("bio-bubble-state");
    const elBioDebris = document.getElementById("bio-debris-state");
    const elBioEffluent = document.getElementById("bio-effluent-state");

    if (elBioSludge) {
      elBioSludge.textContent = `Phân tán ${sludge.dispersion_pct ?? 0}% · ${water.pigment_label || "Bùn hoạt tính"}`;
      applyStageBadgeTone(elBioSludge, water.status === "alarm" ? "alarm" : "normal");
    }
    if (elBioBubble) {
      elBioBubble.textContent = sludge.bubble_state || "—";
      applyStageBadgeTone(elBioBubble, sludge.bubble_level || "normal");
    }
    if (elBioDebris) {
      elBioDebris.textContent = debris.count > 0
        ? `Phát hiện ${debris.count} túi nilon / mảnh nhựa`
        : "Không có túi nilon / mảnh nhựa nổi";
      applyStageBadgeTone(elBioDebris, debris.level || "normal");
    }
    if (elBioEffluent) {
      elBioEffluent.textContent = water.clarity_label || "—";
      applyStageBadgeTone(elBioEffluent, water.status || "normal");
    }

    // 4. Cập nhật 4 Tasks thử nghiệm (R&D Workbench)
    const elTask1 = document.getElementById("task1-live-val");
    const elTask3 = document.getElementById("task3-live-val");
    const elTask4 = document.getElementById("task4-live-val");
    if (elTask1) {
      elTask1.textContent = `${cov}% diện tích mặt bể`;
    }
    if (elTask3) {
      elTask3.textContent = `${water.pigment_label || "—"} · Độ trong ${water.clarity_score ?? "—"}%`;
    }
    if (elTask4) {
      elTask4.textContent = debris.summary || "Không phát hiện dị vật";
    }

    // 5. Kết hợp thông số vận hành nhà máy (RPM, DO, pH, UV) + AI Scenarios
    renderOperationalScenarios(scenarios, sample);
  }

  function renderOperationalScenarios(aiScenarios, sample) {
    const elList = document.getElementById("scenario-list");
    if (!elList) return;

    const combined = [...aiScenarios];
    const rpmInput = document.getElementById("input-mixer-rpm");
    const doInput = document.getElementById("input-bio-do");
    const phInput = document.getElementById("input-bio-ph");
    const uvSelect = document.getElementById("select-uv-lamp");

    const rpm = rpmInput ? parseFloat(rpmInput.value) : 45;
    const doVal = doInput ? parseFloat(doInput.value) : 2.4;
    const phVal = phInput ? parseFloat(phInput.value) : 7.2;
    const uvState = uvSelect ? uvSelect.value : "off";

    if (!Number.isNaN(rpm) && rpm < 10) {
      combined.unshift({
        stage: "Bể Hóa lý · Máy khuấy",
        severity: "alarm",
        title: `Máy khuấy quay quá chậm hoặc đang dừng`,
        diagnosis: "Tốc độ cánh khuấy quá thấp khiến hóa chất không trộn đều và cặn lắng xuống đáy.",
        action: "Kiểm tra lại công tắc và động cơ máy khuấy tại bể hóa lý.",
      });
    }
    if (!Number.isNaN(doVal) && (doVal < 1.2 || doVal > 4.5)) {
      combined.unshift({
        stage: "Bể Sinh học · Lượng Oxy",
        severity: "warn",
        title: doVal < 1.2 ? `Lượng Oxy trong nước thấp` : `Lượng Oxy trong nước dư cao`,
        diagnosis: doVal < 1.2
          ? `Kết hợp tỷ lệ bọt ${sample?.coverage_pct ?? 0}%: nước thiếu oxy khiến vi sinh vật yếu đi.`
          : `Kết hợp tỷ lệ bọt ${sample?.coverage_pct ?? 0}%: máy sục khí đang bật mạnh hơn mức cần thiết, gây tốn điện.`,
        action: doVal < 1.2 ? "Tăng máy thổi khí và kiểm tra ống dẫn khí dưới bể." : "Giảm bớt máy thổi khí để tiết kiệm điện.",
      });
    }
    if (!Number.isNaN(phVal) && (phVal < 6.0 || phVal > 8.5)) {
      combined.unshift({
        stage: "Bể Hóa lý & Sinh học · Độ pH",
        severity: "alarm",
        title: `Độ pH của nước vượt ngưỡng an toàn`,
        diagnosis: "Nước quá chua hoặc quá kiềm sẽ làm hại vi sinh vật và khiến cặn không kết dính được.",
        action: "Kiểm tra lại bơm châm hóa chất cân bằng độ pH ở bể đầu vào.",
      });
    }
    if (uvState === "low") {
      combined.push({
        stage: "Đầu ra · Đèn khử trùng",
        severity: "warn",
        title: "Đèn chiếu khử trùng bị yếu sáng",
        diagnosis: "Bóng đèn khử trùng ở đầu ra bị bám cặn bẩn hoặc giảm độ sáng.",
        action: "Lau sạch ống bảo vệ đèn khử trùng đầu ra để diệt khuẩn tốt hơn.",
      });
    }

    elList.innerHTML = combined
      .map((sc) => {
        const sev = sc.severity || "normal";
        const sevLabel = sev === "alarm" ? "Cảnh báo cao" : sev === "warn" ? "Cần chú ý" : "Ổn định";
        return `
          <div class="scenario-item is-${escapeHtml(sev)}">
            <div class="scenario-item-head">
              <span class="scenario-stage-tag">${escapeHtml(sc.stage || "Toàn bộ bể")}</span>
              <span class="scenario-sev-badge">${sevLabel}</span>
            </div>
            <h4>${escapeHtml(sc.title || "Tình trạng mặt bể")}</h4>
            <p class="scenario-diag">${escapeHtml(sc.diagnosis || "")}</p>
            <div class="scenario-action-box">
              <strong>Cách xử lý:</strong> ${escapeHtml(sc.action || "")}
            </div>
          </div>
        `;
      })
      .join("");
  }

  function refreshDebrisCountFromFeed() {
    // Module dị vật chưa triển khai — không suy ra số giả từ feed.
    if (elKpiDebris) elKpiDebris.textContent = "—";
  }

  // 5. Polling REST APIs for Telemetry & Health
  let lastConnState = null;
  async function pollStatus() {
    try {
      const res = await apiFetch(`${API_BASE}/status`);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();

      elBackendDot.className = "badge-dot dot-online";
      elBackendText.textContent = "Hệ thống";

      // Camera State
      isCameraRunning = Boolean(data.camera_active);
      elKpiFps.textContent = data.current_fps ? data.current_fps.toFixed(1) : "0.0";
      elKpiTracks.textContent = data.tracked_persons_count ?? 0;
      applyFoamSnapshot(data.foam);

      // Network / remote camera health (auto-reconnect with backoff runs on the server)
      const conn = data.camera_connection;
      if (conn && conn.state === "reconnecting") {
        const tries = conn.reconnect_attempts ? ` (lần thử ${conn.reconnect_attempts})` : "";
        showCamFeedback(`Mất kết nối camera ở xa, đang tự động kết nối lại${tries}...`, "error", 2500);
        lastConnState = "reconnecting";
      } else if (conn && conn.state === "connected" && lastConnState === "reconnecting") {
        showCamFeedback("Đã kết nối lại với camera.", "success", 3000);
        lastConnState = "connected";
      }

      // Update button labels
      if (isCameraRunning) {
        if (elBtnCamToggleTxt) elBtnCamToggleTxt.textContent = "Dừng luồng";
        if (elOfflineOverlay) elOfflineOverlay.style.display = "none";
        
        // Camera connected: show its picture automatically
        if (!elVideoStream.getAttribute("src") || elVideoStream.src.indexOf("/stream/mjpeg") === -1) {
          elVideoStream.src = buildMjpegUrl();
        }
      } else {
        if (elBtnCamToggleTxt) elBtnCamToggleTxt.textContent = "Bật luồng";
        if (elOfflineOverlay) elOfflineOverlay.style.display = "flex";
      }
      if (typeof syncWaterRoiUi === "function") {
        syncWaterRoiUi(data.water_roi || null, isCameraRunning);
      }

      // Update simulated or active persons in table
      updatePersonTable(data.tracked_persons_count);
    } catch (_) {
      elBackendDot.className = "badge-dot dot-offline";
      elBackendText.textContent = "Mất kết nối";
      elOfflineOverlay.style.display = "flex";
    }
  }

  async function pollHealth() {
    try {
      const res = await apiFetch(`${API_BASE}/health`);
      if (!res.ok) return;
      const data = await res.json();

      if (data.telemetry) {
        if (elTelemCpu) elTelemCpu.textContent = `${data.telemetry.cpu_percent ?? 0}%`;
        if (elTelemRam) elTelemRam.textContent = `${data.telemetry.ram_used_gb ?? 0} GB`;
        if (elTelemGpu) elTelemGpu.textContent = data.telemetry.gpu_available ? "CUDA (RTX 3050)" : "CPU Runtime";
      }
    } catch (_) {}
  }

  // 6. Update Risk Meter KPI
  function updateRiskKpi(score, stateText) {
    elKpiRisk.textContent = score.toFixed(2);
    elKpiRiskState.textContent = stateText || (score > 0.7 ? "NGUY CƠ CAO" : score > 0.4 ? "NGHI VẤN" : "BÌNH THƯỜNG");

    const pct = Math.min(100, Math.max(5, score * 100));
    elKpiRiskMeter.style.width = `${pct}%`;

    if (score > 0.7) {
      elKpiRisk.className = "kpi-value risk-red";
      elKpiRiskMeter.className = "kpi-meter-fill meter-red";
    } else if (score > 0.4) {
      elKpiRisk.className = "kpi-value risk-yellow";
      elKpiRiskMeter.className = "kpi-meter-fill meter-yellow";
    } else {
      elKpiRisk.className = "kpi-value risk-green";
      elKpiRiskMeter.className = "kpi-meter-fill meter-green";
    }
  }

  // Lying context from the risk engine (decision support only, never a diagnosis)
  const LYING_CONTEXT_LABELS = {
    lying: "Đang nằm",
    resting: "Nằm nghỉ / ngủ",
    using_phone: "Nằm dùng điện thoại",
    repositioning: "Trở mình",
    collapsed: "Đổ gục rồi nằm im",
    struggling: "Cố ngồi dậy nhiều lần không được",
    asymmetric_movement: "Chỉ cử động một bên người",
    still_on_floor: "Nằm im lâu trên sàn",
    staggering: "Đi loạng choạng, mất thăng bằng",
    abnormal_gesture: "Ôm đầu / ôm ngực / nôn",
    unsteady_before_fall: "Loạng choạng ngay trước khi ngã",
    collapse_from_sitting: "Đổ gục từ tư thế ngồi",
    convulsion: "Co giật (giật nhịp nhàng nhiều phần cơ thể)",
    after_convulsion: "Nằm sau cơn co giật",
  };

  // Lý do hệ thống kết luận cách người đó nằm xuống
  const ONSET_REASON_LABELS = {
    sat_down_first: "Ngồi xuống trước rồi nằm (chủ động)",
    paused_then_lowered: "Dừng lại rồi từ từ hạ người (chủ động)",
    slow_transition: "Hạ người chậm (chủ động)",
    awake_after_drop: "Nằm phịch xuống nhưng vẫn hoạt động bình thường",
    convulsion: "Co giật rồi nằm ra (không phải chủ động nằm)",
    unsteady_before: "Loạng choạng rồi ngã",
    collapse_from_sitting: "Đổ gục từ tư thế ngồi",
    fast_drop: "Rơi nhanh xuống",
    upright_to_floor: "Từ tư thế đứng xuống sàn trong vài giây",
    inherited: "Tiếp nối từ lần theo dõi trước",
  };

  // 7. Update Person Kinematics Table
  function updatePersonTable(trackCount) {
    if (!trackCount || trackCount === 0) {
      updateRiskKpi(0.05, "BÌNH THƯỜNG");
    }
    // The person table was removed from index.html; without this guard the TypeError
    // lands in pollStatus' catch and shows "API: Mất kết nối" over a running camera.
    if (!elPersonTableBody) return;

    if (!trackCount || trackCount === 0) {
      elPersonTableBody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center text-muted">Không có đối tượng bất thường trên khung quan sát</td>
        </tr>
      `;
      return;
    }

    let rowsHtml = "";
    for (let i = 1; i <= trackCount; i++) {
      rowsHtml += `
        <tr>
          <td><strong>#${i}</strong></td>
          <td><span class="action-badge badge-walking">walking</span></td>
          <td>12.4°</td>
          <td>0.48</td>
          <td>0.02 m/s</td>
          <td><span style="color: var(--status-normal);">0.08</span></td>
          <td><span style="color: var(--status-normal);">NORMAL</span></td>
        </tr>
      `;
    }
    elPersonTableBody.innerHTML = rowsHtml;
  }

  // 8. Fetch Historical Events on Load
  async function fetchHistoricalEvents() {
    try {
      const res = await apiFetch(`${API_BASE}/events?limit=20`);
      if (!res.ok) return;
      const events = await res.json();
      if (Array.isArray(events) && events.length > 0) {
        if (elEmptyPlaceholder) elEmptyPlaceholder.style.display = "none";
        const tbody = document.getElementById("alerts-table-body");
        if (tbody) tbody.innerHTML = "";
        // API trả oldest→newest; hiển thị mới nhất trước
        const newestFirst = [...events].reverse();
        newestFirst.forEach((evt, idx) => {
          renderAlertCard(evt, false);
          if (tbody) {
            const label = wwtpEventLabel(evt.event_type, evt.evidence?.primary_action || "Sự cố");
            const cam = evt.camera_name || evt.camera_id || "—";
            const ts = evt.timestamp ? new Date(evt.timestamp).toLocaleTimeString() : "—";
            const tr = document.createElement("tr");
            if (idx === 0) tr.className = "alert-row-highlight";
            tr.innerHTML = `
              <td><span class="id-tag">#${String(events.length - idx).padStart(3, "0")}</span></td>
              <td>${ts}</td>
              <td><span class="badge-type-danger">${escapeHtml(label)}</span></td>
              <td>${escapeHtml(cam)}</td>
              <td><span class="badge-state-pending">${evt.acknowledged ? "Đã xác nhận" : "Mở"}</span></td>
            `;
            tbody.appendChild(tr);
          }
        });
        const latest = newestFirst[0];
        if (latest) {
          const elIncTs = document.getElementById("incident-timestamp-txt");
          const elIncConf = document.getElementById("incident-confidence-txt");
          const elIncCam = document.getElementById("incident-cam-title");
          const elIncStatus = document.getElementById("incident-status-tag");
          if (elIncCam) elIncCam.textContent = latest.camera_name || latest.camera_id || "Bể sinh học 01";
          if (elIncTs && latest.timestamp) {
            const d = new Date(latest.timestamp);
            elIncTs.textContent = `${d.toLocaleTimeString()} - ${d.toLocaleDateString("vi-VN")}`;
          }
          if (elIncConf && typeof latest.risk_score === "number") {
            elIncConf.textContent = `${(latest.risk_score * 100).toFixed(0)}%`;
          }
          if (elIncStatus) elIncStatus.textContent = latest.acknowledged ? "Đã xác nhận" : "Mở";
        }
        const elTotalAlerts = document.getElementById("stat-total-alerts-count");
        if (elTotalAlerts) {
          const openCount = events.filter((e) => !e.acknowledged).length;
          elTotalAlerts.textContent = String(openCount);
        }
        if (elKpiDebris) elKpiDebris.textContent = "—";
      }
    } catch (_) {}
  }

  // 9. Interactive UI Events
  // Stream error handler
  // The live <img> keeps retrying while the camera runs, so the picture comes back on its own
  // after a network drop or when the page loaded before the camera was ready.
  let streamRetryTimer = null;
  if (elVideoStream) {
    elVideoStream.addEventListener("error", () => {
      if (!isCameraRunning || !elVideoStream.getAttribute("src")) {
        if (elOfflineOverlay) elOfflineOverlay.style.display = "flex";
        return;
      }
      if (streamRetryTimer) return;
      streamRetryTimer = setTimeout(() => {
        streamRetryTimer = null;
        if (isCameraRunning) elVideoStream.src = buildMjpegUrl();
      }, 2000);
    });
    elVideoStream.addEventListener("load", () => {
      if (elOfflineOverlay) elOfflineOverlay.style.display = "none";
    });
  }

  // Toast feedback message helper
  let camToastTimer = null;
  function showCamFeedback(msg, type = "info", duration = 4500) {
    if (!elCamToastFeedback) return;
    if (camToastTimer) clearTimeout(camToastTimer);
    elCamToastFeedback.className = `cam-toast-feedback toast-${type}`;
    const tag = type === "success" ? "[OK]" : (type === "error" ? "[LỖI]" : "[THÔNG BÁO]");
    elCamToastFeedback.innerHTML = `<span class="num-mono">${tag}</span> <span>${msg}</span>`;
    elCamToastFeedback.style.display = "flex";
    if (duration > 0) {
      camToastTimer = setTimeout(() => {
        elCamToastFeedback.style.display = "none";
      }, duration);
    }
  }

  // Preset RTSP templates
  const RTSP_TEMPLATES = {
    custom: "",
    hikvision: "rtsp://admin:password123@192.168.1.100:554/Streaming/Channels/101",
    dahua: "rtsp://admin:password123@192.168.1.100:554/cam/realmonitor?channel=1&subtype=0",
    yoosee: "rtsp://admin:123456@192.168.1.100:554/onvif1",
    tapo: "rtsp://admin:password123@192.168.1.100:554/stream1",
    ezviz: "rtsp://admin:VERIFICATION_CODE@192.168.1.100:554/h264/ch1/main/av_stream",
    ddns: "rtsp://tenmien-cua-ban.ddns.net:554/stream1",
    vpn: "rtsp://100.64.0.10:554/stream1",
    http_mjpeg: "http://192.168.1.50:8080/video",
  };

  function readRtspCredentials() {
    return {
      rtsp_username: elRtspUsernameInput && elRtspUsernameInput.value.trim() ? elRtspUsernameInput.value.trim() : undefined,
      rtsp_password: elRtspPasswordInput && elRtspPasswordInput.value ? elRtspPasswordInput.value : undefined,
    };
  }

  if (elBtnTestRtsp) {
    elBtnTestRtsp.addEventListener("click", async () => {
      const url = elRtspUrlInput ? elRtspUrlInput.value.trim() : "";
      if (!url) {
        showCamFeedback("Vui lòng nhập đường dẫn camera trước khi kiểm tra.", "error", 3500);
        return;
      }
      elBtnTestRtsp.disabled = true;
      elBtnTestRtsp.textContent = "Đang thử…";
      showCamFeedback("Đang kiểm tra kết nối tới camera (tối đa ~10 giây)…", "info", 0);
      try {
        const res = await apiFetch(`${API_BASE}/camera/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rtsp_url: url, ...readRtspCredentials() }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          showCamFeedback(`${data.message} (${data.connect_ms} ms)`, "success", 6000);
        } else {
          // The backend explains the failure (own IP, RTSP off, wrong verification code, wrong path...)
          const msg = escapeHtml(data.message || data.detail || "Không kết nối được camera.");
          showCamFeedback(data.hint ? `${msg}<br>Hướng dẫn: ${escapeHtml(data.hint)}` : msg, "error", 15000);
        }
      } catch (e) {
        showCamFeedback("Không kết nối được hệ thống: " + e.message, "error", 5000);
      } finally {
        elBtnTestRtsp.disabled = false;
        elBtnTestRtsp.textContent = "Kiểm tra";
      }
    });
  }

  // Put a discovered camera's IP (and RTSP port) into the URL, keeping the user's path / credentials
  function applyDiscoveredCamera(dev) {
    if (!elRtspUrlInput) return;
    if (elRtspPresetSelect && dev.preset && dev.preset !== "custom" && RTSP_TEMPLATES[dev.preset] !== undefined) {
      elRtspPresetSelect.value = dev.preset;
    }
    let url;
    if (!dev.rtsp_open && dev.http_port && dev.preset === "http_mjpeg") {
      url = `http://${dev.ip}:${dev.http_port}/video`;
    } else {
      const base = elRtspUrlInput.value.trim() || RTSP_TEMPLATES[dev.preset] || `rtsp://${dev.ip}:${dev.rtsp_port}/`;
      url = base.replace(/^(\w+:\/\/(?:[^@\/]*@)?)[^\/:?#]+(?::\d+)?/, `$1${dev.ip}:${dev.rtsp_port}`);
    }
    elRtspUrlInput.value = url;
    elRtspUrlInput.focus();
    if (dev.rtsp_open) {
      showCamFeedback(`Đã điền IP ${escapeHtml(dev.ip)}. Kiểm tra tài khoản / mật khẩu (EZVIZ: mã xác minh) rồi bấm "Kiểm tra".`, "success", 8000);
    } else {
      showCamFeedback(`Đã điền IP ${escapeHtml(dev.ip)}. ${escapeHtml(dev.status)}`, "info", 12000);
    }
  }

  async function discoverNetworkCameras() {
    if (!elBtnDiscoverCameras || !elCamDiscoverResults) return;
    elBtnDiscoverCameras.disabled = true;
    elBtnDiscoverCameras.textContent = "Đang dò mạng (~5s)…";
    elCamDiscoverResults.style.display = "none";
    try {
      const res = await apiFetch(`${API_BASE}/camera/discover`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || res.status);
      elCamDiscoverResults.innerHTML = "";
      const devices = Array.isArray(data.devices) ? data.devices : [];
      if (devices.length === 0) {
        const empty = document.createElement("div");
        empty.className = "cam-discover-empty";
        const nets = (data.networks || []).join(", ") || "không có mạng LAN";
        empty.textContent = `Không tìm thấy camera trong mạng ${nets}. Kiểm tra camera đã bật và cùng mạng với máy trạm.`;
        elCamDiscoverResults.appendChild(empty);
      }
      devices.forEach((dev) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "cam-discover-item" + (dev.rtsp_open ? "" : " rtsp-off");
        item.innerHTML = `<span class="cam-discover-head">${escapeHtml(dev.ip)} · ${escapeHtml(dev.brand)}</span>`
          + `<span class="cam-discover-status">${dev.rtsp_open ? "[SẴN SÀNG]" : "[CẦN CẤU HÌNH]"} ${escapeHtml(dev.status)}</span>`;
        item.addEventListener("click", () => applyDiscoveredCamera(dev));
        elCamDiscoverResults.appendChild(item);
      });
      elCamDiscoverResults.style.display = "flex";
      if (devices.length > 0) {
        showCamFeedback(`Tìm thấy ${devices.length} thiết bị. Chọn thiết bị để điền địa chỉ IP.`, "info", 5000);
      }
    } catch (e) {
      showCamFeedback("Không dò được mạng: " + escapeHtml(String(e.message || e)), "error", 6000);
    } finally {
      elBtnDiscoverCameras.disabled = false;
      elBtnDiscoverCameras.textContent = "Dò thiết bị trên mạng LAN";
    }
  }

  if (elBtnDiscoverCameras) {
    elBtnDiscoverCameras.addEventListener("click", discoverNetworkCameras);
  }

  function webcamOptionLabel(dev) {
    let label = `${dev.device_index}: ${dev.name}`;
    if (dev.is_virtual) label += " — điện thoại / camera ảo";
    if (dev.is_active) label += " (đang dùng)";
    return label;
  }

  // List webcams by name (the server does not open any of them)
  async function fetchCameraDevices() {
    if (!elWebcamDeviceSelect) return;
    try {
      if (elBtnScanWebcams) {
        elBtnScanWebcams.disabled = true;
        elBtnScanWebcams.textContent = "Đang quét…";
      }
      const res = await apiFetch(`${API_BASE}/camera/devices`);
      if (!res.ok) return;
      const devices = await res.json();
      if (Array.isArray(devices) && devices.length > 0) {
        // Primary camera: every webcam except those already used by an extra camera
        elWebcamDeviceSelect.innerHTML = "";
        devices.forEach((dev) => {
          if (dev.in_use_by_extra && !dev.is_active) return;
          const opt = document.createElement("option");
          opt.value = dev.device_index;
          opt.textContent = webcamOptionLabel(dev);
          if (dev.is_active) opt.selected = true;
          elWebcamDeviceSelect.appendChild(opt);
        });
        // Extra camera: only webcams not used by the primary camera or another extra camera
        if (elExtraCamDevice && elExtraCamDevice.tagName === "SELECT") {
          elExtraCamDevice.innerHTML = "";
          devices.filter((dev) => !dev.is_active && !dev.in_use_by_extra).forEach((dev) => {
            const opt = document.createElement("option");
            opt.value = dev.device_index;
            opt.textContent = webcamOptionLabel(dev);
            elExtraCamDevice.appendChild(opt);
          });
          if (!elExtraCamDevice.options.length) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "Không còn webcam trống";
            elExtraCamDevice.appendChild(opt);
          }
        }
      }
    } catch (err) {
      console.warn("[Dashboard] Lỗi khi quét danh sách camera:", err);
    } finally {
      if (elBtnScanWebcams) {
        elBtnScanWebcams.disabled = false;
        elBtnScanWebcams.textContent = "Quét";
      }
    }
  }

  // Fetch Active Camera Status & Information
  async function fetchCameraInfo() {
    try {
      const res = await apiFetch(`${API_BASE}/camera/info`);
      if (!res.ok) return;
      const info = await res.json();
      if (info) {
        const srcType = info.source_type || "webcam";
        if (elCameraTypeSelect) {
          elCameraTypeSelect.value = srcType === "synthetic" ? "video" : srcType;
        }
        handleCameraTypeChange();

        if (info.device_index !== undefined && elWebcamDeviceSelect) {
          elWebcamDeviceSelect.value = String(info.device_index);
        }
        if (info.rtsp_url && elRtspUrlInput) {
          elRtspUrlInput.value = info.rtsp_url;
        }

        const camName = info.name || (srcType === "webcam" ? `Webcam ${info.device_index ?? 0}` : (srcType === "rtsp" ? "RTSP Camera" : "Video File"));
        if (elCamActiveNameTxt) elCamActiveNameTxt.textContent = camName;
        if (elHudCamName) elHudCamName.textContent = `CAM: ${camName.toUpperCase()}`;
      }
    } catch (_) {}
  }

  // Handle Camera Type Switch (Webcam / RTSP / Video)
  function handleCameraTypeChange() {
    const selectedType = elCameraTypeSelect ? elCameraTypeSelect.value : "webcam";
    if (elGroupWebcamDevice) elGroupWebcamDevice.style.display = selectedType === "webcam" ? "grid" : "none";
    if (elGroupRtspPreset) elGroupRtspPreset.style.display = selectedType === "rtsp" ? "grid" : "none";
    if (elGroupRtspUrlRow) elGroupRtspUrlRow.style.display = selectedType === "rtsp" ? "grid" : "none";
    if (elGroupVideoPreset) elGroupVideoPreset.style.display = selectedType === "video" ? "grid" : "none";
    if (elGroupVideoCustomRow) {
      elGroupVideoCustomRow.style.display = (selectedType === "video" && elVideoPresetSelect && elVideoPresetSelect.value === "custom") ? "grid" : "none";
    }
  }

  if (elCameraTypeSelect) {
    elCameraTypeSelect.addEventListener("change", () => {
      handleCameraTypeChange();
      if (elCameraTypeSelect.value === "video") fetchCameraVideos();
    });
  }

  const elBtnRefreshVideos = document.getElementById("btn-refresh-videos");
  if (elBtnRefreshVideos) {
    elBtnRefreshVideos.addEventListener("click", () => {
      fetchCameraVideos();
      showCamFeedback("Đã tải lại danh sách video.", "info", 2000);
    });
  }

  if (elRtspPresetSelect) {
    elRtspPresetSelect.addEventListener("change", (e) => {
      const presetKey = e.target.value;
      if (RTSP_TEMPLATES[presetKey] && elRtspUrlInput) {
        elRtspUrlInput.value = RTSP_TEMPLATES[presetKey];
        elRtspUrlInput.focus();
      }
    });
  }

  if (elVideoPresetSelect) {
    elVideoPresetSelect.addEventListener("change", (e) => {
      if (elGroupVideoCustomRow) {
        elGroupVideoCustomRow.style.display = e.target.value === "custom" ? "grid" : "none";
      }
    });
  }

  if (elBtnScanWebcams) {
    elBtnScanWebcams.addEventListener("click", () => {
      fetchCameraDevices();
      showCamFeedback("Đang quét các cổng webcam trên máy tính...", "info", 2000);
    });
  }

  // Apply & Switch Camera
  async function applyCameraSwitch(saveDefault = false) {
    const srcType = elCameraTypeSelect ? elCameraTypeSelect.value : "webcam";
    let devIndex = 0;
    let rtspUrl = "";
    let videoPath = "";

    if (srcType === "webcam") {
      devIndex = parseInt(elWebcamDeviceSelect ? elWebcamDeviceSelect.value : "0", 10) || 0;
    } else if (srcType === "rtsp") {
      rtspUrl = elRtspUrlInput ? elRtspUrlInput.value.trim() : "";
      if (!rtspUrl) {
        showCamFeedback("Vui lòng nhập đường dẫn camera (ví dụ: rtsp://192.168.1.100:554/stream1 hoặc rtsp://tenmien.ddns.net:554/stream1)", "error", 4000);
        if (elRtspUrlInput) elRtspUrlInput.focus();
        return;
      }
    } else if (srcType === "video") {
      const preset = elVideoPresetSelect ? elVideoPresetSelect.value : "";
      if (preset === "custom") {
        videoPath = elCustomVideoPathInput ? elCustomVideoPathInput.value.trim() : "";
        if (!videoPath) {
          showCamFeedback("Vui lòng nhập đường dẫn tệp video MP4 cục bộ", "error", 3000);
          return;
        }
      } else if (!preset) {
        showCamFeedback("Chưa có video. Thêm file MP4 hoặc nhập vị trí file tùy chỉnh.", "error", 5000);
        return;
      } else {
        videoPath = preset;
      }
    }

    // Set UI loading state
    if (elBtnApplyCamera) elBtnApplyCamera.disabled = true;
    if (elCamSpinner) elCamSpinner.style.display = "inline-block";
    if (elBtnApplyTxt) elBtnApplyTxt.textContent = "Đang kết nối…";
    showCamFeedback("Đang giải phóng luồng cũ và kết nối nguồn mới…", "info", 0);

    try {
      const res = await apiFetch(`${API_BASE}/camera/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_type: srcType,
          device_index: devIndex,
          rtsp_url: rtspUrl || undefined,
          ...(srcType === "rtsp" ? readRtspCredentials() : {}),
          video_path: videoPath || undefined,
          save_as_default: saveDefault,
        }),
      });

      const data = await res.json();

      if (res.ok && data.status === "success") {
        isCameraRunning = true;
        if (elOfflineOverlay) elOfflineOverlay.style.display = "none";
        showCamFeedback(data.message || "Đã chuyển đổi camera thành công!", "success", 4000);
        fetchCameraDevices();

        // Update active badge & HUD
        const newName = data.camera_info?.name || "Camera";
        if (elCamActiveNameTxt) elCamActiveNameTxt.textContent = newName;
        if (elHudCamName) elHudCamName.textContent = `CAM: ${newName.toUpperCase()}`;

        // Reload MJPEG stream with cachebuster
        setTimeout(() => {
          if (elVideoStream) {
            elVideoStream.src = buildMjpegUrl();
          }
          pollStatus();
        }, 400);

      } else {
        const msg = data.detail || data.message || "Không thể kết nối đến camera được chọn.";
        showCamFeedback(escapeHtml(msg), "error", 12000);
        pollStatus();
      }
    } catch (e) {
      showCamFeedback("Không kết nối được hệ thống: " + e.message, "error", 5000);
      pollStatus();
    } finally {
      if (elBtnApplyCamera) elBtnApplyCamera.disabled = false;
      if (elCamSpinner) elCamSpinner.style.display = "none";
      if (elBtnApplyTxt) elBtnApplyTxt.textContent = "Kết nối nguồn này";
    }
  }

  if (elBtnApplyCamera) {
    elBtnApplyCamera.addEventListener("click", () => applyCameraSwitch(false));
  }

  if (elBtnSaveCameraDefault) {
    elBtnSaveCameraDefault.addEventListener("click", () => applyCameraSwitch(true));
  }

  // Toggle Camera Start / Stop
  async function toggleCamera() {
    if (isCameraRunning) {
      try {
        await apiFetch(`${API_BASE}/camera/stop`, { method: "POST" });
        isCameraRunning = false;
        if (elVideoStream) elVideoStream.removeAttribute("src");
        if (elOfflineOverlay) elOfflineOverlay.style.display = "flex";
        showCamFeedback("Đã tạm dừng luồng camera giám sát.", "info", 2500);
        pollStatus();
      } catch (e) {
        showCamFeedback("Lỗi khi dừng camera: " + e.message, "error", 3000);
      }
    } else {
      await applyCameraSwitch(false);
    }
  }

  if (elBtnCameraToggle) elBtnCameraToggle.addEventListener("click", toggleCamera);

  // Refresh stream
  if (elBtnRefreshStream) {
    elBtnRefreshStream.addEventListener("click", () => {
      if (elVideoStream) {
        elVideoStream.src = buildMjpegUrl();
        showCamFeedback("Đã tải lại luồng hiển thị video.", "info", 2000);
      }
    });
  }

  // Dismiss Emergency Banner & Silence Alarm
  elBtnDismissAlert.addEventListener("click", () => {
    stopContinuousAlarm();
    clearEmergencyVisuals();
    elEmergencyBar.style.display = "none";
    updateRiskKpi(0.05, "BÌNH THƯỜNG");
  });

  // Xóa đơn lẻ vĩnh viễn 1 cảnh báo
  async function deleteSingleAlertPermanently(eventId, cardElement) {
    if (eventId) {
      try {
        await apiFetch(`${API_BASE}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
      } catch (err) {
        console.warn("[Dashboard] Lỗi kết nối khi xóa sự kiện trên server:", err);
      }
    }

    if (cardElement) {
      cardElement.style.transition = "all 0.25s ease-out";
      cardElement.style.opacity = "0";
      cardElement.style.transform = "translateX(25px)";
      setTimeout(() => {
        if (cardElement.parentNode) {
          cardElement.parentNode.removeChild(cardElement);
        }
      }, 250);
    }

    alertCount = Math.max(0, alertCount - 1);
    if (elAlertsCountBadge) elAlertsCountBadge.textContent = String(alertCount);

    if (alertCount === 0) {
      if (elEmptyPlaceholder) {
        elEmptyPlaceholder.style.display = "block";
      }
      stopContinuousAlarm();
      clearEmergencyVisuals();
      if (elEmergencyBar) elEmergencyBar.style.display = "none";
      updateRiskKpi(0.05, "BÌNH THƯỜNG");
    }
  }

  // Chức năng 1: Xóa tạm thời (Ẩn khỏi màn hình hiện tại & tắt chuông, không xóa dữ liệu máy chủ)
  function clearTempAlerts() {
    if (elAlertsFeed) elAlertsFeed.innerHTML = "";
    if (elEmptyPlaceholder) elEmptyPlaceholder.style.display = "block";
    alertCount = 0;
    if (elAlertsCountBadge) elAlertsCountBadge.textContent = "0";

    stopContinuousAlarm();
    clearEmergencyVisuals();
    if (elEmergencyBar) elEmergencyBar.style.display = "none";
    updateRiskKpi(0.05, "BÌNH THƯỜNG");

    console.log("[Dashboard] Danh sách cảnh báo đã được xóa tạm thời khỏi màn hình.");
  }

  // Chức năng 2: Xóa vĩnh viễn (Xóa toàn bộ trên giao diện và xóa vĩnh viễn dữ liệu trên Backend API)
  async function clearPermanentAlerts() {
    const confirmClear = window.confirm(
      "CẢNH BÁO XÓA VĨNH VIỄN:\nToàn bộ dữ liệu lịch sử cảnh báo sẽ bị xóa sạch khỏi hệ thống máy chủ và không thể khôi phục.\nBạn có chắc chắn muốn xóa không?"
    );
    if (!confirmClear) return;

    if (elAlertsFeed) elAlertsFeed.innerHTML = "";
    if (elEmptyPlaceholder) elEmptyPlaceholder.style.display = "block";
    alertCount = 0;
    if (elAlertsCountBadge) elAlertsCountBadge.textContent = "0";

    stopContinuousAlarm();
    clearEmergencyVisuals();
    if (elEmergencyBar) elEmergencyBar.style.display = "none";
    updateRiskKpi(0.05, "BÌNH THƯỜNG");

    try {
      await apiFetch(`${API_BASE}/events/clear`, { method: "POST" });
      console.log("[Dashboard] Toàn bộ dữ liệu cảnh báo đã được xóa vĩnh viễn trên Server.");
    } catch (err) {
      console.warn("[Dashboard] Lỗi khi gửi yêu cầu xóa vĩnh viễn lên server:", err);
    }
  }

  if (elBtnClearTemp) {
    elBtnClearTemp.addEventListener("click", () => {
      clearTempAlerts();
      if (elAlertsMenuDropdown) elAlertsMenuDropdown.classList.remove("show");
      if (elBtnAlertsMenuToggle) elBtnAlertsMenuToggle.classList.remove("active");
    });
  }
  if (elBtnClearPermanent) {
    elBtnClearPermanent.addEventListener("click", async () => {
      await clearPermanentAlerts();
      if (elAlertsMenuDropdown) elAlertsMenuDropdown.classList.remove("show");
      if (elBtnAlertsMenuToggle) elBtnAlertsMenuToggle.classList.remove("active");
    });
  }

  // Header 3-Dots Dropdown Menu for Alerts Card
  const elBtnAlertsMenuToggle = document.getElementById("btn-alerts-menu-toggle");
  const elAlertsMenuDropdown = document.getElementById("alerts-menu-dropdown");

  if (elBtnAlertsMenuToggle && elAlertsMenuDropdown) {
    elBtnAlertsMenuToggle.addEventListener("click", (evt) => {
      evt.stopPropagation();
      // Close other item dropdowns
      document.querySelectorAll(".alert-menu-dropdown.show").forEach((el) => el.classList.remove("show"));
      document.querySelectorAll(".btn-alert-menu.active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll(".bubble-popover-menu.show").forEach((el) => el.classList.remove("show"));
      document.querySelectorAll(".btn-bubble-dots.active").forEach((el) => el.classList.remove("active"));

      elAlertsMenuDropdown.classList.toggle("show");
      elBtnAlertsMenuToggle.classList.toggle("active");
    });
  }

  // Camera 3-Dots Bubble Popover Menu (Image 2 style)
  const elBtnCamMenuToggle = document.getElementById("btn-cam-menu-toggle");
  const elCamPopoverMenu = document.getElementById("cam-popover-menu");

  if (elBtnCamMenuToggle && elCamPopoverMenu) {
    elBtnCamMenuToggle.addEventListener("click", (evt) => {
      evt.stopPropagation();
      // Close alert dropdown
      if (elAlertsMenuDropdown) elAlertsMenuDropdown.classList.remove("show");
      if (elBtnAlertsMenuToggle) elBtnAlertsMenuToggle.classList.remove("active");

      const isOpen = elCamPopoverMenu.classList.toggle("show");
      elBtnCamMenuToggle.classList.toggle("active", isOpen);
    });

    // Prevent accidental closing when interacting with controls inside popover
    elCamPopoverMenu.addEventListener("click", (evt) => {
      evt.stopPropagation();
    });
  }

  // Snapshot Capture Button (Inside 3-Dots Popover)
  const elBtnSnapshot = document.getElementById("btn-snapshot");
  if (elBtnSnapshot) {
    elBtnSnapshot.addEventListener("click", () => {
      const videoImg = document.getElementById("live-video-stream");
      if (!videoImg || !videoImg.naturalWidth) {
        showCamFeedback("Chưa có luồng video hoạt động để chụp ảnh.", "error", 2500);
        return;
      }
      try {
        const canvas = document.createElement("canvas");
        canvas.width = videoImg.naturalWidth;
        canvas.height = videoImg.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(videoImg, 0, 0);
        const link = document.createElement("a");
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        link.download = `camera_snapshot_${timestamp}.png`;
        link.href = canvas.toDataURL("image/png");
        link.click();
        showCamFeedback("Đã chụp và tải ảnh về máy.", "success", 2500);
      } catch (err) {
        console.warn("[Dashboard] Snapshot error:", err);
        showCamFeedback("Đã lưu khung hình snapshot!", "info", 2500);
      }
    });
  }

  // Đóng toàn bộ dropdown / popover 3 chấm khi click ra ngoài
  document.addEventListener("click", () => {
    document.querySelectorAll(".alert-menu-dropdown.show").forEach((el) => el.classList.remove("show"));
    document.querySelectorAll(".chrome-menu-dropdown.show").forEach((el) => el.classList.remove("show"));
    document.querySelectorAll(".bubble-popover-menu.show").forEach((el) => el.classList.remove("show"));
    document.querySelectorAll(".btn-alert-menu.active").forEach((el) => el.classList.remove("active"));
    document.querySelectorAll(".btn-chrome-more.active").forEach((el) => el.classList.remove("active"));
    document.querySelectorAll(".btn-bubble-dots.active").forEach((el) => el.classList.remove("active"));
  });

  const elSoundIconIndicator = document.getElementById("sound-icon-indicator");
  const elSoundBadgeStatus = document.getElementById("sound-badge-status");

  function updateSoundUi() {
    if (elSoundIconIndicator) {
      elSoundIconIndicator.textContent = soundEnabled ? "🔊" : "🔇";
    }
    if (elSoundBadgeStatus) {
      elSoundBadgeStatus.textContent = soundEnabled ? "BẬT" : "TẮT";
      elSoundBadgeStatus.className = soundEnabled ? "item-badge-status status-on" : "item-badge-status status-off";
    }
  }

  // Nút Test Chuông Cảnh Báo
  if (elBtnTestChime) {
    elBtnTestChime.addEventListener("click", () => {
      initAudioContext();
      if (!soundEnabled) {
        soundEnabled = true;
        updateSoundUi();
      }
      console.log("[Dashboard] Testing emergency alarm chime over speaker...");
      triggerAlarmChime("fall");
    });
  }

  // Sound Toggle
  if (elBtnSoundToggle) {
    elBtnSoundToggle.addEventListener("click", () => {
      soundEnabled = !soundEnabled;
      if (!soundEnabled) {
        stopContinuousAlarm();
      } else {
        initAudioContext();
        playBellChimeTone(880, 0.35, 0.4); // Tiếng chuông nhẹ xác nhận đã bật loa
      }
      updateSoundUi();
    });
  }

  // Fullscreen toggle
  elBtnFullscreen.addEventListener("click", () => {
    const container = document.getElementById("video-container");
    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  // ==============================================================================
  // 9. SETTINGS MODAL CONTROLLER (BẢNG CÀI ĐẶT HỆ THỐNG GỌN GÀNG 1-CLICK)
  // ==============================================================================
  const elBtnOpenSettings = document.getElementById("btn-open-settings");
  const elBtnCloseSettings = document.getElementById("btn-close-settings");
  const elSettingsOverlay = document.getElementById("settings-modal-overlay");
  const elToggleAutostart = document.getElementById("toggle-autostart");
  const elAutostartPill = document.getElementById("autostart-status-pill");
  const elAutostartFeedback = document.getElementById("autostart-feedback");
  const elBtnCheckCamera = document.getElementById("btn-check-camera");
  const elBtnOpenWinCamera = document.getElementById("btn-open-win-camera-settings");
  const elCameraCheckFeedback = document.getElementById("camera-check-feedback");
  const elToggleFaceBlur = document.getElementById("toggle-face-blur");
  const elBtnModalShutdown = document.getElementById("btn-modal-shutdown");

  function openSettingsModal() {
    if (elSettingsOverlay) elSettingsOverlay.style.display = "flex";
    fetchAutostartStatus();
    fetchTelegramSettings();
    fetchUpdateStatus();
  }

  // ---- Cập nhật phiên bản (GitHub Releases) ----
  const elUpdatePill = document.getElementById("update-status-pill");
  const elUpdateCheck = document.getElementById("btn-update-check");
  const elUpdateDownload = document.getElementById("btn-update-download");
  const elUpdateInstall = document.getElementById("btn-update-install");
  const elUpdateProgress = document.getElementById("update-progress");
  const elUpdateProgressBar = document.getElementById("update-progress-bar");
  const elUpdateNotes = document.getElementById("update-notes");
  const elUpdateFeedback = document.getElementById("update-feedback");
  const elAppVersionText = document.getElementById("app-version-text");
  let updatePollTimer = null;
  let installArmedUntil = 0;

  function showUpdateFeedback(text, kind) {
    if (!elUpdateFeedback) return;
    elUpdateFeedback.style.display = text ? "block" : "none";
    elUpdateFeedback.className = `settings-feedback ${kind === "error" ? "feedback-error" : "feedback-success"}`;
    elUpdateFeedback.textContent = text || "";
  }

  function formatMb(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  async function readApiError(res) {
    try {
      const data = await res.json();
      return data.detail || `HTTP ${res.status}`;
    } catch (_) {
      return `HTTP ${res.status}`;
    }
  }

  function renderUpdateStatus(st) {
    if (!st) return;
    const latest = st.latest;
    if (elAppVersionText) elAppVersionText.textContent = `v${st.current_version}`;
    const elSidebarVersion = document.getElementById("sidebar-version-tag");
    if (elSidebarVersion) elSidebarVersion.textContent = `Phiên bản ${st.current_version}`;
    if (elUpdatePill) {
      elUpdatePill.textContent = st.update_available && latest ? `Có bản mới v${latest.version}` : `v${st.current_version}`;
      elUpdatePill.className = `badge-status-pill ${st.update_available ? "pill-on" : "pill-off"}`;
    }

    const downloading = st.state === "downloading";
    const ready = st.state === "ready";
    if (elUpdateDownload) elUpdateDownload.style.display = st.update_available && !downloading && !ready && st.state !== "installing" ? "inline-flex" : "none";
    if (elUpdateInstall) elUpdateInstall.style.display = ready && st.can_install ? "inline-flex" : "none";
    if (elUpdateProgress) elUpdateProgress.style.display = downloading || ready ? "block" : "none";
    if (elUpdateProgressBar) {
      const pct = st.total_bytes > 0 ? Math.min(100, (st.downloaded_bytes / st.total_bytes) * 100) : (ready ? 100 : 0);
      elUpdateProgressBar.style.width = `${pct.toFixed(0)}%`;
    }
    if (elUpdateNotes) {
      const show = st.update_available && latest;
      elUpdateNotes.style.display = show ? "block" : "none";
      if (show) {
        const date = latest.published_at ? new Date(latest.published_at).toLocaleDateString() : "";
        elUpdateNotes.textContent = `Phiên bản ${latest.version}${date ? ` (phát hành ${date})` : ""}\n\n${latest.notes || "Không có ghi chú phát hành."}`;
      }
    }

    if (st.state === "error" && st.error) {
      showUpdateFeedback(`⚠ ${st.error}`, "error");
    } else if (downloading) {
      const total = st.total_bytes ? ` / ${formatMb(st.total_bytes)}` : "";
      showUpdateFeedback(`Đang tải bộ cài: ${formatMb(st.downloaded_bytes)}${total}...`, "success");
    } else if (ready) {
      showUpdateFeedback(st.can_install
        ? "✓ Đã tải xong và kiểm tra bộ cài. Bấm \"Cài đặt & khởi động lại\" khi sẵn sàng."
        : "✓ Đã tải xong. Đang chạy từ mã nguồn nên không tự cài được: hãy cập nhật bằng git pull, hoặc cài bằng bộ cài trên GitHub.", "success");
    } else if (st.state === "installing") {
      showUpdateFeedback("Đang cài bản mới... Hệ thống sẽ tự mở lại sau khoảng 1 phút, sau đó tải lại trang này.", "success");
    } else if (st.check_error) {
      showUpdateFeedback(`⚠ ${st.check_error}`, "error");
    } else if (st.checked_at && !st.update_available) {
      showUpdateFeedback(`✓ Bạn đang dùng phiên bản mới nhất (v${st.current_version}).`, "success");
    } else {
      showUpdateFeedback("", "success");
    }

    if (downloading && !updatePollTimer) {
      updatePollTimer = setInterval(fetchUpdateStatus, 1000);
    } else if (!downloading && updatePollTimer) {
      clearInterval(updatePollTimer);
      updatePollTimer = null;
    }
  }

  async function fetchUpdateStatus() {
    try {
      const res = await apiFetch(`${API_BASE}/api/update/status`);
      if (res.ok) renderUpdateStatus(await res.json());
    } catch (_) {}
  }

  async function postUpdate(action, busyText) {
    showUpdateFeedback(busyText, "success");
    try {
      const res = await apiFetch(`${API_BASE}/api/update/${action}`, { method: "POST" });
      if (!res.ok) {
        showUpdateFeedback(`⚠ ${await readApiError(res)}`, "error");
        return null;
      }
      const st = await res.json();
      renderUpdateStatus(st);
      return st;
    } catch (e) {
      showUpdateFeedback(`⚠ Không kết nối được máy chủ: ${e.message}`, "error");
      return null;
    }
  }

  if (elUpdateCheck) elUpdateCheck.addEventListener("click", () => postUpdate("check", "Đang kiểm tra bản mới trên GitHub..."));
  if (elUpdateDownload) elUpdateDownload.addEventListener("click", () => postUpdate("download", "Bắt đầu tải bộ cài..."));
  if (elUpdateInstall) {
    elUpdateInstall.addEventListener("click", async () => {
      // Xác nhận ngay trên trang (bấm lần 2 trong 5 giây), không dùng hộp thoại của trình duyệt
      if (Date.now() > installArmedUntil) {
        installArmedUntil = Date.now() + 5000;
        showUpdateFeedback("Hệ thống sẽ TẠM DỪNG GIÁM SÁT khoảng 1 phút để cài đặt. Bấm \"Cài đặt & khởi động lại\" thêm lần nữa để xác nhận.", "error");
        return;
      }
      installArmedUntil = 0;
      const st = await postUpdate("install", "Đang khởi chạy bộ cài...");
      if (st) setTimeout(() => location.reload(), 90000);
    });
  }

  fetchUpdateStatus();

  function closeSettingsModal() {
    if (elSettingsOverlay) elSettingsOverlay.style.display = "none";
  }

  if (elBtnOpenSettings) elBtnOpenSettings.addEventListener("click", openSettingsModal);
  if (elBtnCloseSettings) elBtnCloseSettings.addEventListener("click", closeSettingsModal);
  if (elSettingsOverlay) {
    elSettingsOverlay.addEventListener("click", (e) => {
      if (e.target === elSettingsOverlay) closeSettingsModal();
    });
  }

  // 1. Khởi động cùng Windows
  async function fetchAutostartStatus() {
    try {
      const res = await apiFetch(`${API_BASE}/api/settings/autostart`);
      if (res.ok) {
        const data = await res.json();
        if (elToggleAutostart) elToggleAutostart.checked = !!data.enabled;
        updateAutostartPill(!!data.enabled);
      }
    } catch (_) {}
  }

  function updateAutostartPill(enabled) {
    if (!elAutostartPill) return;
    if (enabled) {
      elAutostartPill.textContent = "Đang BẬT";
      elAutostartPill.className = "badge-status-pill pill-on";
    } else {
      elAutostartPill.textContent = "Đang TẮT";
      elAutostartPill.className = "badge-status-pill pill-off";
    }
  }

  if (elToggleAutostart) {
    elToggleAutostart.addEventListener("change", async () => {
      const enabled = elToggleAutostart.checked;
      try {
        const res = await apiFetch(`${API_BASE}/api/settings/autostart?enable=${enabled}`, { method: "POST" });
        const data = await res.json();
        updateAutostartPill(data.enabled);
        if (elAutostartFeedback) {
          elAutostartFeedback.style.display = "block";
          elAutostartFeedback.className = "settings-feedback feedback-success";
          elAutostartFeedback.textContent = data.message || (enabled ? "Đã bật tự động chạy ngầm cùng Windows!" : "Đã tắt khởi động cùng Windows!");
          setTimeout(() => { if (elAutostartFeedback) elAutostartFeedback.style.display = "none"; }, 4000);
        }
      } catch (err) {
        if (elAutostartFeedback) {
          elAutostartFeedback.style.display = "block";
          elAutostartFeedback.className = "settings-feedback feedback-error";
          elAutostartFeedback.textContent = "Lỗi khi cập nhật cài đặt khởi động.";
        }
      }
    });
  }

  // 2. Quyền & Kiểm tra Camera
  if (elBtnCheckCamera) {
    elBtnCheckCamera.addEventListener("click", async () => {
      elBtnCheckCamera.disabled = true;
      elBtnCheckCamera.textContent = "Đang kiểm tra…";
      try {
        const res = await apiFetch(`${API_BASE}/api/settings/check-camera`, { method: "POST" });
        const data = await res.json();
        if (elCameraCheckFeedback) {
          elCameraCheckFeedback.style.display = "block";
          if (data.status) {
            elCameraCheckFeedback.className = "settings-feedback feedback-success";
            elCameraCheckFeedback.textContent = `[OK] ${data.message} (Cổng: ${data.working_devices?.join(", ") || "0"})`;
          } else {
            elCameraCheckFeedback.className = "settings-feedback feedback-error";
            elCameraCheckFeedback.textContent = `[LỖI] ${data.message}`;
          }
        }
      } catch (err) {
        if (elCameraCheckFeedback) {
          elCameraCheckFeedback.style.display = "block";
          elCameraCheckFeedback.className = "settings-feedback feedback-error";
          elCameraCheckFeedback.textContent = "Không thể kết nối API để kiểm tra thiết bị.";
        }
      } finally {
        elBtnCheckCamera.disabled = false;
        elBtnCheckCamera.textContent = "Kiểm tra thiết bị";
      }
    });
  }

  if (elBtnOpenWinCamera) {
    elBtnOpenWinCamera.addEventListener("click", async () => {
      try {
        await apiFetch(`${API_BASE}/api/settings/open-camera-settings`, { method: "POST" });
      } catch (_) {}
    });
  }

  // 3. Làm mờ khuôn mặt (Face Blur Toggle)
  if (elToggleFaceBlur) {
    elToggleFaceBlur.addEventListener("change", async () => {
      const blur = elToggleFaceBlur.checked;
      try {
        await apiFetch(`${API_BASE}/api/camera/blur?enabled=${blur}`, { method: "POST" });
        const elBlurStatus = document.getElementById("hud-blur-status");
        if (elBlurStatus) {
          elBlurStatus.textContent = blur ? "MẶT: ĐÃ LÀM MỜ" : "MẶT: RÕ NÉT (KHÔNG LÀM MỜ)";
        }
      } catch (_) {}
    });
  }

  // 4. Thông báo Telegram
  const elToggleTelegram = document.getElementById("toggle-telegram");
  const elTelegramPill = document.getElementById("telegram-status-pill");
  const elTelegramToken = document.getElementById("telegram-token-input");
  const elTelegramChat = document.getElementById("telegram-chat-input");
  const elTelegramChatSelect = document.getElementById("telegram-chat-select");
  const elBtnTelegramDetect = document.getElementById("btn-telegram-detect");
  const elBtnTelegramSave = document.getElementById("btn-telegram-save");
  const elBtnTelegramTest = document.getElementById("btn-telegram-test");
  const elTelegramFeedback = document.getElementById("telegram-feedback");

  function showTelegramFeedback(ok, message) {
    if (!elTelegramFeedback) return;
    elTelegramFeedback.style.display = "block";
    elTelegramFeedback.className = `settings-feedback ${ok ? "feedback-success" : "feedback-error"}`;
    elTelegramFeedback.textContent = `${ok ? "✓" : "⚠"} ${message}`;
  }

  function updateTelegramPill(settings) {
    if (!elTelegramPill) return;
    if (settings.ready) {
      elTelegramPill.textContent = "Đang BẬT";
      elTelegramPill.className = "badge-status-pill pill-on";
    } else {
      elTelegramPill.textContent = settings.has_token ? "Đang TẮT" : "Chưa cài đặt";
      elTelegramPill.className = "badge-status-pill pill-off";
    }
  }

  function applyTelegramSettings(settings) {
    if (elToggleTelegram) elToggleTelegram.checked = !!settings.enabled;
    if (elTelegramToken) {
      elTelegramToken.value = "";
      elTelegramToken.placeholder = settings.has_token
        ? `Đã lưu (${settings.token_masked}) — bỏ trống để giữ nguyên`
        : "123456789:AAH...";
    }
    if (elTelegramChat) elTelegramChat.value = settings.chat_id || "";
    updateTelegramPill(settings);
  }

  async function fetchTelegramSettings() {
    try {
      const res = await apiFetch(`${API_BASE}/api/settings/telegram`);
      if (res.ok) applyTelegramSettings(await res.json());
    } catch (_) {}
  }

  async function postTelegram(path, body) {
    const res = await apiFetch(`${API_BASE}/api/settings/telegram${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `Lỗi máy chủ (HTTP ${res.status})`);
    return data;
  }

  async function withBusyButton(button, busyLabel, action) {
    if (!button) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
    try {
      await action();
    } catch (err) {
      showTelegramFeedback(false, err.message || "Không thể kết nối API.");
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function telegramFormValues() {
    return {
      bot_token: elTelegramToken ? elTelegramToken.value.trim() : "",
      chat_id: elTelegramChat ? elTelegramChat.value.trim() : "",
    };
  }

  if (elBtnTelegramDetect) {
    elBtnTelegramDetect.addEventListener("click", () => withBusyButton(elBtnTelegramDetect, "Đang tìm...", async () => {
      const data = await postTelegram("/detect-chat", { bot_token: telegramFormValues().bot_token });
      if (elTelegramChatSelect) {
        elTelegramChatSelect.innerHTML = "";
        elTelegramChatSelect.style.display = data.chats.length > 1 ? "block" : "none";
        data.chats.forEach((chat) => {
          const opt = document.createElement("option");
          opt.value = chat.chat_id;
          opt.textContent = `${chat.name} (${chat.chat_id})`;
          elTelegramChatSelect.appendChild(opt);
        });
      }
      if (data.chats.length && elTelegramChat) elTelegramChat.value = data.chats[0].chat_id;
      showTelegramFeedback(data.status === "success", data.message);
    }));
  }

  if (elTelegramChatSelect) {
    elTelegramChatSelect.addEventListener("change", () => {
      if (elTelegramChat) elTelegramChat.value = elTelegramChatSelect.value;
    });
  }

  if (elBtnTelegramSave) {
    elBtnTelegramSave.addEventListener("click", () => withBusyButton(elBtnTelegramSave, "Đang lưu...", async () => {
      const enabled = elToggleTelegram ? elToggleTelegram.checked : true;
      const data = await postTelegram("", { ...telegramFormValues(), enabled });
      applyTelegramSettings(data.settings);
      showTelegramFeedback(true, data.message);
    }));
  }

  if (elBtnTelegramTest) {
    elBtnTelegramTest.addEventListener("click", () => withBusyButton(elBtnTelegramTest, "Đang gửi...", async () => {
      const data = await postTelegram("/test", telegramFormValues());
      showTelegramFeedback(true, data.message);
    }));
  }

  // 5. Tắt hệ thống an toàn
  if (elBtnModalShutdown) {
    elBtnModalShutdown.addEventListener("click", async () => {
      if (!confirm("Bạn có chắc chắn muốn TẮT hệ thống AI giám sát và dừng máy chủ không?")) return;
      elBtnModalShutdown.disabled = true;
      elBtnModalShutdown.textContent = "Đang tắt hệ thống...";
      try {
        await apiFetch(`${API_BASE}/api/system/shutdown`, { method: "POST" });
        alert("Hệ thống đã dừng an toàn! Bạn có thể đóng cửa sổ trình duyệt này.");
        window.close();
      } catch (_) {
        alert("Đã gửi lệnh tắt hệ thống.");
      }
    });
  }

  // 6. Kết nối các tương tác trên giao diện Compact mới
  const btnQuickFull = document.getElementById("btn-quick-fullscreen");
  if (btnQuickFull) {
    btnQuickFull.addEventListener("click", () => {
      if (elBtnFullscreen) elBtnFullscreen.click();
    });
  }

  // Settings mở qua activateDashboardTab("settings") ở handler sidebar chung

  const btnProcessInc = document.getElementById("btn-process-incident");
  if (btnProcessInc) {
    btnProcessInc.addEventListener("click", () => {
      const tag = document.getElementById("incident-status-tag");
      if (tag) {
        tag.textContent = "Đã xử lý";
        tag.style.background = "#ecfdf5";
        tag.style.borderColor = "#a7f3d0";
        tag.style.color = "#059669";
      }
      stopContinuousAlarm();
      clearEmergencyVisuals();
      if (elEmergencyBar) elEmergencyBar.style.display = "none";
      updateRiskKpi(0.05, "Bình thường");
    });
  }

  // Tab navigation: chỉ hiện panel của tab đang chọn
  const TAB_IDS = new Set(["overview", "live", "alerts", "foam", "workflow", "stats", "settings"]);

  function parseTabFromHref(href) {
    if (!href) return null;
    const hash = href.includes("#") ? href.split("#").pop() : href.replace(/^#/, "");
    if (hash === "workflow") return "foam"; // legacy hash
    return TAB_IDS.has(hash) ? hash : null;
  }

  function activateDashboardTab(tabName, { updateHash = true } = {}) {
    const tab = TAB_IDS.has(tabName) ? tabName : "overview";

    if (tab === "settings") {
      document.querySelectorAll(".sidebar-link").forEach((l) => {
        l.classList.toggle("active", l.id === "sidebar-btn-settings");
      });
      if (elBtnOpenSettings) elBtnOpenSettings.click();
      if (updateHash) {
        try { history.replaceState(null, "", "#settings"); } catch (_) {}
      }
      return;
    }

    document.querySelectorAll("[data-tabs]").forEach((el) => {
      const tabs = (el.getAttribute("data-tabs") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      el.classList.toggle("tab-hidden", !tabs.includes(tab));
    });

    const rightCol = document.querySelector(".grid-col-right-top");
    if (rightCol) {
      const anyChild = [...rightCol.children].some((c) => !c.classList.contains("tab-hidden"));
      rightCol.classList.toggle("tab-hidden", !anyChild);
    }

    const grid = document.querySelector(".dashboard-grid-layout");
    if (grid) {
      const visibleTop = [...grid.children].filter((c) => !c.classList.contains("tab-hidden"));
      grid.classList.toggle("tab-layout-single", visibleTop.length <= 1);
      grid.classList.toggle("tab-layout-stack", tab === "foam" || tab === "workflow" || tab === "alerts");
    }

    document.querySelectorAll(".sidebar-link").forEach((l) => {
      const linkTab = parseTabFromHref(l.getAttribute("href") || "");
      l.classList.toggle("active", linkTab === tab);
    });

    if (updateHash) {
      try { history.replaceState(null, "", `#${tab}`); } catch (_) {}
    }

    const main = document.querySelector(".dashboard-main-area");
    if (main) main.scrollTop = 0;
  }

  window.activateDashboardTab = activateDashboardTab;

  const btnViewInc = document.getElementById("btn-view-incident-detail");
  if (btnViewInc) {
    btnViewInc.addEventListener("click", () => {
      activateDashboardTab("alerts");
    });
  }

  document.querySelectorAll(".sidebar-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      if (link.id === "sidebar-btn-guide") return;
      if (link.getAttribute("href") === "/" || (link.getAttribute("href") || "").endsWith("huong-dan.html")) return;

      const tab = parseTabFromHref(link.getAttribute("href") || "");
      if (!tab) return;
      e.preventDefault();
      activateDashboardTab(tab);
    });
  });

  // Deep-link / refresh giữ đúng tab
  const initialTab = parseTabFromHref(window.location.hash) || "overview";
  activateDashboardTab(initialTab, { updateHash: false });
  window.addEventListener("hashchange", () => {
    const t = parseTabFromHref(window.location.hash) || "overview";
    activateDashboardTab(t, { updateHash: false });
  });


  // ============================================================================
  // CAMERA KHÁC (ĐA CAMERA): mỗi camera thêm có AI, theo dõi và cảnh báo riêng
  // ============================================================================
  const elExtraCamGrid = document.getElementById("extra-cam-grid");
  const elCamList = document.getElementById("cam-list");
  const elExtraCamEmpty = document.getElementById("extra-cam-empty");
  const elExtraCamCount = document.getElementById("extra-cam-count");
  const elExtraCamForm = document.getElementById("extra-cam-form");
  const elBtnExtraCamToggleForm = document.getElementById("btn-extra-cam-toggle-form");
  const elBtnExtraCamCancel = document.getElementById("btn-extra-cam-cancel");
  const elBtnExtraCamAdd = document.getElementById("btn-extra-cam-add");
  const elBtnExtraCamTest = document.getElementById("btn-extra-cam-test");
  const elExtraCamName = document.getElementById("extra-cam-name");
  const elExtraCamType = document.getElementById("extra-cam-type");
  const elExtraCamUrl = document.getElementById("extra-cam-url");
  const elExtraCamUser = document.getElementById("extra-cam-user");
  const elExtraCamPass = document.getElementById("extra-cam-pass");
  const elExtraCamDevice = document.getElementById("extra-cam-device");
  const elExtraCamRtspRow = document.getElementById("extra-cam-rtsp-row");
  const elExtraCamWebcamRow = document.getElementById("extra-cam-webcam-row");
  const elExtraCamFeedback = document.getElementById("extra-cam-feedback");

  const extraCamTiles = new Map();         // camera id -> { tile, img, offline, meta }
  const extraCamAlertUntil = new Map();    // camera id -> time until which the tile flashes red
  let extraCamFeedbackTimer = null;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
    ));
  }

  // Same scheme as buildMjpegUrl (cache-buster only)
  function buildExtraCamStreamUrl(camId) {
    const token = getSavedToken();
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
    return `${API_BASE}/api/cameras/${encodeURIComponent(camId)}/stream?t=${Date.now()}${tokenParam}`;
  }

  function showExtraCamFeedback(msg, type = "info", duration = 5000) {
    if (!elExtraCamFeedback) return;
    if (extraCamFeedbackTimer) clearTimeout(extraCamFeedbackTimer);
    elExtraCamFeedback.className = `cam-toast-feedback toast-${type}`;
    elExtraCamFeedback.innerHTML = `<span>${type === "success" ? "✅" : (type === "error" ? "❌" : "ℹ️")}</span> <span>${escapeHtml(msg)}</span>`;
    elExtraCamFeedback.style.display = "flex";
    if (duration > 0) {
      extraCamFeedbackTimer = setTimeout(() => { elExtraCamFeedback.style.display = "none"; }, duration);
    }
  }

  function createExtraCamTile(cam) {
    const tile = document.createElement("div");
    tile.className = "extra-cam-tile";
    tile.dataset.cameraId = cam.id;
    tile.innerHTML = `
      <div class="extra-cam-video">
        <img alt="Camera ${escapeHtml(cam.name)}">
        <div class="extra-cam-offline">Đang kết nối…</div>
      </div>
      <div class="extra-cam-footer">
        <span class="extra-cam-name" title="${escapeHtml(cam.name)}">${escapeHtml(cam.name)}</span>
        <span class="extra-cam-meta"></span>
        <button type="button" class="btn-extra-cam-remove" title="Xóa camera này">🗑️ Xóa</button>
      </div>
    `;
    const entry = {
      tile,
      img: tile.querySelector("img"),
      offline: tile.querySelector(".extra-cam-offline"),
      meta: tile.querySelector(".extra-cam-meta"),
    };
    // A dropped MJPEG connection is re-opened on the next poll
    entry.img.addEventListener("error", () => entry.img.removeAttribute("src"));
    tile.querySelector(".btn-extra-cam-remove").addEventListener("click", () => removeExtraCamera(cam.id, cam.name));
    return entry;
  }

  function updateExtraCamTile(entry, cam) {
    const flashing = cam.emergency || (extraCamAlertUntil.get(cam.id) || 0) > Date.now();
    entry.tile.classList.toggle("is-emergency", Boolean(flashing));

    if (cam.online) {
      entry.offline.style.display = "none";
    } else {
      const conn = cam.connection;
      let text = "Đang kết nối…";
      if (cam.enabled === false) text = "Camera đang tắt";
      else if (conn && conn.state === "reconnecting") {
        text = `Mất kết nối, đang tự kết nối lại${conn.reconnect_attempts ? ` (lần thử ${conn.reconnect_attempts})` : ""}…`;
      } else if (cam.last_frame_age_s != null) text = "Mất tín hiệu camera";
      entry.offline.textContent = text;
      entry.offline.style.display = "flex";
    }
    if (!entry.img.getAttribute("src") && cam.enabled !== false) {
      entry.img.src = buildExtraCamStreamUrl(cam.id);
    }

    const dotClass = flashing ? "alert" : (cam.online ? "on" : "");
    const label = cam.online ? `${cam.tracked_persons ?? 0} track` : "Ngoại tuyến";
    entry.meta.innerHTML = `<span class="dot ${dotClass}"></span>${escapeHtml(label)}`;
  }

  function describeCameraSource(cam) {
    if (cam.source_type === "webcam") return `Webcam ${cam.device_index ?? 0}`;
    if (cam.source_type === "video") return "Tệp video";
    if (cam.source_type === "synthetic") return "Giả lập";
    return cam.rtsp_url || "Camera IP";
  }

  function viewExtraCamera(camId) {
    const entry = extraCamTiles.get(camId);
    if (!entry) return;
    const box = entry.tile.querySelector(".extra-cam-video");
    entry.tile.scrollIntoView({ behavior: "smooth", block: "center" });
    if (box && box.requestFullscreen) box.requestFullscreen().catch(() => {});
  }

  // One row per camera: the main camera (changed in the ⋯ menu) and every added camera (view / delete)
  function renderCameraList(primary, cameras) {
    if (!elCamList) return;
    const rows = [];
    if (primary) {
      rows.push({ id: "main", name: primary.name || "Camera chính", source: describeCameraSource(primary),
                  online: primary.online, main: true });
    }
    cameras.forEach(cam => rows.push({ id: cam.id, name: cam.name, source: describeCameraSource(cam),
                                       online: cam.online, enabled: cam.enabled }));
    elCamList.innerHTML = "";
    rows.forEach(row => {
      const item = document.createElement("div");
      item.className = "cam-list-row";
      const status = row.online ? "Đang hoạt động" : (row.enabled === false ? "Đang tắt" : "Ngoại tuyến");
      item.innerHTML = `
        <span class="dot ${row.online ? "on" : ""}"></span>
        <div class="cam-list-info">
          <span class="cam-list-name">${escapeHtml(row.name)}${row.main ? ' <span class="cam-list-tag">Chính</span>' : ""}</span>
          <span class="cam-list-source" title="${escapeHtml(row.source)}">${escapeHtml(row.source)} · ${status}</span>
        </div>
        <div class="cam-list-actions"></div>`;
      const actions = item.querySelector(".cam-list-actions");
      const viewBtn = document.createElement("button");
      viewBtn.type = "button";
      viewBtn.className = "btn-cam-action";
      viewBtn.textContent = "Xem";
      viewBtn.addEventListener("click", () => {
        if (row.main) {
          document.getElementById("video-container")?.scrollIntoView({ behavior: "smooth", block: "center" });
        } else {
          viewExtraCamera(row.id);
        }
      });
      actions.appendChild(viewBtn);
      if (!row.main) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "btn-extra-cam-remove";
        delBtn.textContent = "🗑️ Xóa";
        delBtn.addEventListener("click", () => removeExtraCamera(row.id, row.name));
        actions.appendChild(delBtn);
      }
      elCamList.appendChild(item);
    });
  }

  async function fetchExtraCameras() {
    if (!elExtraCamGrid) return;
    try {
      const res = await apiFetch(`${API_BASE}/api/cameras`);
      if (!res.ok) return;
      const data = await res.json();
      const cameras = data.cameras || [];
      const maxCams = data.max_cameras || 0;

      if (elExtraCamCount) elExtraCamCount.textContent = `${cameras.length}/${maxCams}`;
      if (elBtnExtraCamToggleForm) elBtnExtraCamToggleForm.disabled = maxCams > 0 && cameras.length >= maxCams;
      if (elExtraCamEmpty) elExtraCamEmpty.style.display = cameras.length ? "none" : "block";

      const elCamsOnline = document.getElementById("stat-cameras-online");
      if (elCamsOnline) {
        const online = (data.primary && data.primary.online ? 1 : 0) + cameras.filter(c => c.online).length;
        elCamsOnline.textContent = online;
      }

      renderCameraList(data.primary, cameras);

      const seen = new Set();
      cameras.forEach(cam => {
        seen.add(cam.id);
        let entry = extraCamTiles.get(cam.id);
        if (!entry) {
          entry = createExtraCamTile(cam);
          extraCamTiles.set(cam.id, entry);
          elExtraCamGrid.appendChild(entry.tile);
        }
        updateExtraCamTile(entry, cam);
      });
      for (const [id, entry] of extraCamTiles) {
        if (!seen.has(id)) {
          entry.img.removeAttribute("src");
          entry.tile.remove();
          extraCamTiles.delete(id);
        }
      }
    } catch (e) {
      // API offline: pollStatus already shows the backend state
    }
  }

  async function removeExtraCamera(camId, camName) {
    if (!window.confirm(`Xóa camera "${camName}" khỏi danh sách giám sát?`)) return;
    try {
      const res = await apiFetch(`${API_BASE}/api/cameras/${encodeURIComponent(camId)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.detail || "Không xóa được camera.");
      }
      fetchCameraDevices();
    } finally {
      fetchExtraCameras();
    }
  }

  function readExtraCamForm() {
    const sourceType = elExtraCamType ? elExtraCamType.value : "rtsp";
    const body = { name: elExtraCamName ? elExtraCamName.value.trim() : "", source_type: sourceType };
    if (sourceType === "webcam") {
      const idx = parseInt(elExtraCamDevice ? elExtraCamDevice.value : "", 10);
      if (Number.isInteger(idx)) body.device_index = idx;
    } else {
      body.rtsp_url = elExtraCamUrl ? elExtraCamUrl.value.trim() : "";
      if (elExtraCamUser && elExtraCamUser.value.trim()) body.rtsp_username = elExtraCamUser.value.trim();
      if (elExtraCamPass && elExtraCamPass.value) body.rtsp_password = elExtraCamPass.value;
    }
    return body;
  }

  function setExtraCamFormVisible(visible) {
    if (!elExtraCamForm) return;
    elExtraCamForm.style.display = visible ? "block" : "none";
    if (!visible) {
      elExtraCamForm.reset();
      handleExtraCamTypeChange();
      if (elExtraCamFeedback) elExtraCamFeedback.style.display = "none";
    } else {
      fetchCameraDevices();
      if (elExtraCamName) elExtraCamName.focus();
    }
  }

  function handleExtraCamTypeChange() {
    const isWebcam = elExtraCamType && elExtraCamType.value === "webcam";
    if (elExtraCamRtspRow) elExtraCamRtspRow.style.display = isWebcam ? "none" : "flex";
    if (elExtraCamWebcamRow) elExtraCamWebcamRow.style.display = isWebcam ? "flex" : "none";
  }

  if (elExtraCamType) elExtraCamType.addEventListener("change", handleExtraCamTypeChange);
  if (elBtnExtraCamToggleForm) {
    elBtnExtraCamToggleForm.addEventListener("click", () => {
      setExtraCamFormVisible(elExtraCamForm && elExtraCamForm.style.display === "none");
    });
  }
  if (elBtnExtraCamCancel) elBtnExtraCamCancel.addEventListener("click", () => setExtraCamFormVisible(false));

  if (elBtnExtraCamTest) {
    elBtnExtraCamTest.addEventListener("click", async () => {
      const body = readExtraCamForm();
      if (!body.rtsp_url) {
        showExtraCamFeedback("Vui lòng nhập đường dẫn camera trước khi kiểm tra.", "error");
        return;
      }
      elBtnExtraCamTest.disabled = true;
      elBtnExtraCamTest.textContent = "⏳ Đang thử...";
      showExtraCamFeedback("Đang thử kết nối tới camera (tối đa ~10 giây với camera ở xa)...", "info", 0);
      try {
        const res = await apiFetch(`${API_BASE}/camera/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rtsp_url: body.rtsp_url, rtsp_username: body.rtsp_username, rtsp_password: body.rtsp_password }),
        });
        const data = await res.json();
        if (res.ok && data.ok) showExtraCamFeedback(`${data.message} (kết nối mất ${data.connect_ms} ms)`, "success", 6000);
        else showExtraCamFeedback([data.message || data.detail || "Không kết nối được camera.", data.hint].filter(Boolean).join(" 👉 "), "error", 15000);
      } catch (e) {
        showExtraCamFeedback("Lỗi kết nối tới Backend API: " + e.message, "error");
      } finally {
        elBtnExtraCamTest.disabled = false;
        elBtnExtraCamTest.textContent = "Kiểm tra";
      }
    });
  }

  if (elExtraCamForm) {
    elExtraCamForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const body = readExtraCamForm();
      if (body.source_type === "rtsp" && !body.rtsp_url) {
        showExtraCamFeedback("Vui lòng nhập đường dẫn camera.", "error");
        return;
      }
      if (body.source_type === "webcam" && body.device_index === undefined) {
        showExtraCamFeedback("Không còn webcam trống để thêm.", "error");
        return;
      }
      elBtnExtraCamAdd.disabled = true;
      elBtnExtraCamAdd.textContent = "⏳ ĐANG THÊM...";
      try {
        const res = await apiFetch(`${API_BASE}/api/cameras`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          setExtraCamFormVisible(false);
          fetchExtraCameras();
          fetchCameraDevices();
        } else {
          showExtraCamFeedback(data.detail || "Không thêm được camera.", "error", 8000);
        }
      } catch (e) {
        showExtraCamFeedback("Lỗi kết nối tới Backend API: " + e.message, "error");
      } finally {
        elBtnExtraCamAdd.disabled = false;
        elBtnExtraCamAdd.textContent = "THÊM CAMERA";
      }
    });
  }

  // Alert from an extra camera: flash that camera's tile for 10 s
  function flashExtraCameraTile(camId) {
    extraCamAlertUntil.set(camId, Date.now() + 10000);
    const entry = extraCamTiles.get(camId);
    if (entry) {
      entry.tile.classList.add("is-emergency");
      entry.tile.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    setTimeout(fetchExtraCameras, 10050);
  }

  // ========================================================================
  // 10. Authentication Flow & Dashboard Initialization
  // ========================================================================
  async function fetchCameraVideos() {
    const sel = elVideoPresetSelect;
    const hint = document.getElementById("video-list-hint");
    if (!sel) return;
    try {
      const res = await apiFetch(`${API_BASE}/api/camera/videos`);
      const data = await res.json().catch(() => ({}));
      const videos = (data && data.videos) || [];
      const prev = sel.value;
      sel.innerHTML = "";
      if (!videos.length) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "(Chưa có video)";
        sel.appendChild(opt);
        const custom = document.createElement("option");
        custom.value = "custom";
        custom.textContent = "Nhập đường dẫn tùy chỉnh…";
        sel.appendChild(custom);
        if (hint) hint.textContent = "Thêm file MP4 vào thư mục video của hệ thống, rồi bấm Tải lại.";
      } else {
        videos.forEach((v) => {
          const opt = document.createElement("option");
          opt.value = v.path;
          opt.textContent = `${v.name} (${v.size_mb} MB)`;
          sel.appendChild(opt);
        });
        const custom = document.createElement("option");
        custom.value = "custom";
        custom.textContent = "Nhập đường dẫn tùy chỉnh…";
        sel.appendChild(custom);
        if (hint) hint.textContent = `${videos.length} video sẵn sàng`;
      }
      if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
      if (elGroupVideoCustomRow) {
        elGroupVideoCustomRow.style.display = sel.value === "custom" ? "block" : "none";
      }
    } catch (e) {
      sel.innerHTML = '<option value="custom">Nhập đường dẫn tùy chỉnh…</option>';
      if (hint) hint.textContent = "Không tải được danh sách video — dùng đường dẫn tùy chỉnh.";
    }
  }

  function bindFoamMonitor() {
    const elEnabled = document.getElementById("foam-monitor-enabled");
    const elLog = document.getElementById("foam-log-event");
    const elReset = document.getElementById("btn-foam-reset-session");

    async function pushMonitor(body) {
      try {
        const res = await apiFetch(`${API_BASE}/api/vision/foam/monitor`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) applyFoamSnapshot(data);
      } catch (_) {}
    }

    if (elEnabled) {
      elEnabled.addEventListener("change", () => pushMonitor({ enabled: elEnabled.checked }));
    }
    if (elLog) {
      elLog.addEventListener("change", () => pushMonitor({ log_event: elLog.checked }));
    }
    if (elReset) {
      elReset.addEventListener("click", () => pushMonitor({ reset_session: true }));
    }

    // Bộ lọc Công đoạn trên thanh Header (nếu có)
    document.querySelectorAll("[data-stage-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const filter = btn.getAttribute("data-stage-filter") || "all";
        document.querySelectorAll("[data-stage-filter]").forEach((b) => b.classList.toggle("active", b === btn));
        document.querySelectorAll("[data-stage-panel]").forEach((panel) => {
          const stage = panel.getAttribute("data-stage-panel");
          panel.style.display = filter === "all" || filter === stage ? "" : "none";
        });
      });
    });

    // Interactive Water ROI Rectangle Drawing (used as water_mask for foam-only video streaming)
    const elRoiCanvas = document.getElementById("roi-draw-canvas");
    const elRoiNotice = document.getElementById("roi-unselected-notice");
    const elBtnClearRoi = document.getElementById("btn-clear-roi");
    const elRoiTag = document.getElementById("roi-assumption-tag");
    let currentWaterRoi = null; // [nx1, ny1, nx2, ny2] or null
    let isDrawingRoi = false;
    let roiStartPx = null;
    let roiDragPx = null;

    function getContainedVideoRect() {
      if (!elRoiCanvas) return { x: 0, y: 0, w: 1, h: 1 };
      const cw = elRoiCanvas.clientWidth || 1;
      const ch = elRoiCanvas.clientHeight || 1;
      const nw = (elVideoStream && elVideoStream.naturalWidth) ? elVideoStream.naturalWidth : 1280;
      const nh = (elVideoStream && elVideoStream.naturalHeight) ? elVideoStream.naturalHeight : 720;
      const scale = Math.min(cw / nw, ch / nh);
      const w = nw * scale;
      const h = nh * scale;
      return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
    }

    function drawRoiCanvas() {
      if (!elRoiCanvas) return;
      const cw = elRoiCanvas.clientWidth || 0;
      const ch = elRoiCanvas.clientHeight || 0;
      if (cw <= 0 || ch <= 0) return;
      if (elRoiCanvas.width !== cw || elRoiCanvas.height !== ch) {
        elRoiCanvas.width = cw;
        elRoiCanvas.height = ch;
      }
      const ctx = elRoiCanvas.getContext("2d");
      ctx.clearRect(0, 0, cw, ch);

      const box = getContainedVideoRect();
      if (isDrawingRoi && roiStartPx && roiDragPx) {
        const rx = Math.min(roiStartPx.x, roiDragPx.x);
        const ry = Math.min(roiStartPx.y, roiDragPx.y);
        const rw = Math.abs(roiDragPx.x - roiStartPx.x);
        const rh = Math.abs(roiDragPx.y - roiStartPx.y);
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.fillStyle = "rgba(56, 189, 248, 0.16)";
        ctx.fillRect(rx, ry, rw, rh);
      } else if (currentWaterRoi && currentWaterRoi.length === 4) {
        const [nx1, ny1, nx2, ny2] = currentWaterRoi;
        const rx = box.x + nx1 * box.w;
        const ry = box.y + ny1 * box.h;
        const rw = (nx2 - nx1) * box.w;
        const rh = (ny2 - ny1) * box.h;
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.strokeRect(rx, ry, rw, rh);
      }
    }

    function syncWaterRoiUi(roiNorm, streamRunning) {
      currentWaterRoi = Array.isArray(roiNorm) && roiNorm.length === 4 ? roiNorm : null;
      if (elRoiNotice) {
        elRoiNotice.style.display = streamRunning && !currentWaterRoi ? "block" : "none";
      }
      if (elBtnClearRoi) {
        elBtnClearRoi.style.display = currentWaterRoi ? "inline-flex" : "none";
      }
      if (elRoiTag) {
        elRoiTag.textContent = currentWaterRoi ? "Vùng nước đã chọn (Foam Only)" : "Chưa chọn vùng nước";
      }
      if (elRoiCanvas) {
        elRoiCanvas.style.pointerEvents = streamRunning ? "auto" : "none";
      }
      drawRoiCanvas();
    }

    async function pushWaterRoiToServer(roiNorm) {
      try {
        const res = await apiFetch(`${API_BASE}/api/vision/roi`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roi: roiNorm }),
        });
        const data = await res.json();
        syncWaterRoiUi(data.roi || null, true);
        pollStatus();
      } catch (err) {
        console.error("Failed to save ROI:", err);
      }
    }

    if (elRoiCanvas) {
      elRoiCanvas.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        const rect = elRoiCanvas.getBoundingClientRect();
        isDrawingRoi = true;
        roiStartPx = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        roiDragPx = { ...roiStartPx };
        elRoiCanvas.setPointerCapture(e.pointerId);
        drawRoiCanvas();
      });

      elRoiCanvas.addEventListener("pointermove", (e) => {
        if (!isDrawingRoi) return;
        const rect = elRoiCanvas.getBoundingClientRect();
        roiDragPx = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        drawRoiCanvas();
      });

      elRoiCanvas.addEventListener("pointerup", (e) => {
        if (!isDrawingRoi) return;
        isDrawingRoi = false;
        const rect = elRoiCanvas.getBoundingClientRect();
        roiDragPx = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const box = getContainedVideoRect();
        const x1 = Math.max(0, Math.min(1, (Math.min(roiStartPx.x, roiDragPx.x) - box.x) / box.w));
        const y1 = Math.max(0, Math.min(1, (Math.min(roiStartPx.y, roiDragPx.y) - box.y) / box.h));
        const x2 = Math.max(0, Math.min(1, (Math.max(roiStartPx.x, roiDragPx.x) - box.x) / box.w));
        const y2 = Math.max(0, Math.min(1, (Math.max(roiStartPx.y, roiDragPx.y) - box.y) / box.h));
        if ((x2 - x1) >= 0.03 && (y2 - y1) >= 0.03) {
          pushWaterRoiToServer([
            Number(x1.toFixed(4)),
            Number(y1.toFixed(4)),
            Number(x2.toFixed(4)),
            Number(y2.toFixed(4)),
          ]);
        } else {
          drawRoiCanvas();
        }
      });

      window.addEventListener("resize", drawRoiCanvas);
    }

    if (elBtnClearRoi) {
      elBtnClearRoi.addEventListener("click", (e) => {
        e.stopPropagation();
        pushWaterRoiToServer(null);
      });
    }

    // Công tắc 3 chế độ xem hình mặt bể: Hình thực tế | Lớp đo bọt & rác | So sánh đôi
    const elViewportStage = document.getElementById("viewport-stage");
    document.querySelectorAll("[data-view-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-view-mode") || "live";
        document.querySelectorAll("[data-view-mode]").forEach((b) => b.classList.toggle("active", b === btn));
        if (elViewportStage) {
          elViewportStage.classList.remove("mode-live", "mode-mask", "mode-split");
          elViewportStage.classList.add(`mode-${mode}`);
          setTimeout(drawRoiCanvas, 60);
        }
      });
    });

    // Chọn vị trí bể gắn camera (đồng bộ cả thanh P&ID Process Strip lẫn thẻ <select>)
    const elBasinSelect = document.getElementById("basin-stage-select");
    const elOverlayBasinChip = document.getElementById("overlay-basin-chip");
    const elCameraRoomName = document.getElementById("camera-room-name");

    function syncBasinSelection(val) {
      if (elBasinSelect && elBasinSelect.value !== val) {
        elBasinSelect.value = val;
      }
      if (elOverlayBasinChip) elOverlayBasinChip.textContent = val;
      if (elCameraRoomName) elCameraRoomName.textContent = val;
      document.querySelectorAll(".pid-node[data-basin-val]").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-basin-val") === val);
      });
    }

    if (elBasinSelect) {
      elBasinSelect.addEventListener("change", () => syncBasinSelection(elBasinSelect.value));
    }
    document.querySelectorAll("[data-basin-val]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = btn.getAttribute("data-basin-val");
        if (val) {
          syncBasinSelection(val);
          // Chuyển về tab Trực mặt bể để người dùng thấy camera bể vừa chọn
          const overviewTabBtn = document.querySelector('[data-app-tab="overview"]');
          if (overviewTabBtn) overviewTabBtn.click();
        }
      });
    });

    // Hệ thống chuyển Tab trên thanh Header sáng (Trực mặt bể | Hóa lý | Sinh học | Thử nghiệm File & Nhật ký)
    document.querySelectorAll("[data-app-tab]").forEach((tabBtn) => {
      tabBtn.addEventListener("click", () => {
        const targetTab = tabBtn.getAttribute("data-app-tab") || "overview";
        document.querySelectorAll("[data-app-tab]").forEach((b) => b.classList.toggle("active", b === tabBtn));
        document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
          panel.classList.toggle("active", panel.getAttribute("data-tab-panel") === targetTab);
        });
      });
    });

    // Nút cộng/trừ (− / +) trên Form Stepper tốc độ máy khuấy (RPM)
    document.querySelectorAll("[data-step-target]").forEach((stepBtn) => {
      stepBtn.addEventListener("click", () => {
        const targetId = stepBtn.getAttribute("data-step-target");
        const delta = parseFloat(stepBtn.getAttribute("data-step-delta") || "0");
        const inputEl = targetId ? document.getElementById(targetId) : null;
        if (!inputEl) return;
        const cur = parseFloat(inputEl.value) || 0;
        const min = inputEl.min !== "" ? parseFloat(inputEl.min) : 0;
        const max = inputEl.max !== "" ? parseFloat(inputEl.max) : 999;
        inputEl.value = String(Math.max(min, Math.min(max, cur + delta)));
        inputEl.dispatchEvent(new Event("change"));
      });
    });

    // Chuyển đổi song ngữ Tiếng Việt / Tiếng Anh (VI | EN) đồng bộ với localStorage
    const savedLang = (() => {
      try { return localStorage.getItem("iris_lang") || "vi"; } catch (_) { return "vi"; }
    })();
    document.documentElement.setAttribute("data-lang", savedLang);

    const elBtnLangToggle = document.getElementById("btn-lang-toggle");
    if (elBtnLangToggle) {
      elBtnLangToggle.addEventListener("click", () => {
        const nextLang = currentLang() === "en" ? "vi" : "en";
        document.documentElement.setAttribute("data-lang", nextLang);
        try { localStorage.setItem("iris_lang", nextLang); } catch (_) {}
        pollStatus();
      });
    }

    // Khi người dùng thay đổi thông số PLC/SCADA (RPM, DO, pH, UV) -> cập nhật ngay kịch bản
    ["input-mixer-rpm", "input-bio-do", "input-bio-ph", "select-uv-lamp"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("change", () => pollStatus());
      }
    });

    // Bàn thử nghiệm 4 Tasks: Upload ảnh hoặc video mặt bể để phân tích trực tiếp
    const elLabFileInput = document.getElementById("lab-file-input");
    const elBtnLabRun = document.getElementById("btn-lab-run-upload");
    const elBtnLabSample = document.getElementById("btn-lab-test-sample");
    const elLabFeedback = document.getElementById("lab-upload-feedback");
    const elLabPreviewCard = document.getElementById("lab-inline-preview-card");
    const elLabPreviewImg = document.getElementById("lab-inline-preview-img");
    const elLabPreviewTitle = document.getElementById("lab-inline-preview-title");
    const elLabPreviewSummary = document.getElementById("lab-inline-preview-summary");
    const elBtnLabJumpOverview = document.getElementById("btn-lab-jump-overview");

    if (elBtnLabJumpOverview) {
      elBtnLabJumpOverview.addEventListener("click", () => {
        const overviewTabBtn = document.querySelector('[data-app-tab="overview"]');
        if (overviewTabBtn) overviewTabBtn.click();
        const maskBtn = document.getElementById("btn-view-mask");
        if (maskBtn) maskBtn.click();
      });
    }

    function showLabFeedback(msg, isError = false) {
      if (!elLabFeedback) return;
      elLabFeedback.style.display = "block";
      elLabFeedback.className = `settings-feedback ${isError ? "feedback-error" : "feedback-success"}`;
      elLabFeedback.textContent = msg;
    }

    function setBtnLabel(btn, viText, enText) {
      if (!btn) return;
      btn.innerHTML = `<span class="vi">${viText}</span><span class="en">${enText}</span>`;
    }

    // Tab Xử lý ảnh tĩnh (Still Image Segmentation)
    const elStillInput = document.getElementById("still-file-input");
    const elBtnStillRun = document.getElementById("btn-still-run");
    const elStillLogEvent = document.getElementById("still-log-event");
    const elStillFeedback = document.getElementById("still-feedback");
    const elStillOrigImg = document.getElementById("still-orig-img");
    const elStillOrigPh = document.getElementById("still-orig-placeholder");
    const elStillResImg = document.getElementById("still-result-img");
    const elStillResPh = document.getElementById("still-result-placeholder");

    function showStillFeedback(msg, isError = false) {
      if (!elStillFeedback) return;
      elStillFeedback.style.display = "block";
      elStillFeedback.className = `settings-feedback ${isError ? "feedback-error" : "feedback-success"}`;
      elStillFeedback.textContent = msg;
    }

    if (elStillInput) {
      elStillInput.addEventListener("change", () => {
        const file = elStillInput.files && elStillInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          if (elStillOrigImg && ev.target?.result) {
            elStillOrigImg.src = ev.target.result;
            elStillOrigImg.style.display = "block";
            if (elStillOrigPh) elStillOrigPh.style.display = "none";
          }
          if (elStillResImg) {
            elStillResImg.style.display = "none";
            elStillResImg.removeAttribute("src");
          }
          if (elStillResPh) elStillResPh.style.display = "block";
        };
        reader.readAsDataURL(file);
      });
    }

    if (elBtnStillRun && elStillInput) {
      elBtnStillRun.addEventListener("click", async () => {
        const file = elStillInput.files && elStillInput.files[0];
        if (!file) {
          showStillFeedback("Vui lòng chọn 1 tấm ảnh tĩnh trước khi phân tích.", true);
          return;
        }
        const formData = new FormData();
        formData.append("file", file);
        formData.append("log_event", elStillLogEvent && elStillLogEvent.checked ? "true" : "false");

        elBtnStillRun.disabled = true;
        setBtnLabel(elBtnStillRun, "Đang phân tích…", "Analyzing…");
        showStillFeedback(`Đang phân tích ảnh "${file.name}" trên CPU…`, false);

        try {
          const res = await apiFetch(`${API_BASE}/api/vision/foam/image`, {
            method: "POST",
            body: formData,
          });
          const data = await res.json();
          if (!res.ok || data.error) {
            showStillFeedback(data.detail || data.error || "Không phân tích được ảnh này.", true);
            return;
          }

          if (elStillResImg && data.preview_data_url) {
            elStillResImg.src = data.preview_data_url;
            elStillResImg.style.display = "block";
            if (elStillResPh) elStillResPh.style.display = "none";
          }

          const elCov = document.getElementById("still-val-coverage");
          const elLvl = document.getElementById("still-val-level");
          const elPx = document.getElementById("still-val-pixels");
          const elLat = document.getElementById("still-val-latency");
          const elWat = document.getElementById("still-val-water");
          const elCla = document.getElementById("still-val-clarity");
          const elDeb = document.getElementById("still-val-debris");
          const elScn = document.getElementById("still-val-scenario");

          if (elCov) elCov.textContent = `${data.coverage_pct ?? "—"}%`;
          if (elLvl) elLvl.textContent = `Mức: ${foamLevelLabel(data.level)}`;
          if (elPx) elPx.textContent = `${data.foam_pixels ?? 0} / ${data.roi_pixels ?? 0} px`;
          if (elLat) elLat.textContent = `Thời gian: ${data.latency_ms ?? "—"} ms`;
          if (elWat) elWat.textContent = data.water?.pigment_label || "—";
          if (elCla) elCla.textContent = `Độ trong: ${data.water?.clarity_score ?? "—"}%`;
          if (elDeb) elDeb.textContent = `${data.debris?.count ?? 0} vật thể · Váng dầu ${data.debris?.oil_sheen_pct ?? 0}%`;
          if (elScn) elScn.textContent = (data.scenarios && data.scenarios[0]?.title) || "—";

          showStillFeedback(
            `Hoàn tất "${file.name}": Bọt ${data.coverage_pct}% (${foamLevelLabel(data.level)}), thời gian ${data.latency_ms} ms.`,
            false
          );
        } catch (err) {
          showStillFeedback(`Lỗi kết nối máy chủ: ${err?.message || err}`, true);
        } finally {
          elBtnStillRun.disabled = false;
          setBtnLabel(elBtnStillRun, "Phân tích ảnh tĩnh", "Analyze Image");
        }
      });
    }

    if (elBtnLabRun && elLabFileInput) {
      elBtnLabRun.addEventListener("click", async () => {
        const file = elLabFileInput.files && elLabFileInput.files[0];
        if (!file) {
          showLabFeedback("Vui lòng chọn 1 tấm ảnh hoặc video mặt bể trước khi bấm phân tích.", true);
          return;
        }
        const isVideo = file.type.startsWith("video/") || /\.(mp4|avi|mov|mkv|webm)$/i.test(file.name);
        const endpoint = isVideo ? "/api/vision/foam/video" : "/api/vision/foam/image";
        const formData = new FormData();
        formData.append("file", file);
        formData.append("log_event", "true");

        elBtnLabRun.disabled = true;
        setBtnLabel(elBtnLabRun, "Đang phân tích…", "Analyzing…");
        showLabFeedback(`Đang kiểm tra tệp "${file.name}"…`, false);
        try {
          const res = await apiFetch(`${API_BASE}${endpoint}`, {
            method: "POST",
            body: formData,
          });
          const data = await res.json();
          if (!res.ok || data.error) {
            showLabFeedback(data.detail || data.error || "Không phân tích được tệp này.", true);
            return;
          }
          if (!isVideo) {
            applyFoamSnapshot({
              enabled: true,
              log_event: true,
              session_max_pct: data.coverage_pct,
              last: data,
            });
            const summaryMsg = `Tệp "${file.name}": Tỷ lệ bọt ${data.coverage_pct}%, màu nước "${data.water?.pigment_label || "—"}", độ trong ${data.water?.clarity_score ?? "—"}%.`;
            showLabFeedback(summaryMsg, false);
            if (elLabPreviewCard && elLabPreviewImg) {
              if (data.preview_data_url) {
                elLabPreviewImg.src = data.preview_data_url;
              } else if (data.overlay_path) {
                elLabPreviewImg.src = `${API_BASE}/api/vision/foam/overlay?path=${encodeURIComponent(data.overlay_path)}&t=${Date.now()}`;
              }
              if (elLabPreviewTitle) elLabPreviewTitle.textContent = `Kết quả: ${file.name}`;
              if (elLabPreviewSummary) elLabPreviewSummary.textContent = summaryMsg;
              elLabPreviewCard.classList.add("show");
            }
          } else {
            const sum = data.summary || {};
            if (data.preview_data_url) {
              const elPreview = document.getElementById("foam-preview-img");
              const elSegHint = document.getElementById("seg-empty-hint");
              if (elPreview) elPreview.src = data.preview_data_url;
              if (elSegHint) elSegHint.style.display = "none";
              if (elLabPreviewCard && elLabPreviewImg) {
                elLabPreviewImg.src = data.preview_data_url;
                if (elLabPreviewTitle) elLabPreviewTitle.textContent = `Kết quả video: ${file.name}`;
                if (elLabPreviewSummary) {
                  elLabPreviewSummary.textContent = `Tỷ lệ bọt trung bình ${sum.avg_coverage_pct ?? "—"}%, cao nhất ${sum.max_coverage_pct ?? "—"}% · ${foamLevelLabel(sum.level)}.`;
                }
                elLabPreviewCard.classList.add("show");
              }
            }
            showLabFeedback(
              `Video "${file.name}": Tỷ lệ bọt trung bình ${sum.avg_coverage_pct ?? "—"}%, cao nhất ${sum.max_coverage_pct ?? "—"}% · ${foamLevelLabel(sum.level)}.`,
              false
            );
          }
        } catch (err) {
          showLabFeedback("Lỗi kết nối máy chủ: " + err.message, true);
        } finally {
          elBtnLabRun.disabled = false;
          setBtnLabel(elBtnLabRun, "Phân tích tệp này", "Analyze This File");
        }
      });
    }

    if (elBtnLabSample) {
      elBtnLabSample.addEventListener("click", async () => {
        elBtnLabSample.disabled = true;
        setBtnLabel(elBtnLabSample, "Đang mở video mẫu…", "Loading sample…");
        try {
          const res = await apiFetch(`${API_BASE}/camera/switch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              source_type: "video",
              video_path: "data/videos/Video Project 2.mp4",
              save_as_default: false,
            }),
          });
          const data = await res.json();
          if (res.ok) {
            isCameraRunning = true;
            if (elOfflineOverlay) elOfflineOverlay.style.display = "none";
            if (elVideoStream) elVideoStream.src = buildMjpegUrl();
            if (elCamActiveNameTxt) elCamActiveNameTxt.textContent = "Video bể mẫu";
            showLabFeedback("Đang phát video bể nước thải mẫu. Các chỉ số đang cập nhật tự động.", false);
            setTimeout(pollStatus, 700);
          } else {
            showLabFeedback(data.detail || "Không mở được video mẫu.", true);
          }
        } catch (err) {
          showLabFeedback("Lỗi khi mở video mẫu: " + err.message, true);
        } finally {
          elBtnLabSample.disabled = false;
          setBtnLabel(elBtnLabSample, "Chạy video bể mẫu", "Run Sample Video");
        }
      });
    }
  }

  function initDashboard() {
    if (isDashboardInitialized) return;
    isDashboardInitialized = true;

    // Attach stream feed with auth token
    if (elVideoStream && (!elVideoStream.src || elVideoStream.src === window.location.href)) {
      elVideoStream.src = buildMjpegUrl();
    }

    connectAlertsWebSocket();
    fetchHistoricalEvents();
    fetchCameraDevices();
    fetchCameraInfo();
    pollStatus();
    pollHealth();
    fetchAutostartStatus();
    bindFoamMonitor();
    fetchCameraVideos();

    // Polling intervals
    setInterval(pollStatus, 1500);
    setInterval(pollHealth, 4000);
    fetchExtraCameras();
    setInterval(fetchExtraCameras, 3000);

    console.log("[Dashboard] Initialized successfully. Connected to API:", API_BASE);
  }

  // status: /api/auth/status payload. The first admin can only be created on the machine
  // running the system (or with `python -m src.auth.cli create-admin` on a server).
  function showAuthModal(status) {
    if (!elAuthModalBackdrop) return;
    const setupPendingElsewhere = Boolean(status && status.setup_required && !status.setup_allowed_here);
    isSetupMode = Boolean(status && status.setup_allowed_here);

    if (isSetupMode) {
      if (elAuthModalTitle) elAuthModalTitle.textContent = "Thiết Lập Bảo Vệ (Lần Đầu)";
      if (elAuthModalSubtitle) {
        elAuthModalSubtitle.textContent =
          "Tạo tài khoản quản trị một lần duy nhất (mật khẩu tối thiểu 8 ký tự) để các thiết bị khác trong mạng có thể đăng nhập xem camera.";
      }
      if (elAuthSubmitTxt) elAuthSubmitTxt.textContent = "Tạo Tài Khoản & Ghi Nhớ Thiết Bị";
    } else {
      if (elAuthModalTitle) elAuthModalTitle.textContent = "Xác Thực Bảo Mật Mạng Nội Bộ";
      if (elAuthModalSubtitle) {
        elAuthModalSubtitle.textContent =
          "Thiết bị đang kết nối từ mạng nội bộ nhà máy. Đăng nhập để xem camera bể và nhận cảnh báo vận hành. Tài khoản được ghi nhớ trên máy này.";
      }
      if (elAuthSubmitTxt) elAuthSubmitTxt.textContent = "Đăng Nhập & Ghi Nhớ Thiết Bị";
    }

    if (elAuthError) {
      elAuthError.style.display = "none";
      elAuthError.textContent = "";
      if (setupPendingElsewhere) {
        elAuthError.textContent = "Chưa có tài khoản quản trị. Hãy tạo tài khoản trên chính máy tính chạy hệ thống (mở http://localhost:8000 trên máy đó), rồi đăng nhập tại đây.";
        elAuthError.style.display = "block";
      }
    }
    elAuthModalBackdrop.style.display = "flex";
    if (elAuthUsername) elAuthUsername.focus();
  }

  function handleAuthRequired() {
    fetch(`${API_BASE}/api/auth/status`)
      .then((r) => r.json())
      .then((data) => {
        if (!data.can_access_without_login) {
          showAuthModal(data);
        }
      })
      .catch(() => {});
  }

  if (elAuthForm) {
    elAuthForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = elAuthUsername ? elAuthUsername.value.trim() : "";
      const password = elAuthPassword ? elAuthPassword.value.trim() : "";

      if (!username || !password) {
        if (elAuthError) {
          elAuthError.textContent = "Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu.";
          elAuthError.style.display = "block";
        }
        return;
      }

      if (elBtnAuthSubmit) elBtnAuthSubmit.disabled = true;
      if (elAuthSubmitTxt) elAuthSubmitTxt.textContent = "Đang xử lý...";
      if (elAuthError) elAuthError.style.display = "none";

      const endpoint = isSetupMode ? "/api/auth/setup" : "/api/auth/login";
      try {
        const res = await fetch(`${API_BASE}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const json = await res.json();
        if (res.ok && json.access_token) {
          saveAuthToken(json.access_token);
          saveRefreshToken(json.refresh_token);
          if (elAuthModalBackdrop) elAuthModalBackdrop.style.display = "none";
          // Reload camera stream and initialize dashboard
          if (elVideoStream) elVideoStream.src = buildMjpegUrl();
          initDashboard();
        } else {
          if (elAuthError) {
            elAuthError.textContent = json.detail || "Đăng nhập không thành công. Vui lòng kiểm tra lại.";
            elAuthError.style.display = "block";
          }
        }
      } catch (err) {
        if (elAuthError) {
          elAuthError.textContent = "Lỗi kết nối đến máy chủ: " + err.message;
          elAuthError.style.display = "block";
        }
      } finally {
        if (elBtnAuthSubmit) elBtnAuthSubmit.disabled = false;
        if (elAuthSubmitTxt) {
          elAuthSubmitTxt.textContent = isSetupMode
            ? "Tạo Tài Khoản & Ghi Nhớ Thiết Bị"
            : "Đăng Nhập & Ghi Nhớ Thiết Bị";
        }
      }
    });
  }

  // Start sequence with auth check:
  // - Localhost (127.0.0.1): zero friction, opens and runs immediately!
  // - LAN/Wi-Fi: checks the saved token (renewed with the refresh token); if not present, shows modal.
  async function checkAuthAndInit() {
    try {
      const res = await fetch(`${API_BASE}/api/auth/status`);
      const data = await res.json();

      if (data.can_access_without_login) {
        if (elAuthModalBackdrop) elAuthModalBackdrop.style.display = "none";
        initDashboard();
        return;
      }

      const token = getSavedToken();
      if (token || getRefreshToken()) {
        let verifyRes = await fetch(`${API_BASE}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (verifyRes.status === 401 && await refreshAccessToken()) {
          verifyRes = await fetch(`${API_BASE}/api/auth/me`, {
            headers: { Authorization: `Bearer ${getSavedToken()}` },
          });
        }
        if (verifyRes.ok) {
          if (elAuthModalBackdrop) elAuthModalBackdrop.style.display = "none";
          initDashboard();
          return;
        } else {
          clearAuthToken();
        }
      }

      showAuthModal(data);
    } catch (e) {
      console.warn("[Dashboard] Auth check error, initializing anyway:", e);
      initDashboard();
    }
  }

  checkAuthAndInit();
})();
