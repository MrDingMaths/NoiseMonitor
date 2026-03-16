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

    const STORAGE_KEY_CLASSES = 'noise-monitor_classes';
    const STORAGE_KEY_ACTIVE_CLASS = 'noise-monitor_activeClass';

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
        alarmTicks: 0,
        warningCount: 0,
        lastAlarmCycle: 0,
        activeClass: ''
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
            threshold: CONTAINER.querySelector('#vnl-in-threshold'),
            classSelect: CONTAINER.querySelector('#vnl-class-select'),
            classNewName: CONTAINER.querySelector('#vnl-class-new-name')
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
            warningCount: CONTAINER.querySelector('#vnl-warning-count'),
            historyPanel: CONTAINER.querySelector('#vnl-class-history'),
            activeClassName: CONTAINER.querySelector('#vnl-active-class-name'),
            classBestStreak: CONTAINER.querySelector('#vnl-class-best-streak'),
            historyTableWrap: CONTAINER.querySelector('#vnl-history-table-wrap'),
            scoreDisplay: CONTAINER.querySelector('#vnl-score-display'),
            scoreValue: CONTAINER.querySelector('#vnl-score-value'),
            streakDisplay: CONTAINER.querySelector('#vnl-streak-display'),
            streakValue: CONTAINER.querySelector('#vnl-streak-value'),
            bestStreak: CONTAINER.querySelector('#vnl-best-streak')
        }
    };

    // --- LocalStorage ---
    function loadSettings() {
        var saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            var data = JSON.parse(saved);
            STATE.sensitivity = parseInt(data.sens) || DEFAULT_SENSITIVITY;
            STATE.threshold = parseInt(data.thresh) || DEFAULT_THRESHOLD;
            els.controls.sensitivity.value = STATE.sensitivity;
            els.controls.threshold.value = STATE.threshold;
            updateThresholdUI();
        }
    }

    function saveSettings() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            sens: els.controls.sensitivity.value,
            thresh: els.controls.threshold.value
        }));
    }

    // --- Class Storage ---
    function loadClasses() {
        var raw = localStorage.getItem(STORAGE_KEY_CLASSES);
        return raw ? JSON.parse(raw) : {};
    }

    function saveClasses(classes) {
        localStorage.setItem(STORAGE_KEY_CLASSES, JSON.stringify(classes));
    }

    function setActiveClass(name) {
        STATE.activeClass = name;
        localStorage.setItem(STORAGE_KEY_ACTIVE_CLASS, name);
        var classes = loadClasses();
        STATE.bestStreakMs = (classes[name] && classes[name].bestStreakMs) || 0;
        updateHistoryPanel();
    }

    function saveRecords() {
        if (!STATE.activeClass) return;
        var classes = loadClasses();
        var cls = classes[STATE.activeClass];
        if (!cls) return;
        if (STATE.bestStreakMs > cls.bestStreakMs) {
            cls.bestStreakMs = STATE.bestStreakMs;
            saveClasses(classes);
        }
    }

    function saveSessionToActiveClass() {
        var name = STATE.activeClass;
        if (!name || STATE.totalMs < 3000) return;
        var classes = loadClasses();
        if (!classes[name]) classes[name] = { bestStreakMs: 0, sessions: [] };
        var cls = classes[name];
        if (STATE.bestStreakMs > cls.bestStreakMs) cls.bestStreakMs = STATE.bestStreakMs;
        var score = STATE.totalMs > 0 ? Math.round((STATE.totalMs - STATE.overLimitMs) / STATE.totalMs * 100) : 100;
        var grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
        cls.sessions.push({
            date: new Date().toLocaleDateString(),
            duration: STATE.totalMs,
            score: score,
            grade: grade,
            overLimitMs: STATE.overLimitMs,
            bestStreakMs: STATE.bestStreakMs
        });
        if (cls.sessions.length > 20) cls.sessions = cls.sessions.slice(-20);
        saveClasses(classes);
    }

    function populateClassSelect() {
        var classes = loadClasses();
        var active = localStorage.getItem(STORAGE_KEY_ACTIVE_CLASS) || '';
        var sel = els.controls.classSelect;
        sel.innerHTML = '<option value="">— no class selected —</option>';
        Object.keys(classes).forEach(function (name) {
            var opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (name === active) opt.selected = true;
            sel.appendChild(opt);
        });
        var newOpt = document.createElement('option');
        newOpt.value = '__new__';
        newOpt.textContent = '＋ New class\u2026';
        sel.appendChild(newOpt);
        if (active) setActiveClass(active);
    }

    function deleteSession(sessionIdx) {
        var name = STATE.activeClass;
        if (!name) return;
        var classes = loadClasses();
        var cls = classes[name];
        if (!cls || !cls.sessions[sessionIdx]) return;
        cls.sessions.splice(sessionIdx, 1);
        cls.bestStreakMs = cls.sessions.reduce(function (max, s) {
            return Math.max(max, s.bestStreakMs || 0);
        }, 0);
        saveClasses(classes);
        STATE.bestStreakMs = cls.bestStreakMs;
        updateHistoryPanel();
    }

    function updateHistoryPanel() {
        var name = STATE.activeClass;
        if (!name) {
            els.visuals.historyPanel.style.display = 'none';
            return;
        }
        els.visuals.historyPanel.style.display = '';
        els.visuals.activeClassName.textContent = name;
        var classes = loadClasses();
        var cls = classes[name] || { bestStreakMs: 0, sessions: [] };
        els.visuals.classBestStreak.textContent = formatTime(cls.bestStreakMs);
        var totalSessions = cls.sessions.length;
        var startIdx = Math.max(0, totalSessions - 5);
        var sessions = cls.sessions.slice(startIdx).reverse();
        if (sessions.length === 0) {
            els.visuals.historyTableWrap.innerHTML = '<p class="vnl-history-empty">No sessions yet for this class.</p>';
            return;
        }
        var rows = sessions.map(function (s, i) {
            var actualIdx = totalSessions - 1 - i;
            return '<tr><td>' + s.date + '</td><td>' + formatTime(s.duration) + '</td><td class="grade-' + s.grade.toLowerCase() + '">' + s.grade + '</td><td><button class="vnl-btn-delete-session" data-idx="' + actualIdx + '" title="Delete session">✕</button></td></tr>';
        }).join('');
        els.visuals.historyTableWrap.innerHTML = '<table class="vnl-history-table"><thead><tr><th>Date</th><th>Duration</th><th>Grade</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
        els.visuals.historyTableWrap.querySelectorAll('.vnl-btn-delete-session').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var idx = parseInt(this.getAttribute('data-idx'));
                if (confirm('Delete this session?')) {
                    deleteSession(idx);
                }
            });
        });
    }

    // --- Audio ---
    async function startAudio() {
        // Handle class selection before acquiring mic
        var sel = els.controls.classSelect;
        var newInput = els.controls.classNewName;
        if (sel.value === '__new__') {
            var newName = newInput.value.trim();
            if (!newName) { alert('Please enter a class name.'); return; }
            var classes = loadClasses();
            if (!classes[newName]) { classes[newName] = { bestStreakMs: 0, sessions: [] }; saveClasses(classes); }
            populateClassSelect();
            sel.value = newName;
            newInput.style.display = 'none';
            setActiveClass(newName);
        } else {
            setActiveClass(sel.value);
        }

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
        saveSessionToActiveClass();

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
        STATE.warningCount = 0;
        STATE.lastAlarmCycle = 0;

        els.views.monitor.classList.remove('active');
        els.views.start.classList.add('active');
        updateHistoryPanel();

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

        // Total time label — top-right
        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.font = 'bold 22px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(formatTime(STATE.totalMs), w - 14, 26);
        ctx.restore();

        if (n < 2) return;

        // Build a smooth curve path using quadratic bezier midpoint smoothing
        function buildPath() {
            ctx.beginPath();
            var x0 = 0;
            var y0 = h - data[0] * h;
            ctx.moveTo(x0, y0);
            for (var i = 1; i < n; i++) {
                var x1 = (i / (n - 1)) * w;
                var y1 = h - data[i] * h;
                var mx = (x0 + x1) / 2;
                var my = (y0 + y1) / 2;
                ctx.quadraticCurveTo(x0, y0, mx, my);
                x0 = x1;
                y0 = y1;
            }
            ctx.lineTo(x0, y0);
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

            // Every completed 5-second cycle → flash and increment warning count
            var currentCycle = Math.floor(STATE.alarmTicks * TICK_INTERVAL / 5000);
            if (currentCycle > STATE.lastAlarmCycle) {
                STATE.lastAlarmCycle = currentCycle;
                STATE.warningCount++;
                var overlay = els.visuals.alarm;
                overlay.classList.add('vnl-flash-hit');
                setTimeout(function () { overlay.classList.remove('vnl-flash-hit'); }, 350);
                els.visuals.warningCount.textContent = '\u26A0 ' + STATE.warningCount + ' warning' + (STATE.warningCount !== 1 ? 's' : '');
            }
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
            STATE.lastAlarmCycle = 0;
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
        // Reload best streak from class so reset doesn't wipe persisted record
        var classes = loadClasses();
        STATE.bestStreakMs = STATE.activeClass ? ((classes[STATE.activeClass] || {}).bestStreakMs || 0) : 0;
        STATE.alarmCooldown = 0;
        STATE.alarmActive = false;
        STATE.alarmTicks = 0;
        STATE.warningCount = 0;
        STATE.lastAlarmCycle = 0;

        els.visuals.alarm.classList.remove('active');
        els.visuals.warningCount.textContent = '';
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
    els.controls.classSelect.addEventListener('change', function () {
        var val = this.value;
        if (val === '__new__') {
            els.controls.classNewName.style.display = '';
            els.controls.classNewName.focus();
            setActiveClass('');
        } else {
            els.controls.classNewName.style.display = 'none';
            setActiveClass(val);
        }
    });

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
    populateClassSelect();
})();
