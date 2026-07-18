# Probe P-1 — prior-art desk read (plausibility pre-assessment)

> **Purpose.** The P-1 spike doc (`probe-p1-feasibility-spike.md`) specifies the physical-device measurement
> protocol and its acceptance bars but does not estimate, from prior art, whether those bars are _plausibly_
> clearable — i.e. whether it is worth putting a device and a test drive on it at all. This note fills that gap.
> It is a **literature/prior-art read, not device evidence**: it cannot mark any P-1 sub-gate "passed" (only a
> real mid-range-phone measurement does that, per the spike doc). Its job is the cheap decision input: is there a
> _cheap kill_ (a bar that prior art says is physically implausible on mid-range hardware), and if not, where does
> the real risk actually concentrate?
>
> Bars assessed (from `probe-p1-feasibility-spike.md` §4): battery ≤5%/hr incremental on a mid-range phone; tiles
> ≤400 MB per metro region; match accuracy ≥90% `way_id` and ≥95% carriageway direction.

## Bottom line

**No cheap kill exists. The load-bearing feasibility assumption does not collapse on paper — but it is not
off-the-shelf prior art either.** Two of the three bars (battery, storage) clear comfortably in the analysis with
high confidence; they are not the risk. The entire real risk concentrates in **one place**: there is no existing
FOSS on-device continuous Meili matcher (it is greenfield integration work), and match accuracy is only solidly
plausible on highway/suburban roads — it degrades to marginal in dense-urban canyons / sparse / multipath. So the
honest verdict is **"feasible-looking, gated on integration effort + dense-urban accuracy tuning — not on
physics."** Nothing found says flagship-only or impossible.

## Bar-by-bar

### Storage (≤400 MB per metro region) — PLAUSIBLE, high confidence

Routing-only tiles are a small slice of an offline region. OsmAnd's routable graph is ~0.5–1% of a full `.obf`;
its roads-only country map is ~71% smaller than the full map (Japan roads-only = 200 MB for a _whole country_).
Valhalla's own regional extracts go "as small as ~100 MB"; all of Germany's routing tiles are ~4.6 GB (tarball
incl. elevation) — a single metro is a small fraction. A metro's matcher tiles land in the tens-to-low-hundreds of
MB, well inside 400 MB. And the matcher's tiles are a strict subset of what an offline-navigation pipeline already
ships, so no bespoke second pipeline is needed. **Design constraint:** ship routing/graph tiles, not full
rendering `.obf`/`.mwm` bundles.

### Battery (≤5%/hr incremental) — PLAUSIBLE, high confidence

The bar isolates matcher _compute_ on top of GPS that is on regardless. Per-fix online HMM matching (bounded ~200 m
candidate search + one Viterbi step, existing state retained) is ~0.1–2 ms/fix server-class; budget 5–20 ms on a
mid-range core → a 0.5–2% CPU duty cycle at 1 Hz → **~0.1–1%/hr added draw, 5–50× under the bar**. For comparison,
screen-off 1 Hz GPS + track logging is only 2–3%/hr total, and on-screen nav is dominated by screen (~50%) and GPS
(~30%), with map _rendering_ (which the probe does not do) far heavier than matching. A ~1% duty-cycle workload is
nowhere near the sustained-100%-load regime that throttles phones.

**Two load-bearing caveats.** (1) The verdict holds only because GPS is on regardless. For a Contributor who is
_not_ otherwise navigating, enabling the probe forces GPS to 1 Hz high-accuracy, so the honest number disclosed to
a contributor is the **full GPS baseline (~2–4%/hr screen-off), dominated by GPS not matching** — still under 5%/hr,
but attribute it correctly. (2) The risk is engineering, not algorithmic: keep tiles/graph resident and reuse HMM
state incrementally (cold tile reloads are what blow up matching time), bound the search radius, and avoid a
high-frequency wakelock that defeats CPU deep-sleep between fixes.

### Engine + accuracy — the real risk

**Engine (does a proven on-device continuous matcher yielding `way_id` + direction exist?) — PARTIAL.**

- The output format is exactly right: Valhalla Meili's `trace_attributes` returns per-edge OSM `way_id` +
  `traverse_direction` (forward/backward). The algorithm (HMM + Viterbi, Newson–Krumm) is battle-tested, and
  Valhalla ranks at/near the top on matching accuracy vs FMM/OSRM/GraphHopper.
