# 4B11 Tuner

A browser-based tuning workbench for the Mitsubishi 4B11 — EcuFlash ROMs and
EvoScan datalogs in one place, with AI-assisted suggestions for MAF scaling and
timing advance.

Everything runs in your browser. Your ROM and logs are parsed locally and are
never uploaded anywhere.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 40 tests against the real sample files
npm run build    # static site in dist/
```

`npm run build` produces a plain static site, so it can be served from GitHub
Pages, any static host, or opened straight from disk.

## What it does

### Log viewer

Load one or more EvoScan `.csv` logs and plot any combination of channels on a
shared time base. Drag to zoom a time range, scroll to zoom around the cursor,
shift-drag to pan, double-click to reset. Check and uncheck channels in the
sidebar; click a channel name to give it the left axis. The cursor readout shows
every visible channel's value at the point you are hovering.

Channels sharing a unit share a Y axis by default, so two AFR traces or two
temperatures can be read against each other rather than being drawn at unrelated
magnifications. Railed sensor readings — a wideband's 0 before light-off, or its
99.9 outside the measurable range — are drawn as gaps rather than as data, since
plotting them literally stretches the axis to 0-100 and compresses the real
9-22 AFR signal into a sliver. Both are toggles above the chart, and the cursor
readout still shows the raw value, marked as railed.

Two views tie the log back to the maps you actually edit:

- **Operating points** — RPM against Load, coloured by any third channel, with
  gridlines drawn on the real spark map axes read out of your ROM.
- **Cell coverage** — the same RPM × Load grid filled with sample counts, or the
  mean/median/max of any channel, or knock counts per cell.

### ROM tables

Load your EcuFlash `.xml` definition and the `.bin` it describes. The app
verifies the ROM ID before showing anything — applying the wrong definition
produces tables that look plausible and are entirely wrong, so it refuses rather
than guessing.

All 141 tables in the definition are browsable and editable as heatmap grids in
EcuFlash's own orientation. Edits are quantised to what the ECU can actually
store, so what you see is what would really be written. Cells your logs never
visited are dimmed.

**The app never writes a `.bin`.** You copy a table as TSV and paste it into
EcuFlash. That keeps your existing tool in charge of checksums and flashing, so
there is no path from a bug here to a bad flash.

### AI-assisted tuning

Suggestions are computed by deterministic maths in `src/lib/tune`, not by a
language model. The same logs and the same table always produce the same
numbers.

**MAF scaling** corrects the transfer function from measured fuelling error —
closed-loop fuel trims when the ECU reports them, otherwise wideband AFR against
the ECU's own target. Railed sensor values (0, 99.9 AFR) are dropped per sample.
Each MAF part is corrected only from samples inside its own voltage range. The
result is smoothed, held monotonic, and capped at 10% change per pass.

**Timing advance** works cell by cell on the spark map under one of four
profiles:

| Profile | What it does |
|---|---|
| Economy | Adds timing in the light-load cruise region only. |
| Power | Works mid- and high-load cells toward best torque. |
| Pops & bangs | Drives the closed-throttle overrun cells to about 10° after TDC. |
| Flames | The same mechanism at about 20° after TDC, across a wider rpm band. |

The two overrun profiles let you pick the exact block of cells they work on —
RPM from/to and load from/to, chosen from the loaded spark map's own breakpoints
so a window always names whole cells. Which cells your engine passes through on
a closed throttle depends on gearing, exhaust and how you drive, so the defaults
are a starting point rather than an answer. The picker reports how many cells
are selected and how many your logs actually visited, and warns if the window
reaches down into idle or up into real throttle.

Two rules are enforced in code, in every profile:

- **A cell that recorded knock never gets advance.** It gets retard proportional
  to the knock seen.
- **No cell is advanced past the load-dependent ceiling**, or outside the range
  the ROM's own scaling can store.

Cells with too little data are left alone and reported, rather than being given a
confident-looking average of four samples.

The two overrun profiles are the exception to that rule, deliberately. Adding
advance is a correction and needs evidence; retarding the overrun region is a
configuration choice, and which cells the engine passes through on a closed
throttle is known from the map's own axes rather than discovered from a log.
Gating it on coverage would silently do nothing on most logs, since lifting off
is a small fraction of any drive. They set an absolute target past TDC rather
than subtracting a fixed amount — the stock map holds 28-45° here, and no
bounded subtraction from that reaches the far side of TDC, which is the only
place unburnt fuel survives into the exhaust.

Every suggested cell carries its sample count, knock count, confidence and the
reason for the change — hover it in the grid.

> **Pops & bangs and flames deliberately burn fuel in the exhaust.** They destroy
> catalytic converters and can damage exhaust valves, manifolds and turbine
> housings. The app warns about this and defaults their aggression low, but the
> risk is real.

### Optional Claude layer

Off by default and not needed for anything above. Supply your own Anthropic API
key and it will explain the computed suggestions in plain English and answer
follow-up questions. The key is stored in your browser only, and the request
carries the computed summary and changed cells — never your ROM.

## Datalog health

Bad channels do not announce themselves. A coolant sensor stuck at -13 °C
produces graphs that look perfectly reasonable and recommendations that are
worthless, so the app checks every channel before it analyses anything: stuck
values, physically implausible ranges, missing columns, and fuel trims that
carry no correction information.

Anything that fails is badged in the channel list and explained in the summary at
the top of the viewer. Where a broken channel makes an analysis impossible — no
fuel feedback at all, or no knock signal — the recommender returns a blocked
result saying what to fix, rather than producing numbers.

On the supplied sample logs it correctly reports that `IAT` is pinned at -40,
`MAT` is unscaled raw counts, `Cooltemp` never warms in the drive logs, and
`STFT` is not being logged at all — while still finding `WideBandAF` usable once
its rail values are dropped.

## Layout

```
src/lib/log/     CSV parsing, channel metadata, health gate
src/lib/rom/     definition XML, scaling expressions, table reads, ROM identity
src/lib/tune/    sample binning, MAF and timing recommenders, tune profiles
src/lib/ai/      optional Claude explanation layer
src/components/  viewer, table and tuning UI
src/pages/       the three tabs
samples/         the ROM, definition and logs the tests run against
tests/           40 tests, all against those real files
```

## Notes on the defaults

The advance ceilings, knock-per-degree ratio and per-profile step sizes in
`src/lib/tune/profiles.ts` are conservative defaults for a naturally aspirated
4B11 on pump fuel. They are not measurements from any particular engine. They
are the numbers most worth replacing with real data.
