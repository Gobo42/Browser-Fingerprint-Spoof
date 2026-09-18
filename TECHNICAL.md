# Technical details

Deep-dive documentation for how Browser Fingerprint Spoof actually works.
See [README.md](README.md) for the project summary, motivation, and
day-to-day usage. This document is for understanding (or auditing) the
mechanism itself.

## Contents

- [Runtime behavior: no native calls at serve time](#runtime-behavior-no-native-calls-at-serve-time)
- [Signals captured and served](#signals-captured-and-served)
- [AnalyserNode (live audio fingerprinting)](#analysernode-live-audio-fingerprinting)
- [Hard-block list](#hard-block-list)
- [Per-site management (toolbar popup) and per-origin activity](#per-site-management-toolbar-popup-and-per-origin-activity)
- [Why CDN-hosted script domains don't need their own list entries](#why-cdn-hosted-script-domains-dont-need-their-own-list-entries)
- [How call detection works (and its limits)](#how-call-detection-works-and-its-limits)
- [Confirmed working against the real site](#confirmed-working-against-the-real-site)

## Runtime behavior: no native calls at serve time

Before any of the overrides below install, both `content.js` and
`audio-hardblock.js` (via the shared
[`private-host-guard.snippet.js`](src/templates/private-host-guard.snippet.js))
check `window.location.hostname` against a regex covering RFC 1918
(`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), loopback (`127.0.0.0/8`,
`::1`, `localhost`/`*.localhost`), and mDNS `*.local` hostnames, and return
immediately, unpatched, if it matches. This is unconditional, not a
popup-managed list entry, because of a platform constraint: both scripts
run in the page's MAIN world at `document_start` so their prototype patches
land before the page's own scripts can read the real values, and
MAIN-world scripts have no `chrome.runtime`/`chrome.storage` access (see
"How call detection works" below for why `bridge.js` exists at all).
`chrome.storage.local.get()` is always async, so there's no way to gate
this on a live-toggleable setting without introducing a wait that would
let the page's real fingerprinting code run first, defeating the override.
A build-time-only toggle was possible but not worth the complexity:
there's no real case for wanting spoofing *on* against your own LAN, and
canvas/WebGL-readback consoles (a browser-based VM/VNC viewer, for
instance) would otherwise get served fake pixels for what they just drew.
The regex only matches a bare hostname shape (an IPv4 literal, `::1`,
`localhost`, or a `*.local`/`*.localhost` suffix); a private-network
hostname that doesn't fit one of those shapes (a custom internal DNS name,
say) isn't detectable from page JS and isn't covered.

The overridden methods below are never removed, stubbed to throw, or left
`undefined`; each one stays fully present and returns a normal-shaped
value on every call, same as it would for a page nobody is intercepting.
Blocking the request for a fingerprinting script (as a network-level ad
blocker rule would) or deleting/breaking the APIs it calls are both
themselves distinguishing signals a site can score as suspicious, in the
same category as `navigator.webdriver === true`, so the design goal is for
the calling script to run to completion unaware anything is wrong, and get
back data that looks like a normal answer, just not the real one.

The generated `content.js` never calls the real browser implementation of
any of the four core methods it overrides. Everything it returns comes from
the captured (and optionally hand-edited or `obscure`d) `fingerprint.json`
baseline, combined with pure in-JS noise math; no GPU/canvas/audio
hardware is touched while a page is open:

- **`CanvasRenderingContext2D.getImageData`**: builds the returned
  `ImageData` from the captured byte array plus noise. Never re-renders or
  re-reads the real canvas.
- **`HTMLCanvasElement.toDataURL`**: returns the captured data URL string
  as-is. Deliberately does *not* decode/redraw/re-encode a canvas, since
  that would mean invoking the browser's native PNG encoder at runtime. This
  also means it's a fixed value per build, not re-randomized per session;
  edit `fingerprint.json` and rebuild if you want a different one.
- **`WebGLRenderingContext`/`WebGL2RenderingContext.getParameter`**: looks
  the requested parameter up in a small table built from the captured
  baseline (vendor, renderer, max texture size). Any parameter not in that
  table returns `null` rather than falling through to a real GPU query, so
  no WebGL parameter served by this extension ever reaches native code,
  at the cost of exotic/rarely-queried parameters returning a placeholder
  instead of a real-looking value.
- **`AudioBuffer.getChannelData`**: builds the returned `Float32Array` from
  captured samples plus noise. Never runs the real audio rendering pipeline.

**Exception: `RTCPeerConnection`.** This one still constructs a real peer
connection, because WebRTC has to actually function for sites that use it
for calls or screen sharing (Teams, Meet, etc.); fabricating a fake
connection object would just break those. What it does instead is filter
`icecandidate` events so any candidate carrying a private/local IP address
never reaches the page's event handler. The filter regex is unit-tested
against 10 cases including the private-range boundary (172.16-172.31
caught, 172.32 correctly not); see "Confirmed working" below.

Like `window.AudioContext` in the hard-block feature below,
`window.RTCPeerConnection` is locked with `Object.defineProperty(...,
{ writable: false, configurable: false })` rather than a plain assignment,
for the same reason: a page script running after this one could otherwise
silently reassign it and undo the filter.

## Signals captured and served

### Core signals

Beyond canvas/WebGL/audio, the capture script also grabs a set of static
properties confirmed to be read by AliExpress's own `fireyejs.js` risk
script:

- `navigator.hardwareConcurrency`, `navigator.deviceMemory`
- `screen.colorDepth`, `screen.pixelDepth`
- `navigator.userAgent`, `navigator.platform`

The first four are pure JS property reads with no real computation behind
them, so overriding them is free and has no mismatch risk.

**`userAgent`/`platform` are the exception: read this before editing them.**
Overriding `navigator.userAgent` only changes what JavaScript on the page
sees. It does **not** change the real `User-Agent` HTTP header your browser
sends with every request. If you edit `fingerprint.json` to a fake UA
string, a site that compares the JS-visible UA against the header UA will
see a mismatch, which is itself a well-known bot-detection signal, and can
make you look *more* suspicious than not touching it at all. Recommendation:
leave `userAgent` and `platform` as captured (your real values) unless you
also add a `declarativeNetRequest` rule to rewrite the header to match,
not included here, since it needs an extra manifest permission and is easy
to get subtly wrong.

### Further signals (screen, plugins, webdriver, WebGL extensions, media formats)

These map to [Ars Technica's coverage](https://arstechnica.com/security/2026/08/aliexpress-caught-fingerprinting-visitors-after-sending-inaudible-sounds-to-browsers/)
of Callaghan's full list of AliExpress's fingerprinting methods:

- **`screen.width`/`height`/`availWidth`/`availHeight`, `devicePixelRatio`**:
  unlike the other captured fields, `obscure` doesn't jitter your real
  captured resolution here; it replaces it wholesale with one of nine
  internally-consistent (logical-resolution, DPR) combinations representing
  genuine physical-monitor-plus-Windows-scaling setups (e.g. a 1920x1080
  panel at 125% scaling correctly reports logical 1536x864 with DPR 1.25,
  not 1920x1080 at 1.25). An unusual real resolution is itself a signal;
  blending into a common one hides better than adding noise to it would.
  `window.innerWidth`/`innerHeight` are deliberately *not* touched: CSS
  layout actually reads those, so faking them would create a visible
  real-vs-reported mismatch, unlike `screen.*` which is pure reporting.
- **`navigator.plugins`/`mimeTypes`**: always report empty, unconditionally,
  regardless of what's actually installed. No captured baseline needed.
- **`navigator.webdriver`**: always `false`. Already false on a normal,
  non-automated Chrome session; this is mainly a safety net.
- **`WebGLRenderingContext.getSupportedExtensions()`/`getShaderPrecisionFormat()`**:
  a separate API surface from `getParameter()`, confirmed read by AliExpress
  per the article (`getParameter` alone doesn't cover these).
  `getSupportedExtensions()` is captured from your real machine, but
  `obscure` wholesale replaces it with a fixed, hardcoded 30-item list,
  not derived from your capture at all, no per-run variance. That list was
  itself sourced from a real verified capture (a genuine
  Windows/ANGLE/D3D11 Chrome session) with the small set of extensions
  known to actually vary by GPU/driver (timer queries, a couple of
  compressed-texture formats) removed, so it's real data, just not tied to
  any one machine; every install of this tool ends up reporting the same
  list. That's deliberate: this field is about consistency across installs
  rather than per-user uniqueness, unlike the vendor/renderer strings. This
  list, along with every other pool `obscure` draws from (GPU vendor/renderer
  pairs, screen resolutions, hardware concurrency options, etc.), lives in
  [`src/obscure-pools.json`](src/obscure-pools.json); see
  [`src/obscure-pools.md`](src/obscure-pools.md) for the format and
  per-pool restrictions.
  `getShaderPrecisionFormat()` is captured for all 12 (shader type,
  precision type) combinations and left untouched by `obscure`; those
  values are essentially IEEE-754 standard-compliance numbers, the same
  across GPU vendors on modern hardware, so jittering them would make them
  look *less* realistic, not more. Both report under a shared
  `webglExtensions` counter in the popup, separate from `getParameter`.
- **`HTMLMediaElement.canPlayType()`/`MediaCapabilities.decodingInfo()`**:
  confirmed read by AliExpress's own script (direct grep hit on
  `canPlayType`, not just article-sourced). Both are answered from the same
  captured probe table: `canPlayType()` is looked up by exact format/codec
  string; `decodingInfo()` extracts the `contentType` from its config object
  and does the same lookup, converting the `''`/`'maybe'`/`'probably'`
  answer into `{supported, smooth, powerEfficient}` (smooth/powerEfficient
  just mirror supported, a reasonable simplification and not a fully
  accurate emulation of the real API's finer distinctions). The probe table
  covers 20 common format/codec strings (H.264, HEVC, VP8/VP9, Theora, MP3,
  AAC, Vorbis, Opus, FLAC, WAV, plus bare container types); anything outside
  that list gets the "can't play this" answer rather than falling through
  to a real capability check. Both report under a shared `canPlayType`
  counter in the popup. `obscure` doesn't touch this probe table; codec
  support is largely determined by the Chromium build itself rather than
  the underlying hardware, so it's already fairly uniform across desktop
  Chrome installs, similar to shader precision below.

### Deliberately not spoofed

- **`window.innerWidth`/`innerHeight`**: see above; CSS layout reads these.
- **`navigator.userAgent`/`platform`**: see above; HTTP header mismatch risk.
- **Browser performance timing**: spoofing timing convincingly is harder
  than the others; noisy/wrong timing data risks looking *more* anomalous
  than doing nothing, the same tension as the `AudioContext`
  throw-vs-fake decision below.
- **Mouse/touch/focus/scroll events, device motion/orientation**: a
  different category of signal entirely (behavioral biometrics / mobile
  sensors), not a static value that can be "spoofed" the same way.
- **Full WebRTC fingerprint**: only the local-IP-leak vector is filtered;
  codec lists and SDP-level behavior aren't touched.

## AnalyserNode (live audio fingerprinting)

Public research in August 2026 ([Matt Callaghan's original writeup](https://blog.laserphile.com/2026/08/aliexpress-webpage-keeping-multipoint.html),
covered by Tom's Hardware, CyberNews, and Ars Technica)
documented AliExpress's actual audio-fingerprinting technique: a live
oscillator feeding an `AnalyserNode`, plus a separate silent (`gain = 0`)
path to the destination, read repeatedly via
`getFloatFrequencyData()`/`getByteFrequencyData()`/`getFloatTimeDomainData()`/
`getByteTimeDomainData()`. This is a **different API surface** from
`AudioBuffer.getChannelData()` (the offline-render pattern); the two don't
overlap, so a site using only the AnalyserNode pattern needs this coverage
separately. All four AnalyserNode read methods are overridden the same way
as the other APIs: served from a captured baseline (`analyserFrequencyData` /
`analyserTimeDomainData`, captured by reproducing the same oscillator ->
analyser -> silent-gain graph) plus per-session noise, never reading the
real analysis.

Data-spoofing alone doesn't address the Bluetooth-multipoint interference
symptom from the original report, though: that happens because the site
holds a real, continuously-processing `AudioContext` open at the OS audio
level, and spoofing what the *read* methods return doesn't stop that
session from existing. See "Hard-block list" below for the feature that
actually addresses this.

You'll need to re-run the capture script to pick up the
`analyserFrequencyData`/`analyserTimeDomainData` fields before rebuilding if
you're on an older `fingerprint.json`; the AnalyserNode override silently
does nothing if both are absent.

## Hard-block list

For sites where you want to go further than data-spoofing (AliExpress,
given the above, is the seeded default in `hardblock-list.json`), there's a
second list, managed the same way from the popup ("Hard-block audio on
this site & reload", plus a per-origin button in the "Activity on this
page" breakdown, plus the editable "Hard-blocked (audio) sites" list). A
site can be spoofed, excluded, hard-blocked, or spoofed-and-hard-blocked
(AliExpress's own combination); the one contradictory pairing, excluded
(real values everywhere) plus hard-blocked (an actively faked
`AudioContext`) at the same time, isn't allowed to persist: the popup's
`saveExcludeList` prunes any hard-block entry for a host (or a subdomain of
it) the moment that host is added to the exclude list, whichever way it
got added (a quick-action button, the manual pattern field, or editing an
existing entry in place). It only runs in that direction, hard-blocking an
already-excluded site doesn't clear the exclude entry back out.

On a hard-blocked site, `audio-hardblock.js` replaces `window.AudioContext`
(and `webkitAudioContext`) with a **fully functional fake**: real method
names (`createOscillator`, `createAnalyser`, `createGain`, `.connect()`,
`.start()`, `currentTime`, `state`, etc.), no exceptions, and its
`AnalyserNode` methods return the same captured-baseline-plus-noise data as
the rest of the tool. Deliberately not a throw-on-construct block: an
uncaught exception on a core API is itself a distinguishing, detectable
signal ("a modern browser that can't create an AudioContext"), which some
anti-bot systems specifically watch for. A fake that looks and behaves
normally is far harder to tell apart from a real one.

Because no real `AudioContext` is ever constructed, no live audio session
is ever opened at the OS level on a hard-blocked site, which is what
actually stops the Bluetooth-interference side effect, not just the
fingerprint. `OfflineAudioContext` is untouched by this (it never touches
real hardware anyway, and its output already goes through content.js's own
overrides), so offline-render-based audio use on a hard-blocked site still
works normally.

The `window.AudioContext` property is locked with
`Object.defineProperty(..., { writable: false, configurable: false })`
rather than a plain assignment: a plain `window.AudioContext =
FakeAudioContext` can be silently overwritten by a page script that runs
later, such as AliExpress's own `fireyejs.js`, which does exactly this on
its own. Locking the property confirmed surviving that reassignment attempt
in live testing.

**Trade-off**: any site that actually plays real audio through the
real-time Web Audio API (an equalizer, a visualizer, in-page audio
processing) will go silent on a hard-blocked site, since the fake context
never reaches real hardware. This is why it's a separate, deliberately
narrow list rather than a default behavior: fine for a shopping site with
no legitimate real-time-audio use case, not something to apply broadly.

## Per-site management (toolbar popup) and per-origin activity

Some sites (Microsoft Teams was the motivating example) depend on real
canvas/WebGL/audio/WebRTC behavior and will misbehave if this extension
spoofs those APIs on them. Both the exclude list and the hard-block list
are managed live from the extension's toolbar popup, no rebuild required:

- **"Exclude this site & reload"** / **"Hard-block audio on this site &
  reload"**: adds the current tab's top-level hostname (and all its
  subdomains) to the respective list and reloads the tab immediately. Before
  adding, it checks whether the host is already covered by an existing
  entry in that list (e.g. clicking this on `www.aliexpress.us` when
  `*://*.aliexpress.us/*` is already present adds nothing, since that
  pattern's subdomain wildcard already matches `www`), it just reloads the
  tab in that case. This check only guards the quick-action buttons;
  the manual "add a pattern by hand" fields below apply whatever you type
  without checking for overlap, since a hand-typed pattern might
  intentionally use a different shape.
- **"Activity on this page"** breaks activity down **per origin, including
  iframes**, not just the top-level tab URL. `content.js`/`bridge.js` are
  registered with `allFrames: true`, so a cross-origin frame embedded by
  the page (an auth iframe, an SSO redirect frame) gets patched and its
  calls reported separately, under its own origin, with its own
  **Exclude**/**Hard-block audio** buttons. This is the mechanism for
  cases like Teams embedding other `*.microsoft.com` origins: if an
  embedded origin itself calls WebGL/canvas/audio, it shows up here as its
  own entry, distinguishable from the top-level site, and you can act on
  just that one origin rather than guessing at a broad pattern upfront.
- The exclude list and hard-block list are each shown on their own tab
  ("Excluded (N)" / "Hard-blocked (N)", the count updating live)
  rather than stacked one above the other, so the popup stays a manageable
  height as either list grows. Each tab shows every pattern currently
  active in that list, sorted alphabetically by domain (the host portion of
  the pattern, wildcard prefix stripped) rather than insertion order, with
  an inline-editable text field and a remove button per entry, plus a field
  to add an arbitrary pattern by hand. Editing or removing an entry is
  keyed by the pattern's value, not its position in the list, so sorting
  for display never risks editing/removing the wrong entry.
- Each tab also has an **Import file...** button (`parseImport`/`wireImport`
  in `popup.js`). It reads a JSON array of strings (the seed-file shape) or
  plain text with one entry per line. Comments are stripped first: a
  trailing `# note` (the `#` must follow whitespace, so a `#` inside a
  pattern's path survives) is dropped, and blank lines and whole-line
  comments are skipped without being counted. Each remaining line is then
  one of two things. A line containing `://` must already be a valid
  match pattern and is kept exactly (so path-scoped entries such as
  `*://www.google.com/recaptcha/*` survive). A line without `://` must be
  only a domain (`example.com`, `*.example.com`) and is wrapped as
  `*://*.HOST/*`, the same shape the quick-action buttons produce (a
  dotless host counts only as an explicit wildcard, `*.gov`). Anything
  else, such as `example.com/path` or `example.com:8080`, is ignored and
  only counted in the result, not treated as an error. Filtering matters
  more here than for the manual field: an invalid pattern makes
  `chrome.scripting.registerContentScripts` throw, and `background.js` never
  answers the save message in that case, so one bad line in a bulk file
  would otherwise leave the whole list unsaved. Import only adds (entries
  already present or repeated in the file are skipped, nothing is removed)
  and saves through the same `saveExcludeList`/`saveHardblockList` as manual
  adds, so importing into the exclude list also prunes matching hard-block
  entries. The result (added, duplicate, ignored counts) shows under the
  button.
- The toolbar icon's badge shows the running total across all origins on
  the active tab.

Patterns use [Chrome's match-pattern syntax](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns):
a scheme (usually `*://`), a host (`*.` prefix matches all subdomains), and
a path ending in `/*`. Editing either list updates `chrome.scripting`'s
dynamically registered content scripts immediately, but, same as any
content-script change, it only takes effect on a page's *next* load, not
retroactively on an already-open tab, which is why the popup's quick-action
buttons reload the tab for you.

`exclude-list.json`/`hardblock-list.json` in the project root are
**seeds** only; `background.js` reads them once, on first install, to populate
`chrome.storage.local` if nothing's stored yet. After that, all edits live
in storage and persist across browser restarts and rebuilds; re-running the
build script does not reset your popup-managed lists. Pass different seed
files as the build script's third/fourth arguments if you want a different
starting point for a fresh install.

**Editing storage vs. editing the seed file**: if you've already installed
the extension and add a site via the popup, that edit lives in
`chrome.storage.local`, not in the JSON seed file on disk. Editing
`exclude-list.json`/`hardblock-list.json` afterward only affects *future*
fresh installs; to change or remove an already-running extension's list,
do it from the popup itself.

To verify a site is excluded without opening the popup: check
`window.__fpSpoofActive` in its DevTools console; `undefined` means the
script didn't run there.

## Why CDN-hosted script domains don't need their own list entries

A common point of confusion: AliExpress's fingerprinting code
(`fireyejs.js`, `collina.js`, etc.) is physically hosted on CDN domains like
`assets.aliexpress-media.com` and `o.alicdn.com`; you can see this
directly in the page's Network tab. It might seem like those domains should
need their own exclude/hard-block entries, or that "Activity on this page"
should show them as separate entries. Neither is true, and here's why:

**A `<script src="...">` tag does not create a new origin context; only
`<iframe>`s do.** When a page includes
`<script src="https://assets.aliexpress-media.com/.../fireyejs.js">`, the
browser fetches that file's *text* from the CDN, but then executes it *as
if it were the including page's own code*: same `window`, same
`document`, same `location.origin` (the top-level page's origin, e.g.
`https://www.aliexpress.us`). This is standard web-platform behavior, not
specific to this project: it's exactly why third-party `<script>` tags
(analytics, ads, etc.) can freely read/manipulate the including page's DOM,
unlike an `<iframe src="...">`, which genuinely does get its own separate,
sandboxed origin.

Consequences:

- Every fingerprinting call made by code loaded via `<script src>`
  correctly gets attributed to the origin of the page that *included* it,
  not the CDN it was *fetched from*; this is accurate, not a gap.
- A CDN/asset-hosting domain only ever needs its own exclude/hard-block
  entry if it's genuinely embedded as an `<iframe src="...">` on the page
  (a real, separate execution context), not merely referenced in a
  `<script src>` or `<img src>`. Check the page's actual DOM/iframe
  structure (not just the Network tab's list of fetched URLs) before
  adding a pattern for a CDN domain; if it's not iframed, the entry will be
  a silent no-op, since there's no frame at that origin to ever match.

## How call detection works (and its limits)

`content.js` runs in the page's "MAIN world" (required so its prototype
patches affect the real `window.AudioContext` etc. that the page uses), but
MAIN-world scripts have no `chrome.runtime` access, so they can't
message the background worker directly. Each patched method instead does a
`window.postMessage` on a random, per-build channel token; `bridge.js` (a
separate, isolated-world content script sharing the same token) listens for
exactly that and relays it to `background.js`.

Worth knowing: `postMessage` on a page dispatches to *all* listeners in
that window, including the site's own scripts; restricting the
`targetOrigin` doesn't hide it from other same-origin code. A site
specifically looking for this would be able to detect that a spoofing
extension is present by listening for the message traffic, even though the
random channel token makes it impractical to guess without watching for
it. This is a known, accepted trade-off for getting the call-count feature
at all; it doesn't affect the actual spoofed values sites receive, only
whether the *presence* of spoofing is detectable by a sufficiently
determined page.

`bridge.js`'s `chrome.runtime.sendMessage` call is wrapped in a try/catch:
`chrome.runtime` becomes unavailable to an already-injected content script
once the extension that injected it reloads ("Extension context
invalidated"). A tab that already had `bridge.js` running before a reload
will throw exactly this error the next time it tries to report a call, on
whatever page happens to be open at the time; nothing about the specific
page matters. Without the guard this throws an uncaught `TypeError` into
the page's console; with it, a spoof-call in that context just silently
isn't counted rather than breaking anything. Reloading the tab (not just
the extension) clears it.

## Confirmed working against the real site

Everything above was built from public research and our own inspection of
AliExpress's scripts, then verified with synthetic test calls during
development. The popup's "Activity on this page" gives a stronger kind of
proof, though: it counts calls made by whatever is actually running on the
page, which on a real AliExpress visit means AliExpress's own
`fireyejs.js`/`collina.js`, not anything this project's test scripts
triggered.

On a plain, ordinary page load of AliExpress (no interaction, no manual
testing), the popup showed:

```
Canvas (getImageData)                1
Canvas (toDataURL)                   6
WebGL (getParameter)                12
WebGL (extensions/shader precision)  1
```

Every one of those calls was intercepted and served fake data instead of
real values, and the last one is the most significant:
`getSupportedExtensions()`/`getShaderPrecisionFormat()` had only ever been
*article*-sourced ([Callaghan's deobfuscation work](https://blog.laserphile.com/2026/08/aliexpress-webpage-keeping-multipoint.html)), since our own direct
string search of `fireyejs.js` never found those method names; the
obfuscation defeats a plain grep. This is independent, first-party
confirmation that AliExpress's real script calls it, not just a claim
taken on the article's word. Between this and the `toDataURL`/`getParameter`
counts (which roughly doubled across two checks a few minutes apart,
suggesting the site's fingerprinting pass runs more than once per visit),
every vector documented in the public research that this project covers is
confirmed both present in AliExpress's real production code and
successfully intercepted.

Other things directly verified live (not just unit-tested or structurally
reviewed):

- Screen dimensions/DPR and WebGL extensions: confirmed matching the
  *obscured* baseline (the pool-selected/fixed-default values, not the raw
  capture) on a real AliExpress page load.
- `navigator.plugins`/`mimeTypes` (empty) and `navigator.webdriver`
  (`false`): confirmed matching their always-on behavior, independent of
  any captured or obscured data.
- WebGL shader precision and `canPlayType`/`MediaCapabilities`: confirmed
  matching the *captured* baseline. Neither is touched by `obscure`
  (see "Signals captured and served" above for why), so these are your
  real machine's values, not randomized ones.
- The `AudioContext` hard-block property lock: confirmed surviving
  AliExpress's own reassignment attempt (see "Hard-block list" above).
- `RTCPeerConnection` filter logic: unit-tested against 10 cases including
  the private-IP-range boundary; a real ICE-gathering test against
  AliExpress produced no raw private/local IP candidates (one candidate was
  Chrome's own built-in mDNS-obfuscated hostname, unrelated to this
  project's filter; the other was a public srflx IP, which isn't a privacy
  concern this filter targets).
- The `RTCPeerConnection` property lock: confirmed holding on a real
  AliExpress page load (`Object.getOwnPropertyDescriptor` shows
  `configurable: false, writable: false`), with construction, `onicecandidate`
  wrapping, and ICE candidate filtering all still functioning correctly
  after the lock.
- The popup UI itself and the full call-tracking pipeline
  (`content.js` -> `bridge.js` -> `background.js` -> popup): confirmed
  rendering and reporting correctly against a real tab.
