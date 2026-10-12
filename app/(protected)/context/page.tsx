'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity, BrainCircuit, Filter, GitMerge, Loader2, MapPin,
  RadioTower, RefreshCw, Sparkles,
} from 'lucide-react';
import { useApi } from '../../../hooks/useApi';
import {
  contextApi, type CtxEntity, type CtxEvidence, type CtxEvent,
  type CtxSnapshot, type CtxState,
} from '../../../lib/context-api';
import { EventTimeline } from '../../../components/context/EventTimeline';
import { BleRelationMap } from '../../../components/context/BleRelationMap';
import { EvidenceInspector } from '../../../components/context/EvidenceInspector';
import { EntityExplorer } from '../../../components/context/EntityExplorer';
import { LocalizationPanel } from '../../../components/context/LocalizationPanel';
import { InferPanel } from '../../../components/context/InferPanel';

type Tab = 'overview' | 'entities' | 'evidence' | 'events' | 'ble'
  | 'localization' | 'infer';

const TABS: Array<{ id: Tab; label: string; icon: typeof Activity }> = [
  { id: 'overview', label: 'Live context', icon: BrainCircuit },
  { id: 'entities', label: 'Entities', icon: GitMerge },
  { id: 'evidence', label: 'Evidence', icon: Filter },
  { id: 'events', label: 'Timeline', icon: Activity },
  { id: 'ble', label: 'BLE map', icon: RadioTower },
  { id: 'localization', label: 'Localization', icon: MapPin },
  { id: 'infer', label: 'Infer', icon: Sparkles },
];

const POLL_MS = 15000;
const fmtAge = (ts?: number) =>
  ts ? `${Math.max(0, Date.now() / 1000 - ts).toFixed(0)}s` : '—';
const fmtSnapshotAge = (ts?: number) => {
  if (!ts) return 'Snapshot time unavailable';
  const seconds = Math.max(0, Date.now() / 1000 - ts);
  return `Context snapshot updated ${seconds < 60 ? `${Math.round(seconds)}s` : `${Math.round(seconds / 60)}m`} ago`;
};
const fmtVal = (v: unknown) =>
  typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '—');

interface SpaceState {
  space_id: number; name: string; occupied: boolean;
  people_count: number; confidence: number;
  zones: Record<string, { occupied: boolean; people_count: number; confidence: number }>;
}

