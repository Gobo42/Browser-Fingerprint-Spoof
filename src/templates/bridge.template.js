// Isolated-world companion to content.js and audio-hardblock.js (both run in
// the MAIN world and therefore have no chrome.runtime access). Relays
// call-detection events from either of them to the background service
// worker so the popup can show them.
//
// CHANNEL is a per-build random token (see build-extension.js), shared by
// all three files, so this listener only reacts to our own scripts, not
// arbitrary page messages.
(function () {
  const CHANNEL = '__FP_CHANNEL__';

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.channel !== CHANNEL) return;
    // chrome.runtime becomes unavailable here once the extension that
    // injected this script reloads ("Extension context invalidated").
    // Any tab that already had this script running before a reload hits
    // this on whatever page happens to be open, not something specific to
    // any particular site. Not worth reporting a spoof-call count from an
    // invalidated context; worth not throwing an uncaught error into the
    // page's console either.
    try {
      chrome.runtime.sendMessage({ type: 'reportCall', method: event.data.method });
    } catch (e) {}
  });
})();
