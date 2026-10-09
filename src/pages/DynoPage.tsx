import { useEffect, useMemo, useState } from 'react';
import { activeLogs, useProject } from '../state/project';
import { FileBar } from '../components/FileBar';
import { DynoChart } from '../components/dyno/DynoChart';
import type { DynoSeries } from '../components/dyno/DynoChart';
import {
  crankFromWheel, DEFAULT_DYNO_OPTIONS, DEFAULT_VEHICLE, runDyno, toHp, toLbFt,
} from '../lib/dyno/dyno';
import type { DynoPull, VehicleSpec } from '../lib/dyno/dyno';
import { getPowerUnits, getVehicle, setPowerUnits, setVehicle } from '../lib/dyno/prefs';
import type { PowerUnits } from '../lib/dyno/prefs';

/**
 * Pull colours, in fixed order. Validated as a set against the panel surface
 * (#191d24): every adjacent pair separates for colour-blind readers and all
 * clear 3:1 contrast. A pull keeps its colour while it stays selected, so
 * ticking another pull never repaints the ones already on the chart.
 */
const PULL_COLORS = [
  '#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767',
];
const MAX_SHOWN = PULL_COLORS.length;

const VEHICLE_FIELDS: {
  key: keyof VehicleSpec; label: string; unit: string; step: number; hint: string;
}[] = [
  { key: 'massKg', label: 'Weight with driver', unit: 'kg', step: 10, hint: 'Curb weight plus everyone and everything aboard. Power scales directly with it.' },
  { key: 'cd', label: 'Drag coefficient', unit: 'Cd', step: 0.01, hint: 'Lancer ≈ 0.32, Evo X ≈ 0.34.' },
  { key: 'frontalAreaM2', label: 'Frontal area', unit: 'm²', step: 0.05, hint: 'Width × height × ~0.85.' },
  { key: 'crr', label: 'Rolling resistance', unit: 'Crr', step: 0.001, hint: 'Road tyres ≈ 0.010–0.015.' },
  { key: 'drivetrainLossPct', label: 'Drivetrain loss', unit: '%', step: 1, hint: 'Only for the crank estimate. Manual FWD ≈ 12–15, CVT/twin-clutch ≈ 15–20.' },
];

function fmtPower(kw: number, units: PowerUnits): string {
  return (units === 'metric' ? kw : toHp(kw)).toFixed(0);
}
function fmtTorque(nm: number, units: PowerUnits): string {
  return (units === 'metric' ? nm : toLbFt(nm)).toFixed(0);
}

