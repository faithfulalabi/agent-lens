# Vendored fonts — provenance

These six `.woff2` files are committed to the repo on purpose. `design-system.md`
makes self-hosting a **hard rule** ("a Google Fonts request would violate
zero-egress"), and `ui/src/__tests__/no-egress.test.ts` enforces it against the
built bundle.

They are **not** npm dependencies. Each file was extracted once, by hand, from the
published fontsource tarball named below, then committed. Nothing in `ui/` depends
on `@fontsource*` at runtime or at build time.

## Why vendored rather than `npm install @fontsource…`

- **`@fontsource-variable/inter` declares the family as `Inter Variable`, not
  `Inter`.** `--font-sans: "Inter", …` would match nothing and silently fall back
  to `ui-sans-serif` — a failure that a "is a .woff2 bundled?" check cannot see.
  Hand-authoring `@font-face` in `../../styles/fonts.css` is what makes the family
  name the spec names (`Inter`) the family name the browser resolves.
- **It also has no per-subset entrypoint.** Its only CSS files pull all seven
  subsets (~213 KiB) to use two.
- **`@fontsource/jetbrains-mono` pairs every `.woff2` with a legacy `.woff`**
  (~28 KB per weight) that a Vite-built SPA never needs.
- Vendoring both keeps one `@font-face` file, one `font-display` policy, and one
  licence story (feeds Task 8.6) instead of straddling `node_modules`.

`font-display` is deliberately `block` here, not the `swap` both packages ship:
these fonts are same-origin and load in milliseconds, and an instrument UI should
not flash a fallback metric.

## Files

Subsets are **latin + latin-ext only**. Total: **191,188 B (~187 KiB)**.

| file                                        | source package@version             | original path in tarball                          | bytes  | SHA-256                                                            |
| ------------------------------------------- | ---------------------------------- | ------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| `inter-latin-wght-normal.woff2`             | `@fontsource-variable/inter@5.3.0` | `files/inter-latin-wght-normal.woff2`             | 48,256 | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| `inter-latin-ext-wght-normal.woff2`         | `@fontsource-variable/inter@5.3.0` | `files/inter-latin-ext-wght-normal.woff2`         | 85,068 | `34b9c504cab7a73e37b746343a449132e56cf7b5481af2cb81dc74dcff25c956` |
| `jetbrains-mono-latin-400-normal.woff2`     | `@fontsource/jetbrains-mono@5.3.0` | `files/jetbrains-mono-latin-400-normal.woff2`     | 21,168 | `14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb` |
| `jetbrains-mono-latin-500-normal.woff2`     | `@fontsource/jetbrains-mono@5.3.0` | `files/jetbrains-mono-latin-500-normal.woff2`     | 21,832 | `cb182feeed4d798ff6961d3c79f7026279448fca0676438aaecb21f3fc39553a` |
| `jetbrains-mono-latin-ext-400-normal.woff2` | `@fontsource/jetbrains-mono@5.3.0` | `files/jetbrains-mono-latin-ext-400-normal.woff2` | 7,336  | `505dfba8ecbe77e82765f36d317ed7ef4ac42719dc5f4ae68d1c483fd22d0d14` |
| `jetbrains-mono-latin-ext-500-normal.woff2` | `@fontsource/jetbrains-mono@5.3.0` | `files/jetbrains-mono-latin-ext-500-normal.woff2` | 7,528  | `879df9319f1cbf633bee1dd489e376a9e1e8c458f4abddcfe381cb83b5e6b027` |

Verify with:

```bash
shasum -a 256 ui/src/assets/fonts/*.woff2
```

## Licences

Both families are **SIL Open Font License 1.1**. The full texts ship beside the
binaries — `no-egress.test.ts` asserts they exist and are non-empty, because
redistribution requires it.

| family         | upstream                                                                                         | licence text                |
| -------------- | ------------------------------------------------------------------------------------------------ | --------------------------- |
| Inter          | <https://github.com/rsms/inter> — Copyright 2016 The Inter Project Authors                       | `LICENSE-Inter.txt`         |
| JetBrains Mono | <https://github.com/JetBrains/JetBrainsMono> — Copyright 2020 The JetBrains Mono Project Authors | `LICENSE-JetBrainsMono.txt` |

## Re-vendoring (how to reproduce or upgrade)

```bash
npm pack @fontsource-variable/inter@5.3.0 @fontsource/jetbrains-mono@5.3.0
tar xzf fontsource-variable-inter-5.3.0.tgz
tar xzf fontsource-jetbrains-mono-5.3.0.tgz
# copy the six files in the table above out of package/files/
```

The `unicode-range` values in `../../styles/fonts.css` are copied verbatim from
the same tarballs (`wght.css` for Inter; `unicode.json` for JetBrains Mono, whose
per-weight CSS omits them). **Re-copy them on any version bump** — a stale range
silently stops matching glyphs the new subset moved.
