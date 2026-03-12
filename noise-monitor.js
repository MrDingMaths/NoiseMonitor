(function () {
    'use strict';

    // --- Constants ---
    const CONTAINER_ID = 'noise-monitor';
    const STORAGE_KEY = 'noise-monitor_settings';

    const FFT_SIZE = 256;
    const SMOOTHING = 0.4;

    const SENSITIVITY_MIN_MULT = 0.5;
    const SENSITIVITY_RANGE = 25;
    const DEFAULT_SENSITIVITY = 50;
    const DEFAULT_THRESHOLD = 70;

    const TICK_INTERVAL = 250;          // ms between ticks (4Hz)
    const ROLLING_WINDOW = 10;          // ticks to average (10 × 250ms = 2.5s)
    const ALARM_COOLDOWN_TICKS = 6;     // ~3 seconds at 2Hz
    const EMOJI_MAX_SCALE = 0.5;
    const WARNING_ZONE_RATIO = 0.7;

    // --- Container ---
    const CONTAINER = document.getElementById(CONTAINER_ID);
    if (!CONTAINER) return;

    // --- State ---
    const STATE = {
        isMonitoring: false,
        isPaused: false,
        sensitivity: DEFAULT_SENSITIVITY,
        threshold: DEFAULT_THRESHOLD,
        audioCtx: null,
        analyser: null,
        source: null,
        stream: null,
        intervalId: null,
        alarmCooldown: 0,
        dataArray: null,
        rawSamples: [],   // ring buffer of last ROLLING_WINDOW instantaneous readings
        graphData: [],    // all averaged samples since session start
        overLimitMs: 0,
        totalMs: 0,
        lastTimestamp: 0,
        streakMs: 0,
        bestStreakMs: 0,
        alarmActive: false,
        alarmTicks: 0
    };

    // --- DOM Elements ---
    const els = {
        views: {
            start: CONTAINER.querySelector('#vnl-view-start'),
            monitor: CONTAINER.querySelector('#vnl-view-monitor')
        },
        controls: {
            activate: CONTAINER.querySelector('#vnl-btn-activate'),
            stop: CONTAINER.querySelector('#vnl-btn-stop'),
            pause: CONTAINER.querySelector('#vnl-btn-pause'),
            reset: CONTAINER.querySelector('#vnl-btn-reset'),
            fullscreen: CONTAINER.querySelector('#vnl-btn-fullscreen'),
            sensitivity: CONTAINER.querySelector('#vnl-in-sensitivity'),
            threshold: CONTAINER.querySelector('#vnl-in-threshold')
        },
        visuals: {
            fill: CONTAINER.querySelector('#vnl-meter-fill'),
            limitLine: CONTAINER.querySelector('#vnl-limit-line'),
            emoji: CONTAINER.querySelector('#vnl-emoji-display'),
            stage: CONTAINER.querySelector('.vnl-stage'),
            alarm: CONTAINER.querySelector('#vnl-alarm-overlay'),
            graph: CONTAINER.querySelector('#vnl-graph'),
            overLimitDisplay: CONTAINER.querySelector('#vnl-over-limit'),
            overLimitValue: CONTAINER.querySelector('#vnl-over-limit-value'),
            toast: CONTAINER.querySelector('#vnl-toast'),
            countdown: CONTAINER.querySelector('#vnl-alarm-countdown'),
            scoreDisplay: CONTAINER.querySelector('#vnl-score-display'),
            scoreValue: CONTAINER.querySelector('#vnl-score-value'),
            streakDisplay: CONTAINER.querySelector('#vnl-streak-display'),
            streakValue: CONTAINER.querySelector('#vnl-streak-value'),
            bestStreak: CONTAINER.querySelector('#vnl-best-streak')
        }
    };

    // --- LocalStorage ---
    function loadSettings() {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const data = JSON.parse(saved);
            STATE.sensitivity = parseInt(data.sens) || DEFAULT_SENSITIVITY;
            STATE.threshold = parseInt(data.thresh) || DEFAULT_THRESHOLD;
            STATE.bestStreakMs = parseInt(data.bestStreakMs) || 0;
            els.controls.sensitivity.value = STATE.sensitivity;
            els.controls.threshold.value = STATE.threshold;
            updateThresholdUI();
        }
    }

    function saveSettings() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            sens: els.controls.sensitivity.value,
            thresh: els.controls.threshold.value,
            bestStreakMs: STATE.bestStreakMs
        }));
    }

    function saveRecords() {
        var saved = localStorage.getItem(STORAGE_KEY);
        var data = saved ? JSON.parse(saved) : {};
        data.bestStreakMs = STATE.bestStreakMs;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }

    // --- Audio ---
    async function startAudio() {
        try {
            STATE.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                },
                video: false
            });

            STATE.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            await STATE.audioCtx.resume();
            STATE.analyser = STATE.audioCtx.createAnalyser();
            STATE.analyser.fftSize = FFT_SIZE;
            STATE.analyser.smoothingTimeConstant = SMOOTHING;

            STATE.source = STATE.audioCtx.createMediaStreamSource(STATE.stream);
            STATE.source.connect(STATE.analyser);

            STATE.stream.getAudioTracks()[0].addEventListener('ended', function () {
                stopAudio();
                alert('Microphone disconnected. Monitoring stopped.');
            });

            STATE.dataArray = new Float32Array(STATE.analyser.fftSize);
            STATE.isMonitoring = true;
            STATE.isPaused = false;
            els.controls.pause.textContent = 'Pause';

            els.views.start.classList.remove('active');
            els.views.monitor.classList.add('active');

            STATE.intervalId = setInterval(tick, TICK_INTERVAL);
        } catch (err) {
            console.error(err);
            alert('Could not access microphone. Please ensure you have allowed permission and are using HTTPS.');
        }
    }

    function stopAudio() {
        if (STATE.stream) STATE.stream.getTracks().forEach(function (track) { track.stop(); });
        if (STATE.audioCtx) STATE.audioCtx.close();
        if (STATE.intervalId) clearInterval(STATE.intervalId);

        STATE.isMonitoring = false;
        STATE.isPaused = false;
        STATE.audioCtx = null;
        STATE.analyser = null;
        STATE.source = null;
        STATE.stream = null;
        STATE.intervalId = null;
        STATE.dataArray = null;
        STATE.rawSamples = [];
        STATE.graphData = [];
        STATE.overLimitMs = 0;
        STATE.totalMs = 0;
        STATE.lastTimestamp = 0;
        STATE.streakMs = 0;
        STATE.alarmActive = false;
        STATE.alarmTicks = 0;

        els.views.monitor.classList.remove('active');
        els.views.start.classList.add('active');

        els.visuals.alarm.classList.remove('active');
        els.visuals.fill.style.height = '0%';
        els.visuals.fill.classList.remove('vnl-fill-warn', 'vnl-fill-calm');
        els.visuals.overLimitValue.textContent = '0:00';
        els.visuals.overLimitDisplay.classList.remove('active');
        els.visuals.scoreDisplay.style.display = 'none';
        els.visuals.streakDisplay.style.display = 'none';
        els.controls.pause.textContent = 'Pause';

        var canvas = els.visuals.graph;
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    }

    function togglePause() {
        STATE.isPaused = !STATE.isPaused;
        els.controls.pause.textContent = STATE.isPaused ? 'Resume' : 'Pause';
        if (!STATE.isPaused) {
            // Reset so first tick after resume uses default delta rather than stale gap
            STATE.lastTimestamp = 0;
        }
    }

    function getVolume() {
        STATE.analyser.getFloatTimeDomainData(STATE.dataArray);

        var sumSq = 0;
        for (var i = 0; i < STATE.dataArray.length; i++) {
            sumSq += STATE.dataArray[i] * STATE.dataArray[i];
        }
        var rms = Math.sqrt(sumSq / STATE.dataArray.length);

        var sensitivityMult = SENSITIVITY_MIN_MULT + (STATE.sensitivity / SENSITIVITY_RANGE);
        return Math.min(Math.max(rms * sensitivityMult, 0), 1);
    }

    // --- Graph ---
    function drawGraph() {
        var canvas = els.visuals.graph;
        var ctx = canvas.getContext('2d');

        var rect = canvas.getBoundingClientRect();
        if (rect.width > 0 && (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height))) {
            canvas.width = Math.round(rect.width);
            canvas.height = Math.round(rect.height);
        }

        var w = canvas.width;
        var h = canvas.height;
        if (w === 0 || h === 0) return;

        ctx.clearRect(0, 0, w, h);

        var data = STATE.graphData;
        var n = data.length;

        var thresh = STATE.threshold / 100;
        var threshY = h - thresh * h;

        // Threshold dashed line (draw even with n < 2)
        ctx.save();
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.55)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, threshY);
        ctx.lineTo(w, threshY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // "MAX" label bottom-left of threshold line
        ctx.save();
        ctx.fillStyle = 'rgba(239, 68, 68, 0.65)';
        ctx.font = 'bold 18px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('TOO LOUD', 4, threshY - 4);
        ctx.restore();

        // Total time label — top-right
        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.font = 'bold 22px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(formatTime(STATE.totalMs), w - 14, 26);
        ctx.restore();

        if (n < 2) return;

        // Build the polyline path (all points spread across full width)
        function buildPath() {
            ctx.beginPath();
            for (var i = 0; i < n; i++) {
                var x = (i / (n - 1)) * w;
                var y = h - data[i] * h;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
        }

        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        // Below-threshold in green
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, threshY, w, h - threshY);
        ctx.clip();
        buildPath();
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.9)';
        ctx.stroke();
        ctx.restore();

        // Above-threshold in red
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, w, threshY);
        ctx.clip();
        buildPath();
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.9)';
        ctx.stroke();
        ctx.restore();
    }

    // --- Time Formatter ---
    function formatTime(ms) {
        var s = Math.floor(ms / 1000);
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    // --- Main Tick (2Hz) ---
    function tick() {
        if (!STATE.isMonitoring || STATE.isPaused) return;

        var now = Date.now();
        var delta = STATE.lastTimestamp ? now - STATE.lastTimestamp : TICK_INTERVAL;
        STATE.lastTimestamp = now;

        STATE.totalMs += delta;

        // Instantaneous sample → rolling average
        var instant = getVolume();
        STATE.rawSamples.push(instant);
        if (STATE.rawSamples.length > ROLLING_WINDOW) STATE.rawSamples.shift();

        var sum = 0;
        for (var i = 0; i < STATE.rawSamples.length; i++) sum += STATE.rawSamples[i];
        var vol = sum / STATE.rawSamples.length;
        var percentage = vol * 100;

        // Update bar and emoji
        els.visuals.fill.style.height = percentage + '%';
        var scale = 1 + (vol * EMOJI_MAX_SCALE);
        els.visuals.emoji.style.transform = 'scale(' + scale + ')';

        var thresh = STATE.threshold;

        // Alarm logic — track transition for toast
        var wasAlarmActive = STATE.alarmActive;
        if (percentage > thresh) {
            if (STATE.alarmCooldown <= 0) {
                triggerAlarm(true);
            }
        } else {
            if (STATE.alarmCooldown > 0) STATE.alarmCooldown--;
            else triggerAlarm(false);
        }
        var isAlarmNowActive = STATE.alarmActive;

        if (wasAlarmActive && !isAlarmNowActive) {
            showToast();
        }

        // Countdown
        if (isAlarmNowActive) {
            STATE.alarmTicks++;
            var countdownSec = 5 - (Math.floor(STATE.alarmTicks * TICK_INTERVAL / 1000) % 5);
            els.visuals.countdown.textContent = countdownSec === 0 ? 5 : countdownSec;
        }

        // Streak tracking
        if (!isAlarmNowActive) {
            STATE.streakMs += delta;
            if (STATE.streakMs > STATE.bestStreakMs) {
                STATE.bestStreakMs = STATE.streakMs;
                saveRecords();
            }
        } else {
            STATE.streakMs = 0;
        }

        // Session score
        var score = STATE.totalMs > 0 ? Math.round((STATE.totalMs - STATE.overLimitMs) / STATE.totalMs * 100) : 100;
        var grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
        var gradeClass = 'grade-' + grade.toLowerCase();
        els.visuals.scoreValue.textContent = grade;
        els.visuals.scoreValue.className = gradeClass;
        els.visuals.scoreDisplay.style.display = '';

        // Color stages
        if (percentage > thresh) {
            els.visuals.stage.className = 'vnl-stage stage-loud';
        } else if (percentage > thresh * WARNING_ZONE_RATIO) {
            els.visuals.fill.classList.add('vnl-fill-warn');
            els.visuals.fill.classList.remove('vnl-fill-calm');
            els.visuals.emoji.textContent = '\uD83D\uDE16'; // Confounded face
            els.visuals.stage.className = 'vnl-stage stage-warn';
        } else {
            els.visuals.fill.classList.add('vnl-fill-calm');
            els.visuals.fill.classList.remove('vnl-fill-warn');
            els.visuals.emoji.textContent = '\uD83D\uDE0A'; // Smiling face
            els.visuals.stage.className = 'vnl-stage';
        }

        // Record graph point
        STATE.graphData.push(vol);

        // Over-limit tracking
        if (vol > thresh / 100) {
            STATE.overLimitMs += delta;
            els.visuals.overLimitDisplay.classList.add('active');
        } else {
            els.visuals.overLimitDisplay.classList.remove('active');
        }
        els.visuals.overLimitValue.textContent = formatTime(STATE.overLimitMs);

        // Streak/best display
        els.visuals.streakValue.textContent = formatTime(STATE.streakMs);
        els.visuals.bestStreak.textContent = 'Best: ' + formatTime(STATE.bestStreakMs);
        els.visuals.streakDisplay.style.display = '';

        drawGraph();
    }

    function triggerAlarm(isActive) {
        STATE.alarmActive = isActive;
        if (isActive) {
            els.visuals.alarm.classList.add('active');
            STATE.alarmCooldown = ALARM_COOLDOWN_TICKS;
        } else {
            STATE.alarmTicks = 0;
            els.visuals.countdown.textContent = '5';
            els.visuals.alarm.classList.remove('active');
        }
    }

    function showToast() {
        var toast = els.visuals.toast;
        toast.classList.add('active');
        setTimeout(function() { toast.classList.remove('active'); }, 2000);
    }

    function resetData() {
        STATE.rawSamples = [];
        STATE.graphData = [];
        STATE.overLimitMs = 0;
        STATE.totalMs = 0;
        STATE.lastTimestamp = 0;
        STATE.streakMs = 0;
        STATE.bestStreakMs = 0;
        STATE.alarmCooldown = 0;
        STATE.alarmActive = false;
        STATE.alarmTicks = 0;

        els.visuals.alarm.classList.remove('active');
        els.visuals.fill.style.height = '0%';
        els.visuals.overLimitValue.textContent = '0:00';
        els.visuals.overLimitDisplay.classList.remove('active');
        els.visuals.streakValue.textContent = '0:00';
        els.visuals.bestStreak.textContent = 'Best: 0:00';
        els.visuals.countdown.textContent = '5';

        var canvas = els.visuals.graph;
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
        saveRecords();
    }

    function updateThresholdUI() {
        els.visuals.limitLine.style.bottom = STATE.threshold + '%';
    }

    // --- Event Listeners ---
    els.controls.activate.addEventListener('click', startAudio);
    els.controls.stop.addEventListener('click', stopAudio);
    els.controls.pause.addEventListener('click', togglePause);
    els.controls.reset.addEventListener('click', resetData);

    els.controls.sensitivity.addEventListener('input', function (e) {
        STATE.sensitivity = parseInt(e.target.value);
        saveSettings();
    });

    els.controls.threshold.addEventListener('input', function (e) {
        STATE.threshold = parseInt(e.target.value);
        updateThresholdUI();
        saveSettings();
    });

    els.controls.fullscreen.addEventListener('click', function () {
        if (!document.fullscreenElement) {
            CONTAINER.requestFullscreen().catch(function (err) { console.log(err); });
        } else {
            document.exitFullscreen();
        }
    });

    // --- Init ---
    loadSettings();
    updateThresholdUI();
})();
