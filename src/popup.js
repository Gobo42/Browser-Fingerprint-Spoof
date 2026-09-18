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

// True if `host` (or any of its subdomains) is already covered by an
// existing *://*.EXISTING/* entry in the list, e.g. "www.aliexpress.us"
// is already covered by an existing "*://*.aliexpress.us/*" entry, since
// that pattern's "*." already matches any subdomain including "www".
function isHostAlreadyCovered(host, list) {
  return list.some((pattern) => {
    const match = /^\*:\/\/\*\.(.+)\/\*$/.exec(pattern);
    if (!match) return false;
    const existingHost = match[1];
    return host === existingHost || host.endsWith('.' + existingHost);
  });
}

// True if `host` is already on `list` one way or another: a broader
// wildcard entry covering it (isHostAlreadyCovered), or an exact entry for
// it in either shape (*://*.HOST/* or the bare *://HOST/*, e.g. the seeded
// teams.microsoft.com entries use both). Used to grey out a quick-action
// button once it'd be a no-op.
function isHostExcluded(host, list) {
  return list.includes(`*://${host}/*`) || isHostAlreadyCovered(host, list);
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

    const originHost = (safeParseUrl(origin) || {}).hostname;

    const excludeOriginBtn = document.createElement('button');
    if (originHost && isHostExcluded(originHost, excludeList)) {
      excludeOriginBtn.textContent = 'Excluded';
      excludeOriginBtn.disabled = true;
    } else {
      excludeOriginBtn.textContent = 'Exclude';
      excludeOriginBtn.addEventListener('click', () => addOriginToList(origin, 'exclude'));
    }

    const hardblockOriginBtn = document.createElement('button');
    if (originHost && isHostExcluded(originHost, hardblockList)) {
      hardblockOriginBtn.textContent = 'Hard-blocked';
      hardblockOriginBtn.disabled = true;
    } else {
      hardblockOriginBtn.textContent = 'Hard-block audio';
      hardblockOriginBtn.addEventListener('click', () => addOriginToList(origin, 'hardblock'));
    }

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

// Host portion of a pattern (any leading "*." wildcard stripped), or null
// for anything that doesn't parse as scheme://host/path.
function hostFromPattern(pattern) {
  const m = /^[^:]*:\/\/([^/]+)\//.exec(pattern);
  if (!m) return null;
  return m[1].startsWith('*.') ? m[1].slice(2) : m[1];
}

// Sort key for a pattern: its host, lowercased. Falls back to the raw
// pattern for anything hostFromPattern can't parse, still sorts
// deterministically, just not necessarily "by domain" for exotic
// manually-typed patterns.
function patternSortKey(pattern) {
  return (hostFromPattern(pattern) || pattern).toLowerCase();
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

// True if `existingHost` is at or under `host`, i.e. excluding `host`
// should also cover it (a hard-block entry for the same host, or for a
// subdomain of it).
function isHostWithin(existingHost, host) {
  return existingHost === host || existingHost.endsWith('.' + host);
}

// Removes any hard-block entries for a host that was just added to the
// exclude list. "Excluded" (real values everywhere) and "hard-blocked"
// (actively fake AudioContext) contradict each other for the same site, so
// excluding wins and clears the hard-block side rather than leaving both
// active at once.
async function pruneHardblockForHost(host) {
  const remaining = hardblockList.filter((pattern) => {
    const h = hostFromPattern(pattern);
    return !(h && isHostWithin(h, host));
  });
  if (remaining.length !== hardblockList.length) await saveHardblockList(remaining);
}

async function saveExcludeList(list) {
  const addedHosts = list
    .filter((p) => !excludeList.includes(p))
    .map(hostFromPattern)
    .filter(Boolean);

  await chrome.runtime.sendMessage({ type: 'setExcludeList', list });
  excludeList = list;
  renderPatternList('excludeListEl', excludeList, saveExcludeList);
  updateTabLabel('tabExcludeBtn', 'Excluded', excludeList.length);

  for (const host of addedHosts) await pruneHardblockForHost(host);
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
    const pattern = `*://*.${url.hostname}/*`;
    if (which === 'exclude') {
      await saveExcludeList([...excludeList, pattern]);
    } else {
      await saveHardblockList([...hardblockList, pattern]);
    }
  }
  if (activeTab) chrome.tabs.reload(activeTab.id);
  window.close();
}

// Chrome match pattern: scheme://host/path, host being "*", "*.example.com",
// or a plain host.
const MATCH_PATTERN_RE = /^(\*|https?):\/\/(\*|(\*\.)?[^/*\s]+)\/\S*$/;

// One import line -> a match pattern, or null if it's neither. A line with
// "://" must already be a valid match pattern and is kept exactly, so
// path-scoped entries like *://www.google.com/recaptcha/* survive unchanged.
// A line with no "://" must be only a domain ("foo.com", "*.foo.com") and
// gets wrapped in the same *://*.HOST/* shape the quick-action buttons
// produce. A dotless host only counts when written as a wildcard ("*.gov"),
// so stray words don't turn into entries.
function toPattern(line) {
  if (line.includes('://')) return MATCH_PATTERN_RE.test(line) ? line : null;
  const wild = /^\*?\./.test(line);
  const host = line.replace(/^\*?\./, '').toLowerCase();
  const isDomain = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host) && (wild || host.includes('.'));
  return isDomain ? `*://*.${host}/*` : null;
}

// File text -> { patterns, ignored } (or { error }). A JSON array of strings
// (the same shape as exclude-list.json) or one entry per line. Lines that
// are neither a domain nor a valid pattern are ignored, not errors.
function parseImport(text) {
  const trimmed = text.trim();
  let lines;
  if (trimmed.startsWith('[')) {
    try { lines = JSON.parse(trimmed); } catch (e) { return { error: 'Not valid JSON.' }; }
  } else {
    lines = trimmed.split(/\r?\n/);
  }
  const patterns = [];
  const ignored = [];
  for (const raw of lines) {
    // Drop a trailing " # comment" (the # must follow whitespace, so a # inside
    // a pattern's path survives), then skip blank and whole-line comments.
    const line = String(raw).replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const pattern = toPattern(line);
    if (pattern) patterns.push(pattern); else ignored.push(line);
  }
  return { patterns, ignored };
}

// Import only ever adds: entries already in the list (or repeated in the
// file) are skipped, nothing is removed. Goes through the same save function
// as manual adds, so excluding via import also prunes hard-block entries.
function wireImport({ btnId, fileId, statusId, getList, save }) {
  const input = document.getElementById(fileId);
  const status = document.getElementById(statusId);
  document.getElementById(btnId).addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = ''; // so picking the same file again still fires change
    if (!file) return;
    const parsed = parseImport(await file.text());
    if (parsed.error) { status.textContent = parsed.error; return; }
    const existing = new Set(getList());
    const added = [...new Set(parsed.patterns)].filter((p) => !existing.has(p));
    if (added.length) await save([...getList(), ...added]);
    const skipped = parsed.patterns.length - added.length;
    status.textContent = `Added ${added.length}, skipped ${skipped} duplicate, ignored ${parsed.ignored.length}`;
  });
}

async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = activeTab && activeTab.url ? safeParseUrl(activeTab.url) : null;
  document.getElementById('site').textContent = url ? url.hostname : '(no active tab URL)';

  // Loaded before renderOrigins/the quick-action buttons below, since both
  // need the lists already in hand to grey out a button that'd be a no-op.
  excludeList = (await chrome.runtime.sendMessage({ type: 'getExcludeList' })) || [];
  hardblockList = (await chrome.runtime.sendMessage({ type: 'getHardblockList' })) || [];

  const origins = activeTab
    ? await chrome.runtime.sendMessage({ type: 'getCallCounts', tabId: activeTab.id })
    : {};
  renderOrigins(origins || {});

  renderPatternList('excludeListEl', excludeList, saveExcludeList);
  updateTabLabel('tabExcludeBtn', 'Excluded', excludeList.length);

  renderPatternList('hardblockListEl', hardblockList, saveHardblockList);
  updateTabLabel('tabHardblockBtn', 'Hard-blocked', hardblockList.length);

  const excludeBtn = document.getElementById('excludeBtn');
  const hardblockBtn = document.getElementById('hardblockBtn');
  if (!url) {
    excludeBtn.disabled = true;
    hardblockBtn.disabled = true;
  } else {
    if (isHostExcluded(url.hostname, excludeList)) {
      excludeBtn.disabled = true;
      excludeBtn.textContent = 'Already excluded';
    } else {
      excludeBtn.addEventListener('click', () => addOriginToList(url.origin, 'exclude'));
    }
    if (isHostExcluded(url.hostname, hardblockList)) {
      hardblockBtn.disabled = true;
      hardblockBtn.textContent = 'Already hard-blocked';
    } else {
      hardblockBtn.addEventListener('click', () => addOriginToList(url.origin, 'hardblock'));
    }
  }

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

  wireImport({ btnId: 'importExcludeBtn', fileId: 'importExcludeFile', statusId: 'importExcludeStatus', getList: () => excludeList, save: saveExcludeList });
  wireImport({ btnId: 'importHardblockBtn', fileId: 'importHardblockFile', statusId: 'importHardblockStatus', getList: () => hardblockList, save: saveHardblockList });

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
