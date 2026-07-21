const DB_NAME = 'jack-cut-local';
const DB_VERSION = 1;
const STORE_NAME = 'projects';

const QUALITY_PRESETS = {
  draft: { label: '快速预览', maxSide: 1280, crf: 28, preset: 'veryfast' },
  balanced: { label: '平衡', maxSide: 1920, crf: 23, preset: 'faster' },
  high: { label: '高质量', maxSide: 2560, crf: 20, preset: 'medium' },
};

const ASPECT_PRESETS = {
  original: { label: '原始', ratio: null },
  '16:9': { label: '16:9', ratio: 16 / 9 },
  '9:16': { label: '9:16', ratio: 9 / 16 },
  '1:1': { label: '1:1', ratio: 1 },
  '4:5': { label: '4:5', ratio: 4 / 5 },
};

const COMMON_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi']);

const state = {
  db: null,
  projects: [],
  activeProjectId: null,
  activeSegmentId: null,
  storagePersisted: false,
  storageUsage: null,
  storageQuota: null,
  playbackLoop: true,
  isPlaying: false,
  exportBusy: false,
  exportProgress: 0,
  exportMessage: '等待导出',
  exportBlobUrl: null,
};

const DOM = {};

function $(id) {
  return document.getElementById(id);
}

function uid(prefix = 'id') {
  if (crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatTime(seconds = 0) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00.00';
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const secText = secs.toFixed(2).padStart(5, '0');
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secText.padStart(5, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${secText}`;
}

function formatDate(ts) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function once(target, eventName, options = {}) {
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      cleanup();
      resolve(event);
    };
    const errorHandler = (event) => {
      cleanup();
      reject(event?.error || new Error(`事件 ${eventName} 失败`));
    };
    const cleanup = () => {
      target.removeEventListener(eventName, handler, options);
      target.removeEventListener('error', errorHandler, options);
    };
    target.addEventListener(eventName, handler, options);
    target.addEventListener('error', errorHandler, options);
  });
}

function sanitizeFilename(name) {
  return String(name || 'jack-cut')
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function makeDefaultCrop() {
  return {
    aspect: 'original',
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
  };
}

function makeDefaultSegment(duration = 0) {
  return {
    id: uid('seg'),
    label: '主片段',
    start: 0,
    end: Math.max(0.1, duration || 0.1),
  };
}

function normalizeCrop(crop = {}) {
  return {
    aspect: ASPECT_PRESETS[crop.aspect] ? crop.aspect : 'original',
    zoom: clamp(Number(crop.zoom ?? 1) || 1, 1, 3),
    offsetX: clamp(Number(crop.offsetX ?? 0) || 0, -100, 100),
    offsetY: clamp(Number(crop.offsetY ?? 0) || 0, -100, 100),
  };
}

function normalizeSegment(segment, duration = 0) {
  const start = clamp(Number(segment?.start ?? 0) || 0, 0, Math.max(duration, 0.1));
  const endSeed = segment?.end ?? (duration || 0.1);
  const end = clamp(Number(endSeed) || 0.1, 0.1, Math.max(duration, 0.1));
  return {
    id: segment?.id || uid('seg'),
    label: String(segment?.label || '片段'),
    start: Math.min(start, end - 0.01),
    end: Math.max(end, start + 0.01),
  };
}

function normalizeProject(raw) {
  const duration = Number(raw?.duration ?? 0) || 0;
  const width = Number(raw?.width ?? 0) || 0;
  const height = Number(raw?.height ?? 0) || 0;
  const project = {
    id: raw?.id || uid('project'),
    name: raw?.name || '未命名项目',
    sourceName: raw?.sourceName || '未导入视频',
    sourceType: raw?.sourceType || '',
    sourceSize: Number(raw?.sourceSize ?? 0) || 0,
    sourceBlob: raw?.sourceBlob || null,
    thumbnail: raw?.thumbnail || '',
    duration,
    width,
    height,
    crop: normalizeCrop(raw?.crop),
    segments: Array.isArray(raw?.segments) && raw.segments.length
      ? raw.segments.map((segment) => normalizeSegment(segment, duration || 0.1))
      : (raw?.sourceBlob ? [makeDefaultSegment(duration)] : []),
    exportHistory: Array.isArray(raw?.exportHistory) ? raw.exportHistory : [],
    createdAt: Number(raw?.createdAt ?? Date.now()) || Date.now(),
    updatedAt: Number(raw?.updatedAt ?? Date.now()) || Date.now(),
    lastOpenedAt: Number(raw?.lastOpenedAt ?? Date.now()) || Date.now(),
  };
  return project;
}

function storageProjectPayload(project) {
  return {
    id: project.id,
    name: project.name,
    sourceName: project.sourceName,
    sourceType: project.sourceType,
    sourceSize: project.sourceSize,
    sourceBlob: project.sourceBlob,
    thumbnail: project.thumbnail,
    duration: project.duration,
    width: project.width,
    height: project.height,
    crop: project.crop,
    segments: project.segments,
    exportHistory: project.exportHistory,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    lastOpenedAt: project.lastOpenedAt,
  };
}

async function openDb() {
  if (state.db) return state.db;
  state.db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return state.db;
}

async function dbGetAllProjects() {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function dbPutProject(project) {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(storageProjectPayload(project));
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

async function dbDeleteProject(id) {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

function getActiveProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || null;
}

function getActiveSegment(project = getActiveProject()) {
  if (!project) return null;
  return project.segments.find((segment) => segment.id === state.activeSegmentId) || project.segments[0] || null;
}

function setToast(message, tone = 'info') {
  DOM.toast.textContent = message;
  DOM.toast.hidden = false;
  DOM.toast.dataset.tone = tone;
  clearTimeout(setToast.timer);
  setToast.timer = setTimeout(() => {
    DOM.toast.hidden = true;
  }, 2600);
}

function setExportProgress(progress, message) {
  state.exportProgress = clamp(progress, 0, 1);
  if (message) state.exportMessage = message;
  DOM.exportProgress.style.width = `${Math.round(state.exportProgress * 100)}%`;
  DOM.exportPercent.textContent = `${Math.round(state.exportProgress * 100)}%`;
  DOM.exportStatus.textContent = state.exportMessage;
}

function updateStorageMetrics() {
  if (!navigator.storage?.estimate) {
    DOM.storageUsage.textContent = '浏览器不支持';
    DOM.storageState.textContent = state.storagePersisted ? '已启用' : '未激活';
    return;
  }

  navigator.storage.estimate().then((estimate) => {
    state.storageUsage = estimate.usage || 0;
    state.storageQuota = estimate.quota || 0;
    if (estimate.quota) {
      DOM.storageUsage.textContent = `${formatBytes(estimate.usage || 0)} / ${formatBytes(estimate.quota)}`;
    } else {
      DOM.storageUsage.textContent = formatBytes(estimate.usage || 0);
    }
    DOM.storageState.textContent = state.storagePersisted ? '已持久化' : '未激活';
  }).catch(() => {
    DOM.storageUsage.textContent = '读取失败';
  });
}

function updateStoragePill() {
  DOM.storagePill.textContent = state.storagePersisted ? '已启用持久存储' : '本地项目存储';
  DOM.storageState.textContent = state.storagePersisted ? '已持久化' : '未激活';
}

function renderProjectList() {
  DOM.projectCount.textContent = `${state.projects.length} 个`;
  const sorted = [...state.projects].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  DOM.projectList.innerHTML = '';

  if (!sorted.length) {
    DOM.projectList.innerHTML = `
      <div class="project-card">
        <div class="project-main" style="grid-column: 1 / -1">
          <h3>还没有项目</h3>
          <p>先导入一个本地视频。页面只在浏览器里处理，不会触发服务器上传。</p>
        </div>
      </div>
    `;
    return;
  }

  for (const project of sorted) {
    const card = document.createElement('article');
    card.className = `project-card${project.id === state.activeProjectId ? ' active' : ''}`;
    card.tabIndex = 0;
    card.dataset.id = project.id;
    card.innerHTML = `
      <div class="project-thumb">${project.thumbnail ? `<img src="${project.thumbnail}" alt="">` : '<span>项目</span>'}</div>
      <div class="project-main">
        <h3>${escapeHtml(project.name)}</h3>
        <p>${escapeHtml(project.sourceName || '未导入视频')}</p>
        <div class="project-meta">
          <span>${project.duration ? `${formatTime(project.duration)}` : '--:--'}</span>
          <span>${project.width && project.height ? `${project.width} × ${project.height}` : '未知分辨率'}</span>
          <span>${formatDate(project.updatedAt || project.createdAt)}</span>
        </div>
      </div>
    `;
    card.addEventListener('click', () => selectProject(project.id));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') selectProject(project.id);
    });
    DOM.projectList.appendChild(card);
  }
}

function renderActiveProjectHeader(project) {
  if (!project) {
    DOM.activeProjectName.textContent = '还没有打开项目';
    DOM.activeProjectMeta.textContent = '导入一个视频后，裁切和导出流程会在这里进行。';
    DOM.exportName.value = '';
    DOM.exportName.disabled = true;
    DOM.exportBtn.disabled = true;
    DOM.aspectSelect.disabled = true;
    DOM.zoomRange.disabled = true;
    DOM.offsetX.disabled = true;
    DOM.offsetY.disabled = true;
    DOM.resetCropBtn.disabled = true;
    DOM.playBtn.disabled = true;
    DOM.loopBtn.disabled = true;
    DOM.seekRange.disabled = true;
    DOM.segmentLabel.disabled = true;
    DOM.segmentStart.disabled = true;
    DOM.segmentEnd.disabled = true;
    DOM.addSegmentBtn.disabled = true;
    DOM.qualitySelect.disabled = true;
    DOM.renameBtn.disabled = true;
    DOM.duplicateBtn.disabled = true;
    DOM.deleteBtn.disabled = true;
    DOM.previewEmpty.hidden = false;
    DOM.previewFrame.hidden = true;
    DOM.outputRatioLabel.textContent = '原始';
    DOM.transportTime.textContent = '00:00.00 / 00:00.00';
    DOM.segmentRangeText.textContent = '--';
    DOM.segmentDurationText.textContent = '--';
    DOM.segmentList.innerHTML = '';
    DOM.timelineBar.innerHTML = '';
    DOM.exportList.innerHTML = '';
    DOM.exportCount.textContent = '0 个';
    return;
  }

  DOM.activeProjectName.textContent = project.name;
  DOM.activeProjectMeta.textContent = [
    project.sourceName || '未导入视频',
    project.duration ? formatTime(project.duration) : '--:--',
    project.width && project.height ? `${project.width} × ${project.height}` : '未知分辨率',
  ].join(' · ');

  DOM.exportName.disabled = false;
  DOM.exportBtn.disabled = !project.sourceBlob;
  DOM.aspectSelect.disabled = false;
  DOM.zoomRange.disabled = false;
  DOM.offsetX.disabled = false;
  DOM.offsetY.disabled = false;
  DOM.resetCropBtn.disabled = false;
  DOM.playBtn.disabled = !project.sourceBlob;
  DOM.loopBtn.disabled = !project.sourceBlob;
  DOM.seekRange.disabled = !project.sourceBlob;
  DOM.segmentLabel.disabled = false;
  DOM.segmentStart.disabled = false;
  DOM.segmentEnd.disabled = false;
  DOM.addSegmentBtn.disabled = !project.sourceBlob;
  DOM.qualitySelect.disabled = !project.sourceBlob;
  DOM.renameBtn.disabled = false;
  DOM.duplicateBtn.disabled = false;
  DOM.deleteBtn.disabled = false;
  DOM.previewEmpty.hidden = !!project.sourceBlob;
  DOM.previewFrame.hidden = !project.sourceBlob;
  DOM.outputRatioLabel.textContent = ASPECT_PRESETS[project.crop.aspect]?.label || '原始';
  DOM.exportName.value = sanitizeFilename(project.name) || 'jack-cut-export';

  if (!project.sourceBlob) {
    DOM.exportBtn.disabled = true;
  }
}

function applyCropPreview(project) {
  if (!project?.sourceBlob) return;

  const ratioEntry = ASPECT_PRESETS[project.crop.aspect] || ASPECT_PRESETS.original;
  const ratio = ratioEntry.ratio || (project.width && project.height ? project.width / project.height : 16 / 9);
  DOM.previewFrame.style.aspectRatio = `${ratio}`;
  DOM.zoomValue.textContent = `${Number(project.crop.zoom).toFixed(2)}×`;
  DOM.offsetXValue.textContent = `${project.crop.offsetX}`;
  DOM.offsetYValue.textContent = `${project.crop.offsetY}`;
  DOM.videoPlayer.style.transform = `scale(${project.crop.zoom})`;
  DOM.videoPlayer.style.objectPosition = `${50 + project.crop.offsetX * 0.35}% ${50 + project.crop.offsetY * 0.35}%`;
  DOM.videoPlayer.style.filter = 'contrast(1.02) saturate(1.03)';
}

function renderTrimControls(project) {
  const segment = getActiveSegment(project);
  if (!project || !segment) {
    DOM.segmentLabel.value = '';
    DOM.segmentStart.value = 0;
    DOM.segmentEnd.value = 0;
    DOM.segmentRangeText.textContent = '--';
    DOM.segmentDurationText.textContent = '--';
    return;
  }

  const max = Math.max(project.duration || 0, 0.1);
  DOM.segmentStart.max = String(max);
  DOM.segmentEnd.max = String(max);
  DOM.seekRange.max = String(max);

  DOM.segmentLabel.value = segment.label;
  DOM.segmentStart.value = String(segment.start);
  DOM.segmentEnd.value = String(segment.end);
  DOM.segmentRangeText.textContent = `${formatTime(segment.start)} → ${formatTime(segment.end)}`;
  DOM.segmentDurationText.textContent = `${formatTime(segment.end - segment.start)} 片段`;

  if (project.sourceBlob) {
    DOM.seekRange.value = String(clamp(DOM.videoPlayer.currentTime || 0, 0, max));
    DOM.transportTime.textContent = `${formatTime(DOM.videoPlayer.currentTime || 0)} / ${formatTime(project.duration || 0)}`;
  }
}

function renderTimeline(project) {
  const segmentList = project?.segments || [];
  DOM.segmentList.innerHTML = '';
  DOM.timelineBar.innerHTML = '';

  if (!project || !segmentList.length) {
    DOM.segmentList.innerHTML = `
      <div class="segment-card">
        <div class="segment-main">
          <h3>暂无片段</h3>
          <p>导入视频后，先选定一个片段范围，再点“新建片段”。</p>
        </div>
      </div>
    `;
    return;
  }

  const totalDuration = Math.max(
    project.duration || 0,
    ...segmentList.map((segment) => segment.end || 0),
    0.1,
  );

  for (const segment of segmentList) {
    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = `timeline-segment${segment.id === state.activeSegmentId ? ' active' : ''}`;
    const left = (segment.start / totalDuration) * 100;
    const width = ((segment.end - segment.start) / totalDuration) * 100;
    bar.style.left = `${left}%`;
    bar.style.width = `${Math.max(width, 1)}%`;
    bar.title = `${segment.label} ${formatTime(segment.start)} - ${formatTime(segment.end)}`;
    bar.addEventListener('click', () => selectSegment(segment.id));
    DOM.timelineBar.appendChild(bar);
  }

  segmentList.forEach((segment, index) => {
    const card = document.createElement('article');
    card.className = `segment-card${segment.id === state.activeSegmentId ? ' active' : ''}`;
    card.dataset.id = segment.id;
    card.innerHTML = `
      <div class="segment-card-head">
        <div class="segment-main">
          <h3>${escapeHtml(segment.label || `片段 ${index + 1}`)}</h3>
          <p>${formatTime(segment.start)} → ${formatTime(segment.end)} · ${formatTime(segment.end - segment.start)}</p>
        </div>
        <div class="segment-actions">
          <button class="mini-btn" data-action="up" type="button">上移</button>
          <button class="mini-btn" data-action="down" type="button">下移</button>
          <button class="mini-btn" data-action="select" type="button">使用</button>
          <button class="mini-btn" data-action="delete" type="button">删除</button>
        </div>
      </div>
    `;

    card.addEventListener('click', (event) => {
      const action = event.target?.dataset?.action;
      if (!action) {
        selectSegment(segment.id);
      }
    });

    card.querySelector('[data-action="up"]').addEventListener('click', (event) => {
      event.stopPropagation();
      moveSegment(segment.id, -1);
    });
    card.querySelector('[data-action="down"]').addEventListener('click', (event) => {
      event.stopPropagation();
      moveSegment(segment.id, 1);
    });
    card.querySelector('[data-action="select"]').addEventListener('click', (event) => {
      event.stopPropagation();
      selectSegment(segment.id);
    });
    card.querySelector('[data-action="delete"]').addEventListener('click', (event) => {
      event.stopPropagation();
      deleteSegment(segment.id);
    });

    DOM.segmentList.appendChild(card);
  });
}

function renderExportHistory(project) {
  const history = project?.exportHistory || [];
  DOM.exportCount.textContent = `${history.length} 个`;
  DOM.exportList.innerHTML = '';

  if (!history.length) {
    DOM.exportList.innerHTML = `
      <div class="export-card">
        <div class="export-card-body">
          <h3>暂无导出</h3>
          <p>导出过的 MP4 会保存在这个项目里，方便你随时重新下载。</p>
        </div>
      </div>
    `;
    return;
  }

  history.forEach((item, index) => {
    const card = document.createElement('article');
    card.className = 'export-card';
    const sizeText = item.size ? formatBytes(item.size) : '--';
    card.innerHTML = `
      <div class="export-card-body">
        <h3>${escapeHtml(item.name || `导出 ${index + 1}`)}</h3>
        <p>${formatDate(item.createdAt || Date.now())} · ${sizeText}</p>
      </div>
      <div class="export-card-actions">
        <button class="mini-btn" data-action="download" type="button">下载</button>
        <button class="mini-btn" data-action="remove" type="button">移除记录</button>
      </div>
    `;

    card.querySelector('[data-action="download"]').addEventListener('click', () => {
      if (!item.blob) {
        setToast('这个导出记录里没有文件本体。', 'warn');
        return;
      }
      downloadBlob(item.blob, item.name || 'jack-cut-export.mp4');
    });
    card.querySelector('[data-action="remove"]').addEventListener('click', () => removeExportHistory(item.id));

    DOM.exportList.appendChild(card);
  });
}

function renderProject(project = getActiveProject()) {
  renderProjectList();
  renderActiveProjectHeader(project);
  renderTrimControls(project);
  renderTimeline(project);
  renderExportHistory(project);

  if (project?.sourceBlob) {
    applyCropPreview(project);
  }

  updatePlaybackUi();
  updateActionStates();
}

function updateActionStates() {
  const project = getActiveProject();
  const hasProject = !!project;
  const hasSource = !!project?.sourceBlob;

  DOM.chooseFileBtn.disabled = false;
  DOM.newProjectBtn.disabled = false;
  DOM.renameBtn.disabled = !hasProject;
  DOM.duplicateBtn.disabled = !hasProject;
  DOM.deleteBtn.disabled = !hasProject;
  DOM.exportBtn.disabled = !hasSource;
  DOM.resetCropBtn.disabled = !hasProject;
  DOM.addSegmentBtn.disabled = !hasSource;
  DOM.aspectSelect.disabled = !hasProject;
  DOM.zoomRange.disabled = !hasProject;
  DOM.offsetX.disabled = !hasProject;
  DOM.offsetY.disabled = !hasProject;
  DOM.segmentLabel.disabled = !hasProject;
  DOM.segmentStart.disabled = !hasProject || !hasSource;
  DOM.segmentEnd.disabled = !hasProject || !hasSource;
  DOM.qualitySelect.disabled = !hasSource;
  DOM.playBtn.disabled = !hasSource;
  DOM.loopBtn.disabled = !hasSource;
  DOM.seekRange.disabled = !hasSource;
}

function updatePlaybackUi() {
  DOM.loopBtn.classList.toggle('is-active', state.playbackLoop);
  DOM.loopBtn.textContent = state.playbackLoop ? '循环片段' : '单次播放';
  DOM.playBtn.textContent = state.isPlaying ? '暂停' : '播放';
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function loadVideoMetadataFromBlob(blob) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.playsInline = true;
  video.muted = true;
  video.src = url;

  try {
    await once(video, 'loadedmetadata');
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const width = video.videoWidth || 0;
    const height = video.videoHeight || 0;
    return { duration, width, height, url };
  } catch (error) {
    throw new Error(`读取视频元数据失败：${error.message || error}`);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

async function captureThumbnailFromBlob(blob, seekTime = 0.8) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  video.muted = true;
  video.src = url;

  try {
    await once(video, 'loadeddata');
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration > 0) {
      video.currentTime = clamp(seekTime, 0, Math.max(0.1, duration - 0.1));
      await once(video, 'seeked');
    }
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 270;
    const context = canvas.getContext('2d');
    context.fillStyle = '#090b10';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const sourceW = video.videoWidth || canvas.width;
    const sourceH = video.videoHeight || canvas.height;
    const scale = Math.min(canvas.width / sourceW, canvas.height / sourceH);
    const drawW = sourceW * scale;
    const drawH = sourceH * scale;
    const offsetX = (canvas.width - drawW) / 2;
    const offsetY = (canvas.height - drawH) / 2;
    context.drawImage(video, offsetX, offsetY, drawW, drawH);
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch (error) {
    return '';
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

async function createProjectFromBlob(blob, fileName, options = {}) {
  const meta = await loadVideoMetadataFromBlob(blob);
  const thumbnail = await captureThumbnailFromBlob(blob);
  const title = options.title || sanitizeFilename(fileName) || '未命名项目';
  return normalizeProject({
    id: uid('project'),
    name: title,
    sourceName: fileName,
    sourceType: blob.type || '',
    sourceSize: blob.size || 0,
    sourceBlob: blob,
    thumbnail,
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    crop: makeDefaultCrop(),
    segments: [makeDefaultSegment(meta.duration)],
    exportHistory: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastOpenedAt: Date.now(),
  });
}

async function createBlankProject() {
  const project = normalizeProject({
    id: uid('project'),
    name: '未命名项目',
    sourceName: '未导入视频',
    sourceBlob: null,
    thumbnail: '',
    duration: 0,
    width: 0,
    height: 0,
    crop: makeDefaultCrop(),
    segments: [],
    exportHistory: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastOpenedAt: Date.now(),
  });
  await saveProjectAndRefresh(project);
  selectProject(project.id);
  setToast('已创建空项目。', 'ok');
}

async function saveProjectAndRefresh(project) {
  project.updatedAt = Date.now();
  await dbPutProject(project);
  const index = state.projects.findIndex((item) => item.id === project.id);
  if (index >= 0) {
    state.projects[index] = project;
  } else {
    state.projects.push(project);
  }
  renderProjectList();
  updateStorageMetrics();
}

async function loadProjects() {
  const rawProjects = await dbGetAllProjects();
  state.projects = rawProjects
    .map(normalizeProject)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  if (state.projects.length) {
    const preferred = state.projects.find((project) => project.id === state.activeProjectId) || state.projects[0];
    await selectProject(preferred.id, { skipToast: true });
  } else {
    state.activeProjectId = null;
    state.activeSegmentId = null;
    renderProject(null);
  }
  updateStorageMetrics();
}

async function selectProject(projectId, options = {}) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;

  if (state.activeProjectId && state.activeProjectId !== project.id) {
    revokeProjectSource(state.projects.find((item) => item.id === state.activeProjectId));
  }

  state.activeProjectId = project.id;
  project.lastOpenedAt = Date.now();
  if (project.segments.length && !project.segments.some((segment) => segment.id === state.activeSegmentId)) {
    state.activeSegmentId = project.segments[0].id;
  } else if (!state.activeSegmentId && project.segments.length) {
    state.activeSegmentId = project.segments[0].id;
  }

  if (project.sourceBlob) {
    await ensureSourceUrl(project);
    bindProjectToVideo(project);
  } else {
    DOM.videoPlayer.removeAttribute('src');
    DOM.videoPlayer.load();
    DOM.previewEmpty.hidden = false;
    DOM.previewFrame.hidden = true;
  }

  await dbPutProject(project);
  renderProject(project);
  if (!options.skipToast) {
    setToast(`已打开项目：${project.name}`, 'ok');
  }
}

async function ensureSourceUrl(project) {
  if (!project?.sourceBlob) return null;
  if (project.runtimeSourceUrl) return project.runtimeSourceUrl;
  const url = URL.createObjectURL(project.sourceBlob);
  project.runtimeSourceUrl = url;
  return url;
}

function revokeProjectSource(project) {
  if (project?.runtimeSourceUrl) {
    URL.revokeObjectURL(project.runtimeSourceUrl);
    delete project.runtimeSourceUrl;
  }
}

function bindProjectToVideo(project) {
  if (!project?.sourceBlob) return;
  const url = project.runtimeSourceUrl;
  if (!url) return;

  DOM.previewEmpty.hidden = true;
  DOM.previewFrame.hidden = false;
  DOM.videoPlayer.src = url;
  DOM.videoPlayer.load();

  DOM.videoPlayer.onloadedmetadata = () => {
    if (!project.duration || !Number.isFinite(project.duration)) {
      project.duration = Number.isFinite(DOM.videoPlayer.duration) ? DOM.videoPlayer.duration : 0;
    }
    if (!project.width) project.width = DOM.videoPlayer.videoWidth || 0;
    if (!project.height) project.height = DOM.videoPlayer.videoHeight || 0;
    if (!project.segments.length) {
      project.segments = [makeDefaultSegment(project.duration)];
      state.activeSegmentId = project.segments[0].id;
    }
    const active = getActiveSegment(project) || project.segments[0];
    if (active) {
      DOM.videoPlayer.currentTime = clamp(active.start || 0, 0, project.duration || active.end || 0);
      syncSegmentControlsFromState(project, active);
    }
    applyCropPreview(project);
    renderProject(project);
    updatePlaybackUi();
    saveCurrentProject().catch((error) => console.warn(error));
  };

  DOM.videoPlayer.onpause = () => {
    state.isPlaying = false;
    updatePlaybackUi();
  };

  DOM.videoPlayer.onplay = () => {
    state.isPlaying = true;
    updatePlaybackUi();
  };

  DOM.videoPlayer.ontimeupdate = () => {
    const segment = getActiveSegment(project);
    if (!segment) return;
    if (state.playbackLoop && state.isPlaying && DOM.videoPlayer.currentTime >= segment.end - 0.02) {
      DOM.videoPlayer.currentTime = segment.start;
      if (DOM.videoPlayer.paused) {
        DOM.videoPlayer.play().catch(() => {});
      }
    }
    DOM.seekRange.value = String(DOM.videoPlayer.currentTime || 0);
    DOM.transportTime.textContent = `${formatTime(DOM.videoPlayer.currentTime || 0)} / ${formatTime(project.duration || 0)}`;
  };

  DOM.videoPlayer.onended = () => {
    state.isPlaying = false;
    updatePlaybackUi();
    const segment = getActiveSegment(project);
    if (segment && state.playbackLoop) {
      DOM.videoPlayer.currentTime = segment.start;
    }
  };
}

function syncSegmentControlsFromState(project, segment) {
  if (!project || !segment) return;
  DOM.segmentLabel.value = segment.label || '';
  DOM.segmentStart.max = String(Math.max(project.duration || 0, 0.1));
  DOM.segmentEnd.max = String(Math.max(project.duration || 0, 0.1));
  DOM.segmentStart.value = String(segment.start);
  DOM.segmentEnd.value = String(segment.end);
  DOM.segmentRangeText.textContent = `${formatTime(segment.start)} → ${formatTime(segment.end)}`;
  DOM.segmentDurationText.textContent = `${formatTime(segment.end - segment.start)} 片段`;
}

function selectSegment(segmentId) {
  const project = getActiveProject();
  if (!project) return;
  const segment = project.segments.find((item) => item.id === segmentId);
  if (!segment) return;
  state.activeSegmentId = segment.id;
  syncSegmentControlsFromState(project, segment);
  if (project.sourceBlob && DOM.videoPlayer.src) {
    DOM.videoPlayer.currentTime = clamp(segment.start || 0, 0, project.duration || segment.end || 0);
  }
  renderProject(project);
}

async function saveCurrentProject() {
  const project = getActiveProject();
  if (!project) return;
  project.lastOpenedAt = Date.now();
  project.updatedAt = Date.now();
  await dbPutProject(project);
  renderProjectList();
  updateStorageMetrics();
}

function updateSegmentFromControls() {
  const project = getActiveProject();
  if (!project) return;
  const segment = getActiveSegment(project);
  if (!segment) return;

  const max = Math.max(project.duration || 0, 0.1);
  const start = clamp(Number(DOM.segmentStart.value || 0), 0, max);
  const end = clamp(Number(DOM.segmentEnd.value || max), 0.1, max);
  const safeStart = Math.min(start, end - 0.01);
  const safeEnd = Math.max(end, safeStart + 0.01);

  segment.label = DOM.segmentLabel.value.trim() || '片段';
  segment.start = safeStart;
  segment.end = safeEnd;
  DOM.segmentStart.value = String(safeStart);
  DOM.segmentEnd.value = String(safeEnd);
  DOM.segmentRangeText.textContent = `${formatTime(safeStart)} → ${formatTime(safeEnd)}`;
  DOM.segmentDurationText.textContent = `${formatTime(safeEnd - safeStart)} 片段`;
  if (DOM.videoPlayer.src) {
    DOM.videoPlayer.currentTime = clamp(safeStart, 0, max);
  }
  renderProject(project);
  saveCurrentProject().catch((error) => {
    console.error(error);
    setToast('保存片段失败。', 'warn');
  });
}

async function addSegmentFromCurrentRange() {
  const project = getActiveProject();
  if (!project?.sourceBlob) {
    setToast('先导入视频再新建片段。', 'warn');
    return;
  }
  const segment = getActiveSegment(project);
  if (!segment) {
    const fallback = makeDefaultSegment(project.duration);
    project.segments.push(fallback);
    state.activeSegmentId = fallback.id;
    await saveCurrentProject();
    renderProject(project);
    return;
  }

  const newSegment = {
    id: uid('seg'),
    label: `${segment.label || '片段'} 副本`,
    start: segment.start,
    end: segment.end,
  };
  project.segments.push(newSegment);
  state.activeSegmentId = newSegment.id;
  await saveCurrentProject();
  renderProject(project);
  setToast('已复制当前片段。', 'ok');
}

async function moveSegment(segmentId, direction) {
  const project = getActiveProject();
  if (!project || project.segments.length < 2) return;
  const index = project.segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) return;
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= project.segments.length) return;
  const [segment] = project.segments.splice(index, 1);
  project.segments.splice(newIndex, 0, segment);
  await saveCurrentProject();
  renderProject(project);
}

async function deleteSegment(segmentId) {
  const project = getActiveProject();
  if (!project) return;
  if (project.segments.length <= 1) {
    setToast('至少保留一个片段。', 'warn');
    return;
  }
  const index = project.segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) return;
  project.segments.splice(index, 1);
  if (state.activeSegmentId === segmentId) {
    state.activeSegmentId = project.segments[Math.max(0, index - 1)]?.id || project.segments[0]?.id || null;
  }
  await saveCurrentProject();
  renderProject(project);
}

async function renameCurrentProject() {
  const project = getActiveProject();
  if (!project) return;
  const nextName = window.prompt('给这个项目起个名字：', project.name || '未命名项目');
  if (!nextName) return;
  project.name = nextName.trim() || project.name;
  project.updatedAt = Date.now();
  await dbPutProject(project);
  renderProject(project);
  setToast('项目已重命名。', 'ok');
}

async function duplicateCurrentProject() {
  const project = getActiveProject();
  if (!project) return;
  const copy = normalizeProject({
    ...structuredClone(storageProjectPayload(project)),
    id: uid('project'),
    name: `${project.name} 副本`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastOpenedAt: Date.now(),
    exportHistory: [],
  });
  copy.sourceBlob = project.sourceBlob;
  copy.thumbnail = project.thumbnail;
  copy.segments = project.segments.map((segment) => ({ ...segment, id: uid('seg') }));
  copy.crop = { ...project.crop };
  await saveProjectAndRefresh(copy);
  await selectProject(copy.id);
  setToast('已复制当前项目。', 'ok');
}

async function deleteCurrentProject() {
  const project = getActiveProject();
  if (!project) return;
  const ok = window.confirm(`确认删除项目「${project.name}」？这会从浏览器本地移除项目数据。`);
  if (!ok) return;
  revokeProjectSource(project);
  await dbDeleteProject(project.id);
  state.projects = state.projects.filter((item) => item.id !== project.id);
  if (state.activeProjectId === project.id) {
    state.activeProjectId = null;
    state.activeSegmentId = null;
  }
  await loadProjects();
  setToast('项目已删除。', 'ok');
}

function computeCropPlan(project) {
  const sourceW = project.width || 1920;
  const sourceH = project.height || 1080;
  const sourceRatio = sourceW / sourceH;
  const ratio = ASPECT_PRESETS[project.crop.aspect]?.ratio || sourceRatio;
  const zoom = clamp(Number(project.crop.zoom || 1), 1, 3);
  const baseW = ratio >= sourceRatio ? sourceW : Math.round(sourceH * ratio);
  const baseH = ratio >= sourceRatio ? Math.round(sourceW / ratio) : sourceH;
  const cropW = Math.max(64, Math.min(sourceW, Math.round(baseW / zoom)));
  const cropH = Math.max(64, Math.min(sourceH, Math.round(baseH / zoom)));
  const freeX = Math.max(0, sourceW - cropW);
  const freeY = Math.max(0, sourceH - cropH);
  const cropX = Math.round(clamp((freeX / 2) + (project.crop.offsetX / 100) * (freeX / 2), 0, freeX));
  const cropY = Math.round(clamp((freeY / 2) + (project.crop.offsetY / 100) * (freeY / 2), 0, freeY));
  const outputSide = QUALITY_PRESETS[DOM.qualitySelect.value || 'balanced']?.maxSide || 1920;
  let outW;
  let outH;
  if (ratio >= 1) {
    outW = Math.min(outputSide, sourceW);
    outH = Math.max(2, Math.round(outW / ratio));
  } else {
    outH = Math.min(outputSide, sourceH);
    outW = Math.max(2, Math.round(outH * ratio));
  }
  return { cropW, cropH, cropX, cropY, outW, outH, ratio };
}

function buildCropFilter(project) {
  const cropPlan = computeCropPlan(project);
  const filter = `crop=${cropPlan.cropW}:${cropPlan.cropH}:${cropPlan.cropX}:${cropPlan.cropY},scale=${cropPlan.outW}:${cropPlan.outH},setsar=1`;
  return { ...cropPlan, filter };
}

function getExportFilename(project) {
  const base = sanitizeFilename(DOM.exportName.value || project.name || 'jack-cut-export');
  return `${base || 'jack-cut-export'}.mp4`;
}

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function removeExportHistory(exportId) {
  const project = getActiveProject();
  if (!project) return;
  project.exportHistory = project.exportHistory.filter((item) => item.id !== exportId);
  await saveCurrentProject();
  renderProject(project);
}

async function exportProject() {
  const project = getActiveProject();
  if (!project?.sourceBlob) {
    setToast('先导入视频再导出。', 'warn');
    return;
  }
  if (state.exportBusy) return;

    state.exportBusy = true;
    DOM.exportBtn.disabled = true;
    setExportProgress(0, '初始化导出');
    setToast('开始在浏览器里导出 MP4。', 'info');

  const exportName = getExportFilename(project);
  const quality = QUALITY_PRESETS[DOM.qualitySelect.value || 'balanced'] || QUALITY_PRESETS.balanced;
  const segments = project.segments.length ? [...project.segments] : [makeDefaultSegment(project.duration)];
  const inputName = `${sanitizeFilename(project.sourceName || project.name || 'input') || 'input'}.source`;
  const tempFiles = [];

  let ffmpeg;
  let util;
  try {
    const [ffmpegMod, utilMod] = await Promise.all([
      import('./vendor/ffmpeg/ffmpeg/index.js'),
      import('./vendor/ffmpeg/util/index.js'),
    ]);
    ffmpeg = new ffmpegMod.FFmpeg();
    util = utilMod;

    ffmpeg.on('log', ({ message }) => {
      if (message) console.log('[ffmpeg]', message);
    });

    let progressBase = 0;
    let activeSteps = segments.length + 1;
    ffmpeg.on('progress', ({ progress }) => {
      const normalized = clamp(progress || 0, 0, 1);
      setExportProgress((progressBase + normalized) / activeSteps, state.exportMessage);
    });

    setExportProgress(0.02, '加载本地渲染核心');
    const coreURL = new URL('./vendor/ffmpeg/core/ffmpeg-core.js', window.location.href).href;
    const wasmURL = new URL('./vendor/ffmpeg/core/ffmpeg-core.wasm', window.location.href).href;
    await ffmpeg.load({
      coreURL,
      wasmURL,
    });

    setExportProgress(0.08, '写入源视频');
    await ffmpeg.writeFile(inputName, await util.fetchFile(project.sourceBlob));

    const cropPlan = buildCropFilter(project);
    const clipFiles = [];

    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      const clipName = `clip_${i + 1}.mp4`;
      clipFiles.push(clipName);
      tempFiles.push(clipName);
      state.exportMessage = `导出片段 ${i + 1}/${segments.length}`;
      progressBase = i;
      setExportProgress(i / activeSteps, state.exportMessage);
      const start = Math.max(0, Number(segment.start || 0));
      const duration = Math.max(0.1, Number(segment.end || 0.1) - start);

      await ffmpeg.exec([
        '-hide_banner',
        '-y',
        '-ss', start.toFixed(3),
        '-t', duration.toFixed(3),
        '-i', inputName,
        '-vf', cropPlan.filter,
        '-c:v', 'libx264',
        '-preset', quality.preset,
        '-crf', String(quality.crf),
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        clipName,
      ]);
    }

    let finalName = clipFiles[0];
    if (clipFiles.length > 1) {
      state.exportMessage = '拼接片段';
      setExportProgress((segments.length) / activeSteps, state.exportMessage);
      const concatText = clipFiles.map((file) => `file '${file}'`).join('\n');
      const concatName = 'concat-list.txt';
      await ffmpeg.writeFile(concatName, new TextEncoder().encode(concatText));
      tempFiles.push(concatName);
      finalName = 'final-output.mp4';
      await ffmpeg.exec([
        '-hide_banner',
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatName,
        '-c', 'copy',
        '-movflags', '+faststart',
        finalName,
      ]);
    }

    setExportProgress(0.98, '读取导出结果');
    const data = await ffmpeg.readFile(finalName);
    const blob = new Blob([data], { type: 'video/mp4' });

    const exportRecord = {
      id: uid('export'),
      name: exportName,
      createdAt: Date.now(),
      size: blob.size,
      blob,
      crop: {
        aspect: project.crop.aspect,
        zoom: project.crop.zoom,
        offsetX: project.crop.offsetX,
        offsetY: project.crop.offsetY,
      },
      segments: segments.map((segment) => ({
        id: segment.id,
        label: segment.label,
        start: segment.start,
        end: segment.end,
      })),
      quality: DOM.qualitySelect.value || 'balanced',
    };

    project.exportHistory = [exportRecord, ...(project.exportHistory || [])].slice(0, 3);
    project.updatedAt = Date.now();
    await dbPutProject(project);

    await downloadBlob(blob, exportName);
    setExportProgress(1, `导出完成：${exportName}`);
    setToast('导出完成，文件已下载到本机。', 'ok');
    renderProject(project);
  } catch (error) {
    console.error(error);
    setExportProgress(0, `导出失败：${error?.message || error}`);
    setToast(`导出失败：${error?.message || error}`, 'warn');
  } finally {
    state.exportBusy = false;
    DOM.exportBtn.disabled = !getActiveProject()?.sourceBlob;
    if (ffmpeg?.terminate) {
      try {
        for (const file of tempFiles) {
          await ffmpeg.deleteFile(file).catch(() => {});
        }
        await ffmpeg.deleteFile(inputName).catch(() => {});
      } catch (error) {
        console.warn(error);
      }
      try {
        ffmpeg.terminate();
      } catch (error) {
        console.warn(error);
      }
    }
  }
}

async function handleFiles(fileList) {
  const files = [...fileList];
  const videoFile = files.find((file) => file && (file.type.startsWith('video/') || isVideoByExtension(file.name)));
  if (!videoFile) {
    setToast('只支持常见视频文件。', 'warn');
    return;
  }

  const activeProject = getActiveProject();
  if (activeProject && !activeProject.sourceBlob) {
    await attachFileToProject(activeProject, videoFile);
  } else {
    await createProjectFromFile(videoFile);
  }
}

function isVideoByExtension(name = '') {
  const ext = String(name).split('.').pop()?.toLowerCase();
  return COMMON_EXTENSIONS.has(ext);
}

async function attachFileToProject(project, file) {
  try {
    state.exportBusy = true;
    setToast('正在读取本地视频信息...', 'info');
    const updated = await createProjectFromBlob(file, file.name, {
      title: project.name || sanitizeFilename(file.name),
    });
    project.sourceBlob = updated.sourceBlob;
    project.sourceName = updated.sourceName;
    project.sourceType = updated.sourceType;
    project.sourceSize = updated.sourceSize;
    project.thumbnail = updated.thumbnail;
    project.duration = updated.duration;
    project.width = updated.width;
    project.height = updated.height;
    project.segments = updated.segments;
    project.crop = updated.crop;
    project.updatedAt = Date.now();
    await dbPutProject(project);
    await loadProjects();
    await selectProject(project.id);
    setToast('已把视频挂到当前项目。', 'ok');
  } finally {
    state.exportBusy = false;
  }
}

async function createProjectFromFile(file) {
  try {
    state.exportBusy = true;
    DOM.exportBtn.disabled = true;
    setToast('正在读取本地视频信息...', 'info');
    const project = await createProjectFromBlob(file, file.name, {
      title: sanitizeFilename(file.name) || '未命名项目',
    });
    await saveProjectAndRefresh(project);
    await selectProject(project.id);
    setToast(`已导入：${project.name}`, 'ok');
  } catch (error) {
    console.error(error);
    setToast(`导入失败：${error?.message || error}`, 'warn');
  } finally {
    state.exportBusy = false;
    updateActionStates();
  }
}

function resetCrop() {
  const project = getActiveProject();
  if (!project) return;
  project.crop = makeDefaultCrop();
  DOM.aspectSelect.value = project.crop.aspect;
  DOM.zoomRange.value = String(project.crop.zoom);
  DOM.offsetX.value = String(project.crop.offsetX);
  DOM.offsetY.value = String(project.crop.offsetY);
  applyCropPreview(project);
  saveCurrentProject().catch(() => {});
  renderProject(project);
}

async function requestPersistedStorage() {
  if (!navigator.storage?.persist) {
    setToast('当前浏览器不支持持久存储 API。', 'warn');
    return;
  }
  const granted = await navigator.storage.persist();
  state.storagePersisted = granted;
  updateStoragePill();
  updateStorageMetrics();
  setToast(granted ? '已启用持久存储。' : '浏览器没有授予持久存储。', granted ? 'ok' : 'warn');
}

function wireEvents() {
  DOM.chooseFileBtn.addEventListener('click', () => DOM.videoInput.click());
  DOM.dropzone.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    DOM.videoInput.click();
  });

  DOM.videoInput.addEventListener('change', (event) => {
    if (event.target.files?.length) {
      handleFiles(event.target.files);
      event.target.value = '';
    }
  });

  ['dragenter', 'dragover'].forEach((eventName) => {
    DOM.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      DOM.dropzone.classList.add('is-dragging');
    });
  });
  ['dragleave', 'drop'].forEach((eventName) => {
    DOM.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      DOM.dropzone.classList.remove('is-dragging');
    });
  });
  DOM.dropzone.addEventListener('drop', (event) => {
    const files = event.dataTransfer?.files;
    if (files?.length) handleFiles(files);
  });

  DOM.newProjectBtn.addEventListener('click', createBlankProject);
  DOM.persistBtn.addEventListener('click', requestPersistedStorage);
  DOM.renameBtn.addEventListener('click', renameCurrentProject);
  DOM.duplicateBtn.addEventListener('click', duplicateCurrentProject);
  DOM.deleteBtn.addEventListener('click', deleteCurrentProject);
  DOM.addSegmentBtn.addEventListener('click', addSegmentFromCurrentRange);
  DOM.resetCropBtn.addEventListener('click', resetCrop);
  DOM.exportBtn.addEventListener('click', exportProject);

  DOM.playBtn.addEventListener('click', async () => {
    const project = getActiveProject();
    if (!project?.sourceBlob) return;
    if (DOM.videoPlayer.paused) {
      const segment = getActiveSegment(project);
      if (segment && DOM.videoPlayer.currentTime < segment.start) {
        DOM.videoPlayer.currentTime = segment.start;
      }
      await DOM.videoPlayer.play();
      state.isPlaying = true;
    } else {
      DOM.videoPlayer.pause();
      state.isPlaying = false;
    }
    updatePlaybackUi();
  });

  DOM.loopBtn.addEventListener('click', () => {
    state.playbackLoop = !state.playbackLoop;
    updatePlaybackUi();
  });

  DOM.seekRange.addEventListener('input', () => {
    const project = getActiveProject();
    if (!project?.sourceBlob) return;
    const time = Number(DOM.seekRange.value || 0);
    DOM.videoPlayer.currentTime = time;
    DOM.transportTime.textContent = `${formatTime(time)} / ${formatTime(project.duration || 0)}`;
  });

  DOM.segmentLabel.addEventListener('input', updateSegmentFromControls);
  DOM.segmentStart.addEventListener('input', updateSegmentFromControls);
  DOM.segmentEnd.addEventListener('input', updateSegmentFromControls);

  DOM.aspectSelect.addEventListener('change', () => {
    const project = getActiveProject();
    if (!project) return;
    project.crop.aspect = DOM.aspectSelect.value;
    DOM.outputRatioLabel.textContent = ASPECT_PRESETS[project.crop.aspect]?.label || '原始';
    applyCropPreview(project);
    saveCurrentProject().catch(() => {});
    renderProject(project);
  });

  DOM.zoomRange.addEventListener('input', () => {
    const project = getActiveProject();
    if (!project) return;
    project.crop.zoom = clamp(Number(DOM.zoomRange.value || 1), 1, 3);
    applyCropPreview(project);
    saveCurrentProject().catch(() => {});
    renderProject(project);
  });

  DOM.offsetX.addEventListener('input', () => {
    const project = getActiveProject();
    if (!project) return;
    project.crop.offsetX = clamp(Number(DOM.offsetX.value || 0), -100, 100);
    applyCropPreview(project);
    saveCurrentProject().catch(() => {});
    renderProject(project);
  });

  DOM.offsetY.addEventListener('input', () => {
    const project = getActiveProject();
    if (!project) return;
    project.crop.offsetY = clamp(Number(DOM.offsetY.value || 0), -100, 100);
    applyCropPreview(project);
    saveCurrentProject().catch(() => {});
    renderProject(project);
  });

  DOM.qualitySelect.addEventListener('change', () => {
    const project = getActiveProject();
    if (!project) return;
    renderProject(project);
  });

  DOM.exportName.addEventListener('change', () => {
    const project = getActiveProject();
    if (!project) return;
    project.name = DOM.exportName.value.trim() || project.name;
    saveCurrentProject().catch(() => {});
    renderProject(project);
  });

  window.addEventListener('beforeunload', () => {
    state.projects.forEach((project) => revokeProjectSource(project));
  });
}

async function bootstrap() {
  const domIds = {
    storagePill: 'storage-pill',
    persistBtn: 'persist-btn',
    newProjectBtn: 'new-project-btn',
    projectCount: 'project-count',
    projectList: 'project-list',
    storageUsage: 'storage-usage',
    storageState: 'storage-state',
    dropzone: 'dropzone',
    videoInput: 'video-input',
    chooseFileBtn: 'choose-file-btn',
    activeProjectName: 'active-project-name',
    activeProjectMeta: 'active-project-meta',
    renameBtn: 'rename-btn',
    duplicateBtn: 'duplicate-btn',
    deleteBtn: 'delete-btn',
    previewEmpty: 'preview-empty',
    previewFrame: 'preview-frame',
    videoPlayer: 'video-player',
    playBtn: 'play-btn',
    loopBtn: 'loop-btn',
    transportTime: 'transport-time',
    seekRange: 'seek-range',
    segmentLabel: 'segment-label',
    segmentStart: 'segment-start',
    segmentEnd: 'segment-end',
    segmentRangeText: 'segment-range-text',
    segmentDurationText: 'segment-duration-text',
    addSegmentBtn: 'add-segment-btn',
    timelineBar: 'timeline-bar',
    segmentList: 'segment-list',
    aspectSelect: 'aspect-select',
    zoomRange: 'zoom-range',
    zoomValue: 'zoom-value',
    offsetX: 'offset-x',
    offsetY: 'offset-y',
    offsetXValue: 'offset-x-value',
    offsetYValue: 'offset-y-value',
    resetCropBtn: 'reset-crop-btn',
    outputRatioLabel: 'output-ratio-label',
    exportName: 'export-name',
    qualitySelect: 'quality-select',
    exportBtn: 'export-btn',
    exportProgress: 'export-progress',
    exportStatus: 'export-status',
    exportPercent: 'export-percent',
    exportCount: 'export-count',
    exportList: 'export-list',
    toast: 'toast',
  };

  Object.entries(domIds).forEach(([key, id]) => {
    DOM[key] = $(id);
  });

  updateStoragePill();
  updateStorageMetrics();

  if (navigator.storage?.persisted) {
    state.storagePersisted = await navigator.storage.persisted();
    updateStoragePill();
  }

  wireEvents();

  try {
    await openDb();
    await loadProjects();
  } catch (error) {
    console.error(error);
    setToast(`数据库初始化失败：${error?.message || error}`, 'warn');
  }

  if (!state.projects.length) {
    renderProject(null);
  }
}

bootstrap().catch((error) => {
  console.error(error);
  setToast(`启动失败：${error?.message || error}`, 'warn');
});
