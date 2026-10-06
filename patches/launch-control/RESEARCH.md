# Launch control for 54740002 (2011 Lancer 4B11 NA 5MT): ROM research

Goal: a spark-cut launch control, armed by a steering-wheel cruise button with no
clutch condition, built Tephra-style (code in free flash plus tunable tables in the XML).

Everything here comes from static disassembly of `samples/stock_2.bin`, which carries
ROM ID 54740002 at `0x5002A`. The disassembler was binutils-multiarch objdump:

```
objdump -b binary -m m32r -EB -D samples/stock_2.bin > rom.dis
```

Every item is marked **confirmed** (checked in code or data) or **open** (not yet found).

## Status

| Piece | Status |
|---|---|
| CPU, endianness, register base | confirmed |
| Free flash for patch code | confirmed |
| RPM, vehicle speed, ECT, MUT timing RAM | confirmed |
| Rev limiter / stationary limiter / speed limiter code | confirmed |
| Interrupt dispatch (MJT timer ISRs) | confirmed, partially traced |
| Ignition coil output path (where a spark cut goes) | **open** |
| Cruise switch input (A/D channel → RAM variable) | **open** |
| Clutch switch input (port bit) | monitored by the ECU (P0830); bit **open**, found by logging |

No patch code has been written yet. A spark-cut hook placed on a guess could leave the
engine misfiring or not running. The ignition output has to be found first, plus the input for whichever activation mode is used (clutch or button).

## CPU and memory

- **Confirmed:** Renesas M32R (M32186F8), big-endian, 1 MB flash. The reset vector at
  `0x0` branches to `0x32B4`.
- **Confirmed:** reset code sets `fp = 0x80C000` (`0x32D8: ld24 fp,0x80c000`). All
  engine RAM is accessed as `@(disp,fp)`, so RAM address = `0x80C000 + disp`. For
  example, `@(-14602,fp)` is `0x8086F6`.
- **Confirmed:** calibration addresses are loaded with `ld24 rN,0x5xxxx`, so a grep
  for `ld24 .*,0x<addr>` finds every reader of a table.
- **Confirmed:** SFRs are at `0x800000–0x803FFF`.
  - `0x800100`: A/D0 status/control.
  - `0x800224–0x8003FF`: MJT timers.
  - `0x800232–0x80023E`: timer interrupt status.
  - `0x800700–0x80070F`: port data.
- **Confirmed:** free flash (all `0xFF`) is at `0xA2E69–0xFFFFE` (about 380 KB). Patch
  code will go at `0xA3000`. Smaller gaps exist at `0x5F97E–0x67FFF` and
  `0x3D322–0x3FFBF`.

## RAM variables

| RAM | `fp` disp | Meaning | Evidence |
|---|---|---|---|
| `0x8086F6` (u16) | -14602 | Engine RPM, 31.25 rpm/count | MUT `0x21` → `0x8086F7`; 254 code references; compared against rev-limit calibrations |
| `0x808780` (u16) | -14464 | Vehicle speed, 2 km/h per count | MUT `0x2F` → `0x808781`; speed limiter `0x17E80` compares it with `0x51262` (Speed16) |
| `0x80877E` (u16) | -14466 | Vehicle speed, finer resolution (stationary check) | compared with `0x51638`/`0x5163A`/`0x5273A`/`0x5273C` |
| `0x8085EC` (u16) | -14868 | Coolant temperature | MUT `0x07` → `0x8085ED` |
| `0x80899A` (u16) | -13926 | Ignition advance, MUT/display copy only | MUT `0x06`; written at `0x1EDA0` from `0x80899E` |
| `0x8094D6` (u16) | -11050 | RPM, finer scale (`>>2` gives 31.25 rpm/count) | used against the stationary limit `0x51634` |
| `0x808ACC` (u16) | -13620 | Limiter status flags (bits 0–3, 5–7) | built by `0x9FFB0` |

The **MUT table** at `0x3C7E8` (`Hex32`) maps MUT request IDs to RAM addresses.
Repointing a spare entry to any RAM address lets EvoScan log it. This is how the open
items below will be closed on the car.

## Limiter code

- **Confirmed:** `0x9FFB0`, the limiter flag routine, does the following:
  - Bit 1 of `0x808ACC` is set when `0x8094D6>>2` exceeds `Stationary Rev Limit`
    (`0x51634`), and cleared below `0x51636`.
  - Bit 2 / bit 0 hold vehicle-speed hysteresis (`0x51638`/`0x5163A`, `0x5162C`/`0x5162E`).
  - Stock value `0x51634` = `0x00FF`, which is 7969 rpm, so the stationary limiter
    never triggers.
  - **This is the natural place for the launch "armed + stationary + RPM ≥ launch RPM"
    decision**, because it already has the RPM and speed hysteresis structure.
