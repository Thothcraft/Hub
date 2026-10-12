'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { brainJson, nodeGet } from '../../lib/node-api';
import { contextApi, type CtxRelationship, type CtxState } from '../../lib/context-api';

interface Prediction {
  model_id?: string;
  label?: string;
  confidence?: number;
  timestamp?: number;
  [key: string]: unknown;
}

/**
 * Device detail → Context tab (Part 6): this node's predictions are
 * evidence; the derived context states and relationships referencing
 * it are shown separately with estimator attribution.
 */
export function DeviceContextPanel({ deviceId }: { deviceId: string }) {
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [states, setStates] = useState<CtxState[]>([]);
  const [rels, setRels] = useState<CtxRelationship[]>([]);
  const [entities, setEntities] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [snap, preds] = await Promise.all([
        contextApi.snapshot(),
        brainJson<{ predictions?: Prediction[] }>(
          `/devices/${encodeURIComponent(deviceId)}/predictions?limit=25`)
          .then((r) => r.predictions ?? [])
          .catch(() => nodeGet<any>(deviceId, '/api/v1/predictions')
            .then((r) => r?.predictions ?? [])
            .catch(() => [] as Prediction[])),
      ]);
      const entityIds = new Set(snap.entities.map((e) => e.id));
      const map: Record<string, string> = {};
      for (const e of snap.entities) map[e.id] = e.name ?? e.id;
      setEntities(map);
      // States whose evidence/provenance mentions this device.
      setStates(snap.states.filter((s) =>
        s.entity_id === deviceId || s.entity_id === `device:${deviceId}` ||
        JSON.stringify(s).includes(deviceId)));
      setRels(snap.relationships.filter((r) =>
        r.subject.includes(deviceId) || r.object.includes(deviceId)));
      setPredictions(preds);
      setError('');
      void entityIds;
    } catch (e: any) {
      setError(e?.message || 'context unavailable');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  if (loading) return (
    <div className="flex items-center gap-2 py-16 text-slate-500">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading context…
    </div>);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-900">
          Predictions (evidence)
        </h3>
        <p className="mb-3 text-xs text-slate-500">
          Raw model output — not asserted truth.
        </p>
        {predictions.length === 0 && (
          <p className="text-xs text-slate-400">No recent predictions.</p>)}
        {predictions.map((p, i) => (
          <div key={i} className="mb-1.5 flex justify-between text-xs">
            <span className="font-mono">{p.model_id ?? 'model'}</span>
            <span>{p.label ?? JSON.stringify(p)}</span>
            <span className="text-slate-500">
              {p.confidence != null ? `${Math.round(p.confidence * 100)}%` : ''}
            </span>
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-900">
          Derived context
        </h3>
        <p className="mb-3 text-xs text-slate-500">
          States attributed to this device&apos;s observations.
        </p>
        {states.length === 0 && (
          <p className="text-xs text-slate-400">No context states yet.</p>)}
        {states.map((s) => (
          <div key={s.id} className="mb-2 rounded bg-slate-50 px-3 py-2 text-xs">
            <div className="flex justify-between">
              <span className="font-mono text-blue-700">{s.key}</span>
              <span className="text-slate-500">
                {Math.round(s.confidence * 100)}% · {s.estimator || '—'}
              </span>
            </div>
            <div className="text-slate-800">
              {entities[s.entity_id] ?? s.entity_id ?? 'space'} →{' '}
              {typeof s.value === 'object' ? JSON.stringify(s.value) : String(s.value)}
            </div>
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-900">
          Relationships
        </h3>
        <p className="mb-3 text-xs text-slate-500">
          Edges mentioning this device in the context graph.
        </p>
        {rels.length === 0 && (
          <p className="text-xs text-slate-400">None.</p>)}
        {rels.map((r) => (
          <div key={r.id} className="mb-1 flex justify-between rounded bg-slate-50 px-3 py-1.5 text-xs">
            <span>{entities[r.subject] ?? r.subject} —{r.predicate}→ {entities[r.object] ?? r.object}</span>
            <span className="text-slate-500">{Math.round(r.confidence * 100)}%</span>
          </div>
        ))}
      </section>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
