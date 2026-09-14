// Service worker: owns the exclude list and the hard-block list, (re)registers
// the dynamic content scripts whenever either changes, and tracks per-tab
// spoof-call counts reported by content.js/audio-hardblock.js (via bridge.js)
// for the popup to display.
//
// Two independent lists:
// - exclude list: sites where content.js/bridge.js (data spoofing) don't
//   run at all, real values everywhere, for sites that break with spoofing.
// - hardblock list: sites where, IN ADDITION to normal spoofing, the
//   real-time AudioContext constructor is disabled outright. This is for
//   sites (AliExpress is the motivating case) that hold a live audio
//   session open for fingerprinting purposes and cause side effects like
//   Bluetooth multipoint interference; spoofing the data those sites read
//   doesn't stop the live audio session from existing in the first place.

const SCRIPT_ID = 'fp-spoof';
const BRIDGE_ID = 'fp-bridge';
const HARDBLOCK_ID = 'fp-audio-hardblock';

const callCounts = new Map(); // tabId -> Map<origin, counts>  (origin covers the top frame AND any iframes on that tab)

function originOf(sender) {
  if (sender.origin) return sender.origin;
  try { return new URL(sender.url).origin; } catch (e) { return 'unknown'; }
}

async function getStoredList(storageKey, seedFile) {
  const stored = await chrome.storage.local.get(storageKey);
  if (stored[storageKey]) return stored[storageKey];
  // First run: seed from the bundled default list, if present.
  try {
    const res = await fetch(chrome.runtime.getURL(seedFile));
    const seeded = await res.json();
    await chrome.storage.local.set({ [storageKey]: seeded });
    return seeded;
  } catch (e) {
    return [];
  }
}

const getExcludeList = () => getStoredList('excludeList', 'exclude-list.json');
const getHardblockList = () => getStoredList('hardblockList', 'hardblock-list.json');

async function registerOrUpdate(defs) {
  // Try register first, fall back to update if it's already registered.
  // (Checking "is it registered?" first and branching on that is a TOCTOU
  // race: if init() ever runs twice concurrently, both calls can see "not
  // registered yet" and both attempt to register, and the second throws
  // "Duplicate script ID". Try/catch here makes this idempotent regardless
  // of how many times or how close together it's called.)
  try {
    await chrome.scripting.registerContentScripts(defs);
  } catch (e) {
    await chrome.scripting.updateContentScripts(defs);
  }
}

async function registerSpoofScripts(excludeMatches) {
  await registerOrUpdate([
    {
      id: SCRIPT_ID,
      js: ['content.js'],
      matches: ['<all_urls>'],
      excludeMatches,
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true, // also patch cross-origin iframes (e.g. an auth or CDN frame embedded by the top page), not just the top-level document
    },
    {
      id: BRIDGE_ID,
      js: ['bridge.js'],
      matches: ['<all_urls>'],
      excludeMatches,
      runAt: 'document_start',
      allFrames: true,
    },
  ]);
}

async function registerHardblockScript(matches) {
  if (!matches.length) {
    // registerContentScripts rejects an empty matches array, and there's
    // nothing to block anyway, unregister instead (no-op, wrapped in
    // try/catch, if it was never registered in the first place).
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [HARDBLOCK_ID] });
    } catch (e) {}
    return;
  }
  await registerOrUpdate([
    {
      id: HARDBLOCK_ID,
      js: ['audio-hardblock.js'],
      matches,
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
    },
  ]);
}

async function init() {
  const [excludeList, hardblockList] = await Promise.all([getExcludeList(), getHardblockList()]);
  await Promise.all([registerSpoofScripts(excludeList), registerHardblockScript(hardblockList)]);
}

// Dynamically registered content scripts persist across service worker
// sleep/wake cycles on their own, so we only need to (re)register on
// install/update and on browser startup, not on every SW wake.
chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

// Reset counts whenever a tab starts a new navigation, so the popup only
// ever shows activity from the current page load.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') callCounts.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => callCounts.delete(tabId));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'reportCall') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    const origin = originOf(sender);

    let perTab = callCounts.get(tabId);
    if (!perTab) {
      perTab = new Map();
      callCounts.set(tabId, perTab);
    }
    const counts = perTab.get(origin) || {};
    counts[msg.method] = (counts[msg.method] || 0) + 1;
    perTab.set(origin, counts);

    let total = 0;
    for (const c of perTab.values()) total += Object.values(c).reduce((a, b) => a + b, 0);
    chrome.action.setBadgeText({ tabId, text: total ? String(total) : '' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#8855ee' });
    return;
  }

  if (msg.type === 'getCallCounts') {
    const perTab = callCounts.get(msg.tabId);
    const result = {};
    if (perTab) {
      for (const [origin, counts] of perTab.entries()) result[origin] = counts;
    }
    sendResponse(result);
    return;
  }

  if (msg.type === 'getExcludeList') {
    getExcludeList().then(sendResponse);
    return true; // keep the message channel open for the async response
  }

  if (msg.type === 'setExcludeList') {
    chrome.storage.local.set({ excludeList: msg.list }).then(async () => {
      await registerSpoofScripts(msg.list);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'getHardblockList') {
    getHardblockList().then(sendResponse);
    return true;
  }

  if (msg.type === 'setHardblockList') {
    chrome.storage.local.set({ hardblockList: msg.list }).then(async () => {
      await registerHardblockScript(msg.list);
      sendResponse({ ok: true });
    });
    return true;
  }
});