- **Confirmed:** `0x2BBD8` is the main fuel-cut rev limiter. It compares `0x808CF6`
  (disp -13066) with `0x5125E`/`0x51260` (6602 / 6302 rpm, stock) and keeps the state
  in bit 5 of `0x808816`.
- **Confirmed:** `0x17E80` is the speed limiter, at `0x51262`/`0x51264` = 110/108,
  i.e. 220/216 km/h.

## Interrupts

- **Confirmed:** ICU vectors at `0x94–0x154` point to a second-level table at
  `0x8004–0x80A8`. That table holds the handler addresses:

  | Handler | What it does |
  |---|---|
  | `0xFA1C`, `0xFA48`, `0xFA78`, `0xFADC`, `0xFB24` | Read MJT status `0x800232–0x80023E` |
  | `0xFB88` | Status `0x800408` |
  | `0xFBB0` | A/D0, `0x800100` |
  | `0xDD90`, `0xFC40` | Other sources |

- **Confirmed:** `0xCA2C`/`0xCA54`/`0xCA7C` sample port `0x800707`/`0x800708`, then
  call `0x2D0B0` with a pin mask (1/8, 2/16, 4/32). This is edge processing, probably
  crank/cam.
- **Confirmed:** `0xF268` drives one pin, P0.6 (`0x800700` bit 6), through a 1–5 state
  machine together with timer `0x8003BC`/`0x800224`. **It is not the four-coil
  ignition output.**

## Open item 1: ignition output (where the spark cut goes)

The 4B11 has one ignition signal per coil. The output is almost certainly MJT output
timers (TOP/TIO) armed from the crank interrupt path. The registers
`0x8003D0` (98 references) and `0x8002FC` (48 references) are the leading candidates.

Next steps:

1. Follow `0x2D0B0` and its callees, and find the per-cylinder writes to output-timer
   compare registers and output-enable bits.
2. Look for an existing per-cylinder "skip this spark" condition. Mitsubishi code
   usually has one for misfire/immobiliser/engine-stop. Reusing it is far safer than
   inventing a new cut.
3. The hook then becomes: `if (launch_active) take the existing skip path`.

## Open item 2: cruise button input

- **Confirmed:** `ECU Options Set #3` (`0x50092`) = `0xA718`, so bit 14 (labelled
  CRUISE CONTROL) is 0 in the ROM. **This is only a default.** The code at
  `0x10CF4–0x10D98` puts the value the ECU actually uses in RAM `0x80878C`:
  - It picks one of 8 copies of the word by variant index `0x808798`. All 8 copies
    are identical in this ROM.
  - `0x5038E` = 1, so the word is then adjusted from the car's variant coding
    (`0x804EDC–0x804EE8`).
  - Coding values 12–17 at `0x804EE8`, or bit 7 of `0x804EE6`, turn on bit 14
    (`or3 r0,r0,#0x4000`).
  - The cruise enable therefore comes from how the car is coded, not from this bit.
    The table in the definition reads the ROM correctly, but it doesn't show the
    runtime state.
- **Confirmed:** `ECU Options Set #2` bit 10, "Cruise Control IGN RETARD", is 1, which
  is enabled. The `Spark Retard Cruise Control ON` map (`0x581AB`) is in use.
- The Mitsubishi cruise switch is a resistor ladder into one A/D channel. Each button
  (ON/OFF, CANCEL, SET-, RES+) gives a distinct voltage.

Next steps:

1. Repoint a spare MUT entry to `0x80878C`/`0x80878D` and log it. Bit 14 set means
   the ECU has cruise enabled at runtime. Leave the ROM bit as it is.
2. Repoint spare MUT entries to candidate A/D result RAM, then log in EvoScan while
   pressing each button. This identifies the variable and the voltage window for each
   button.
3. If the switch isn't wired to the ECU on this car, wire a momentary button to a spare
   analog input instead.

## Clutch switch input (for clutch activation mode)

- **Confirmed:** the ECU monitors a clutch pedal switch. `ECU Options Set #6`
  (`0x500C2`) bit 8 is labelled P0830 "CLUTCH PEDAL SWITCH A Circuit".
  - The code copies Set #6 to RAM `0x808792`.
  - `0x9FE24` builds the DTC enable mask from it: `ldub @(-14446,fp)` /
    `btst #7` tests halfword bit 8.
  - Set #6 = `0x0000`, so P0830 is not masked off. The switch is wired and checked.
