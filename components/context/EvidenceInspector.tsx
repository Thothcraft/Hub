'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { contextApi, type CtxEvidence } from '../../lib/context-api';

const fmtTs = (ts?: number) =>
  ts ? new Date(ts * 1000).toLocaleString() : '—';
const truncate = (s: string, n = 120) =>
  s.length > n ? `${s.slice(0, n)}…` : s;

/**
 * Evidence inspector — raw observation/prediction rows with provenance,
 * filterable by key/source. This is the *evidence* layer, kept visually
 * separate from derived context state (Part 6).
 */
export function EvidenceInspector() {
  const [rows, setRows] = useState<CtxEvidence[]>([]);
  const [key, setKey] = useState('');
  const [source, setSource] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await contextApi.evidence({
        key: key || undefined,
        sourceId: source || undefined,
        limit: 300,
      }));
      setError('');
    } catch (e: any) {
      setError(e?.message || 'evidence unavailable');
    } finally {
      setLoading(false);
    }
  }, [key, source]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input value={key} onChange={(e) => setKey(e.target.value)}
          placeholder="key (e.g. ble.proximity.v1)"
          className="rounded bg-[#ece8de] px-3 py-1.5 text-sm" />
        <input value={source} onChange={(e) => setSource(e.target.value)}
          placeholder="source id"
          className="rounded bg-[#ece8de] px-3 py-1.5 text-sm" />
        <button onClick={load}
          className="rounded bg-[#11110f] px-3 py-1.5 text-sm hover:bg-[#6b7f4a]">
          Apply
        </button>
        <span className="text-xs text-[#5b5953]">
          Evidence = raw observations/predictions — not asserted truth.
        </span>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-12 text-[#5b5953]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading evidence…
        </div>
      ) : error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-[#5b5953]">
          No evidence rows match.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[#c9c4b9]">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#faf8f2] text-[#5b5953]">
              <tr>
                <th className="px-3 py-2">time</th>
                <th className="px-3 py-2">key</th>
                <th className="px-3 py-2">value</th>
                <th className="px-3 py-2">source</th>
                <th className="px-3 py-2">conf.</th>
                <th className="px-3 py-2">provenance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}
                  className="cursor-pointer border-t border-[#c9c4b9] hover:bg-[#faf8f2]"
                  onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <td className="px-3 py-2 text-[#5b5953]">{fmtTs(e.timestamp)}</td>
                  <td className="px-3 py-2 font-mono text-[#344323]">{e.key}</td>
                  <td className="px-3 py-2 font-mono">
                    {truncate(typeof e.value === 'object'
                      ? JSON.stringify(e.value) : String(e.value ?? ''))}
                  </td>
                  <td className="px-3 py-2 text-[#5b5953]">
                    {e.source_id ?? e.device_id ?? '—'}</td>
                  <td className="px-3 py-2">
                    {e.confidence !== undefined
                      ? `${Math.round(e.confidence * 100)}%` : '—'}</td>
                  <td className="px-3 py-2 text-[#5b5953]">
                    {open === e.id
                      ? <pre className="whitespace-pre-wrap font-mono">
                          {JSON.stringify(e.provenance ?? {}, null, 1)}
                        </pre>
                      : `${e.model_id ?? ''}${e.prediction_id ? ` · pred ${e.prediction_id}` : ''}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
