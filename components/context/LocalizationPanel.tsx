'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { contextApi, type CtxEvidence, type CtxState } from '../../lib/context-api';

/**
 * Localization diagnostics (Part 6): live location.* state, the BLE
 * fingerprints collected during calibration, and per-source freshness so
 * coverage gaps are visible before trusting location.space/zone.v1.
 */
export function LocalizationPanel() {
  const [states, setStates] = useState<CtxState[]>([]);
  const [fingerprints, setFingerprints] = useState<CtxEvidence[]>([]);
  const [ble, setBle] = useState<CtxEvidence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [loc, fp, proximity] = await Promise.all([
        contextApi.states({ activeOnly: true }),
        contextApi.evidence({ key: 'localization.fingerprint.v1', limit: 200 }),
        contextApi.evidence({ key: 'ble.proximity.v1', limit: 200 }),
      ]);
      setStates(loc.filter((s) => s.key.startsWith('location.')));
      setFingerprints(fp);
      setBle(proximity);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'localization data unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  if (loading) return (
    <div className="flex items-center gap-2 py-16 text-[#5b5953]">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading localization…
    </div>);

  const observers = new Set(ble.map((e) =>
    String(((e.value ?? {}) as any).observer ?? e.source_id ?? '?')));
  const targets = new Set(ble.map((e) =>
    String(((e.value ?? {}) as any).target ?? '?')));

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <section className="rounded-lg border border-[#c9c4b9] bg-[#faf8f2] p-4">
        <h3 className="mb-3 text-sm font-semibold">Live location state</h3>
        {states.length === 0 && (
          <p className="text-xs text-[#5b5953]">
            No location.space.v1 / location.zone.v1 states — run calibration
            from the mobile app.</p>)}
        {states.map((s) => (
          <div key={s.id} className="mb-2 rounded bg-[#f4f1e9] px-3 py-2 text-sm">
            <div className="flex justify-between">
              <span className="font-mono text-xs text-[#5b5953]">{s.key}</span>
              <span className="text-xs text-[#5b5953]">
                {Math.round(s.confidence * 100)}%</span>
            </div>
            <div>{s.entity_id || 'space'} → {String(s.value ?? '—')}</div>
            <div className="text-xs text-[#5b5953]">est. {s.estimator || '—'}</div>
          </div>
        ))}
      </section>

      <section className="rounded-lg border border-[#c9c4b9] bg-[#faf8f2] p-4">
        <h3 className="mb-3 text-sm font-semibold">
          Calibration fingerprints ({fingerprints.length})
        </h3>
        {fingerprints.map((f) => {
          const v = (f.value ?? {}) as Record<string, unknown>;
          return (
            <div key={f.id} className="mb-2 rounded bg-[#f4f1e9] px-3 py-2 text-xs">
              <div className="flex justify-between">
                <span>{String(v.zone ?? 'space')}</span>
                <span className="text-[#5b5953]">×{Number(v.samples ?? 0)}</span>
              </div>
              <pre className="mt-1 max-h-24 overflow-auto text-[#5b5953]">
                {JSON.stringify(v.vector ?? {}, null, 0)}</pre>
            </div>
          );
        })}
        {fingerprints.length === 0 && (
          <p className="text-xs text-[#5b5953]">
            None collected — use Calibrate in the app.</p>)}
      </section>

      <section className="rounded-lg border border-[#c9c4b9] bg-[#faf8f2] p-4">
        <h3 className="mb-3 text-sm font-semibold">BLE coverage</h3>
        <div className="space-y-2 text-xs text-[#5b5953]">
          <p>{observers.size} observer(s) reporting · {targets.size} target(s)</p>
          {ble.slice(0, 12).map((e) => {
            const v = (e.value ?? {}) as Record<string, unknown>;
            const age = e.timestamp
              ? Math.max(0, Date.now() / 1000 - e.timestamp) : 0;
            return (
              <div key={e.id} className="flex justify-between">
                <span className="font-mono">
                  {String(v.observer ?? '?').split(':').pop()} →{' '}
                  {String(v.target ?? '?').split(':').pop()}
                </span>
                <span className={age > 60 ? 'text-amber-400' : 'text-green-400'}>
                  {Number(v.rssi_dbm ?? v.rssi)} dBm · {age.toFixed(0)}s
                </span>
              </div>
            );
          })}
          {ble.length === 0 && (
            <p>No proximity evidence flowing — check the BLE source.</p>)}
        </div>
      </section>

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