- **Open:** which port bit the switch is read on. It's a digital input, so the
  quickest way to find it is a log: repoint spare MUT entries to the port data
  registers `0x800700–0x80070F`, log them in EvoScan, and press and release the
  clutch with the engine off. The bit that follows the pedal is the switch.

## Planned patch (once the ignition output and the activation input are found)

- `launch.s` at `0xA3000`, with the state kept in free RAM (to be checked as unused).
- All settings come from the tables at `0xA2F00–0xA2F13` (see the definition).

**Activation mode `0xA2F0C`:**

| Mode | Arms when | Active while | Disarms when |
|---|---|---|---|
| 0 = steering wheel button | button held for `Arm Hold Time`, speed `0x808780` < 2 (< 4 km/h), ECT ≥ `Min ECT` | armed, speed < `Disarm Speed`, `0x8086F6` ≥ `Launch RPM` | speed ≥ `Disarm Speed`, button pressed again, `Arm Timeout` reached, or ignition off |
| 1 = clutch pedal | clutch pressed, speed < `Disarm Speed`, ECT ≥ `Min ECT` | clutch pressed and RPM ≥ `Launch RPM` | clutch released, so it ends as you launch. No timeout needed. |

**Spark cut pattern.** This is applied in the hook to the existing per-cylinder skip
path. While active, every spark event steps a counter `n` from 0 to `L-1`:

- **Frequency** `L` = `0xA2F10`, the pattern length in sparks, 2–16. Each pattern is
  one burst of cut sparks followed by fired sparks, so `L` sets how often the cut
  repeats. Short patterns give a fast, even "brrap". Long patterns give slower, bigger
  bangs.
- **Density** `D` = `0xA2F0E`, the share of sparks cut, in 6.25 % steps (stored as
  sixteenths). Each pattern cuts `k = round(L × D)` sparks: spark `n` is cut when
  `n < k`.
- **Rotation:** the pattern start moves one cylinder per pattern, so the cuts don't
  always land on the same cylinder and the heat is shared out.
- **Examples:**
  - D = 50 %, L = 2: cut, fire, cut, fire, and so on.
  - D = 50 %, L = 8: 4 cut, then 4 fired.
  - D = 25 %, L = 8: 2 cut, then 6 fired.
  - D = 100 %: hard cut.
- **Timing** `0xA2F12` (signed °BTDC): ignition advance used on the sparks that still
  fire while the cut is active.
- **Backstop:** the fuel-cut rev limiter `0x5125E` stays as it is.
- **Logging:** a MUT entry for the launch-active flag.

`apply_patch.py` checks the ROM ID and the original bytes at every hook site, writes
the code and defaults, and leaves checksums to EcuFlash.

## Other definition files checked

- **SM5268 (2008 USDM Evo X):** a different ROM and an early community definition.
  No launch, RAM or patch information. Not useful here.
- **2011 Evo X GSR snippet** (user-supplied, ROM ID not given): contains
  - a **lean-spool** patch: Hysteresis `0x5312E`, Min Temp `0x53130`, Start/Stop RPM
    `0x53132`/`0x53136` (RPMStatLimit), AFR Enable/Clip `0x53134`/`0x53138`, and the
    "LeanSpool AFR v FuelMap AFR" map `0x55900`;
  - acceleration-enrichment tables.

  So community code patches exist for 2011 Evo X ROMs. But this snippet has **no
  launch control, flat shift or spark cut tables**, and those addresses belong to a
  different ROM. The patched `.bin` with launch control is still the thing to find.

## Definition file notes

The uploaded `2011-5MT-Lancer-X - MUT update v2.xml` has no `<scaling
name="RPMStatLimit">`. The `Stationary Rev Limit - RPM` table depends on that scaling,
so EcuFlash can't display it. `samples/54740002-LancerX-MUT-v2.xml` in this repo
already includes it:

```xml
<scaling name="RPMStatLimit" units="RPM" toexpr="x*31.25" frexpr="x/31.25" format="%.0f" min="0" max="9000" inc="31.25" storagetype="uint16" endian="big"/>
```

`54740002-2011-5MT-Lancer-X_-_MUT_update_v2-launch.xml` in this folder is the uploaded
definition with three changes:
- the RPMStatLimit fix above;
- three new scalings for the launch tables;
- a **Launch Control (INACTIVE - needs code patch)** category, with ten 1D tables in
  empty flash at `0xA2F00–0xA2F13`.

No stock code reads those addresses, so the launch tables do nothing until the code
patch is flashed. On a stock bin they read as `0xFF` (nonsense values).