export function DynoPage() {
  const project = useProject();
  const logs = activeLogs(project);

  const [vehicle, setVehicleState] = useState<VehicleSpec>(getVehicle);
  const [units, setUnitsState] = useState<PowerUnits>(getPowerUnits);
  const [smoothing, setSmoothing] = useState(DEFAULT_DYNO_OPTIONS.smoothingSeconds);
  const [autoThrottle, setAutoThrottle] = useState(true);
  const [minThrottle, setMinThrottle] = useState(90);
  const [hoverRpm, setHoverRpm] = useState<number | null>(null);
  /** Selected pull id → colour slot. */
  const [slots, setSlots] = useState<Record<string, number>>({});

  const powerUnit = units === 'metric' ? 'kW' : 'whp';
  const torqueUnit = units === 'metric' ? 'N·m' : 'lb·ft';

  const updateVehicle = (key: keyof VehicleSpec, value: number) => {
    const next = { ...vehicle, [key]: value };
    setVehicleState(next);
    setVehicle(next);
  };

  const result = useMemo(
    () => runDyno(
      logs.map((l) => l.log),
      vehicle,
      { ...DEFAULT_DYNO_OPTIONS, smoothingSeconds: smoothing, minThrottle: autoThrottle ? null : minThrottle },
    ),
    [logs, vehicle, smoothing, autoThrottle, minThrottle],
  );

  // Keep selections that still exist; start with the first few pulls shown.
  const pullIds = result.pulls.map((p) => p.id).join('|');
  useEffect(() => {
    setSlots((prev) => {
      const ids = new Set(result.pulls.map((p) => p.id));
      const kept = Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id)));
      if (Object.keys(kept).length > 0) return kept;
      const fresh: Record<string, number> = {};
      result.pulls.slice(0, 4).forEach((p, i) => { fresh[p.id] = i; });
      return fresh;
    });
  }, [pullIds]);

  const toggle = (id: string) => {
    setSlots((prev) => {
      if (id in prev) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      const used = new Set(Object.values(prev));
      const free = PULL_COLORS.findIndex((_, i) => !used.has(i));
      return free === -1 ? prev : { ...prev, [id]: free };
    });
  };

  const labelOf = (p: DynoPull) => `Pull ${result.pulls.indexOf(p) + 1}`;
  const shown = result.pulls.filter((p) => p.id in slots);

  const xDomain = useMemo<[number, number]>(() => {
    if (shown.length === 0) return [1000, 7000];
    const lo = Math.min(...shown.map((p) => p.points[0].rpm));
    const hi = Math.max(...shown.map((p) => p.points[p.points.length - 1].rpm));
    return [Math.floor(lo / 500) * 500, Math.ceil(hi / 500) * 500];
  }, [shown]);

  const series = (measure: 'power' | 'torque'): DynoSeries[] =>
    shown.map((p) => ({
      id: p.id,
      label: labelOf(p),
      color: PULL_COLORS[slots[p.id]],
      points: p.points.map((pt) => ({
        x: pt.rpm,
        y: measure === 'power'
          ? (units === 'metric' ? pt.powerKw : toHp(pt.powerKw))
          : (units === 'metric' ? pt.torqueNm : toLbFt(pt.torqueNm)),
      })),
    }));

  const best = shown.length
    ? shown.reduce((a, b) => (b.peakPowerKw > a.peakPowerKw ? b : a))
    : null;
  const bestTorque = shown.length
    ? shown.reduce((a, b) => (b.peakTorqueNm > a.peakTorqueNm ? b : a))
    : null;

  return (
    <div className="main">
      <aside className="sidebar wide">
        <FileBar />

        <div className="panel">
          <h2>Your car</h2>
          <div className="muted small" style={{ marginBottom: 8 }}>
            The dyno measures how fast the car gains speed, so it needs to know what it is
            pushing.
          </div>
          {VEHICLE_FIELDS.map((f) => (
            <label className="small" key={f.key} style={{ display: 'block', marginBottom: 8 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span>{f.label}</span>
                <span className="row" style={{ gap: 4 }}>
                  <input
                    type="number"
                    value={vehicle[f.key]}
                    step={f.step}
                    min={0}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) updateVehicle(f.key, v);
                    }}
                    style={{ width: 90, textAlign: 'right' }}
                  />
                  <span className="muted" style={{ width: 30 }}>{f.unit}</span>
                </span>
              </div>
              <div className="muted" style={{ fontSize: 11 }}>{f.hint}</div>
            </label>
          ))}
          <button
            className="small"
            onClick={() => { setVehicleState(DEFAULT_VEHICLE); setVehicle(DEFAULT_VEHICLE); }}
          >
            Reset to Lancer defaults
          </button>
        </div>

        <div className="panel">
          <h2>Dyno settings</h2>
          <div className="row" style={{ marginBottom: 10 }}>
            <button
              className={units === 'imperial' ? 'primary' : ''}
              onClick={() => { setUnitsState('imperial'); setPowerUnits('imperial'); }}
            >
              hp · lb·ft
            </button>
            <button
              className={units === 'metric' ? 'primary' : ''}
              onClick={() => { setUnitsState('metric'); setPowerUnits('metric'); }}
            >
              kW · N·m
            </button>
          </div>

          <label className="small" style={{ display: 'block' }}>
            Smoothing: {smoothing.toFixed(1)} s
            <input
              type="range"
              min={0.4}
              max={2}
              step={0.1}
              value={smoothing}
              onChange={(e) => setSmoothing(Number(e.target.value))}
              style={{ width: '100%' }}
            />
          </label>
          <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
            RPM is logged in 31-rpm steps, so some smoothing is needed. More smoothing gives a
            cleaner line but rounds off sharp changes.
          </div>

          <label className="row small" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={autoThrottle}
              onChange={(e) => setAutoThrottle(e.target.checked)}
            />
            Detect full throttle automatically
          </label>
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            Many drive-by-wire cars never report 100%. Auto mode treats 95% of the highest
            throttle in each log as full throttle.
          </div>
          {!autoThrottle && (
            <label className="small" style={{ display: 'block', marginTop: 6 }}>
              Pull starts at throttle ≥ {minThrottle}%
              <input
                type="range"
                min={40}
                max={100}
                step={1}
                value={minThrottle}
                onChange={(e) => setMinThrottle(Number(e.target.value))}
                style={{ width: '100%' }}
              />
            </label>
          )}
        </div>
      </aside>

      <main className="content">
        {result.status === 'blocked' ? (
          <div className={`notice ${logs.length === 0 ? 'info' : 'warn'}`}>
            <strong>{logs.length === 0 ? 'Load a log to put it on the dyno' : 'No dyno pull yet'}</strong>
            {result.message}
            {result.notes.length > 0 && <ul>{result.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          </div>
        ) : (
          <>
            <div className="stat-row">
              <div className="stat">
                <div className="muted small">Peak wheel power</div>
                <div className="stat-value">
                  {best ? fmtPower(best.peakPowerKw, units) : '—'}
                  <span className="muted small"> {powerUnit}</span>
                </div>
                <div className="muted small">
                  {best ? `at ${best.peakPowerRpm.toFixed(0)} rpm · ${labelOf(best)}` : 'select a pull'}
                </div>
              </div>
              <div className="stat">
                <div className="muted small">Peak wheel torque</div>
                <div className="stat-value">
                  {bestTorque ? fmtTorque(bestTorque.peakTorqueNm, units) : '—'}
                  <span className="muted small"> {torqueUnit}</span>
                </div>
                <div className="muted small">
                  {bestTorque
                    ? `at ${bestTorque.peakTorqueRpm.toFixed(0)} rpm · ${labelOf(bestTorque)}`
                    : 'select a pull'}
                </div>
              </div>
              <div className="stat">
                <div className="muted small">Estimated at the crank</div>
                <div className="stat-value">
                  {best ? fmtPower(crankFromWheel(best.peakPowerKw, vehicle.drivetrainLossPct), units) : '—'}
                  <span className="muted small"> {units === 'metric' ? 'kW' : 'hp'}</span>
                </div>
                <div className="muted small">assuming {vehicle.drivetrainLossPct}% drivetrain loss</div>
              </div>
            </div>

            <div className="panel">
              <h2>Pulls found</h2>
              <div className="muted small" style={{ marginBottom: 8 }}>
                Each pull is a stretch of full throttle in one gear. Tick up to {MAX_SHOWN} to
                compare them. Torque is wheel power at engine rpm, the same way a Dynojet sheet
                shows it.
              </div>
              <div className="grid-scroll">
                <table className="tune events">
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left' }}>Pull</th>
                      <th style={{ textAlign: 'left' }}>Log</th>
                      <th>Time</th>
                      <th>RPM</th>
                      <th title="Road speed per 1000 rpm in this gear">km/h/krpm</th>
                      <th>Peak power</th>
                      <th>Peak torque</th>
                      <th style={{ textAlign: 'left' }}>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.pulls.map((p) => {
                      const on = p.id in slots;
                      const full = !on && Object.keys(slots).length >= MAX_SHOWN;
                      return (
                        <tr key={p.id}>
                          <td style={{ textAlign: 'left' }}>
                            <label className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                              <input
                                type="checkbox"
                                checked={on}
                                disabled={full}
                                onChange={() => toggle(p.id)}
                              />
                              <span
                                style={{
                                  flex: '0 0 10px', width: 10, height: 10, borderRadius: 2, display: 'inline-block',
                                  background: on ? PULL_COLORS[slots[p.id]] : 'transparent',
                                  border: on ? 'none' : '1px solid var(--border)',
                                }}
                              />
                              {labelOf(p)}
                            </label>
                          </td>
                          <td style={{ textAlign: 'left' }} title={p.logName}>
                            <div style={{ maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.logName}</div>
                          </td>
                          <td>{p.startTime.toFixed(1)}–{p.endTime.toFixed(1)}s</td>
                          <td>{p.rpmStart.toFixed(0)}–{p.rpmEnd.toFixed(0)}</td>
                          <td>{(1000 / p.rpmPerKmh).toFixed(1)}</td>
                          <td>
                            {fmtPower(p.peakPowerKw, units)} {powerUnit}
                            <span className="muted"> @ {p.peakPowerRpm.toFixed(0)}</span>
                          </td>
                          <td>
                            {fmtTorque(p.peakTorqueNm, units)} {torqueUnit}
                            <span className="muted"> @ {p.peakTorqueRpm.toFixed(0)}</span>
                          </td>
                          <td style={{ textAlign: 'left', whiteSpace: 'normal', minWidth: 200, maxWidth: 260 }}>
                            {p.warnings.length === 0 ? (
                              <span className="badge ok">✓ clean</span>
                            ) : (
                              p.warnings.map((w, i) => (
                                <div key={i} className="small" style={{ marginBottom: 2 }}>
                                  <span className="badge suspect">! check</span> <span className="muted">{w}</span>
                                </div>
                              ))
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {shown.length > 0 && (
              <>
                <div className="panel">
                  <h2>Wheel power</h2>
                  <Legend pulls={shown} slots={slots} labelOf={labelOf} />
                  <DynoChart
                    series={series('power')}
                    xDomain={xDomain}
                    yLabel="Power"
                    unit={powerUnit}
                    hoverRpm={hoverRpm}
                    onHover={setHoverRpm}
                  />
                </div>
                <div className="panel">
                  <h2>Wheel torque</h2>
                  <Legend pulls={shown} slots={slots} labelOf={labelOf} />
                  <DynoChart
                    series={series('torque')}
                    xDomain={xDomain}
                    yLabel="Torque"
                    unit={torqueUnit}
                    hoverRpm={hoverRpm}
                    onHover={setHoverRpm}
                  />
                </div>
              </>
            )}

            <div className="notice info">
              <strong>How to get a good reading</strong>
              <ul>
                <li>Use one gear (3rd or 4th) from low rpm to near the redline, at full throttle.</li>
                <li>Pick a flat, straight road and do the same pull in both directions.</li>
                <li>Log only the channels you need so the sample rate goes up.</li>
                <li>Set the weight accurately: 10% too heavy reads about 10% too much power.</li>
              </ul>
              {result.notes.length > 0 && (
                <ul>{result.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Legend({ pulls, slots, labelOf }: {
  pulls: DynoPull[];
  slots: Record<string, number>;
  labelOf(p: DynoPull): string;
}) {
  return (
    <div className="row small" style={{ gap: 12, marginBottom: 6 }}>
      {pulls.map((p) => (
        <span className="row" key={p.id} style={{ gap: 5 }}>
          <span style={{ width: 14, height: 2, background: PULL_COLORS[slots[p.id]], display: 'inline-block' }} />
          {labelOf(p)}
          <span className="muted">
            {p.rpmStart.toFixed(0)}–{p.rpmEnd.toFixed(0)} rpm
          </span>
        </span>
      ))}
    </div>
  );
}
