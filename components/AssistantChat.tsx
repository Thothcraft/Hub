'use client';

/**
 * Thoth assistant — context-grounded chat drawer.
 *
 * Talks to Brain `/v1/chat` through the `/api/brain` proxy:
 *  - answers are grounded in the context-builder bundle (entities,
 *    relationships, states, descriptors, scenes) — echoed back per
 *    reply so the user can inspect exactly what the model was given;
 *  - voice: mic → /chat/transcribe → auto-send → /chat/tts playback;
 *  - files: images → vision input, text/pdf inlined by the server;
 *  - replies render markdown + inline widgets (lists, key-values,
 *    tables, live states, tappable follow-up questions).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot, CheckCircle2, Eye, FileText, Loader2, Mic, MicOff,
  Paperclip, Send, Settings2, Volume2, X,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types (mirror of Brain's chat contract)
// ---------------------------------------------------------------------------

interface ChatWidget {
  type: string;
  title?: string;
  items?: any[];
  columns?: string[];
  rows?: any[][];
}

interface PendingFile {
  name: string;
  mime: string;
  data_b64: string;
  preview?: string;               // object URL for images
}

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  widgets?: ChatWidget[];
  contextUsed?: any;
  attachments?: { name: string; mime: string }[];
}

const HISTORY_LIMIT = 12;
const HISTORY_KEY = 'thoth_chat_history_v1';
const DEFAULT_CONFIG = { window_s: 900, max_bundle_chars: 0, include_scenes: true, include_descriptors: true, include_reference: true, include_builder: true, include_usage: true, include_persons_places: true };

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  try {
    const t = localStorage.getItem('auth_token') ||
      sessionStorage.getItem('auth_token');
    if (t) h.Authorization = `Bearer ${t}`;
  } catch { /* cookies still apply */ }
  return h;
}

function historyStorageKey(): string {
  try {
    const token = localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token') || '';
    const encoded = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/');
    const payload = encoded ? JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='))) : {};
    const account = payload.userId ?? payload.user_id ?? payload.sub ?? 'session';
    return `${HISTORY_KEY}:${String(account)}`;
  } catch { return `${HISTORY_KEY}:session`; }
}

// ---------------------------------------------------------------------------
// Markdown-lite — headers, lists, bold/italic/code/links. No dep needed.
// ---------------------------------------------------------------------------

function renderInline(s: string): React.ReactNode[] {
  const re = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  return s.split(re).filter(Boolean).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2)
      return <em key={i}>{part.slice(1, -1)}</em>;
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={i} className="rounded bg-slate-200 px-1 text-[0.85em]">{part.slice(1, -1)}</code>;
    const m = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (m)
      return <a key={i} href={m[2]} target="_blank" rel="noreferrer"
        className="text-indigo-600 underline">{m[1]}</a>;
    return <span key={i}>{part}</span>;
  });
}