export default function ContextPage() {
  const { get } = useApi();
  const [tab, setTab] = useState<Tab>('overview');
  const [snapshot, setSnapshot] = useState<CtxSnapshot | null>(null);
  const [events, setEvents] = useState<CtxEvent[]>([]);
  const [spaces, setSpaces] = useState<SpaceState[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const sinceRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const [snap, ev, sp] = await Promise.all([
        contextApi.snapshot(),
        contextApi.events({ limit: 100 }),
        get('/spaces/state').catch(() => ({ spaces: [] })),
      ]);
      setSnapshot(snap);
      setEvents(ev);
      setSpaces(sp.spaces || []);
      sinceRef.current = snap.generated_at ?? Date.now() / 1000;
      setError('');
    } catch (e: any) {
      setError(e?.message || 'context unavailable');
    } finally {
      setLoading(false);
    }
  }, [get]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const live = useMemo(
    () => (snapshot?.states ?? []).filter((s) =>
      s.valid_until === undefined || s.valid_until * 1000 > Date.now()),
    [snapshot],
  );

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Context</h1>
          <p className="text-sm text-[#5b5953]">
            Derived from predictions over raw observations — every state shows
            its estimator and confidence.{' '}
            <Link href="/spaces" className="text-[#344323] hover:underline">
              Floor-plan editor →
            </Link>
          </p>
          <p className="mt-1 text-xs text-[#5b5953]">{fmtSnapshotAge(snapshot?.generated_at)}</p>
        </div>
        <button onClick={load}
          className="inline-flex items-center gap-2 rounded border border-[#c9c4b9] px-3 py-1.5 text-sm hover:bg-[#ece8de]">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {error && <p className="rounded bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</p>}

      <nav className="flex flex-wrap gap-1 border-b border-[#c9c4b9]">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
              tab === id
                ? 'border-[#6b7f4a] text-[#344323]'
                : 'border-transparent text-[#5b5953] hover:text-[#11110f]'
            }`}>
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </nav>

      {loading && !snapshot ? (
        <div className="flex items-center gap-2 py-16 text-[#5b5953]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading context…
        </div>
      ) : tab === 'overview' ? (
        <OverviewTab live={live} spaces={spaces} events={events}
          entities={snapshot?.entities ?? []} />
      ) : tab === 'entities' ? (
        <EntityExplorer snapshot={snapshot} />
      ) : tab === 'evidence' ? (
        <EvidenceInspector />
      ) : tab === 'events' ? (
        <EventTimeline events={events} />
      ) : tab === 'ble' ? (
        <BleRelationMap />
      ) : tab === 'infer' ? (
        <InferPanel />
      ) : (
        <LocalizationPanel />
      )}
    </div>
  );
}

function OverviewTab({ live, spaces, events, entities }: {
  live: CtxState[];
  spaces: SpaceState[];
  events: CtxEvent[];
  entities: CtxEntity[];
}) {
  const entityName = (id: string) =>
    entities.find((e) => e.id === id)?.name ?? id.split(':').pop() ?? id;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* spaces */}
      <section className="rounded-lg border border-[#c9c4b9] bg-[#faf8f2] p-4">
        <h3 className="mb-3 text-sm font-semibold">Spaces</h3>
        {spaces.length === 0 && (
          <p className="text-xs text-[#5b5953]">
            No spaces — create them under{' '}
            <Link href="/spaces" className="text-[#344323] hover:underline">Spaces</Link>.
          </p>
        )}
        {spaces.map((s) => (
          <div key={s.space_id}
            className="mb-2 rounded border border-[#c9c4b9] px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-sm">{s.name}</span>
              <span className={`text-xs ${s.occupied ? 'text-green-400' : 'text-[#5b5953]'}`}>
                {s.occupied ? `occupied · ${s.people_count}` : 'empty'}
              </span>
            </div>
            <div className="mt-1 h-1 rounded bg-[#ece8de]">
              <div className="h-1 rounded bg-[#6b7f4a]"
                style={{ width: `${Math.round((s.confidence || 0) * 100)}%` }} />
            </div>
            {Object.entries(s.zones ?? {}).map(([zn, z]) => (
              <div key={zn} className="mt-1 flex justify-between text-xs text-[#5b5953]">
                <span>{zn}</span>
                <span className={z.occupied ? 'text-green-400' : ''}>
                  {z.occupied ? `${z.people_count} here` : '—'}
                </span>
              </div>
            ))}
          </div>
        ))}
      </section>

      {/* now */}
      <section className="rounded-lg border border-[#c9c4b9] bg-[#faf8f2] p-4">
        <h3 className="mb-3 text-sm font-semibold">Now</h3>
        {live.length === 0 && (
          <p className="text-xs text-[#5b5953]">
            No active context — predictions become context once an estimator
            attributes evidence.
          </p>
        )}
        {live.map((s) => (
          <div key={s.id} className="mb-2 text-sm">
            <div className="flex justify-between">
              <span className="font-mono text-xs text-[#5b5953]">{s.key}</span>
              <span className="text-xs text-[#5b5953]">{fmtAge(s.since)}</span>
            </div>
            <div className="flex justify-between">
              <span>{entityName(s.entity_id)} → {fmtVal(s.value)}</span>
              <span className="text-xs text-[#5b5953]">
                {Math.round(s.confidence * 100)}% · {s.estimator || '—'}
              </span>
            </div>
          </div>
        ))}
      </section>

      {/* recent transitions */}
      <section className="rounded-lg border border-[#c9c4b9] bg-[#faf8f2] p-4">
        <h3 className="mb-3 text-sm font-semibold">Recently changed</h3>
        {events.slice(0, 10).map((e) => (
          <div key={e.id} className="mb-1.5 flex justify-between text-xs">
            <span>
              <span className={
                e.type === 'entered' ? 'text-green-400'
                : e.type === 'exited' ? 'text-[#5b5953]' : 'text-[#344323]'}>
                {e.type}
              </span>{' '}
              {entityName(e.entity_id ?? '')} {fmtVal(e.value ?? e.key)}
            </span>
            <span className="text-[#5b5953]">{fmtAge(e.timestamp)}</span>
          </div>
        ))}
        {events.length === 0 && (
          <p className="text-xs text-[#5b5953]">No transitions yet.</p>)}
      </section>
    </div>
  );
}
