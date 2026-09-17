# Browser Fingerprint Spoof

*A personal browser-fingerprint countermeasure: captures a real canvas/WebGL/audio
baseline from your own Chrome, then serves it back with per-session noise via an
unpacked extension, built in response to AliExpress's documented audio/canvas
fingerprinting.*

## Why this exists

In August 2026, researcher Matt Callaghan ("laserphile") published the
original writeup, [*AliExpress webpage keeping multipoint Bluetooth
headphones active with WebAudio
fingerprinting*](https://blog.laserphile.com/2026/08/aliexpress-webpage-keeping-multipoint.html),
after tracing a Bluetooth multipoint dropout back to two hidden, silently
connected `AudioContext` graphs on the AliExpress homepage. It was then
covered by [Tom's Hardware](https://www.tomshardware.com/tech-industry/cyber-security/aliexpress-allegedly-uses-your-browsers-audio-system-to-fingerprint-your-pc-hidden-code-runs-even-when-no-sound-is-playing),
[CyberNews](https://cybernews.com/security/aliexpress-alibaba-audio-systems-tracking/),
and [Ars Technica](https://arstechnica.com/security/2026/08/aliexpress-caught-fingerprinting-visitors-after-sending-inaudible-sounds-to-browsers/),
which documented AliExpress silently fingerprinting
visitors through a battery of browser APIs: canvas rendering, WebGL/GPU
info, hardware specs, and, most invasively, a live Web Audio graph (a
sawtooth oscillator feeding an `AnalyserNode` at zero gain) that stays open
in the background even when no media is playing. That live session was
severe enough to interfere with a user's Bluetooth multipoint headphone
connection. None of it is disclosed or consented to. This project's own
inspection of the live site confirmed the two scripts responsible,
`fireyejs.js` and `collina.js`, and the exact APIs each one reads.

Callaghan's own writeup also documents a way to stop it: two uBlock Origin
filter rules that block the `collina.js`/`fireyejs.js` requests outright.
This project deliberately takes a different approach. Blocking removes the
fingerprinting code, but it also leaves a different kind of evidence
behind: a request that never completes, an `AudioContext` that silently
doesn't exist, a canvas read that throws instead of returning pixels. Any
of those is itself a distinguishing signal, in the same category as
`navigator.webdriver === true` or a headless-browser tell: a site scoring
"this client refused to answer my fingerprinting probes" as suspicious can
flag on that just as easily as on the fingerprint itself. The design goal
here is for AliExpress's own code to run to completion, unaware anything is
wrong, and get back data that looks exactly like a normal answer, just not
*your* answer.

This project is a personal countermeasure, not a general privacy tool: it
captures a real fingerprint baseline from your own browser, then serves
that baseline back to every site with per-session noise instead of your
live, real values, so a fingerprinting script gets *a* consistent-looking
fingerprint, just not one computed from your actual hardware on every visit.
For AliExpress specifically, given the audio technique's side effects,
there's a second, more aggressive tier on top of that: a fully-functional
*fake* `AudioContext` that never opens a real audio session at all, which is
what actually stops the Bluetooth interference, not just the fingerprint
itself.

**How AliExpress is handled, concretely**: it gets the same data-spoofing as
every other site (canvas, WebGL, `AudioBuffer`, `AnalyserNode`, navigator/screen
properties, WebRTC IP filtering), *plus* it's pre-seeded in
`hardblock-list.json`, so its real-time `AudioContext` is replaced outright.
This has been directly verified against AliExpress's real production
code, not just tested in isolation; see
[TECHNICAL.md](TECHNICAL.md#confirmed-working-against-the-real-site) for
the full mechanism and verification details.

## What this tool does

Captures a real canvas/WebGL/audio fingerprint baseline from your own browser,
lets you edit or randomize it, and packages it into an unpacked Chromium
extension (Chrome/Edge/Brave) that serves the (optionally edited) baseline
back with fresh per-session noise on every page load.

## Requirements

- [Node.js](https://nodejs.org/) 18+
- First run only: `npm install` then `npx playwright install chrome`
  (the Windows/Linux wrapper scripts do this for you automatically)

## 1. Capture

Windows:
```powershell
.\capture.ps1
```

Linux/macOS:
```bash
./capture.sh
```

Both accept an optional output path as the first argument (defaults to
`fingerprint.json` in this folder). This launches your real installed Chrome,
reads canvas/WebGL/audio values from it, and writes them to the JSON file.

## 2. Obscure (optional, recommended)

Windows:
```powershell
.\obscure.ps1 -InputFile fingerprint.json
```

Linux/macOS:
```bash
./obscure.sh fingerprint.json
```

Rewrites the fields worth changing (`webgl` vendor/renderer/max texture
size, `navigatorInfo.hardwareConcurrency`/`deviceMemory`, and a freshly
synthesized `canvasDataURL`) with randomized-but-realistic alternate
values (GPU strings stay Windows/D3D11-plausible, `deviceMemory` stays
within Chrome's actual spec-quantized set, etc.), and jitters the large
baseline arrays (`canvasImageData`, `audioSamples`, `analyserFrequencyData`,
`analyserTimeDomainData`) on top of the noise they already get at runtime.
Always picks a value different from whatever's currently there. Prints a
before/after summary so you can see exactly what changed.

All the pools/lists this draws from (GPU vendor/renderer pairs, screen
resolutions, hardware concurrency options, etc.) live in
[`src/obscure-pools.json`](src/obscure-pools.json), separate from the logic
that uses them; edit that file directly if you want to add/remove/change
candidate values, no code changes needed. See
[`src/obscure-pools.md`](src/obscure-pools.md) for the format, per-pool
restrictions (`deviceMemoryPool` in particular has a hard one: Chrome's
API only ever reports specific quantized values), and what happens if an
entry is malformed.

By default it overwrites the input file in place and picks fresh random
values each run; rerun it any time to rotate to a new fake identity. Pass
an output path as the second argument to write elsewhere instead, and
`-Seed <number>` (`seed` as the third argument on Linux/macOS) for a
reproducible run instead of a random one.

You can also just open `fingerprint.json` in a text editor and tweak values
by hand, before or instead of running this; the two aren't mutually
exclusive. Either way, leave `userAgent`/`platform` alone; see
[TECHNICAL.md](TECHNICAL.md#signals-captured-and-served) for why.

## 3. Build the extension

Windows:
```powershell
.\build.ps1 -InputFile fingerprint.json -OutputDir output\fp-extension
```

Linux/macOS:
```bash
./build.sh fingerprint.json output/fp-extension
```

`OutputDir` defaults to `output/fp-extension` if omitted.

## 4. Load it into a browser

1. Go to `chrome://extensions` (or `edge://extensions`, `brave://extensions`)
2. Enable **Developer mode**
3. **Load unpacked** → select the generated output folder

Because the captured data is baked into `content.js` at build time, the
output folder is fully self-contained: copy it to another machine or
browser profile and load it the same way, no server or dependency required.

### Packing for other machines / internal deployment

Chrome's "Pack extension" feature (in `chrome://extensions`, Developer
mode) turns the output folder into a `.crx` file plus a `.pem` private key
for distribution to other machines, or for enterprise-managed installs that
skip the "Developer mode" indicator entirely (Windows Registry/Group
Policy, or a managed-policy JSON file on Debian/Linux). Generated packaging
files (`.crx`, `.pem`, an update manifest, and a script to recompute the
extension's ID from the `.pem`) live in `output/` alongside the unpacked
extension; see [`output/HOW-TO-INSTALL.txt`](output/HOW-TO-INSTALL.txt)
for the exact registry keys, policy file locations, and commands. The
`.crx` reflects whatever `fingerprint.json` looked like at the moment you
packed it, not necessarily your current one; re-pack after rebuilding if
you want the two in sync.

## Re-running after edits

Any time you change `fingerprint.json` (by hand, or by re-running
`obscure`), just re-run the build script; it regenerates `content.js` (and
`audio-hardblock.js`) in the output folder from scratch. `obscure` itself is
safe to run repeatedly too: each run without `-Seed` picks fresh random
values, so it's the normal way to rotate to a new fake identity over time.

## Managing sites (toolbar popup)

Some sites (Microsoft Teams was the motivating example) depend on real
canvas/WebGL/audio/WebRTC behavior and break if this extension spoofs those
APIs on them. Two lists, both editable live from the toolbar popup, no
rebuild required:

- **Exclude list**: no spoofing at all on these sites, real values
  everywhere.
- **Hard-block list** goes further than data-spoofing: real-time
  `AudioContext` is replaced with a fake one entirely, so no live audio
  session ever opens (AliExpress is pre-seeded here by default).

Excluding a site also removes any hard-block entry for it (and for its
subdomains), since "real values everywhere" and "actively fake
`AudioContext`" contradict each other; hard-blocking a site doesn't remove
an exclude entry the other way around.

The popup also shows a live "Activity on this page" breakdown: which
fingerprinting APIs have actually been called on the current tab, broken
down per origin (including iframes), with quick Exclude/Hard-block
buttons right next to each one.

A site can be spoofed (the default), excluded, hard-blocked, or any
combination. Local/private-network hosts (RFC 1918, loopback, and `*.local`,
e.g. a router admin page or a browser-based VM console) are never spoofed,
automatically, with no list entry needed; see
[TECHNICAL.md](TECHNICAL.md#runtime-behavior-no-native-calls-at-serve-time)
for why. See [TECHNICAL.md](TECHNICAL.md#per-site-management-toolbar-popup-and-per-origin-activity)
for the full mechanism, including why some CDN-hosted script domains don't
need their own list entries.

### What's pre-seeded in the exclude list

`exclude-list.json` ships with domains where spoofing is more likely to cause
harm than provide any privacy benefit. These aren't general privacy picks;
they're sites where changing fingerprint signals between visits can itself
trigger re-verification or get flagged:

- **Video/chat apps that lean on WebRTC**: Teams, Zoom, Google Meet, Webex,
  Slack, where real device behavior matters for the call itself.
- **Identity providers**: Google, Microsoft, Apple, Okta, Auth0, where
  risk-based authentication uses fingerprint stability as a signal, and
  there's no privacy upside to spoofing a flow where you're actively
  authenticating as yourself.
- **Enterprise/office apps with continuous device-trust checks**: Office,
  Outlook, SharePoint, where Conditional-Access-style policies re-evaluate
  device signals throughout a session, not just at login.
- **Government and identity-verification sites**: every `.gov` domain
  (federal and state alike; covers things like the IRS, a state DMV, or a
  state tax portal in one pattern) plus `id.me`, which many government
  agencies delegate identity verification to. Same reasoning as the identity
  providers above, just as strong.
- **CAPTCHA/bot-challenge widgets**: Cloudflare Turnstile
  (`challenges.cloudflare.com`), Google reCAPTCHA
  (`google.com/recaptcha`, `recaptcha.net`), and hCaptcha
  (`newassets.hcaptcha.com`). These run their own
  fingerprint checks as part of the challenge itself, and unlike the other
  categories here, this isn't just extra friction: confirmed in practice
  that a spoofed fingerprint can stop the Cloudflare widget from completing
  at all, not just make it more suspicious.
- **AliExpress's own captcha iframe** (`login.aliexpress.com`,
  `login.aliexpress.us`): a first-party version of the same problem, not a
  third-party vendor domain. AliExpress's own risk-scoring can pop this as
  an interstitial on any page, not just login, and confirmed from a HAR
  capture that it renders its slider-puzzle image via `html2canvas`, which
  reads the canvas back with the same `getImageData`/`toDataURL` calls this
  tool spoofs, so the puzzle came back unsolvable rather than just
  triggering more often.

### Bot-heavy checkout and ticketing sites

Sites with aggressive bot-detection on checkout (ticketing platforms,
airline booking, high-demand retail drops) can react to an inconsistent
fingerprint by throwing more CAPTCHAs your way, not by breaking outright.
That's a weaker, more situational case than the categories above, so none of
these are pre-seeded anywhere. If you notice a specific site doing this,
that's exactly what the toolbar popup's per-site **Exclude** button is
for: add it on the spot from the "Activity on this page" view rather than
guessing in advance which sites might react this way.

### Optional exclude lists

A few more categories are common enough to ship as ready-made lists, but
narrow or opinionated enough that they're opt-in rather than merged into the
default list:

- [`exclude-financial.json`](exclude-financial.json): major banks,
  brokerages, and payment processors, where fraud detection leans on
  fingerprint stability even more heavily than the built-in categories.
- [`exclude-streaming.json`](exclude-streaming.json): Netflix, Disney+,
  Hulu, Max, Peacock, Paramount+. Video/audio playback itself is unaffected
  by this tool either way, but these services also do account/household
  device recognition separate from DRM, and an inconsistent fingerprint can
  trigger "new device" verification more often.
- [`exclude-remote-access.json`](exclude-remote-access.json): Chrome
  Remote Desktop, TeamViewer, AnyDesk, Splashtop, LogMeIn, GoToMyPC, RealVNC,
  using the same real-time WebRTC-behavior reasoning as the video/chat apps
  above.
- [`exclude-software-licensing.json`](exclude-software-licensing.json):
  Adobe, Autodesk. Per-device-limited licenses use fingerprinting to count
  activations; a fingerprint that changes on every visit can look like a new
  device each time and burn activation slots.

None of these are read by the build step unless you ask for them; pass any
combination as a comma-separated list instead of editing `exclude-list.json`
itself:

Windows:
```powershell
.\build.ps1 -InputFile fingerprint.json -ExcludeList exclude-list.json,exclude-financial.json,exclude-streaming.json
```

Linux/macOS:
```bash
./build.sh fingerprint.json output/fp-extension exclude-list.json,exclude-financial.json,exclude-streaming.json
```

`-HardblockList`/the fourth `build.sh` argument accepts the same
comma-separated syntax, for combining multiple hard-block sources the same
way. None of these lists are exhaustive; add your own bank, streaming
service, or tool the same way (a file of your own, by hand, or via the popup
after install) if it's not already covered.

## Project layout

```
capture.ps1 / capture.sh    - capture a real fingerprint from your browser
obscure.ps1 / obscure.sh    - randomize the obscurable fields
build.ps1 / build.sh        - package the extension
fingerprint.json            - your active (obscured) fingerprint data
exclude-list.json           - seed for the exclude list (popup-managed after install)
exclude-financial.json      - optional: banks/brokerages, pass to build.ps1/.sh to include
exclude-streaming.json      - optional: streaming services, pass to build.ps1/.sh to include
exclude-remote-access.json  - optional: remote-desktop tools, pass to build.ps1/.sh to include
exclude-software-licensing.json - optional: per-device-licensed software, same as above
hardblock-list.json         - seed for the hard-block list (popup-managed after install)
src/                        - all implementation (.js/.html) and templates
output/                     - generated extension (gitignored)
```

## More detail

This README covers the what and how-to. For the full mechanism, including
how each spoofed API actually works, what's deliberately left unspoofed and
why, the live-audio-fingerprinting technique and the hard-block that
counters it, how per-origin activity tracking works, and the live
verification against AliExpress's real production code, see
[TECHNICAL.md](TECHNICAL.md).