function Markdown({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = (key: string) => {
    if (!list.length) return;
    out.push(
      <ul key={key} className="my-1 list-disc space-y-0.5 pl-5">
        {list.map((li, j) => <li key={j}>{renderInline(li)}</li>)}
      </ul>);
    list = [];
  };
  text.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd();
    if (/^\s*[-*•]\s+/.test(line)) {
      list.push(line.replace(/^\s*[-*•]\s+/, ''));
      return;
    }
    flush(`l${i}`);
    if (!line.trim()) { out.push(<div key={i} className="h-2" />); return; }
    if (line.startsWith('### '))
      out.push(<h4 key={i} className="mt-2 font-semibold">{renderInline(line.slice(4))}</h4>);
    else if (line.startsWith('## ') || line.startsWith('# '))
      out.push(<h3 key={i} className="mt-2 text-[15px] font-semibold">{renderInline(line.replace(/^#+\s*/, ''))}</h3>);
    else
      out.push(<p key={i} className="leading-relaxed">{renderInline(line)}</p>);
  });
  flush('end');
  return <div className="text-[13.5px]">{out}</div>;
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

function StatesCard({ w }: { w: ChatWidget }) {
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-slate-200 bg-white">
      {w.title && <div className="border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{w.title}</div>}
      <div className="divide-y divide-slate-100">
        {(w.items ?? []).map((it: any, i: number) => (
          <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
            <span className="font-mono text-slate-700">{it.key}</span>
            {it.entity && <span className="text-slate-400">@{it.entity}</span>}
            <span className="ml-auto font-medium text-slate-800">
              {typeof it.value === 'object' ? JSON.stringify(it.value) : String(it.value)}
            </span>
            {it.confidence != null &&
              <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-500">
                {(it.confidence * 100).toFixed(0)}%</span>}
            {it.confirmed &&
              <CheckCircle2 size={13} className="text-emerald-600" aria-label="confirmed" />}
          </div>
        ))}
      </div>
    </div>
  );
}

function WidgetView({ w, onQuestion }: { w: ChatWidget; onQuestion: (q: string) => void }) {
  switch (w.type) {
    case 'list':
      return (
        <div className="mt-2">
          {w.title && <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{w.title}</div>}
          <ul className="list-disc space-y-0.5 pl-5 text-[13px]">
            {(w.items ?? []).map((it, i) => <li key={i}>{renderInline(String(it))}</li>)}
          </ul>
        </div>);
    case 'key_values':
      return (
        <div className="mt-2 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {w.title && <div className="border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{w.title}</div>}
          <dl className="divide-y divide-slate-100">
            {(w.items ?? []).map((it: any, i: number) => (
              <div key={i} className="flex gap-2 px-3 py-1.5 text-[12px]">
                <dt className="w-28 shrink-0 text-slate-500">{it.label}</dt>
                <dd className="font-medium text-slate-800">{renderInline(String(it.value))}</dd>
              </div>))}
          </dl>
        </div>);
    case 'table':
      return (
        <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          {w.title && <div className="border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{w.title}</div>}
          <table className="w-full text-[12px]">
            <thead><tr className="border-b border-slate-100 text-left text-slate-500">
              {(w.columns ?? []).map((c, i) => <th key={i} className="px-3 py-1.5 font-medium">{c}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {(w.rows ?? []).map((r, i) => (
                <tr key={i}>{(r ?? []).map((c, j) =>
                  <td key={j} className="px-3 py-1.5 text-slate-800">{renderInline(String(c))}</td>)}</tr>))}
            </tbody>
          </table>
        </div>);
    case 'states':
      return <StatesCard w={w} />;
    case 'questions':
      return (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(w.items ?? []).map((q: any, i: number) => (
            <button key={i} onClick={() => onQuestion(String(q))}
              className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[12px] text-indigo-700 transition hover:bg-indigo-100">
              {String(q)}
            </button>))}
        </div>);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Context-transparency panel — "what the model was given"
// ---------------------------------------------------------------------------

function ContextDigest({ ctx }: { ctx: any }) {
  if (!ctx) return null;
  const entities = ctx.map?.entities ?? [];
  const states = ctx.map?.states ?? [];
  const rels = ctx.map?.relationships ?? [];
  const counts = entities.reduce((m: any, e: any) => {
    m[e.kind] = (m[e.kind] ?? 0) + 1; return m;
  }, {} as Record<string, number>);
  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-[11px] text-slate-600">
      <div className="mb-1 flex items-center gap-1 font-semibold text-slate-700">
        <Eye size={12} /> What the model was shown
      </div>
      <div className="space-y-0.5">
        <div>
          <span className="text-slate-500">entities:</span>{' '}
          {Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}
        </div>
        <div><span className="text-slate-500">relationships:</span> {rels.length} ·
          <span className="text-slate-500"> states:</span> {states.length} ·
          <span className="text-slate-500"> builder runs:</span> {ctx.builder?.builds ?? 0}</div>
        {ctx.builder?.last_summary &&
          <div className="truncate"><span className="text-slate-500">builder says:</span> {ctx.builder.last_summary}</div>}
        {ctx.usage?.remaining != null &&
          <div><span className="text-slate-500">inference quota:</span> {ctx.usage.remaining}/{ctx.usage.allowance} left this month</div>}
        <details className="pt-1">
          <summary className="cursor-pointer text-indigo-600">raw bundle</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-white p-2 text-[10px] leading-snug">
            {JSON.stringify(ctx, null, 1)}
          </pre>
        </details>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The drawer
// ---------------------------------------------------------------------------

export default function AssistantChat({ page = false }: { page?: boolean }) {
  const [open, setOpen] = useState(page);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [ctxPreview, setCtxPreview] = useState<any | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatConfig, setChatConfig] = useState(DEFAULT_CONFIG);
  const [configMessage, setConfigMessage] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const scrollDown = () =>
    setTimeout(() => scrollRef.current?.scrollTo(
      { top: scrollRef.current.scrollHeight, behavior: 'smooth' }), 30);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(
          `/api/brain/chat/history?chat_id=main&limit=${HISTORY_LIMIT}`,
          { headers: authHeaders(), cache: 'no-store' });
        if (!response.ok) throw new Error(`history unavailable (${response.status})`);
        const data = await response.json();
        const shared = Array.isArray(data.messages) ? data.messages : [];
        if (shared.length) {
          if (!cancelled) setMessages(shared.map((m: any) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            text: String(m.content ?? ''),
          })).slice(-HISTORY_LIMIT * 2));
          return;
        }

        // Import the older browser-only transcript once; Brain ignores this
        // if another client has already created shared history.
        let saved: any[] = [];
        try {
          const old = JSON.parse(localStorage.getItem(historyStorageKey()) || '[]');
          if (Array.isArray(old)) saved = old.slice(-HISTORY_LIMIT * 2);
        } catch { /* ignore corrupt browser history */ }
        if (saved.length) {
          const messages = saved
            .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
            .map((m) => ({ role: m.role, content: m.text }));
          if (messages.length) {
            await fetch('/api/brain/chat/history', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders() },
              body: JSON.stringify({ chat_id: 'main', messages }),
            });
            if (!cancelled) setMessages(saved);
          }
        }
      } catch { /* chat remains available if shared history cannot load */ }
    };
    void load();
    return () => {                       // unmount cleanup
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      audioRef.current?.pause();
    };
  }, []);

  const startNewChat = async () => {
    try {
      const response = await fetch('/api/brain/chat/history?chat_id=main', {
        method: 'DELETE', headers: authHeaders(),
      });
      if (!response.ok) throw new Error(`clear failed (${response.status})`);
      setMessages([]);
      localStorage.removeItem(historyStorageKey());
    } catch (e: any) {
      setConfigMessage(e?.message || 'Could not clear shared history.');
    }
  };

  const loadSettings = async () => {
    try {
      const res = await fetch('/api/brain/chat/config', { headers: authHeaders(), cache: 'no-store' });
      if (!res.ok) throw new Error(`settings unavailable (${res.status})`);
      const data = await res.json();
      setChatConfig({ ...DEFAULT_CONFIG, ...(data.config || {}) });
      setConfigMessage('');
    } catch (e: any) { setConfigMessage(e?.message || 'Could not load chat settings.'); }
  };

  const saveSettings = async () => {
    try {
      const res = await fetch('/api/brain/chat/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(chatConfig) });
      if (!res.ok) throw new Error(`settings save failed (${res.status})`);
      setConfigMessage('Settings saved.');
    } catch (e: any) { setConfigMessage(e?.message || 'Could not save chat settings.'); }
  };

  const speak = useCallback(async (text: string) => {
    try {
      audioRef.current?.pause();
      const res = await fetch('/api/brain/chat/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ text: text.slice(0, 3000) }),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch { /* speech is best-effort */ }
  }, []);

  const send = useCallback(async (text: string, pending: PendingFile[]) => {
    const clean = text.trim();
    if ((!clean && !pending.length) || busy) return;
    const userMsg: Msg = {
      role: 'user', text: clean,
      attachments: pending.map((f) => ({ name: f.name, mime: f.mime })),
    };
    const history = [...messages, userMsg]
      .slice(-HISTORY_LIMIT)
      .map((m) => ({ role: m.role, content: m.text }));
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setFiles([]);
    setBusy(true);
    scrollDown();
    try {
      const res = await fetch('/api/brain/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          message: clean,
          chat_id: 'main',
          history: history.slice(0, -1),   // server appends current msg
          attachments: pending.map((f) => ({
            name: f.name, mime: f.mime, data_b64: f.data_b64 })),
          include_context: true,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const detail = typeof err.detail === 'object'
          ? (err.detail.detail || err.detail.error)
          : err.detail;
        throw new Error(detail || `request failed (${res.status})`);
      }
      const data = await res.json();
      const reply: Msg = {
        role: 'assistant', text: data.answer ?? '',
        widgets: data.widgets ?? [], contextUsed: data.context_used,
      };
      setMessages((prev) => [...prev, reply]);
      if (voiceMode && reply.text) void speak(reply.text);
    } catch (e: any) {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        text: `Sorry — ${e?.message ?? 'something went wrong'}.`,
      }]);
    } finally {
      setBusy(false);
      scrollDown();
    }
  }, [busy, messages, voiceMode, speak]);

  // -- voice ---------------------------------------------------------------

  const stopRecording = useCallback(() => {
    recRef.current?.stop();
    setRecording(false);
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        if (blob.size < 100) return;
        setBusy(true);
        try {
          const fd = new FormData();
          fd.append('file', blob, 'voice.webm');
          const res = await fetch('/api/brain/chat/transcribe', {
            method: 'POST', headers: { ...authHeaders() }, body: fd });
          if (!res.ok) throw new Error(`transcribe failed (${res.status})`);
          const { text } = await res.json();
          if (text?.trim()) {
            setInput('');
            // seamless: transcribed speech goes straight to the model
            await send(text.trim(), []);
          }
        } catch (e: any) {
          setMessages((prev) => [...prev, {
            role: 'assistant',
            text: `I couldn't hear that — ${e?.message ?? 'transcribe error'}.`,
          }]);
        } finally {
          setBusy(false);
        }
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setMessages((prev) => [...prev, {
        role: 'assistant', text: 'Microphone access was denied.' }]);
    }
  }, [send]);

  const toggleMic = () => (recording ? stopRecording() : startRecording());

  // -- files ----------------------------------------------------------------

  const pickFiles = async (list: FileList | null) => {
    if (!list) return;
    const next: PendingFile[] = [];
    for (const f of Array.from(list).slice(0, 5)) {
      const buf = await f.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      bytes.forEach((b) => { bin += String.fromCharCode(b); });
      next.push({
        name: f.name, mime: f.type || 'application/octet-stream',
        data_b64: btoa(bin),
        preview: f.type.startsWith('image/')
          ? URL.createObjectURL(f) : undefined,
      });
    }
    setFiles((prev) => [...prev, ...next].slice(0, 5));
    if (fileRef.current) fileRef.current.value = '';
  };

  // -- context preview --------------------------------------------------------

  const loadContextPreview = async () => {
    if (ctxPreview) { setCtxPreview(null); return; }
    try {
      const res = await fetch('/api/brain/chat/context',
        { headers: { ...authHeaders() } });
      if (res.ok) setCtxPreview(await res.json());
    } catch { /* preview is best-effort */ }
  };

  // -- render -----------------------------------------------------------------

  return (
    <div className={page ? 'flex h-[min(78vh,900px)] min-h-[520px] w-full flex-col' : 'fixed bottom-5 right-5 z-50 flex flex-col items-end gap-2'}>
      {open && (
        <div className={page ? 'flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm' : 'flex h-[600px] max-h-[80vh] w-[400px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl'}>
          {/* header */}
          <div className="flex items-center gap-2 bg-slate-950 px-4 py-3 text-white">
            <Bot size={18} />
            <div className="flex-1">
              <div className="text-sm font-semibold leading-tight">Thoth Assistant</div>
              <div className="text-[10px] text-slate-400">grounded in your context map</div>
            </div>
            <button onClick={loadContextPreview} title="What the model sees"
              className={`rounded p-1.5 hover:bg-slate-800 ${ctxPreview ? 'bg-slate-800 text-indigo-300' : ''}`}>
              <Eye size={16} />
            </button>
            <button onClick={() => { setSettingsOpen((v) => !v); if (!settingsOpen) void loadSettings(); }} title="Chat settings" className={`rounded p-1.5 hover:bg-slate-800 ${settingsOpen ? 'bg-slate-800 text-indigo-300' : ''}`}><Settings2 size={16} /></button>
            {page && <button onClick={() => void startNewChat()} title="Clear shared chat history" className="rounded px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800">New chat</button>}
            <button onClick={() => setVoiceMode((v) => !v)}
              title={voiceMode ? 'Voice replies on' : 'Voice replies off'}
              className={`rounded p-1.5 hover:bg-slate-800 ${voiceMode ? 'bg-indigo-600' : ''}`}>
              <Volume2 size={16} />
            </button>
            {!page && <button onClick={() => setOpen(false)} className="rounded p-1.5 hover:bg-slate-800">
              <X size={16} />
            </button>}
          </div>

          {ctxPreview && (
            <div className="max-h-44 overflow-y-auto border-b border-slate-200 p-3">
              <ContextDigest ctx={ctxPreview} />
            </div>
          )}

          {settingsOpen && <div className="max-h-56 overflow-auto border-b border-slate-200 bg-white p-3 text-xs text-slate-700">
            <div className="mb-2 font-semibold">Context and memory</div>
            <label className="flex items-center justify-between gap-4 py-1">Context window (seconds)<input type="number" min={60} max={86400} value={chatConfig.window_s} onChange={(e) => setChatConfig({ ...chatConfig, window_s: Number(e.target.value) })} className="w-28 rounded border px-2 py-1" /></label>
            {(['include_scenes', 'include_descriptors', 'include_reference', 'include_builder', 'include_usage', 'include_persons_places'] as const).map((key) => <label key={key} className="flex items-center gap-2 py-1"><input type="checkbox" checked={chatConfig[key]} onChange={(e) => setChatConfig({ ...chatConfig, [key]: e.target.checked })} />{key.replace('include_', '').replaceAll('_', ' ')}</label>)}
            <div className="mt-2 flex items-center gap-3"><button onClick={() => void saveSettings()} className="rounded bg-indigo-600 px-3 py-1.5 font-medium text-white">Save settings</button><span>{configMessage}</span></div>
            <p className="mt-2 text-[10px] text-slate-500">Context settings and conversation history are shared with the Thoth app.</p>
          </div>}

          {/* messages */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-slate-50 p-3">
            {messages.length === 0 && (
              <div className="mt-8 text-center text-[13px] text-slate-500">
                Ask about your spaces, devices and activity — or send a
                photo/document. Tap the eye to see the context the model gets.
              </div>)}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[88%] rounded-xl px-3 py-2 ${
                  m.role === 'user'
                    ? 'bg-indigo-600 text-white'
                    : 'border border-slate-200 bg-white text-slate-800 shadow-sm'}`}>
                  {m.attachments?.map((a, j) => (
                    <div key={j} className="mb-1 flex items-center gap-1 rounded bg-indigo-500/30 px-2 py-0.5 text-[11px]">
                      <FileText size={11} /> {a.name}
                    </div>))}
                  {m.role === 'user'
                    ? <p className="whitespace-pre-wrap text-[13.5px]">{m.text}</p>
                    : <>
                        <Markdown text={m.text} />
                        {(m.widgets ?? []).map((w, j) => (
                          <WidgetView key={j} w={w}
                            onQuestion={(q) => send(q, [])} />))}
                        {m.contextUsed &&
                          <details className="mt-2">
                            <summary className="cursor-pointer text-[11px] text-indigo-600">
                              context used
                            </summary>
                            <ContextDigest ctx={m.contextUsed} />
                          </details>}
                        <button onClick={() => speak(m.text)} title="Speak"
                          className="mt-1.5 text-slate-400 hover:text-indigo-600">
                          <Volume2 size={14} />
                        </button>
                      </>}
                </div>
              </div>))}
            {busy &&
              <div className="flex items-center gap-2 text-[12px] text-slate-500">
                <Loader2 size={14} className="animate-spin" />
                {recording ? 'transcribing…' : 'thinking…'}
              </div>}
          </div>

          {/* pending attachments */}
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-t border-slate-100 bg-white px-3 py-2">
              {files.map((f, i) => (
                <span key={i} className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">
                  {f.preview
                    ? <img src={f.preview} alt="" className="h-4 w-4 rounded object-cover" />
                    : <FileText size={11} />}
                  {f.name}
                  <button onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}>
                    <X size={11} />
                  </button>
                </span>))}
            </div>
          )}

          {/* composer */}
          <form
            onSubmit={(e) => { e.preventDefault(); void send(input, files); }}
            className="flex items-center gap-1.5 border-t border-slate-200 bg-white p-2.5">
            <input ref={fileRef} type="file" multiple hidden
              accept="image/*,.pdf,.txt,.md,.csv,.json,.log,.py,.yaml,.xml"
              onChange={(e) => void pickFiles(e.target.files)} />
            <button type="button" onClick={() => fileRef.current?.click()}
              title="Attach image/file"
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100">
              <Paperclip size={17} />
            </button>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={recording ? 'Listening…' : 'Ask about your spaces…'}
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-[13.5px] outline-none focus:border-indigo-400"
            />
            <button type="button" onClick={toggleMic}
              title={recording ? 'Stop & send' : 'Talk'}
              className={`rounded-lg p-2 transition ${
                recording ? 'animate-pulse bg-red-500 text-white'
                          : 'text-slate-500 hover:bg-slate-100'}`}>
              {recording ? <MicOff size={17} /> : <Mic size={17} />}
            </button>
            <button type="submit" disabled={busy || (!input.trim() && !files.length)}
              className="rounded-lg bg-indigo-600 p-2 text-white transition hover:bg-indigo-700 disabled:opacity-40">
              <Send size={17} />
            </button>
          </form>
        </div>
      )}

      {!page && <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-950 text-white shadow-lg transition hover:bg-slate-800"
        aria-label="Open assistant">
        {open ? <X size={24} /> : <Bot size={24} />}
      </button>}
    </div>
  );
}
