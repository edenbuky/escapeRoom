# Team 5 Third-Party Code

These are local copies of the dependencies used by the original Team 5 implementation,
not replacements for their behavior. They keep the shared root manifest unchanged.

- `icons.js`: the 12 used icons and supporting React implementation from
  `lucide-react` 1.66.0, bundled by esbuild 0.21.5 with React left external.
  `icons.d.ts` preserves the upstream icon component props for those exports.
  The ISC license and upstream notices are retained in `lucide-LICENSE` and the bundle.
- `eventsource-parser/`: unchanged parser sources from `eventsource-parser` 4.1.3.
  Its MIT license is retained in that directory.

- `xterm/`: the xterm.js terminal (MIT) and its fit addon, extracted unchanged from the design reference
  (`the-last-tdp-exam-rooms-16.html`: the two minified UMD bundles and the stylesheet). `xterm.js` is the 6.x line
  (its stylesheet has the 6.x scrollbar rules); the reference does not record the patch version or the addon's.
  `index.ts` loads them and exposes `Terminal` and `FitAddon`, with the small typed surface the game uses. The
  license notice the reference carries is in `xterm-LICENSE`. It is vendored here, not added to the shared
  `package.json`.

The regular shared `npm ci`, test, and build commands need no extra installation.
Do not edit the generated bundles or copied parser/terminal source. There is no refresh script in
this repository; to update them, rebuild from the upstream packages at the versions above
with esbuild (shipped with the shared Vite toolchain), keeping React external so the
bundle does not introduce a second React instance.
