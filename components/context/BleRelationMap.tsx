'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { contextApi, type CtxEvidence } from '../../lib/context-api';

interface Edge {
  observer: string;
  target: string;
  rssi: number;
  ts: number;
  samples: number;
  known: boolean;
  advName?: string;
}

const W = 760, H = 420;

/**
 * Normalize all three BLE evidence schemas into observer→target edges:
 *   ble.proximity.v1  — phone scan of enrolled wearables (flat value)
 *   ble.discovery.v1  — phone scan of unenrolled advertisers (known=false)
 *   ble.rssi.v1       — node observer (observation envelope: value nests
 *                       {value:{rssi_dbm}, subject}; device_id = node uuid)
 */
function toEdges(rows: CtxEvidence[]): Edge[] {
  const byKey = new Map<string, Edge>();
  for (const e of rows) {
    const outer = (e.value ?? {}) as Record<string, any>;
    let observer = String(outer.observer ?? e.device_id ?? e.source_id ?? 'unknown');
    let target = String(outer.target ?? '');
    let rssi = Number(outer.rssi_dbm ?? outer.rssi);
    let known = e.key !== 'ble.discovery.v1';
    let advName: string | undefined = outer.adv_name;

    if (e.key === 'ble.rssi.v1') {
      const inner = (outer.value ?? {}) as Record<string, any>;
      target = String(outer.subject ?? inner.subject ?? '');
      rssi = Number(inner.rssi_dbm ?? inner.rssi);
      known = !target.startsWith('device:ble:');
    }
    if (!target || !Number.isFinite(rssi)) continue;
    const ts = e.timestamp ?? 0;
    const key = `${observer}→${target}`;
    const prev = byKey.get(key);
    if (!prev || ts > prev.ts) {
      byKey.set(key, { observer, target, rssi, ts,
        samples: (prev?.samples ?? 0) + 1, known, advName });
    } else {
      prev.samples += 1;
    }
  }
  return Array.from(byKey.values());
}

/**
 * BLE relation map — observers (nodes/phones) on the left, targets
 * (wearables, unknown advertisers) on the right. Edge width encodes RSSI,
 * opacity encodes freshness. RSSI is signal strength — never relabeled
 * as distance.
 */
export function BleRelationMap() {
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const since = Date.now() / 1000 - 600;
      const batches = await Promise.all(
        ['ble.proximity.v1', 'ble.rssi.v1', 'ble.discovery.v1']
          .map((key) => contextApi.evidence({ key, since, limit: 400 })
            .catch(() => [] as CtxEvidence[])));
      setEdges(toEdges(batches.flat()));
      setError('');
    } catch (e: any) {
      setError(e?.message || 'BLE evidence unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const layout = useMemo(() => {
    const observers = Array.from(new Set(edges.map((e) => e.observer)));
    const targets = Array.from(new Set(edges.map((e) => e.target)));
    const knownTargets = targets.filter((t) =>
      edges.some((e) => e.target === t && e.known));
    const unknownTargets = targets.filter((t) => !knownTargets.includes(t));
    const pos = new Map<string, { x: number; y: number }>();
    observers.forEach((o, i) =>
      pos.set(`o:${o}`, { x: 110, y: 60 + (i * (H - 120)) / Math.max(1, observers.length - 1 || 1) }));
    const allTargets = [...knownTargets, ...unknownTargets];
    allTargets.forEach((t, i) =>
      pos.set(`t:${t}`, { x: W - 110, y: 60 + (i * (H - 120)) / Math.max(1, allTargets.length - 1 || 1) }));
    return { observers, knownTargets, unknownTargets, pos };
  }, [edges]);

  if (loading) return (
    <div className="flex items-center gap-2 py-16 text-[#5b5953]">
      <Loader2 className="h-4 w-4 animate-spin" /> Reading BLE evidence…
    </div>);
  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (edges.length === 0) return (
    <p className="py-12 text-center text-sm text-[#5b5953]">
      No BLE proximity evidence yet — enable the BLE source in the mobile
      app (enrolled + unknown advertisers) or wait for node-side BLE
      scanning to report edges.</p>);

  const now = Date.now() / 1000;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
      <svg viewBox={`0 0 ${W} ${H}`}
        className="w-full rounded-lg border border-[#c9c4b9] bg-[#f4f1e9]">
        {edges.map((e, i) => {
          const a = layout.pos.get(`o:${e.observer}`)!;
          const b = layout.pos.get(`t:${e.target}`)!;
          const fresh = Math.max(0, 1 - (now - e.ts) / 90);
          const strength = Math.max(0, Math.min(1, (e.rssi + 95) / 60));
          return (
            <g key={i}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={e.known ? '#60a5fa' : '#9ca3af'}
                strokeDasharray={e.known ? undefined : '4 3'}
                strokeOpacity={0.15 + 0.6 * fresh}
                strokeWidth={1 + 3 * strength} />
              <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 3}
                fontSize={10} className="fill-neutral-500" textAnchor="middle">
                {e.rssi} dBm
              </text>
            </g>
          );
        })}
        {layout.observers.map((o) => {
          const p = layout.pos.get(`o:${o}`)!;
          return (
            <g key={o}>
              <circle cx={p.x} cy={p.y} r={16} fill="#3b82f6" />
              <text x={p.x} y={p.y - 24} fontSize={11} textAnchor="middle"
                className="fill-[#34342f]">{o.split(':').pop()}</text>
              <text x={p.x} y={p.y + 4} fontSize={10} textAnchor="middle"
                className="fill-white">◉</text>
            </g>
          );
        })}
        {layout.knownTargets.map((t) => {
          const p = layout.pos.get(`t:${t}`)!;
          return (
            <g key={t}>
              <circle cx={p.x} cy={p.y} r={16} fill="#14b8a6" />
              <text x={p.x} y={p.y - 24} fontSize={11} textAnchor="middle"
                className="fill-[#34342f]">{t.split(':').pop()}</text>
              <text x={p.x} y={p.y + 4} fontSize={10} textAnchor="middle"
                className="fill-white">◌</text>
            </g>
          );
        })}
        {layout.unknownTargets.map((t) => {
          const p = layout.pos.get(`t:${t}`)!;
          const adv = edges.find((e) => e.target === t && e.advName)?.advName;
          return (
            <g key={t}>
              <circle cx={p.x} cy={p.y} r={16} fill="none"
                stroke="#9ca3af" strokeDasharray="4 3" strokeWidth={1.5} />
              <text x={p.x} y={p.y - 24} fontSize={11} textAnchor="middle"
                className="fill-neutral-500">
                {adv ?? `${t.split(':').pop()?.slice(0, 8)}…`}
              </text>
              <text x={p.x} y={p.y + 4} fontSize={10} textAnchor="middle"
                className="fill-neutral-500">?</text>
            </g>
          );
        })}
      </svg>
      <div className="rounded-lg border border-[#c9c4b9] bg-[#faf8f2] p-3 text-xs">
        <p className="mb-2 font-medium text-[#34342f]">
          width = RSSI · fade = age · dashed = unenrolled device
        </p>
        {edges.map((e, i) => (
          <div key={i} className="mb-1 flex justify-between text-[#5b5953]">
            <span className="font-mono">
              {e.observer.split(':').pop()} → {e.target.split(':').pop()?.slice(0, 12)}
            </span>
            <span>{e.rssi} dBm · {Math.max(0, now - e.ts).toFixed(0)}s · ×{e.samples}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
