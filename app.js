// ── State ──────────────────────────────────────────────────────────────────
let currentFile  = null;
let currentJobId = null;
let pollTimer    = null;
let currentXHR   = null;
let selectedLevel = 'high';

// ── DOM refs ───────────────────────────────────────────────────────────────
const uploadZone      = document.getElementById('upload-zone');
const fileInput       = document.getElementById('file-input');
const infoCard        = document.getElementById('info-card');
const settingsPanel   = document.getElementById('settings-panel');
const progressPanel   = document.getElementById('progress-panel');
const resultPanel     = document.getElementById('result-panel');
const errorBanner     = document.getElementById('error-banner');

const fileNameDisplay = document.getElementById('file-name-display');
const infoSize        = document.getElementById('info-size');
const infoDuration    = document.getElementById('info-duration');
const infoResolution  = document.getElementById('info-resolution');
const infoCodec       = document.getElementById('info-codec');

const targetSizeInput = document.getElementById('target-size');
const bitrateHint     = document.getElementById('bitrate-hint');
const memoryWarning   = document.getElementById('memory-warning');
const compressBtn     = document.getElementById('compress-btn');

const phaseLabel      = document.getElementById('phase-label');
const progressFill    = document.getElementById('progress-fill');
const progressDetail  = document.getElementById('progress-detail');
const progressPct     = document.getElementById('progress-pct');
const cancelBtn       = document.getElementById('cancel-btn');

const resultOriginal   = document.getElementById('result-original');
const resultCompressed = document.getElementById('result-compressed');
const savingBadge      = document.getElementById('saving-badge');
const downloadBtn      = document.getElementById('download-btn');
const resetBtn         = document.getElementById('reset-btn');
const errorDetail      = document.getElementById('error-detail');
const errorTitle       = document.getElementById('error-title');

// ── Helpers ────────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' KB';
}

function formatDuration(secs) {
  if (!secs || isNaN(secs)) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function setPhase(phase) {
  uploadZone.style.display    = phase === 'idle'        ? 'flex'  : 'none';
  infoCard.style.display      = phase === 'settings'    ? 'block' : 'none';
  settingsPanel.style.display = phase === 'settings'    ? 'block' : 'none';
  progressPanel.style.display = phase === 'compressing' ? 'block' : 'none';
  resultPanel.style.display   = phase === 'done'        ? 'block' : 'none';
  errorBanner.style.display   = phase === 'error'       ? 'block' : 'none';
}

function setProgress(pct, indeterminate = false) {
  if (indeterminate) {
    progressFill.classList.add('indeterminate');
    progressPct.textContent = '—';
  } else {
    progressFill.classList.remove('indeterminate');
    const clamped = Math.min(100, Math.max(0, pct));
    progressFill.style.width = `${clamped}%`;
    progressPct.textContent  = `${Math.round(clamped)}%`;
  }
}

function showError(detail, title = 'Compression failed') {
  errorTitle.textContent  = title;
  errorDetail.textContent = detail;
  setPhase('error');
}

function updateBitrateHint() {
  if (!currentFile) return;
  compressBtn.disabled = false;
  const targetMB = parseFloat(targetSizeInput.value);
  if (!targetMB || targetMB <= 0) {
    const labels = { low: 'Low compression (high quality)', medium: 'Medium compression', high: 'High compression (smallest file)' };
    bitrateHint.textContent = `Using ${labels[selectedLevel]} mode`;
  } else {
    bitrateHint.textContent = `Target size: ${targetMB} MB`;
  }
}

// ── Video metadata via browser native decoder ──────────────────────────────
function getVideoMeta(file) {
  return new Promise(resolve => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    const url = URL.createObjectURL(file);
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
    };
    video.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    video.src = url;
  });
}

// ── File selection ─────────────────────────────────────────────────────────
async function handleFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.mp4')) {
    showError('Only MP4 files are supported.', 'Unsupported format');
    return;
  }
  currentFile = file;
  memoryWarning.style.display = 'none';

  fileNameDisplay.textContent = file.name;
  infoSize.textContent        = formatSize(file.size);
  infoDuration.textContent   = 'Detecting...';
  infoResolution.textContent = 'Detecting...';
  infoCodec.textContent      = '—';

  setPhase('settings');
  updateBitrateHint();

  const meta = await getVideoMeta(file);
  if (meta) {
    infoDuration.textContent   = formatDuration(meta.duration);
    infoResolution.textContent = meta.width ? `${meta.width}×${meta.height}` : '—';
  } else {
    infoDuration.textContent  = '—';
    infoResolution.textContent = '—';
  }
}

