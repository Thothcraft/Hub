'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import {
  contextApi, type CtxEntity, type CtxRelationship, type CtxSnapshot,
} from '../../lib/context-api';

const KINDS = ['person', 'device', 'wearable', 'space', 'building', 'object'];

/**
 * Entities + relationship graph (Part 6): list with kind/name, create
 * entity form, relationship CRUD, and an edge list grouped by predicate.
 */
export function EntityExplorer({ snapshot }: { snapshot: CtxSnapshot | null }) {
  const [kind, setKind] = useState('person');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [rels, setRels] = useState<CtxRelationship[]>([]);
  const [error, setError] = useState('');
  const [sel, setSel] = useState<string>('');
  const [placementPerson, setPlacementPerson] = useState('');
  const [placementPlace, setPlacementPlace] = useState('');

  const entities = useMemo(() => snapshot?.entities ?? [], [snapshot]);

  const loadRels = useCallback(async () => {
    try {
      setRels(await contextApi.relationships({ activeOnly: true }));
      setError('');
    } catch (e: any) {
      setError(e?.message || 'relationships unavailable');
    }
  }, []);

  useEffect(() => { loadRels(); }, [loadRels]);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const id = `${kind}:${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      await contextApi.upsertEntity({ id, kind, name: name.trim() });
      setName('');
      window.dispatchEvent(new Event('context:refresh'));
    } catch (e: any) {
      setError(e?.message || 'create failed');
    } finally {
      setBusy(false);
    }
  };

  const endRel = async (id: number) => {
    await contextApi.endRelationship(id);
    await loadRels();
  };

  const placePerson = async () => {
    if (!placementPerson || !placementPlace || placementPerson === placementPlace) return;
    setBusy(true);
    try {
      await contextApi.createRelationship({ subject: placementPerson, predicate: 'located_in', object: placementPlace, confidence: 1, source: 'manual', provenance: { confirmed: true, ui: 'context-person-placement' } });
      await loadRels();
      window.dispatchEvent(new Event('context:refresh'));
    } catch (e: any) { setError(e?.message || 'person placement failed'); }
    finally { setBusy(false); }
  };

  const nameOf = (id: string) =>
    entities.find((e) => e.id === id)?.name ?? id.split(':').pop() ?? id;

  const grouped = useMemo(() => {
    const g = new Map<string, CtxRelationship[]>();
    for (const r of rels) {
      if (r.predicate === 'located_in' && r.subject === r.object) continue;
      g.set(r.predicate, [...(g.get(r.predicate) ?? []), r]);
    }
    return g;
  }, [rels]);

  return (
    <div className="grid grid-cols-1 gap-4 text-[#20231b] lg:grid-cols-2">
      <section className="rounded-lg border border-[#c9c4b9] bg-[#faf8f2] p-4">
        <h3 className="mb-3 text-sm font-semibold">Entities</h3>
        <div className="mb-3 flex gap-2">
          <select value={kind} onChange={(e) => setKind(e.target.value)}
            className="rounded bg-[#ece8de] px-2 py-1.5 text-sm">
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="name" className="flex-1 rounded bg-[#ece8de] px-3 py-1.5 text-sm"
            onKeyDown={(e) => e.key === 'Enter' && create()} />
          <button onClick={create} disabled={busy}
            className="rounded bg-[#344323] px-3 py-1.5 text-sm text-white disabled:opacity-40">
            Add
          </button>
        </div>
        {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
        {!entities.length && (
          <p className="text-xs text-[#5b5953]">
            {snapshot ? 'No entities yet.' :
              <><Loader2 className="mr-1 inline h-3 w-3 animate-spin" />Loading…</>}
          </p>)}
        {entities.map((e) => (
          <button key={e.id} onClick={() => setSel(e.id === sel ? '' : e.id)}
            className={`mb-1 flex w-full items-center justify-between rounded border px-3 py-2 text-left text-sm ${
              sel === e.id ? 'border-[#6b7f4a] bg-[#ece8de]' : 'border-[#c9c4b9]'}`}>
            <span>
              <span className="mr-2 rounded bg-[#ece8de] px-1.5 py-0.5 font-mono text-[10px] text-[#5b5953]">
                {e.kind}
              </span>
              {e.name ?? e.id}
            </span>
            <span className="font-mono text-xs text-[#5b5953]">{e.id}</span>
          </button>
        ))}
        {sel && (() => {
          const entity = entities.find((item) => item.id === sel);
          if (!entity) return null;
          return <div className="mt-3 rounded border border-[#c9c4b9] bg-[#f4f1e9] p-3 text-xs">
            <div className="font-semibold">{entity.kind === 'building' ? 'Building' : entity.kind === 'person' ? 'Person' : 'Entity'} details</div>
            <div className="mt-1 text-[#5b5953]">{entity.name || entity.id}</div>
            {entity.created_at && <div className="mt-1 text-[#5b5953]">Added {new Date(entity.created_at * 1000).toLocaleString()}</div>}
            {entity.last_seen && <div className="mt-1 text-[#5b5953]">Last observed {new Date(entity.last_seen * 1000).toLocaleString()}</div>}
            {(entity.confidence != null || entity.confirmed != null) && <div className="mt-1 text-[#5b5953]">
              {entity.confidence != null ? `Confidence ${Math.round(entity.confidence * 100)}%` : ''}
              {entity.confidence != null && entity.confirmed != null ? ' · ' : ''}
              {entity.confirmed != null ? (entity.confirmed ? 'confirmed' : 'unconfirmed') : ''}
            </div>}
            {entity.attributes && Object.keys(entity.attributes).length > 0
              ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[#34342f]">{JSON.stringify(entity.attributes, null, 2)}</pre>
              : <p className="mt-2 text-[#5b5953]">No additional metadata has been recorded.</p>}
          </div>;
        })()}
      </section>

      <section className="rounded-lg border border-[#c9c4b9] bg-[#faf8f2] p-4">
        <h3 className="mb-3 text-sm font-semibold">Relationships</h3>
        <div className="mb-3 rounded border border-[#c9c4b9] bg-[#f4f1e9] p-3">
          <p className="mb-2 text-xs font-medium text-[#34342f]">Set a person&apos;s room</p>
          <div className="flex flex-wrap gap-2">
            <select value={placementPerson} onChange={(e) => setPlacementPerson(e.target.value)} className="min-w-36 rounded border border-[#c9c4b9] bg-white px-2 py-1.5 text-xs text-[#20231b]">
              <option value="">Choose person</option>
              {entities.filter((e) => e.kind === 'person').map((e) => <option key={e.id} value={e.id}>{e.name || e.id}</option>)}
            </select>
            <select value={placementPlace} onChange={(e) => setPlacementPlace(e.target.value)} className="min-w-36 rounded border border-[#c9c4b9] bg-white px-2 py-1.5 text-xs text-[#20231b]">
              <option value="">Choose room or place</option>
              {entities.filter((e) => e.kind === 'place' || e.kind === 'space' || e.kind === 'building').map((e) => <option key={e.id} value={e.id}>{e.name || e.id}</option>)}
            </select>
            <button onClick={placePerson} disabled={busy || !placementPerson || !placementPlace || placementPerson === placementPlace} className="rounded bg-[#344323] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">Set placement</button>
          </div>
          <p className="mt-1 text-[10px] text-[#5b5953]">Manual placements are timestamped and treated as confirmed until ended.</p>
        </div>
        {Array.from(grouped.entries()).map(([pred, list]) => (
          <div key={pred} className="mb-4">
            <p className="mb-1 font-mono text-xs uppercase tracking-wider text-[#5b5953]">
              {pred}
            </p>
            {list.map((r) => (
              <div key={r.id}
                className="mb-1 flex items-center justify-between rounded bg-[#f4f1e9] px-3 py-1.5 text-sm">
                <span className="min-w-0">
                  <span title={r.subject}>{nameOf(r.subject)} <span className="font-mono text-[10px] text-[#5b5953]">[{r.subject}]</span></span>
                  <span className="mx-1 text-[#5b5953]">—{pred}→</span>
                  <span title={r.object}>{nameOf(r.object)} <span className="font-mono text-[10px] text-[#5b5953]">[{r.object}]</span></span>
                  <span className="mt-1 block text-[10px] text-[#5b5953]">{r.source || 'unknown source'} · {r.valid_from ? new Date(r.valid_from * 1000).toLocaleString() : 'time unknown'}</span>
                  {r.provenance && <span className="block truncate text-[10px] text-[#5b5953]" title={JSON.stringify(r.provenance)}>Reference: {JSON.stringify(r.provenance)}</span>}
                </span>
                <span className="flex items-center gap-2 text-xs text-[#5b5953]">
                  {Math.round(r.confidence * 100)}%
                  {r.valid_until && <span className="text-[#5b5953]">ended</span>}
                  <button onClick={() => endRel(r.id)} title="end relationship"
                    className="text-[#5b5953] hover:text-red-400">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        ))}
        {grouped.size === 0 && (
          <p className="text-xs text-[#5b5953]">
            No relationships — wearable enrollment and space assignment
            create them automatically.</p>)}
      </section>
    </div>
  );
}
