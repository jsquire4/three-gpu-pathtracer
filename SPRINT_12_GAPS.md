# Sprint 12 Implementation Gaps — 2026-05-09

This file documents the portions of the Sprint 12 hero-wavelength spectral kernel
rewrite (plan/sprint-12-pt-fork-patch.md) that were NOT completed in the 2026-05-09
patch application, and why.

---

## What WAS applied (Sprint 12 partial)

- **`src/shader/bsdf/spectral_accumulator.glsl.js`** (NEW):
  - `sampleCmfX/Y/Z(lambda)` — linear interpolation on uniform CMF arrays.
  - `sampleHeroWavelength(u, out float pdf)` — CDF binary-search on `uYCmfCdf[82]`.
  - `vec3 wavelengthToRGB(lambda, throughput, pdfLambda)` — XYZ → linear sRGB.
  - All functions are syntactically correct GLSL ES 3.00.

- **`src/shader/bsdf/bsdf_functions.glsl.js`** (MODIFIED):
  - `cauchyIORatLambda(lambdaNm, A, B, C)` — Cauchy IOR at arbitrary wavelength.
  - `evalSpectrumAtHero(lambdaNm)` — Jakob+Hanika spectral weight at hero λ.
  - Both functions are defined and exported; they will be called once the payload
    restructure (§1 below) lands.

- **`src/materials/pathtracing/PhysicalPathTracingMaterial.js`** (MODIFIED):
  - New uniforms: `uCmfX[81]`, `uCmfY[81]`, `uCmfZ[81]` (CMF arrays).
  - New uniforms: `uYCmfCdf[82]`, `uYCmfIntegral` (hero wavelength CDF).
  - New uniforms: `iorCauchyA`, `iorCauchyB`, `iorCauchyC` (Cauchy coefficients, µm).
  - `spectral_accumulator` GLSL block included in the fragment shader.

---

## Gap §1 — Ray payload restructure (APPLIED)

**Spec**: change from `vec3 throughput` to `float wavelength + float throughput`.

**Current state**: core restructuring is now landed:

1. `render_structs.glsl.js` now stores `float wavelength; float wavelengthPdf; float throughput;`.
2. `state.throughputColor` references were removed from the main fragment loop and direct-light helper.
3. `sampleHeroWavelength(rand(30), state.wavelengthPdf)` now seeds the payload at path start.

**Additional work landed after the initial partial pass**:

1. `ScatterRecord` now carries scalar throughput (no `vec3 color` payload).
2. BSDF eval/sample/result internals now use scalar throughput values keyed by hero wavelength.
3. Main-loop throughput updates and roulette no longer rely on luminance projection of RGB BSDF outputs.

**Risk**: this restructure is the single highest-risk change in Sprint 12. It is
pervasive, GPU-unverifiable in this session, and will conflict with every future
upstream merge. Estimated effort: 3 days per `plan/sprint-12-pt-fork-patch.md §5`.

**Where to resume**: validate the scalar transport numerics with GPU A/B renders and tune
material spectral mapping heuristics if color drift is observed.

---

## Gap §2 — Main loop spectral accumulation integration (APPLIED)

**Spec**: replace `gl_FragColor.rgb += emission * state.throughputColor` with
`gl_FragColor.rgb += wavelengthToRGB(wavelength, state.throughput, pdfLambda)`.

**Status**: main-loop contribution sites use
`wavelengthToRGB(state.wavelength, state.throughput, state.wavelengthPdf)` via a
`throughputRgb` helper in the bounce loop.

---

## Gap §3 — BSDF wavelength-aware IOR switchover (APPLIED)

**Spec**: replace Sprint 8's `dispersionTransmissionDirection` (3 discrete channels)
with `cauchyIORatLambda(state.wavelength, iorCauchyA, iorCauchyB, iorCauchyC)` at
the hero wavelength.

**Status**: `dispersionTransmissionDirection` now accepts `heroWavelength` and uses
`cauchyIORatLambda(heroWavelength, iorCauchyA, iorCauchyB, iorCauchyC)` directly.

**Where to resume**: runtime visual/perf validation only.

---

## Gap §4 — Thin-film stack TMM evaluation (APPLIED, runtime-unverified)

**Spec** (RFE-08): implement transfer-matrix-method evaluation in GLSL for multilayer
thin-film stacks (`userData.vitrumThinFilmStack`, 35-layer TiO₂/SiO₂ stacks).

**Current state**:
- `src/shader/bsdf/thin_film_tmm.glsl.js` added with fixed-bound
  `#define N_THIN_FILM_LAYERS 35` TE-approximation matrix solver.
- `src/uniforms/MaterialsTexture.js` now packs per-material 35-layer payload
  (IOR + thickness per layer) with fixed layout.
- `src/shader/bsdf/bsdf_functions.glsl.js` now calls `thinFilmTMM(...)` by
  hit material index to modulate specular and transmission throughput when `surf.thinFilm` is active.

**Remaining work**:
- GPU visual verification (iridescent angle shift A/B scenes).
- Performance validation of the 35-iteration loop on target WebGL2 devices.

---

## Gap §5 — Spectral attenuation Beer-Lambert (APPLIED, runtime-unverified)

**Spec** (RFE-01): read `userData.vitrumSpectralAttenuation` (81-sample curve) and
integrate into Beer-Lambert calculation per-wavelength.

**Current state**:
- `MaterialsTexture.js` now ingests per-material `userData.vitrumSpectralAttenuation`
  and packs representative spectral absorption coefficients into the material payload.
- `material_struct.glsl.js` and `surface_record_struct.glsl.js` propagate these
  spectral coefficients to shading.
- `transmissionAttenuationHero(...)` applies hero-wavelength Beer-Lambert attenuation
  in both the main path-throughput update and the direct-light occlusion attenuation
  path (`attenuate_hit_function.glsl.js`).

**Remaining work**:
- GPU visual validation for spectral colored attenuation scenes.
- Perf validation against the Sprint 12 baseline.

---

## Summary table

| Feature | Status | Blocker |
|---------|--------|---------|
| `spectral_accumulator.glsl.js` (CMF sampling + XYZ→sRGB) | APPLIED | — |
| `sampleHeroWavelength` GLSL | APPLIED | — |
| `cauchyIORatLambda` function | APPLIED | — |
| New uniforms (CMF arrays, Cauchy A/B/C) | APPLIED | — |
| Ray payload restructure (vec3 → float+float) | APPLIED | Runtime visual verification pending |
| Main loop spectral accumulation | APPLIED | Runtime visual verification pending |
| BSDF hero-wavelength IOR switchover | APPLIED | Runtime verification pending |
| Thin-film TMM | APPLIED (runtime-unverified) | Visual/perf verification |
| Spectral attenuation Beer-Lambert | APPLIED (runtime-unverified) | Visual/perf verification |

GPU verification was not available in this session. All applied GLSL is syntactically
valid JavaScript/GLSL template literals but shader correctness depends on WebGL
compile-time validation.
