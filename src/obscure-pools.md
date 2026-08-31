# obscure-pools.json

Candidate values `obscure-fingerprint.js` picks from when rewriting
`fingerprint.json`. Edit this file directly to add, remove, or change
candidates, no code changes needed. `obscure-fingerprint.js` reads it fresh
on every run, so changes take effect the next time you run `obscure`.

All the picking logic works off array length, not fixed indices, so pools
can grow or shrink freely. Confirmed by direct test: temporarily adding a
new `gpuPool` entry and a new `hardwareConcurrencyPool` value, both got
picked and served within 10 runs across different seeds.

## Format

Top-level object with six keys, each an array:

```json
{
  "gpuPool": [ { "unmaskedVendor": "...", "unmaskedRenderer": "..." }, ... ],
  "maxTextureSizePool": [ 4096, 8192, ... ],
  "defaultExtensions": [ "ANGLE_instanced_arrays", ... ],
  "hardwareConcurrencyPool": [ 4, 6, 8, ... ],
  "deviceMemoryPool": [ 2, 4, 8, ... ],
  "screenPool": [ { "width": 1366, "height": 768, "devicePixelRatio": 1 }, ... ]
}
```

## What happens if an entry is malformed

- **Missing a required key** (see per-pool notes below): no crash. The
  affected sub-field just falls back to leaving the real captured value
  untouched for that field, so you get a silently incomplete entry rather
  than an error. Worth double-checking your additions have every required
  key.
- **Invalid JSON syntax anywhere in the file**: `obscure-fingerprint.js`
  fails immediately with a JSON parse error when it starts. Loud, not
  silent: you'll know right away if you broke the file structure.

## Per-pool notes and restrictions

### `gpuPool`

Each entry needs **both** `unmaskedVendor` and `unmaskedRenderer`; these
are served together as a pair via `getParameter(UNMASKED_VENDOR_WEBGL)`/
`getParameter(UNMASKED_RENDERER_WEBGL)`, so don't add one without the other.

**Restriction**: keep entries Windows/D3D11-plausible (`ANGLE (...)` renderer
strings) as long as `fingerprint.json`'s `navigatorInfo.platform` stays your
real `"Win32"`; pairing a Windows platform with, say, a macOS Metal-style
renderer string would itself be an inconsistency a fingerprinter could flag.
If you ever edit `platform` to something else, update this pool to match
that platform instead.

### `maxTextureSizePool`

Plain numbers. No spec restriction; real GPUs report a range of values
depending on hardware generation. Current pool (4096/8192/16384/32768)
covers everything from older integrated GPUs to modern discrete ones;
extending it with other powers of two (e.g. `2048`) is safe.

### `defaultExtensions`

Array of WebGL extension name strings. Wholesale replaces whatever
`getSupportedExtensions()` captured; no per-machine variance, every install
of this tool reports the same list. No format restriction beyond using real
WebGL extension names; inventing a nonexistent extension name would be an
obvious tell if you add one that isn't real. If you want to change this
list's contents, prefer removing/adding real extensions you've verified
from an actual `getSupportedExtensions()` capture over guessing.

### `hardwareConcurrencyPool`

Plain numbers (CPU core counts). No spec restriction, but stick to
plausible real-world values; common counts are 4/6/8/12/16/20/24/32/48/64,
matching consumer through workstation-class CPUs. An oddly specific number
(e.g. `17`) would stand out.

### `deviceMemoryPool`

**Hard restriction, not just a style suggestion**: `navigator.deviceMemory`
is spec-quantized to *exactly* `0.25, 0.5, 1, 2, 4, 8, 16, 32`; Chrome's
real API will never report any other value. Adding a number outside that
set (e.g. `6` or `10`) will work mechanically (the code has no validation
against this), but the served value would itself be a strong tell that it
was hand-edited rather than real, defeating the point. Stay within that set.

### `screenPool`

Each entry needs **all three** of `width`, `height`, `devicePixelRatio`;
they're served together (plus `availWidth`/`availHeight`, derived from
`width`/`height` automatically).

**Restriction**: entries must represent an internally-consistent
(physical-resolution ÷ scale-factor) combination, not an arbitrary pairing
of width, height, and DPR. `screen.width`/`height` already reflect Windows
DPI scaling; e.g. a real 1920x1080 physical panel at 125% Windows scaling
reports **logical** `1536x864` with `devicePixelRatio: 1.25`, not `1920x1080`
at `1.25`. If you add an entry, work out the logical resolution for your
target physical-resolution/scale-factor combo first rather than guessing
three independent numbers.
