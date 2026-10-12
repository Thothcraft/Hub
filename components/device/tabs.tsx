'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Download,
  Play,
  Plus,
  RefreshCw,
  Square,
  Tag,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import {
  Automation,
  CaptureRecord,
  MetadataDoc,
  NodeModel,
  NodeSensor,
  NodeStatus,
  sensorLabel,
  SensorTail,
  nodeDelete,
  nodeGet,
  nodePost,
  nodeFetch,
} from '@/lib/node-api';

/** Shared tab props — the page shell owns the relay plumbing. */
export interface TabProps {
  deviceId: string;
  /** viewer=portal hides raw local token, unpairing, LAN links (§5). */
  viewer: 'local' | 'portal';
}

function fmtTime(ts?: number | null): string {
  if (!ts) return '—';
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleTimeString();
}

function Card({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

export function StatusTab({ deviceId, status, sensors, registryInfo }: TabProps & {
  status: NodeStatus | null;
  sensors: NodeSensor[];
  registryInfo?: { device_name?: string; device_type?: string; hardware_info?: Record<string, unknown>; last_seen?: string } | null;
}) {
  const [predictions, setPredictions] = useState<Array<Record<string, unknown>>>([]);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await nodeGet<{ predictions?: Array<Record<string, unknown>> }>(
          deviceId, '/api/predictions?limit=15');
        if (live) setPredictions(res.predictions || []);
      } catch { /* prediction list is best-effort */ }
    };
    load();
    const t = setInterval(load, 5000);
    return () => { live = false; clearInterval(t); };
  }, [deviceId]);

  const registeredSensors = registryInfo?.hardware_info?.sensors
    ?? registryInfo?.hardware_info?.available_sensors;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title="Device information">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {[
            ['Name', registryInfo?.device_name || status?.name || deviceId],
            ['Hardware', registryInfo?.device_type || String(registryInfo?.hardware_info?.device_type || 'Unknown')],
            ['Hostname', String(registryInfo?.hardware_info?.hostname || '—')],
            ['Last seen', registryInfo?.last_seen ? fmtTime(Date.parse(registryInfo.last_seen)) : '—'],
          ].map(([k, v]) => <div key={k} className="flex justify-between gap-3 border-b border-slate-100 py-1"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium text-slate-800">{v}</dd></div>)}
        </dl>
        {Array.isArray(registeredSensors) && <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-slate-600">Registered hardware sensor inventory</summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-slate-50 p-2 text-[11px] text-slate-700">{JSON.stringify(registeredSensors, null, 2)}</pre>
        </details>}
      </Card>
      <Card title="Node status">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {[
            ['State', status?.state || 'unknown'],
            ['Uptime', status?.uptime_s != null ? `${Math.round(Number(status.uptime_s) / 60)} min` : '—'],
            ['Sensors', String(sensors.length)],
            ['Active models', String(status?.models_active ?? '—')],
            ['Paired to cloud', status?.brain?.paired ? 'yes' : 'no'],
            ['Collection', status?.capture?.active ? 'collecting' : 'idle'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-slate-100 py-1">
              <dt className="text-slate-500">{k}</dt>
              <dd className="font-medium text-slate-800">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title="Sensors">
        {sensors.length === 0 && (
          <p className="text-sm text-slate-500">No sensors reported yet.</p>
        )}
        <ul className="space-y-1.5 text-sm">
          {sensors.map((s) => (
            <li key={s.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-1.5">
              <span className="text-xs text-slate-800">{sensorLabel(s)}
                <span className="ml-1.5 font-mono text-[10px] text-slate-400">{s.id}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="text-xs text-slate-500">{s.type || 'sensor'}</span>
                <span className={`h-2 w-2 rounded-full ${s.online === false ? 'bg-slate-300' : 'bg-emerald-500'}`} />
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Recent predictions">
        {predictions.length === 0 && (
          <p className="text-sm text-slate-500">No predictions yet.</p>
        )}
        <ul className="space-y-1 text-sm">
          {predictions.map((p, i) => (
            <li key={i} className="flex items-center justify-between rounded border border-slate-100 px-3 py-1">
              <span className="font-medium text-slate-800">
                {String(p.label ?? p.class ?? '—')}
              </span>
              <span className="text-xs text-slate-500">
                {p.confidence != null ? `${Math.round(Number(p.confidence) * 100)}%` : ''}
                {' · '}
                {fmtTime(Number(p.timestamp ?? p.ts ?? 0))}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Live                                                                */
/* ------------------------------------------------------------------ */

/** First meaningful numeric leaf of a sample payload — the value the
 * live sparkline tracks (G11). Prefers known names, falls back to the
 * first shallow numeric leaf. */
function pickNumeric(payload: unknown): number | null {
  if (payload == null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  for (const k of ['rssi', 'snr_db', 'snr', 'value', 'level', 'rms',
    'amplitude', 'heart_rate', 'bpm', 'cpu_percent', 'temperature',
    'count', 'magnitude']) {
    const v = p[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  for (const v of Object.values(p)) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v && typeof v === 'object') {
      for (const iv of Object.values(v as Record<string, unknown>)) {
        if (typeof iv === 'number' && Number.isFinite(iv)) return iv;
      }
    }
  }
  return null;
}

const SERIES_CAP = 240;   // rolling window of points kept per sensor
const PLOT_POINTS = 120;  // decimation target — stride-samples the window

/** Inline SVG sparkline — dependency-free, decimates the series. */
function Sparkline({ values }: { values: number[] }) {
  if (!values.length) return null;
  const stride = Math.max(1, Math.ceil(values.length / PLOT_POINTS));
  const pts = values.filter((_, i) => i % stride === 0);
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const w = 100, h = 32;
  const path = pts
    .map((v, i) =>
      `${(i / Math.max(1, pts.length - 1)) * w},${h - ((v - min) / span) * h}`)
    .join(' ');
  return (
    <div className="mb-2">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"
        className="h-16 w-full rounded bg-slate-50" role="img"
        aria-label="Live signal plot">
        <polyline points={path} fill="none" stroke="#0891b2"
          strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-slate-500">
        <span>min {min.toFixed(2)}</span>
        <span>n={values.length} · every {stride}</span>
        <span>max {max.toFixed(2)}</span>
      </div>
    </div>
  );
}

export function SensorTailPanel({ deviceId, sensor }: {
  deviceId: string;
  sensor: NodeSensor;
}) {
  const [tail, setTail] = useState<SensorTail | null>(null);
  const [series, setSeries] = useState<number[]>([]);
  const [err, setErr] = useState('');
  const cursor = useRef<number>(0);

  useEffect(() => {
    let live = true;
    cursor.current = 0;
    setSeries([]);
    const poll = async () => {
      try {
        const res = await nodeGet<SensorTail>(
          deviceId,
          `/api/sensors/${encodeURIComponent(sensor.id)}/tail?cursor=${cursor.current}`,
        );
        if (!live) return;
        if (res.cursor != null) cursor.current = Number(res.cursor);
        setTail(res);
        const vals = (res.samples || [])
          .map((s) => pickNumeric(s?.payload ?? s))
          .filter((v): v is number => v != null);
        if (vals.length) {
          setSeries((prev) => {
            const next = prev.concat(vals);
            return next.length > SERIES_CAP
              ? next.slice(next.length - SERIES_CAP) : next;
          });
        }
        setErr('');
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : 'stream failed');
      }
    };
    poll();
    const t = setInterval(poll, 1500);
    return () => { live = false; clearInterval(t); };
  }, [deviceId, sensor.id]);

  const samples = tail?.samples || [];
  const latest = samples.length ? samples[samples.length - 1] : null;
  const rate = latest && (latest as { sample_rate?: number }).sample_rate;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">
          <Activity className="mr-1 inline h-4 w-4 text-cyan-600" />
          {sensorLabel(sensor)}
        </h3>
        <span className="text-xs text-slate-500">
          {rate ? `${rate} Hz · ` : ''}{samples.length} samples · cursor {cursor.current}
        </span>
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
      <Sparkline values={series} />
      {latest ? (
        <details>
          <summary className="cursor-pointer text-xs text-slate-500">
            Latest sample
          </summary>
          <pre className="mt-1 max-h-56 overflow-auto rounded bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700">
            {JSON.stringify(latest, null, 2)}
          </pre>
        </details>
      ) : (
        <p className="text-xs text-slate-500">Waiting for samples…</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Captures                                                            */
/* ------------------------------------------------------------------ */

export function CapturesTab({ deviceId }: TabProps) {
  const toast = useToast();
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [busy, setBusy] = useState('');
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await nodeGet<{ captures?: CaptureRecord[] }>(deviceId, '/api/captures');
      setCaptures(res.captures || []);
    } catch (e) {
      toast.error('Collected data', e instanceof Error ? e.message : 'load failed');
    }
  }, [deviceId, toast]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success('Done', ok);
      await load();
    } catch (e) {
      toast.error('Collection action failed', e instanceof Error ? e.message : 'error');
    } finally {
      setBusy('');
    }
  };

  const download = async (cap: CaptureRecord) => {
    const id = String(cap.id || cap.capture_id || '');
    try {
      const res = await nodeFetch(deviceId, `/api/captures/${encodeURIComponent(id)}/download`);
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `capture-${id}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error('Download failed', e instanceof Error ? e.message : 'error');
    }
  };

  const activeCount = captures.filter((c) =>
    c.state === 'active' || (c.started_at != null && c.stopped_at == null)).length;

  return (
    <Card
      title={`Collected data${activeCount ? ' · recording' : ''}`}
      actions={
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy === 'start'}
            onClick={() => run('start', () => nodePost(deviceId, '/api/captures/start', {}), 'collection started')}
            className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" /> Start collecting
          </button>
          <button
            type="button"
            onClick={load}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      }
    >
      {captures.length === 0 && (
        <p className="text-sm text-slate-500">Nothing collected on this node yet.</p>
      )}
      <ul className="space-y-2">
        {captures.map((cap) => {
          const id = String(cap.id || cap.capture_id || '');
          const active = cap.state === 'active' || (cap.started_at != null && cap.stopped_at == null);
          const labels = (cap.labels || []).map((l) =>
            typeof l === 'string' ? l : String(l.label || ''));
          const counts = (cap.sample_counts || {}) as Record<string, number>;
          const started = Number(cap.started_at || 0);
          const ended = Number(cap.stopped_at || 0) || (active ? Date.now() / 1000 : 0);
          const spanS = Math.max(0, ended - started);
          const duration = spanS < 60 ? `${Math.round(spanS)}s`
            : spanS < 3600 ? `${Math.floor(spanS / 60)}m ${Math.round(spanS % 60)}s`
            : `${Math.floor(spanS / 3600)}h ${Math.floor((spanS % 3600) / 60)}m`;
          // second-level coverage: manifest `seconds` map epoch → per-sensor counts
          const secs = (cap.seconds || {}) as Record<string, Record<string, number>>;
          const buckets = Math.min(60, Math.max(1, Math.ceil(spanS)));
          const filled = new Set<number>();
          for (const k of Object.keys(secs)) {
            const b = Math.floor(((Number(k) - started) / Math.max(1, spanS)) * buckets);
            if (b >= 0 && b < buckets) filled.add(b);
          }
          return (
            <li key={id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-slate-800">{id}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>
                    {active ? 'recording' : (cap.state || 'stopped')}
                  </span>
                  <span className="text-xs text-slate-500">
                    {fmtTime(cap.started_at)} → {fmtTime(cap.stopped_at)} · {duration}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  {active ? (
                    <button
                      type="button"
                      disabled={busy === `stop-${id}`}
                      onClick={() => run(`stop-${id}`, () => nodePost(deviceId, '/api/captures/stop', { capture_id: id }), 'collection stopped')}
                      className="rounded-md border border-amber-300 bg-amber-50 p-1.5 text-amber-700 hover:bg-amber-100"
                      title="Stop collecting"
                    >
                      <Square className="h-3.5 w-3.5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => download(cap)}
                      className="rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50"
                      title="Download zip"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => run(`auto-${id}`, () => nodePost(deviceId, `/api/captures/${encodeURIComponent(id)}/autolabel`, {}), 'auto-labels applied')}
                    className="rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50"
                    title="Auto-label from predictions"
                  >
                    <Wand2 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={active}
                    onClick={() => run(`del-${id}`, () => nodeDelete(deviceId, `/api/captures/${encodeURIComponent(id)}`), 'collection deleted')}
                    className="rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-red-50 hover:text-red-700 disabled:opacity-40"
                    title={active ? 'Stop collecting first' : 'Delete'}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              {Object.keys(counts).length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px] text-slate-600">
                  {Object.entries(counts).map(([sid, n]) => (
                    <span key={sid} className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono">
                      {sid}: {n}
                    </span>
                  ))}
                </div>
              )}
              {spanS > 0 && (
                <div className="mt-1.5 flex items-center gap-px"
                     title={`${filled.size}/${buckets} seconds with aligned data`}>
                  {Array.from({ length: buckets }, (_, i) => (
                    <div key={i} className="h-2 flex-1 rounded-[1px]"
                         style={{ background: filled.has(i) ? '#10b981' : '#e2e8f0' }} />
                  ))}
                  <span className="ml-1.5 text-[10px] text-slate-500">
                    {Math.round((filled.size / buckets) * 100)}%
                  </span>
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {labels.map((l) => (
                  <span key={l} className="rounded-full bg-cyan-50 px-2 py-0.5 text-[10px] font-medium text-cyan-800">
                    {l}
                  </span>
                ))}
                <input
                  value={labelDrafts[id] ?? ''}
                  onChange={(e) => setLabelDrafts((d) => ({ ...d, [id]: e.target.value }))}
                  placeholder="add label…"
                  className="w-28 rounded-md border border-slate-200 px-2 py-1 text-xs"
                />
                <button
                  type="button"
                  onClick={() => {
                    const label = (labelDrafts[id] || '').trim();
                    if (!label) return;
                    run(`label-${id}`, () => nodePost(deviceId, `/api/captures/${encodeURIComponent(id)}/label`, { label }), `labeled "${label}"`);
                  }}
                  className="rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50"
                  title="Add label"
                >
                  <Tag className="h-3.5 w-3.5" />
                </button>
                {labels.length > 0 && (
                  <button
                    type="button"
                    onClick={() => run(`clear-${id}`, () => nodePost(deviceId, `/api/captures/${encodeURIComponent(id)}/clear-labels`, {}), 'labels cleared')}
                    className="rounded-md border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50"
                    title="Clear labels"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

export function ModelsTab({ deviceId }: TabProps) {
  const toast = useToast();
  const [installed, setInstalled] = useState<NodeModel[]>([]);
  const [catalog, setCatalog] = useState<Array<Record<string, unknown>>>([]);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const [m, c] = await Promise.all([
        nodeGet<{ models?: NodeModel[] }>(deviceId, '/api/models'),
        nodeGet<{ models?: Array<Record<string, unknown>> }>(deviceId, '/api/v1/model-catalog'),
      ]);
      setInstalled(m.models || []);
      setCatalog(c.models || []);
    } catch (e) {
      toast.error('Models', e instanceof Error ? e.message : 'load failed');
    }
  }, [deviceId, toast]);

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  const activate = (m: NodeModel, active: boolean) => {
    const id = String(m.runtime_model_id || m.id || '');
    setBusy(`act-${id}`);
    nodePost(deviceId, '/api/models/activate', { runtime_model_id: id, active })
      .then(() => { toast.success('Model', active ? 'activated' : 'deactivated'); return load(); })
      .catch((e) => toast.error('Activate failed', e instanceof Error ? e.message : 'error'))
      .finally(() => setBusy(''));
  };

  const install = (entry: Record<string, unknown>) => {
    const name = String(entry.name || entry.id || 'model');
    setBusy(`inst-${name}`);
    nodePost(deviceId, '/api/models/install', {
      name,
      processor: entry.processor || 'rule',
      config: entry.config || entry,
      deployment_id: entry.deployment_id,
    })
      .then(() => { toast.success('Model', `${name} installed`); return load(); })
      .catch((e) => toast.error('Install failed', e instanceof Error ? e.message : 'error'))
      .finally(() => setBusy(''));
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title="Installed on node">
        {installed.length === 0 && <p className="text-sm text-slate-500">No models installed.</p>}
        <ul className="space-y-2">
          {installed.map((m) => {
            const id = String(m.runtime_model_id || m.id || m.name);
            const active = m.active !== false && m.enabled !== false;
            return (
              <li key={id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                <div>
                  <div className="text-sm font-medium text-slate-900">{m.name || id}</div>
                  <div className="text-xs text-slate-500">{m.processor || 'model'} · {id}</div>
                </div>
                <button
                  type="button"
                  disabled={busy === `act-${id}`}
                  onClick={() => activate(m, !active)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${active ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                >
                  {active ? 'Active' : 'Inactive'}
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
      <Card title="Catalog (local + cloud)">
        {catalog.length === 0 && <p className="text-sm text-slate-500">Catalog unavailable.</p>}
        <ul className="space-y-2">
          {catalog.map((entry, i) => {
            const name = String(entry.name || entry.id || `model-${i}`);
            return (
              <li key={`${name}-${i}`} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                <div>
                  <div className="text-sm font-medium text-slate-900">{name}</div>
                  <div className="text-xs text-slate-500">
                    {String(entry.processor || '')} {entry.source ? `· ${String(entry.source)}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy === `inst-${name}`}
                  onClick={() => install(entry)}
                  className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
                >
                  <Plus className="h-3 w-3" /> Install
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Automations                                                         */
/* ------------------------------------------------------------------ */

const AUTOMATION_TEMPLATE = JSON.stringify(
  {
    name: 'new-automation',
    enabled: true,
    trigger: { type: 'event', on: 'label' },
    action: { type: 'lan', actuator: 'light', operation: 'toggle', params: {} },
  },
  null,
  2,
);

export function AutomationsTab({ deviceId }: TabProps) {
  const toast = useToast();
  const [items, setItems] = useState<Automation[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState(AUTOMATION_TEMPLATE);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await nodeGet<{ automations?: Automation[] }>(deviceId, '/api/automations');
      setItems(res.automations || []);
    } catch (e) {
      toast.error('Automations', e instanceof Error ? e.message : 'load failed');
    }
  }, [deviceId, toast]);

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  const toggle = (auto: Automation) => {
    setBusy(auto.id);
    nodePost(deviceId, `/api/automations/${encodeURIComponent(auto.id)}`,
      { enabled: !auto.enabled })
      .then(() => load())
      .catch((e) => toast.error('Toggle failed', e instanceof Error ? e.message : 'error'))
      .finally(() => setBusy(''));
  };

  const remove = (auto: Automation) => {
    setBusy(`del-${auto.id}`);
    nodeDelete(deviceId, `/api/automations/${encodeURIComponent(auto.id)}`)
      .then(() => { toast.success('Automation', 'deleted'); return load(); })
      .catch((e) => toast.error('Delete failed', e instanceof Error ? e.message : 'error'))
      .finally(() => setBusy(''));
  };

  const save = () => {
    try {
      const parsed = JSON.parse(draft);
      if (!parsed.name && !parsed.id) {
        toast.error('Automation', 'a name or id is required');
        return;
      }
      setBusy('save');
      nodePost(deviceId, '/api/automations', parsed)
        .then(() => {
          toast.success('Automation', 'saved');
          setEditorOpen(false);
          setDraft(AUTOMATION_TEMPLATE);
          return load();
        })
        .catch((e) => toast.error('Save failed', e instanceof Error ? e.message : 'error'))
        .finally(() => setBusy(''));
    } catch (e) {
      toast.error('Invalid JSON', e instanceof Error ? e.message : 'parse error');
    }
  };

  return (
    <Card
      title="Automations"
      actions={
        <button
          type="button"
          onClick={() => setEditorOpen((v) => !v)}
          className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700"
        >
          <Plus className="h-3.5 w-3.5" /> New
        </button>
      }
    >
      {editorOpen && (
        <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="mb-2 text-xs font-semibold text-slate-600">
            Automation spec (whispy-automation/v1)
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={10}
            spellCheck={false}
            className="w-full rounded-md border border-slate-300 bg-white p-2 font-mono text-xs"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy === 'save'}
              onClick={save}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditorOpen(false)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {items.length === 0 && (
        <p className="text-sm text-slate-500">No automations on this node.</p>
      )}
      <ul className="space-y-2">
        {items.map((auto) => (
          <li key={auto.id} className="rounded-lg border border-slate-200 px-3 py-2">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-900">
                  {auto.name || auto.id}
                </div>
                <div className="truncate font-mono text-[11px] text-slate-500">
                  {JSON.stringify(auto.trigger || {})} → {JSON.stringify(auto.action || {})}
                </div>
              </div>
              <div className="ml-3 flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy === auto.id}
                  onClick={() => toggle(auto)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${auto.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}
                >
                  {auto.enabled ? 'On' : 'Off'}
                </button>
                <button
                  type="button"
                  disabled={busy === `del-${auto.id}`}
                  onClick={() => remove(auto)}
                  className="rounded-md border border-slate-200 p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-700"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

export function MetadataFields({ deviceId, onSaved }: {
  deviceId: string;
  onSaved?: () => void;
}) {
  const toast = useToast();
  const [meta, setMeta] = useState<MetadataDoc | null>(null);
  const [draft, setDraft] = useState({ room_name: '', friendly_name: '', room_id: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await nodeGet<MetadataDoc>(deviceId, '/api/v1/metadata');
      setMeta(res);
      setDraft({
        room_name: res.manual?.room_name || '',
        friendly_name: res.manual?.friendly_name || '',
        room_id: res.manual?.room_id || '',
      });
    } catch { /* node may predate /api/v1/metadata */ }
  }, [deviceId]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      await nodeFetch(deviceId, '/api/v1/metadata', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      toast.success('Metadata', 'saved');
      await load();
      onSaved?.();
    } catch (e) {
      toast.error('Save failed', e instanceof Error ? e.message : 'error');
    } finally {
      setSaving(false);
    }
  };

  const inferred = meta?.inferred || {};

  return (
    <Card title="Device metadata">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Inferred (refreshed by the node)
          </div>
          <dl className="space-y-1.5 text-sm">
            {[
              ['Location', inferred.location?.city || inferred.location?.postal_code ||
                (inferred.location?.lat != null ? `${inferred.location.lat}, ${inferred.location.lon}` : '—')],
              ['Activity', inferred.activity?.kind
                ? `${inferred.activity.kind} (${Math.round(Number(inferred.activity.confidence || 0) * 100)}%)`
                : '—'],
              ['Battery', inferred.battery?.percent != null
                ? `${inferred.battery.percent}%${inferred.battery.charging ? ' ⚡' : ''}`
                : '—'],
              ['Foreground app', inferred.application?.foreground || '—'],
              ['Platform', inferred.application?.platform || '—'],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-slate-100 py-1">
                <dt className="text-slate-500">{k}</dt>
                <dd className="font-medium text-slate-800">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Manual (node-persisted)
          </div>
          {(['friendly_name', 'room_name', 'room_id'] as const).map((field) => (
            <label key={field} className="mb-2 block text-xs text-slate-600">
              {field.replace(/_/g, ' ')}
              <input
                value={draft[field]}
                onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
                className="mt-0.5 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
          ))}
          <button
            type="button"
            disabled={saving}
            onClick={save}
            className="mt-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save metadata'}
          </button>
        </div>
      </div>
    </Card>
  );
}
