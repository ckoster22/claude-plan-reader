---
tree_id: tree-mqcobtz3-5632dc17
flavor: master
---

# Master Plan: Chompy Asteroids — Web 2D Asteroid Game

## Context

The goal is a web-based 2D arcade game where the player pilots an asteroid through an
infinite, boundary-less sandbox. Size is the core rule: much-bigger asteroids consume
much-smaller ones (mass grows by the eaten mass minus high-velocity debris loss);
roughly-equal asteroids destroy each other. A gentle, arcade-tuned **exponential** gravity
field from large bodies bends the free-flight paths of surrounding pure-physics drifters.

The headline mechanic is **velocity-thresholded collision physics** measured along the
contact normal:
- **Slow** closing speed → bodies deform (squash along the impact axis) then coalesce via an
  inelastic, momentum-conserving merge/accretion into one larger rounded body that springs
  back to shape.
- **Medium** → chip off a small real fragment, permanently dent both silhouettes, bounce with
  restitution (no sticking).
- **Fast** → fracture into multiple real asteroid sub-bodies that inherit parent momentum and
  burst outward, losing some mass to dust. Fragments are real bodies that gravitate, consume,
  and collide.

Every body carries a soft-body squash-and-reform spring so deformation reads on both bounces
and merges; particle effects are secondary flavor only.

**Current state (greenfield + reference prototype):** The working directory contains only
`.plan-tree/` metadata and a single-file Canvas prototype at
`.plan-tree/prototype/index.html` (~570 lines, all systems inline as globals). There is no
source tree, `package.json`, build tooling, engine dependency, or git. The prototype is
**load-bearing as the executable spec** — it already implements every headline mechanic and
the full anti-freeze suite, and every sub-plan should reference it.

**Resolved decision — exponential gravity (normalized, dt-based):** The original request
explicitly asks for "exponential more gravity" for large asteroids. The prototype ships
`GRAV_EXP = 1.0` (linear) for calm pacing. The production build honors the request but fixes a
real scale-vs-cap contradiction the prototype would hit: raising `GRAV_EXP > 1` against raw
masses (up to ~1400 and growing unbounded via accretion) makes `m^EXP` explode, so the
per-body acceleration cap would clamp *every* large interaction and flatten the field back to
constant pull — destroying the very differentiation we want. Therefore the contract is:
- Gravity uses **normalized mass**: force ∝ `(m / M_REF)^GRAV_EXP`, so the exponent changes
  the *shape/ratio* of pulls, not the absolute scale.
- The whole simulation is **`dt`-based** (gravity, soft-body, integration share one time base);
  the prototype's per-frame velocity deltas are converted to accelerations × `dt`.
- Softening and caps are tuned so the acceleration cap is a rare safety backstop, not the
  active constraint for in-range bodies; a tunable **mass ceiling** (or radius-based falloff)
  bounds the super-linear term.
- The intended invariant is **the ratio of pull between a large and small body grows with size**
  (tested directly), not raw force magnitude. `GRAV_EXP`, `M_REF`, softening, caps, and the
  mass ceiling are named tunables; final values are balanced in Sub-Plan 04.

**Engine decision (to be finalized in Sub-Plan 01):** The prototype's physics is hand-rolled
and engine-agnostic. **PixiJS (render-only, keep the custom simulation)** is the recommended
fit because Phaser's Arcade/Matter physics would fight the bespoke velocity-regime collision
model. Sub-Plan 01 confirms this and scaffolds accordingly.

## Success Criteria

Collisions visibly break, deform, bounce, and reform/merge as a continuous function of impact
speed, with real fragment bodies and conserved-ish momentum; exponential-but-gentle gravity
visibly bends drifter paths; the game runs enjoyably in-browser at stable frame rates with no
freezes or runaway physics. Core physics math is covered by unit tests.

## Architecture (Volatility-Based Decomposition)

