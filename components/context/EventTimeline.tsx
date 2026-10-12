'use client';

import type { CtxEvent } from '../../lib/context-api';

const fmtTime = (ts?: number) =>
  ts ? new Date(ts * 1000).toLocaleTimeString() : '—';
const fmtVal = (v: unknown) =>
  typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');

/**
 * Discrete context transitions — entered/exited/changed — newest first.
 * Pure display; the parent page owns the poll loop.
 */
export function EventTimeline({ events }: { events: CtxEvent[] }) {
  if (events.length === 0) {
    return <p className="py-12 text-center text-sm text-[#5b5953]">
      No transitions recorded yet.</p>;
  }
  return (
    <ol className="relative ml-3 space-y-4 border-l border-[#c9c4b9]">
      {events.map((e) => (
        <li key={e.id} className="ml-5">
          <span className={`absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full ${
            e.type === 'entered' ? 'bg-green-500'
            : e.type === 'exited' ? 'bg-neutral-600' : 'bg-[#6b7f4a]'}`} />
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-xs text-[#5b5953]">{fmtTime(e.timestamp)}</span>
            <span className="font-mono text-xs text-[#344323]">{e.key}</span>
            <span className={`text-xs font-medium ${
              e.type === 'entered' ? 'text-green-400'
              : e.type === 'exited' ? 'text-[#5b5953]' : 'text-[#11110f]'}`}>
              {e.type}
            </span>
            {e.confidence !== undefined && (
              <span className="text-xs text-[#5b5953]">
                {Math.round(e.confidence * 100)}%
              </span>
            )}
          </div>
          <p className="text-sm text-[#34342f]">
            {e.entity_id ?? '—'} {e.type === 'changed'
              ? `${fmtVal(e.previous_value)} → ${fmtVal(e.value)}`
              : fmtVal(e.value)}
          </p>
        </li>
      ))}
    </ol>
  );
}
