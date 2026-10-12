'use client';

/**
 * InferPanel — drive Brain's /v1/context/infer and inspect both sides
 * of the LLM call: the exact payload the model saw (device roster,
 * node scenes with radar/radio stats, evidence aggregates, context
 * map) and the form it produced (summary, analysis, states, device
 * naming proposals, curation channels).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BrainCircuit, ChevronDown, ChevronRight, Eye, Loader2, Play,
  ScanEye,
} from 'lucide-react';
import {
  inferApi, type InferLast, type InferOptions, type InferResult,
} from '../../lib/context-api';

const fmtTs = (ts?: number) =>
  ts ? new Date(ts * 1000).toLocaleString() : '—';

function Json({ v }: { v: unknown }) {
  return (
    <pre className="max-h-72 overflow-auto rounded bg-[#f4f1e9] p-2 text-[11px] leading-relaxed text-[#34342f]">
      {JSON.stringify(v, null, 2)}
    </pre>
  );
}

function Section({ title, count, children, defaultOpen = false }: {
  title: string; count?: string | number; children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded border border-[#c9c4b9]">
      <button onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs hover:bg-[#ece8de]/60">
        <span className="flex items-center gap-1.5">
          {open ? <ChevronDown className="h-3 w-3" />
                 : <ChevronRight className="h-3 w-3" />}
          <span className="font-mono text-[#34342f]">{title}</span>
        </span>
        {count !== undefined &&
          <span className="text-[#5b5953]">{count}</span>}
      </button>
      {open && <div className="border-t border-[#c9c4b9] p-2">{children}</div>}
    </div>
  );
}

/** Left pane — every section of the payload, with quick stats up front. */
function SeenPane({ seen }: { seen: Record<string, any> }) {
  if (!seen || typeof seen !== 'object') return null;
  if (seen._truncated) {
    return (
      <p className="text-xs text-[#5b5953]">
        Payload was {(seen.bytes / 1024).toFixed(0)} KB — too large to echo.
        Section sizes: <Json v={seen.sections} />
      </p>
    );
  }
  const devices = (seen.devices as any[]) ?? [];
  const scenes = (seen.scenes as any[]) ?? [];
  const observations = (seen.observations as any[]) ?? [];
  const sensorCount = scenes.reduce(
    (n, s) => n + Object.keys(s?.sensors ?? {}).length, 0);
  const radarSensors = scenes.flatMap((s) =>
    Object.entries(s?.sensors ?? {})
      .filter(([, d]: [string, any]) => d?.type === 'radar')
      .map(([id]) => id));

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-[#5b5953]">
        {devices.length} registered device{devices.length === 1 ? '' : 's'}
        {' · '}{scenes.length} node scene{scenes.length === 1 ? '' : 's'}
        {' · '}{sensorCount} sensors
        {radarSensors.length > 0 && ` · radar: ${radarSensors.join(', ')}`}
        {' · '}{observations.length} evidence aggregates
      </p>
      {devices.length > 0 && (
        <Section title="devices — the user's registered nodes"
          count={devices.length} defaultOpen>
          <div className="space-y-1">
            {devices.map((d: any, i: number) => (
              <div key={i} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="text-[#11110f]">{d.name || d.uuid || d.entity}</span>
                <span className="text-[#5b5953]">{d.type}</span>
                {d.mac && <span className="font-mono text-[#5b5953]">{d.mac}</span>}
                {d.association &&
                  <span className={`rounded px-1 text-[10px] ${
                    d.association === 'registered'
                      ? 'bg-green-950 text-green-300'
                      : 'bg-amber-950 text-amber-300'}`}>
                    {d.association}
                  </span>}
                {d.online === false &&
                  <span className="text-[#5b5953]">offline</span>}
              </div>
            ))}
          </div>
          <div className="mt-1.5"><Json v={devices} /></div>
        </Section>
      )}
      {scenes.length > 0 && (
        <Section title="scenes — latest uplink per node (radar / radio / cues)"
          count={scenes.length} defaultOpen>
          <Json v={scenes} />
        </Section>
      )}
      {(['window', 'calibration', 'descriptors', 'context', 'observations',
        'map', 'history', 'coverage'] as const).map((k) =>
        seen[k] !== undefined && seen[k] !== null &&
          !(typeof seen[k] === 'object' &&
            Object.keys(seen[k]).length === 0) ? (
          <Section key={k} title={k}
            count={Array.isArray(seen[k]) ? seen[k].length : undefined}>
            <Json v={seen[k]} />
          </Section>
        ) : null)}
    </div>
  );
}