Map the systems onto the standard split, drawn fresh since the prototype has no boundaries:
- **Connectors/** — input (keyboard), the PixiJS render adapter, the HUD/DOM overlay.
- **Operations/** — pure simulation logic: gravity, collision resolution, soft-body spring,
  growth/consume math, size distribution.
- **Workflows/** — the per-frame sim-step orchestration and the world/population manager.

The simulation state (the `Body` data structure: position, velocity, mass, radius,
soft-body deformation state, polygon shape) is the shared contract threaded through all plans.

### Frozen cross-plan contracts (resolved before any sub-plan goes to `/write-plan`)

These three are cross-plan decisions, not implementation details, so they are pinned here:

1. **Collision is NOT a side-effect-free pure function — it returns an effect descriptor that a
   Workflow applies.** The prototype's collision mutates mass, velocity, deformation, silhouette
   (dented verts), death flags, three global counters, particles, and shockwaves. Modeling that
   as `resolveCollision(a,b) -> {fragments}` would hide every other effect and force a redesign
   at integration. The real contract:
   `resolveCollision(a, b, budget) -> { regime, survivors:[{id, mNew, vx, vy, deformInjection}], dead:[id], fragments:[Body], counters:{eaten,merged,shatter}, fx:{debris, shock} }`.
   `Operations/` computes the descriptor (pure given inputs); a `Workflows/` step applies it to
   the world (mutates bodies, spawns fragments, bumps counters, pushes FX). Counters and FX are
   owned by the Workflow/HUD layer, never by `Operations`.
2. **Body-cap budget is an explicit input to collision, not hidden state.** Fracture/chip paths
   need the remaining body-count room to decide real-fragments-vs-particle-fallback. That room is
   passed in as `budget` (computed from `MAX_BODIES` and current population), so Sub-Plan 02 is
   fully implementable and testable without reaching into Sub-Plan 03's world state.
3. **Conservation invariant — momentum is conserved exactly; mass loss is massless debris.** On a
   slow merge the survivor velocity is `v = combinedMomentum / newMass` (NOT
   `combinedMomentum / combinedMass`), so momentum is conserved while mass drops by the debris
   loss; the lost mass is treated as massless ejecta/particles. This resolves the
   prototype's momentum≠conserved formula. Tests assert the invariant the physics *should*
   satisfy, not the prototype's current arithmetic.

**Performance note:** gravity and collision are both O(n²) pair loops. At `MAX_BODIES≈140`
(~20k + ~10k pairs/frame) this is fine, and it is the body-count budget that guarantees frame
rate. Spatial hashing is the known scaling lever if the cap ever rises — out of scope for the
port, but the contracts above must not preclude it.

---

### Sub-Plan 01: Engine scaffold, body model & render loop

Stand up the greenfield project and the rendering spine.
- Scaffold: package manager, bundler/dev-server (e.g. Vite), and **engine choice — confirm
  PixiJS (render-only) vs Phaser**, recording the rationale. Initialize git.
- Establish the `Workflows/ · Operations/ · Connectors/` module layout.
- Define the canonical **`Body`** data structure — freeze the **complete** field set now (the
  prototype's: `id`, `player`, `dead`, world-space `x/y`, velocity `vx/vy`, `m` (mass), derived
  `r` (radius), rotation `rot`/`vr`, polygon `verts[]`, `hue`, and the soft-body deformation
  state `def, dvel, dax, day, flash`). Mark each field render-only vs. sim so the contract is
  frozen before Sub-Plan 02 builds against it (an incomplete list forces every later plan to
  amend the most-shared artifact).
- Build the camera + per-frame render loop that draws asteroid bodies (with soft-body
  squash applied to the rendered polygon), the infinitely tiled parallax starfield, and a HUD
  shell — all wrapped in the try/catch frame loop from the prototype.
- **Non-goals:** physics math, collision regimes, gravity, input handling, world
  population/spawn logic (stub bodies / mock data are fine for rendering).
- **Verification:** dev server runs; a handful of mock bodies render and the camera follows a
  designated body; starfield tiles correctly when the camera moves far in any direction;
  no console errors over a sustained run.

### Sub-Plan 02: Physics core — gravity, collision regimes, soft-body & growth

Rebuild the bespoke simulation as **pure, unit-testable modules** under `Operations/`.
- **Gravity:** softened N-body attraction with `GRAV_EXP > 1` (exponential mass scaling),
  per-body acceleration cap and global velocity cap, NaN/coincident-center guards.
- **Velocity-thresholded collision resolution** keyed on the normal component of relative
  velocity, with named thresholds `V_MERGE` / `V_FRACTURE`:
  - slow → deform + inelastic momentum-conserving merge/accretion;
  - medium → chip one real fragment + dent + restitution bounce (1D normal impulse);
  - fast → fracture into 2–N real fragment bodies inheriting parent momentum, with debris
    mass loss.
- **Soft-body** squash/reform damped-spring step per body, plus the **deform injection**
  (`applyDeform`-style) that collisions call to kick the spring — both belong to this module's
  contract surface (the injection is collision-triggered; the integrate runs in the step).
- **Size rules as physical consequences:** big-eats-small and equal-destroy emerge from the
  regime logic; consume growth uses the diminishing-returns curve + high-velocity debris loss.
- **Interface contract (per the Frozen contracts above):** consumes the `Body` structure and
  the `dt`-based per-frame update hook from Sub-Plan 01. Produces `gravityAccel(bodies, dt)`;
  `resolveCollision(a, b, budget) -> effectDescriptor` (the full descriptor shape, NOT a
  fragments-only return); `softBodyStep(body, dt)` + `applyDeform(...)`. Regime is selected on
  the normal component of relative velocity AND closing-vs-separating sign — separating pairs
  must follow an explicitly decided path (chip/dent or no-op), not fall through ambiguously.
- **Non-goals:** rendering, input, world spawn/cull, HUD, applying the effect descriptor.
- **Verification (TDD, invariant-first):** unit tests asserting *intended* invariants —
  **momentum conserved exactly across a slow merge** (`v = combinedMomentum/newMass`) while
  mass drops by the debris loss (massless ejecta); total mass conserved minus the specified
  debris loss on fracture; regime selection across the full matrix — boundaries (`< V_MERGE`,
  between, `>= V_FRACTURE`) at exact values **crossed with closing-vs-separating** normal sign;
  fragment count respects the passed `budget` (falls back to particles at the cap); gravity
  acceleration respects the cap and never returns NaN for coincident centers; **the ratio of
  pull between a larger and smaller mass at equal distance strictly increases with `GRAV_EXP`**
  (the exponential-differentiation invariant — test the ratio, not raw magnitude). Each test
  must be shown to fail when the behavior is inverted.

### Sub-Plan 03: Input, controls & infinite-world population management

Player control and the systems that keep an infinite world populated and stable.
- **Controls:** frictionless space-like coasting (thrust = pure acceleration, momentum
  conserved on release), low velocity cap, thruster exhaust trail; camera follow.
- **World management (`Workflows/WorldManager`):** infinite boundary-less world,
  **off-screen-only** spawning in a ring beyond the viewport, camera-relative cull-and-respawn
  to hold steady density (player never culled), power-law **small-weighted** size
  distribution, guaranteed safe-spawn distance from player (no instant death).
- **Anti-freeze suite:** body cap with fragment-to-particle fallback, particle cap with
  drop-oldest, bounded spawn-placement loops with guaranteed fallback, deferred fragment
  buffer so the bodies array is never mutated mid-iteration.
- **Interface contract:** consumes the `Body` structure + physics step functions from
  Sub-Plan 02 and the camera/render loop from Sub-Plan 01. Produces `spawn()`,
  `cullAndRespawn(camera)`, `applyThrust(playerBody, inputState)`.
- **Non-goals:** physics math (consumed), render internals, final HUD polish.
- **Verification:** travel far in any direction — density stays roughly constant, nothing
  spawns inside the viewport, the field never empties; sustained run stays within body/particle
  caps (instrument counts); player survives the opening; thrust feels like coasting (no drag).

### Sub-Plan 04: HUD, integration & tuning

Wire the full vertical slice together, surface state, and balance the game.
- **Integration:** assemble the complete loop (input → gravity → collisions → growth →
  world management → render) into a single playable build.
- **HUD/UI:** mass/size readout, eaten/merged/fractured counters, growth indicator; optional
  debug overlays visualizing gravity influence and collision-regime classification.
- **Lose/restart flow:** the player CAN die (consumed by a much-larger body, or fractured by a
  fast comparable impact) but is NEVER culled by world management — death is collision-only.
  Specify the game-over overlay ("Consumed.") and a restart that reseeds the world. ("No instant
  death" remains an opening-survivability guarantee, not immortality.)
- **Tuning:** balance the named constants against the prototype as spec — `GRAV_EXP` (and
  gravity softening / caps), `V_MERGE`, `V_FRACTURE`, restitution, debris mass-loss, growth
  curve, spawn density and size-distribution weighting — for the calm, survivable,
  non-runaway feel.
- **Interface contract:** consumes `WorldManager` (spawn/cullAndRespawn/applyThrust) and the
  player `Body` from Sub-Plan 03, the physics step functions from Sub-Plan 02, and the HUD
  shell + render loop + starfield from Sub-Plan 01.
- **Non-goals:** new subsystems — this is integration, surfacing, and balancing only.
- **Verification (end-to-end):** run the dev server and play; confirm each collision regime is
  reachable and visibly distinct (slow merge, medium chip+bounce, fast fracture into real
  bodies); confirm exponential gravity visibly bends drifter paths without runaway; confirm
  stable frame rate over a multi-minute session with no freeze and no NaN/explosion; HUD
  reflects live state.

## Execution Notes

- Sub-plans are **sequential**: 01 → 02 → 03 → 04, each consuming the prior's named artifacts.
- The throwaway `.plan-tree/prototype/index.html` is the reference spec for **all four**
  sub-plans — port its tuning values and anti-freeze patterns rather than reinventing them.
- Each sub-plan gets its own detailed plan via `/write-plan` before implementation.
