let activeTab = null;
let excludeList = [];
let hardblockList = [];

const LABELS = {
  getImageData: 'Canvas (getImageData)',
  toDataURL: 'Canvas (toDataURL)',
  getParameter: 'WebGL (getParameter)',
  webglExtensions: 'WebGL (extensions/shader precision)',
  getChannelData: 'Audio (getChannelData)',
  analyser: 'Audio (AnalyserNode)',
  canPlayType: 'Media format support (canPlayType/MediaCapabilities)',
  audioContextFaked: 'AudioContext (faked, hard-blocked)',
  rtc: 'WebRTC (peer connections)',
};

function patternForHost(host, includeSubdomains) {
  return includeSubdomains ? `*://*.${host}/*` : `*://${host}/*`;
}

// Extracts the host from a pattern shaped like *://*.HOST/*, the only
// shape patternForHost(..., true) ever produces. Manually-typed patterns of
// other shapes just won't match here, which is fine; this is only used to
// detect redundancy against the quick-action buttons' own output.
function hostFromWildcardPattern(pattern) {
  const m = /^\*:\/\/\*\.(.+)\/\*$/.exec(pattern);
  return m ? m[1] : null;
}

// True if `host` (or any of its subdomains) is already covered by an
// existing *://*.EXISTING/* entry in the list, e.g. "www.aliexpress.us"
// is already covered by an existing "*://*.aliexpress.us/*" entry, since
// that pattern's "*." already matches any subdomain including "www".
function isHostAlreadyCovered(host, list) {
  return list.some((pattern) => {
    const existingHost = hostFromWildcardPattern(pattern);
    if (!existingHost) return false;
    return host === existingHost || host.endsWith('.' + existingHost);
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function safeParseUrl(str) {
  try { return new URL(str); } catch (e) { return null; }
}

// origins: { originString -> { getImageData, toDataURL, ... } }
function renderOrigins(origins) {
  const container = document.getElementById('origins');
  container.innerHTML = '';
  const keys = Object.keys(origins);

  if (!keys.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No fingerprinting API calls detected yet on this page (including any iframes it loaded). Try reloading the tab.';
    container.appendChild(empty);
    return;
  }

  keys.sort();
  for (const origin of keys) {
    const counts = origins[origin];
    const card = document.createElement('div');
    card.className = 'origin-card';

    const head = document.createElement('div');
    head.className = 'origin-head';

    const name = document.createElement('span');
    name.className = 'origin-name';
    name.textContent = origin;

    const excludeOriginBtn = document.createElement('button');
    excludeOriginBtn.textContent = 'Exclude';
    excludeOriginBtn.addEventListener('click', () => addOriginToList(origin, 'exclude'));

    const hardblockOriginBtn = document.createElement('button');
    hardblockOriginBtn.textContent = 'Hard-block audio';
    hardblockOriginBtn.addEventListener('click', () => addOriginToList(origin, 'hardblock'));

    head.appendChild(name);
    head.appendChild(excludeOriginBtn);
    head.appendChild(hardblockOriginBtn);
    card.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'counts';
    for (const key of Object.keys(LABELS)) {
      if (!counts[key]) continue;
      const label = document.createElement('span');
      label.textContent = LABELS[key];
      const value = document.createElement('span');
      value.textContent = counts[key];
      grid.appendChild(label);
      grid.appendChild(value);
    }
    card.appendChild(grid);

    container.appendChild(card);
  }
}

// Sort key for a pattern: the host portion (with any leading "*." wildcard
// stripped), lowercased. Falls back to the raw pattern for anything that
// doesn't parse as scheme://host/path, still sorts deterministically,
// just not necessarily "by domain" for exotic manually-typed patterns.
function patternSortKey(pattern) {
  const m = /^[^:]*:\/\/([^/]+)\//.exec(pattern);
  if (!m) return pattern.toLowerCase();
  const host = m[1].startsWith('*.') ? m[1].slice(2) : m[1];
  return host.toLowerCase();
}

// Generic renderer for an editable pattern list (shared by exclude + hardblock).
// Displays sorted by domain, but edit/remove are keyed by the pattern's
// *value*, not its position; sorting for display must not change which
// entry an edit/remove click actually affects.
function renderPatternList(elId, list, onSave) {
  const ul = document.getElementById(elId);
  ul.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'None yet.';
    ul.appendChild(empty);
    return;
  }
  const sorted = [...list].sort((a, b) => patternSortKey(a).localeCompare(patternSortKey(b)));
  sorted.forEach((pattern) => {
    const li = document.createElement('li');

    const input = document.createElement('input');
    input.value = pattern;
    input.addEventListener('change', () => {
      const updated = list.map((p) => (p === pattern ? input.value.trim() : p));
      onSave(updated);
    });

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => {
      onSave(list.filter((p) => p !== pattern));
    });

    li.appendChild(input);
    li.appendChild(removeBtn);
    ul.appendChild(li);
  });
}

function updateTabLabel(btnId, baseLabel, count) {
  document.getElementById(btnId).textContent = `${baseLabel} (${count})`;
}

async function saveExcludeList(list) {
  await chrome.runtime.sendMessage({ type: 'setExcludeList', list });
  excludeList = list;
  renderPatternList('excludeListEl', excludeList, saveExcludeList);
  updateTabLabel('tabExcludeBtn', 'Excluded', excludeList.length);
}

async function saveHardblockList(list) {
  await chrome.runtime.sendMessage({ type: 'setHardblockList', list });
  hardblockList = list;
  renderPatternList('hardblockListEl', hardblockList, saveHardblockList);
  updateTabLabel('tabHardblockBtn', 'Hard-blocked', hardblockList.length);
}

async function addOriginToList(origin, which) {
  const url = safeParseUrl(origin);
  if (!url) return;
  const list = which === 'exclude' ? excludeList : hardblockList;

  // Already covered by an existing broader pattern (e.g. clicking this on
  // www.aliexpress.us when *://*.aliexpress.us/* is already in the list):
  // nothing to add, just reload so the existing coverage takes effect.
  if (!isHostAlreadyCovered(url.hostname, list)) {
    const pattern = patternForHost(url.hostname, true);
    if (which === 'exclude') {
      if (!excludeList.includes(pattern)) await saveExcludeList([...excludeList, pattern]);
    } else {
      if (!hardblockList.includes(pattern)) await saveHardblockList([...hardblockList, pattern]);
    }
  }
  if (activeTab) chrome.tabs.reload(activeTab.id);
  window.close();
}

async function init() {
  activeTab = await getActiveTab();
  const url = activeTab && activeTab.url ? safeParseUrl(activeTab.url) : null;
  document.getElementById('site').textContent = url ? url.hostname : '(no active tab URL)';

  const origins = activeTab
    ? await chrome.runtime.sendMessage({ type: 'getCallCounts', tabId: activeTab.id })
    : {};
  renderOrigins(origins || {});

  excludeList = (await chrome.runtime.sendMessage({ type: 'getExcludeList' })) || [];
  renderPatternList('excludeListEl', excludeList, saveExcludeList);
  updateTabLabel('tabExcludeBtn', 'Excluded', excludeList.length);

  hardblockList = (await chrome.runtime.sendMessage({ type: 'getHardblockList' })) || [];
  renderPatternList('hardblockListEl', hardblockList, saveHardblockList);
  updateTabLabel('tabHardblockBtn', 'Hard-blocked', hardblockList.length);

  const excludeBtn = document.getElementById('excludeBtn');
  const hardblockBtn = document.getElementById('hardblockBtn');
  if (!url) {
    excludeBtn.disabled = true;
    hardblockBtn.disabled = true;
  }
  excludeBtn.addEventListener('click', () => addOriginToList(url.origin, 'exclude'));
  hardblockBtn.addEventListener('click', () => addOriginToList(url.origin, 'hardblock'));

  document.getElementById('addExcludeBtn').addEventListener('click', async () => {
    const input = document.getElementById('newExcludePattern');
    const pattern = input.value.trim();
    if (!pattern || excludeList.includes(pattern)) { input.value = ''; return; }
    await saveExcludeList([...excludeList, pattern]);
    input.value = '';
  });

  document.getElementById('addHardblockBtn').addEventListener('click', async () => {
    const input = document.getElementById('newHardblockPattern');
    const pattern = input.value.trim();
    if (!pattern || hardblockList.includes(pattern)) { input.value = ''; return; }
    await saveHardblockList([...hardblockList, pattern]);
    input.value = '';
  });

  setupTabs();
}

function setupTabs() {
  const tabs = [
    { btn: document.getElementById('tabExcludeBtn'), panel: document.getElementById('excludePanel') },
    { btn: document.getElementById('tabHardblockBtn'), panel: document.getElementById('hardblockPanel') },
  ];
  for (const active of tabs) {
    active.btn.addEventListener('click', () => {
      for (const t of tabs) {
        t.btn.classList.toggle('active', t === active);
        t.panel.hidden = t !== active;
      }
    });
  }
}

init();