/** Right pane — the model's text + structured form output. */
function ProducedPane({ result }: { result: InferResult }) {
  const form = result.form ?? {};
  const states = (form.states as any[]) ?? [];
  const entities = (form.entities as any[]) ?? [];
  const rels = (form.relationships as any[]) ?? [];
  const deviceUpdates = (result.device_updates?.length
    ? result.device_updates : form.device_updates) as any[] ?? [];
  const questions = (result.questions ?? form.questions ?? []) as any[];
  const uncertainties =
    (result.uncertainties ?? form.uncertainties ?? []) as any[];
  const notes = (form.notes as any[]) ?? [];
  const applied = result.receipt?.device_updates as any[] | undefined;

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium text-[#11110f]">
          {result.summary || '—'}
        </p>
        {result.analysis && (
          <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-[#34342f]">
            {result.analysis}
          </p>
        )}
        {result.model_text && (
          <p className="mt-1 whitespace-pre-wrap text-xs italic text-[#5b5953]">
            {result.model_text}
          </p>
        )}
      </div>

      {states.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold text-[#5b5953]">States</h4>
          {states.map((s, i) => (
            <div key={i} className="mb-1 flex items-baseline justify-between text-xs">
              <span className="font-mono text-[#34342f]">
                {s.entity_id ? `${s.entity_id} · ` : ''}{s.key}
              </span>
              <span>
                {typeof s.value === 'object' ? JSON.stringify(s.value) : String(s.value)}
                {s.confidence != null &&
                  <span className="ml-2 text-[#5b5953]">
                    {Math.round(s.confidence * 100)}%
                  </span>}
              </span>
            </div>
          ))}
        </div>
      )}

      {deviceUpdates.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold text-[#5b5953]">
            Device naming proposals
          </h4>
          {deviceUpdates.map((d, i) => {
            const landed = applied?.find(
              (a) => a.ref === d.device || a.entity === d.device);
            return (
              <div key={i} className="mb-1.5 rounded border border-[#c9c4b9] px-2 py-1.5 text-xs">
                <div className="flex items-baseline justify-between">
                  <span className="text-[#11110f]">{d.proposed_name}</span>
                  <span className="font-mono text-[#5b5953]">
                    {d.device}
                    {d.confidence != null &&
                      ` · ${Math.round(d.confidence * 100)}%`}
                  </span>
                </div>
                {d.rationale &&
                  <p className="mt-0.5 text-[#5b5953]">{d.rationale}</p>}
                {landed &&
                  <p className="mt-0.5 text-green-400">→ {landed.entity}</p>}
              </div>
            );
          })}
        </div>
      )}

      {entities.length > 0 && (
        <Section title="entities" count={entities.length}><Json v={entities} /></Section>)}
      {rels.length > 0 && (
        <Section title="relationships" count={rels.length}><Json v={rels} /></Section>)}
      {uncertainties.length > 0 && (
        <Section title="uncertainties" count={uncertainties.length} defaultOpen>
          <Json v={uncertainties} /></Section>)}
      {questions.length > 0 && (
        <Section title="questions for the platform" count={questions.length} defaultOpen>
          <Json v={questions} /></Section>)}
      {notes.length > 0 && (
        <Section title="notes" count={notes.length}><Json v={notes} /></Section>)}
      {result.receipt && (
        <Section title="receipt — what landed"><Json v={result.receipt} /></Section>)}
    </div>
  );
}

export function InferPanel() {
  const [options, setOptions] = useState<InferOptions | null>(null);
  const [last, setLast] = useState<InferLast | null>(null);
  const [tier, setTier] = useState('standard');
  const [model, setModel] = useState('');
  const [gatherS, setGatherS] = useState(900);
  const [hint, setHint] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<InferResult | null>(null);

  useEffect(() => {
    inferApi.options().then(setOptions).catch(() => {});
    inferApi.last().then((l) => {
      setLast(l);
      if (l?.input) {
        try {
          setResult({
            form: l.output ? JSON.parse(l.output) : undefined,
            summary: l.summary, analysis: l.analysis,
            model_text: l.model_text, model_id: l.model_id,
            thinking: l.tier, dry_run: l.dry_run,
            seen: JSON.parse(l.input),
            generated_at: l.at,
          });
        } catch { /* malformed retained payload — ignore */ }
      }
    });
  }, []);

  const run = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const r = await inferApi.run({
        thinking: tier,
        model: model || undefined,
        gather_window_s: gatherS > 0 ? gatherS : undefined,
        entity_hint: hint || undefined,
        dry_run: dryRun,
      });
      setResult(r);
    } catch (e: any) {
      setError(e?.message || 'inference failed');
    } finally {
      setBusy(false);
    }
  }, [tier, model, gatherS, hint, dryRun]);

  const effectiveModel = model || options?.defaults?.[tier] || '';

  return (
    <div className="space-y-4">
      {/* controls */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-[#c9c4b9] bg-[#faf8f2] p-3">
        <label className="text-xs">
          <span className="mb-1 block text-[#5b5953]">Thinking tier</span>
          <select value={tier} onChange={(e) => setTier(e.target.value)}
            className="rounded border border-[#c9c4b9] bg-[#f4f1e9] px-2 py-1.5 text-xs">
            {(options?.tiers ?? ['quick', 'standard', 'deep']).map((t) => (
              <option key={t} value={t}>{t}</option>))}
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-[#5b5953]">
            Model (user set — gpt-4o or better)
          </span>
          <select value={model} onChange={(e) => setModel(e.target.value)}
            className="rounded border border-[#c9c4b9] bg-[#f4f1e9] px-2 py-1.5 text-xs">
            <option value="">tier default ({effectiveModel || '…'})</option>
            {(options?.models ?? []).map((m) => (
              <option key={m} value={m}>{m}</option>))}
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-[#5b5953]">
            Sensor window (s) — radar/radio/scene bundle
          </span>
          <input type="number" min={0} max={86400} value={gatherS}
            onChange={(e) => setGatherS(Number(e.target.value) || 0)}
            className="w-24 rounded border border-[#c9c4b9] bg-[#f4f1e9] px-2 py-1.5 text-xs" />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-[#5b5953]">Entity hint</span>
          <input value={hint} onChange={(e) => setHint(e.target.value)}
            placeholder="person:gad" size={14}
            className="rounded border border-[#c9c4b9] bg-[#f4f1e9] px-2 py-1.5 text-xs" />
        </label>
        <label className="flex items-center gap-1.5 pb-1.5 text-xs text-[#5b5953]">
          <input type="checkbox" checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)} />
          dry run
        </label>
        <button onClick={run} disabled={busy}
          className="inline-flex items-center gap-2 rounded bg-[#11110f] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#6b7f4a] disabled:opacity-50">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                 : <Play className="h-3.5 w-3.5" />}
          Infer now
        </button>
        {result?.model_id &&
          <span className="pb-1.5 text-[11px] text-[#5b5953]">
            ran {result.model_id}
            {result.generated_at ? ` · ${fmtTs(result.generated_at)}` : ''}
            {result.dry_run ? ' · dry' : ''}
          </span>}
      </div>

      {error &&
        <p className="rounded bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</p>}

      {!result ? (
        <div className="flex items-center gap-2 py-16 text-[#5b5953]">
          <BrainCircuit className="h-4 w-4" />
          <span className="text-sm">
            Run an inference — the model sees the full sensor bundle and
            writes the context layer.
          </span>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <section className="rounded-lg border border-[#c9c4b9] bg-[#faf8f2] p-3">
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
              <ScanEye className="h-4 w-4 text-[#344323]" />
              What the model saw
            </h3>
            {result.seen
              ? <SeenPane seen={result.seen} />
              : <p className="text-xs text-[#5b5953]">No payload echo.</p>}
          </section>
          <section className="rounded-lg border border-[#c9c4b9] bg-[#faf8f2] p-3">
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
              <Eye className="h-4 w-4 text-green-400" />
              What the model produced
            </h3>
            <ProducedPane result={result} />
          </section>
        </div>
      )}
      {last && !result &&
        <p className="text-[11px] text-[#5b5953]">
          Last run {fmtTs(last.at)} · {last.model_id}
        </p>}
    </div>
  );
}
