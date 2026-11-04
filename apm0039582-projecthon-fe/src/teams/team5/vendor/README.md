# Team 5 Third-Party Code

These are local copies of the dependencies used by the original Team 5 implementation,
not replacements for their behavior. They keep the shared root manifest unchanged.

- `icons.js`: the 12 used icons and supporting React implementation from
  `lucide-react` 1.66.0, bundled by esbuild 0.21.5 with React left external.
  `icons.d.ts` preserves the upstream icon component props for those exports.
  The ISC license and upstream notices are retained in `lucide-LICENSE` and the bundle.
- `eventsource-parser/`: unchanged parser sources from `eventsource-parser` 4.1.3.
  Its MIT license is retained in that directory.

The regular shared `npm ci`, test, and build commands need no extra installation.
Do not edit the generated bundle or copied parser source. There is no refresh script in
this repository; to update them, rebuild from the upstream packages at the versions above
with esbuild (shipped with the shared Vite toolchain), keeping React external so the
bundle does not introduce a second React instance.