- But **no FOSS mobile product runs it on-device today.** The one public Valhalla mobile build
  (`Rallista/valhalla-mobile`) deliberately omits Meili/`trace_attributes` (routing only). Meili's core is
  `OfflineMatch` — batch Viterbi over a complete trajectory — so continuous use needs a custom **sliding-window
  wrapper** (re-run the batch matcher over the last N seconds). OsmAnd/Organic Maps do only geometric snap-to-road,
  not retained `way_id`+direction. Mapbox's Navigation/ADAS SDK _does_ do continuous on-device matching on phones —
  which **proves it is possible on mobile-class hardware** — but it is closed-source, paid, and doesn't surface OSM
  way IDs. Net: greenfield integration on a proven algorithm + a proven-possible platform, not adoption of an
  existing on-device matcher.

**Accuracy (≥90% `way_id`, ≥95% direction) — PLAUSIBLE highway/suburban, MARGINAL dense-urban.**

- Newson–Krumm (consumer SiRF GPS, σ≈4.07 m, 80 km mixed Seattle drive, 1 Hz) matched the ground-truth route
  perfectly at 1 Hz and kept route-mismatch to **0.11%** even thinned to 30 s between fixes — comfortably above the
  90% bar on highway/suburban.
- Dense urban is the documented failure zone: gross outliers in tunnels/urban canyons, and Millard-Ball et al.
  (2019) show off-the-shelf HMM matchers fail on "poor-quality" urban GPS (≥50 m inaccuracy, parking cruises,
  underground) — their purpose-built matcher beat GraphHopper by ~one-third more traces matched.
- Direction: on **divided** roads the carriageways are separate OSM ways, so direction is just the well-solved
  which-way problem (≈99.9% by route length). On **undivided** roads forward/backward is the _same_ way, inferred
  from trajectory **sequence order** (`traverse_direction`) — essentially always correct for a moving vehicle. It
  degrades at stops, very low speed, U-turns, and trip start/end (already partly handled by the plan's ~200 m
  trip-edge trim).
- **Load-bearing caveat:** every published number is a length-weighted route-mismatch fraction from **batch Viterbi
  over a full curated trace on a decent GPS chipset** — not per-segment `way_id` accuracy from a **real-time
  sliding-window** matcher on a mid-range phone with duty-cycled GPS. The aggregate targets are very likely
  reachable _averaged over highway + suburban_, but a naive on-device implementation will miss them in dense urban
  without tuning (heading gating, break-healing, minimum-speed direction locking).

## What this changes for the build/defer decision

- **The desk read did not find a cheap kill** — the phase is not falsified, so "completely defer and forget it"
  is not warranted on feasibility grounds.
- **It also did not find off-the-shelf prior art** — so the P-1 spike is real greenfield work, not a formality.
- **The risk is correctly located.** If/when P-1 is actually run, the money is on the accuracy test drive with a
  custom sliding-window Meili-on-device build, _not_ on battery or storage (those will follow). The first real
  build effort is the sliding-window matcher + a labelled-drive accuracy harness; battery/storage validation ride
  along cheaply once that exists.
- **This does not change the sequencing.** The binding constraint on shipping remains the independent DAP Helper +
  institutional gate (P0), which a positive feasibility result does not advance. So the recommendation stands:
  hold the full P-1 device spike until the institutional gate is in motion; this desk read is the cheap interim
  answer that says "plausible, greenfield, risk is urban accuracy — no reason to permanently abandon, no reason to
  rush a device."

## Sources

Battery/compute: Google Maps power-saving real-world test (androidpolice.com); OsmAnd nav power breakdown
(groups.google.com/g/osmand) and screen-off track-recording 1.2–3%/hr (osmand.net/docs troubleshooting); component
power (petewarden.com 2015); GraphHopper matching throughput (discuss.graphhopper.com); Valhalla Meili overview.
Storage: Valhalla tiles docs + discussion #4816 (Germany 4.6 GB, California ~800 MB); OsmAnd `.obf` roads-only
(Japan 200 MB) + HH-graph 0.5–1%; Organic Maps `.mwm` (Mexico City 172 MB); Rallista/valhalla-mobile;
interline.io tilepacks. Engine/accuracy: Newson & Krumm 2009 (Microsoft Research PDF); Valhalla Map Matching API
reference + Meili architecture; Millard-Ball, Hampshire & Weinberger 2019; Wöltche 2023 (Transactions in GIS);
Mapbox electronic-horizon / ADAS SDK; fmm (cyang-kth).