// ── Compression ────────────────────────────────────────────────────────────
const PHASE_LABELS = {
  uploading:   'Uploading file...',
  analyzing:   'Analyzing video...',
  compressing: 'Compressing...',
  finalizing:  'Finalizing...',
};

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function startPolling(jobId) {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const r    = await fetch(`/progress/${jobId}`);
      const data = await r.json();

      if (data.status === 'running') {
        phaseLabel.textContent     = PHASE_LABELS[data.phase] || 'Processing...';
        progressDetail.textContent = `Progress: ${Math.round(data.progress)}%`;
        setProgress(data.progress);

      } else if (data.status === 'done') {
        stopPolling();
        setProgress(100);
        phaseLabel.textContent = 'Finalizing...';

        const baseName = currentFile.name.replace(/\.mp4$/i, '');
        downloadBtn.href     = `/download/${jobId}`;
        downloadBtn.download = `${baseName}_compressed.mp4`;

        const savedPct = Math.round((1 - data.output_size / data.input_size) * 100);
        resultOriginal.textContent   = formatSize(data.input_size);
        resultCompressed.textContent = formatSize(data.output_size);
        savingBadge.textContent = savedPct > 0
          ? `Saved ${savedPct}% — reduced by ${formatSize(data.input_size - data.output_size)}`
          : `File size: ${formatSize(data.output_size)}`;

        setPhase('done');

      } else if (data.status === 'error') {
        stopPolling();
        showError(data.error || 'Server-side compression failed');
      }
    } catch (_) { /* network blip — keep trying */ }
  }, 800);
}

function uploadFile(file, queryParams) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    currentXHR = xhr;
    xhr.open('POST', `/compress?${queryParams}`);
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) {
        const pct = (e.loaded / e.total) * 100;
        setProgress(pct * 0.2); // upload occupies 0–20% of display
        progressDetail.textContent = `Uploading · ${Math.round(pct)}%`;
      }
    });

    xhr.addEventListener('load', () => {
      currentXHR = null;
      if (xhr.status === 200) {
        try { resolve(JSON.parse(xhr.responseText).job_id); }
        catch (_) { reject(new Error('Invalid server response')); }
      } else {
        reject(new Error(`Upload failed (HTTP ${xhr.status})`));
      }
    });

    xhr.addEventListener('error', () => { currentXHR = null; reject(new Error('Network error — upload failed')); });
    xhr.addEventListener('abort', () => { currentXHR = null; reject(new Error('cancelled')); });
    xhr.send(file);
  });
}

async function startCompression() {
  if (!currentFile) return;

  setPhase('compressing');
  setProgress(0, true);
  phaseLabel.textContent     = 'Uploading file...';
  progressDetail.textContent = 'Do not close this page';

  const targetMB = parseFloat(targetSizeInput.value) || 0;
  const params = new URLSearchParams({
    level:      selectedLevel,
    resolution: 'original',
    target_mb:  targetMB,
  });

  try {
    const jobId = await uploadFile(currentFile, params.toString());
    currentJobId = jobId;
    setProgress(20);
    phaseLabel.textContent = PHASE_LABELS['analyzing'];
    startPolling(jobId);
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg === 'cancelled') { setPhase('settings'); return; }
    showError(msg);
  }
}

// ── Event listeners ────────────────────────────────────────────────────────
uploadZone.addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

document.getElementById('change-file-btn').addEventListener('click', () => {
  setPhase('idle');
  currentFile = null;
  fileInput.value = '';
  resetSettings();
});

targetSizeInput.addEventListener('input', updateBitrateHint);

document.querySelectorAll('[data-level]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-level]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedLevel = btn.dataset.level;
    updateBitrateHint();
  });
});

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    targetSizeInput.value = btn.dataset.mb;
    updateBitrateHint();
  });
});

compressBtn.addEventListener('click', startCompression);

cancelBtn.addEventListener('click', async () => {
  stopPolling();
  if (currentXHR) { currentXHR.abort(); currentXHR = null; }
  if (currentJobId) {
    fetch(`/cancel/${currentJobId}`, { method: 'POST' }).catch(() => {});
    currentJobId = null;
  }
  setPhase('settings');
});

document.getElementById('error-back-btn').addEventListener('click', () => {
  setPhase('idle');
  currentFile = null;
  fileInput.value = '';
});

function resetSettings() {
  selectedLevel = 'high';
  document.querySelectorAll('[data-level]').forEach(b => b.classList.toggle('active', b.dataset.level === 'high'));
  targetSizeInput.value = '';
}

resetBtn.addEventListener('click', () => {
  stopPolling();
  setPhase('idle');
  currentFile  = null;
  currentJobId = null;
  fileInput.value = '';
  progressFill.style.width = '0%';
  resetSettings();
});

// ── Stats tab ──────────────────────────────────────────────────────────────
const viewCompressor = document.getElementById('view-compressor');
const viewStats      = document.getElementById('view-stats');

async function fetchStats() {
  const launchesEl     = document.getElementById('stats-launches');
  const compressionsEl = document.getElementById('stats-compressions');
  const updatedEl      = document.getElementById('stats-updated');
  launchesEl.textContent     = '…';
  compressionsEl.textContent = '…';
  updatedEl.textContent      = '';
  try {
    const r    = await fetch('/stats');
    const data = await r.json();
    launchesEl.textContent     = (data.launches     ?? 0).toLocaleString('zh-CN');
    compressionsEl.textContent = (data.compressions ?? 0).toLocaleString('zh-CN');
    updatedEl.textContent      = `更新于 ${new Date().toLocaleTimeString('zh-CN')}`;
  } catch (_) {
    launchesEl.textContent     = '—';
    compressionsEl.textContent = '—';
    updatedEl.textContent      = '获取失败，请检查网络';
  }
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    const view = btn.dataset.view;
    viewCompressor.style.display = view === 'compressor' ? 'contents' : 'none';
    viewStats.style.display      = view === 'stats'      ? 'flex'     : 'none';
    if (view === 'stats') fetchStats();
  });
});

document.getElementById('stats-refresh-btn').addEventListener('click', fetchStats);
