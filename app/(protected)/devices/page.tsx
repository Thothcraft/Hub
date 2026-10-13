'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { nodeGet } from '@/lib/node-api';
import type { NodeSensor, NodeStatus } from '@/lib/node-api';
import {
  Cpu,
  Link2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';

type Sensor = {
  sensor_type?: string;
  key?: string;
  name?: string;
  available?: boolean;
  devices?: string[];
  receiver_count?: number;
};

type DeviceHardwareInfo = {
  device_type?: string;
  hostname?: string;
  lan_ip?: string;
  sensors?: Sensor[];
  available_sensors?: Sensor[];
};

type Device = {
  device_id: string;
  device_name: string;
  device_type: string;
  online: boolean;
  last_seen: string;
  ip_address: string;
  device_uuid: string;
  hardware_info?: DeviceHardwareInfo;
  collection_active?: boolean;
};

/** Live relay probe — what the node itself reports right now. */
type NodeProbe = {
  ok: boolean;
  collecting: boolean;
  models: number | null;
  sensors: NodeSensor[];
};

function parseServerTime(value?: string | null): number {
  if (!value) return NaN;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  return new Date(normalized).getTime();
}

function lastSeen(value?: string | null): string {
  const t = parseServerTime(value);
  if (!Number.isFinite(t)) return 'N/A';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Count CSI receivers from either Brain-reported hardware_info entries
 * (Sensor[]) or live node sensor descriptors (NodeSensor[]) — tolerant of
 * both `esp32_csi` and legacy `csi` type keys. */
function csiCountFrom(sensors: Array<Sensor | NodeSensor>): number {
  const csi = sensors.filter((s) =>
    /csi/i.test(String(
      (s as Sensor).sensor_type ?? (s as NodeSensor).type ??
      (s as Sensor).key ?? (s as NodeSensor).id ?? '')));
  if (!csi.length) return 0;
  return csi.reduce((n, s) => {
    const devs = (s as Sensor).devices;
    const rc = Number((s as Sensor).receiver_count || 0);
    return n + Math.max(Array.isArray(devs) ? devs.length : 0, rc, 1);
  }, 0);
}

export default function DevicesPage() {
  const router = useRouter();
  const [devices, setDevices] = useState<Device[]>([]);
  const [minuteCounts, setMinuteCounts] = useState<Record<string, number>>({});
  const [probes, setProbes] = useState<Record<string, NodeProbe>>({});
  const [liveMinutes, setLiveMinutes] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  const [pairingBusy, setPairingBusy] = useState(false);
  const loadInFlight = useRef(false);
  const probeInFlight = useRef(false);
  const { get, post, delete: del } = useApi();
  const { user, isLoading: authLoading } = useAuth();
  const toast = useToast();

  const loadData = useCallback(async (showLoading = false) => {
    if (authLoading || !user || loadInFlight.current) return;
    loadInFlight.current = true;
    if (showLoading) setLoading(true);
    try {
      const deviceRes = await get('/device/list?include_offline=true').catch(() => null);
      if (!deviceRes) return;
      const remoteDevices = Array.isArray(deviceRes?.devices) ? deviceRes.devices : [];
      setDevices(remoteDevices);

      const counts = await Promise.all(remoteDevices.map(async (device: Device) => {
        const fileRes = await get(`/device/${device.device_uuid}/files`).catch(() => null);
        const files = Array.isArray(fileRes?.files) ? fileRes.files : [];
        return [device.device_uuid,
          files.filter((f: { on_device?: boolean }) => f.on_device === true).length] as const;
      }));
      setMinuteCounts(Object.fromEntries(counts));
    } catch (err) {
      toast.error('Load failed', err instanceof Error ? err.message : 'Unable to load devices');
    } finally {
      loadInFlight.current = false;
      setLoading(false);
    }
  }, [authLoading, get, toast, user]);

  // Brain's collection flag lags — probe online nodes through the WS relay
  // for the node's own capture state, model count and sensor inventory.
  const probeNodes = useCallback(async () => {
    if (probeInFlight.current) return;
    probeInFlight.current = true;
    try {
      const targets = devices.filter((d) => d.online || probes[d.device_uuid]?.ok);
      const results = await Promise.all(targets.map(async (d) => {
        try {
          const [status, sensors] = await Promise.all([
            nodeGet<NodeStatus>(d.device_uuid, '/api/status'),
            nodeGet<{ sensors?: NodeSensor[] }>(d.device_uuid, '/api/sensors'),
          ]);
          return [d.device_uuid, {
            ok: true,
            collecting: Boolean(status.capture?.active),
            models: typeof status.active_models === 'number'
              ? status.active_models
              : (typeof status.models_active === 'number' ? status.models_active : null),
            sensors: sensors.sensors || [],
          } satisfies NodeProbe] as const;
        } catch {
          return [d.device_uuid, {
            ok: false, collecting: false, models: null, sensors: [],
          } satisfies NodeProbe] as const;
        }
      }));
      setProbes(Object.fromEntries(results));
    } finally {
      probeInFlight.current = false;
    }
  }, [devices, probes]);

  // Continuous-collection devices surface here the second a minute opens —
  // catches collectors whose Brain flag is stale, without relay calls.
  const loadLive = useCallback(async () => {
    if (authLoading || !user) return;
    const res = await get('/device/live-seconds').catch(() => null);
    if (!res?.success) return;
    setLiveMinutes(new Set(
      Object.entries(res.devices || {})
        .filter(([, v]) => Boolean((v as { minute?: string })?.minute))
        .map(([id]) => id)));
  }, [authLoading, get, user]);

  useEffect(() => {
    if (authLoading || !user) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        loadData(false);
        loadLive();
      }
    };
    loadData(true);
    loadLive();
    const timer = window.setInterval(refresh, 8000);
    return () => window.clearInterval(timer);
  }, [authLoading, loadData, loadLive, user]);

  useEffect(() => {
    if (!devices.length) return;
    probeNodes();
    const t = window.setInterval(probeNodes, 12000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices]);

  const claimPairing = async () => {
    const code = pairingCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 8 || pairingBusy) return;
    setPairingBusy(true);
    try {
      const result = await post('/device/pairing/claim', { code });
      setPairingCode('');
      toast.success('Device paired', result?.device_name || 'Your Thoth is now connected');
      await loadData(true);
    } catch (error) {
      toast.error('Pairing failed', error instanceof Error ? error.message : 'Check the code and try again');
    } finally {
      setPairingBusy(false);
    }
  };

  const removeDevice = async (deviceId: string) => {
    const device = devices.find((item) => item.device_uuid === deviceId);
    const name = device?.device_name || deviceId;
    if (!window.confirm(`Detach ${name}? Uploaded cloud files will be retained.`)) return;
    await del(`/device/${deviceId}?mode=detach`);
    setDevices((current) => current.filter((d) => d.device_uuid !== deviceId));
    toast.success('Device detached');
  };

  const rows = useMemo(() => devices.map((device) => {
    const probe = probes[device.device_uuid];
    const online = Boolean(probe?.ok ?? device.online);
    const collecting = Boolean(
      probe?.collecting ?? (device.collection_active || liveMinutes.has(device.device_uuid)));
    const hwSensors = device.hardware_info?.sensors
      ?? device.hardware_info?.available_sensors ?? [];
    const csi = csiCountFrom(probe?.sensors?.length ? probe.sensors : hwSensors);
    return {
      ...device,
      online,
      collecting,
      models: probe?.models ?? null,
      csi,
      minutes: minuteCounts[device.device_uuid] ?? 0,
    };
  }), [devices, probes, liveMinutes, minuteCounts]);

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((device) => {
      if (onlineOnly && !device.online) return false;
      if (!needle) return true;
      return [device.device_name, device.device_id, device.device_uuid,
              device.ip_address, device.hardware_info?.hostname]
        .some((value) => String(value || '').toLowerCase().includes(needle));
    });
  }, [onlineOnly, query, rows]);

  const onlineCount = rows.filter((d) => d.online).length;
  const collectingCount = rows.filter((d) => d.collecting).length;

  if (loading && !devices.length) {
    return <div className="border border-slate-300 bg-white p-8 text-sm text-slate-700">Loading devices…</div>;
  }

  return (
    <div className="space-y-4 text-slate-950 sm:space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-700">Devices</div>
            <h1 className="mt-1 text-3xl font-semibold text-slate-950">Thoth devices</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-700">
              Click a device to open its dashboard — live streams, collected data, models and automations run through the node relay.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="flex overflow-hidden rounded-xl border border-slate-300 bg-white focus-within:border-slate-950">
              <label className="sr-only" htmlFor="pairing-code">Pairing code</label>
              <input id="pairing-code" value={pairingCode}
                     onChange={(e) => setPairingCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))}
                     placeholder="PAIR CODE"
                     className="w-32 border-0 px-3 py-2 font-mono text-sm tracking-widest outline-none" />
              <button type="button" disabled={pairingBusy || pairingCode.length !== 8}
                      onClick={claimPairing}
                      className="inline-flex items-center gap-2 border-l border-slate-300 bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">
                <Link2 className="h-4 w-4" />{pairingBusy ? 'Pairing…' : 'Pair'}
              </button>
            </div>
            <button type="button" onClick={() => loadData(true)}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-slate-100">
              <RefreshCw className="h-4 w-4" /> Refresh
            </button>
          </div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-700">Online</div>
            <div className="mt-1 text-2xl font-semibold text-slate-950">{onlineCount}/{rows.length}</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-700">Collecting</div>
            <div className="mt-1 text-2xl font-semibold text-slate-950">{collectingCount}</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-700">Minutes collected</div>
            <div className="mt-1 text-2xl font-semibold text-slate-950">
              {rows.reduce((n, d) => n + d.minutes, 0)}
            </div>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={query} onChange={(e) => setQuery(e.target.value)}
                   placeholder="Search devices by name, host, IP…"
                   className="w-full rounded-xl border border-slate-300 py-2.5 pl-10 pr-3 text-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-medium sm:justify-start">
            Online only
            <input type="checkbox" checked={onlineOnly}
                   onChange={(e) => setOnlineOnly(e.target.checked)}
                   className="h-4 w-4 accent-cyan-600" />
          </label>
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {visibleRows.map((device) => (
          <article key={device.device_uuid}
                   className={`relative cursor-pointer rounded-2xl border border-slate-200 p-4 shadow-sm transition hover:border-cyan-400 hover:shadow-md ${device.online ? 'bg-white' : 'bg-slate-50 opacity-80'}`}
                   onClick={() => router.push(`/devices/${encodeURIComponent(device.device_uuid)}`)}
                   role="link" tabIndex={0}
                   onKeyDown={(e) => { if (e.key === 'Enter') router.push(`/devices/${encodeURIComponent(device.device_uuid)}`); }}>
            <button type="button" aria-label={`Detach ${device.device_name || 'device'}`}
                    title="Detach device"
                    onClick={(e) => { e.stopPropagation(); removeDevice(device.device_uuid); }}
                    className="absolute right-3 top-3 z-10 grid h-7 w-7 place-items-center rounded-full border border-slate-300 bg-white text-slate-500 hover:border-red-300 hover:bg-red-50 hover:text-red-700">
              <X className="h-3.5 w-3.5" />
            </button>
            <div className="flex items-start gap-3">
              <div className="shrink-0 rounded-xl bg-slate-950 p-3 text-white">
                <Cpu className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold text-slate-950">
                  {device.device_name || device.device_id}
                </h2>
                <div className="mt-1 font-mono text-[11px] text-slate-500">
                  {device.hardware_info?.hostname
                    ? `${device.hardware_info.hostname}:5000`
                    : device.ip_address || device.device_id}
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-semibold ${
                device.online
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-slate-300 bg-slate-100 text-slate-600'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${device.online ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                {device.online ? 'Online' : 'Offline'}
              </span>
              {device.online && (
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-semibold ${
                  device.collecting
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                    : 'border-slate-200 bg-white text-slate-600'}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${device.collecting ? 'animate-pulse bg-emerald-500' : 'bg-slate-300'}`} />
                  {device.collecting ? 'Collecting' : 'Idle'}
                </span>
              )}
              <span className={`rounded-full border px-2.5 py-1 font-semibold ${
                device.csi
                  ? 'border-cyan-300 bg-cyan-50 text-cyan-900'
                  : 'border-slate-200 bg-white text-slate-500'}`}>
                {device.csi ? `CSI ×${device.csi}` : 'no CSI'}
              </span>
              {device.models != null && (
                <span className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 font-semibold text-violet-800">
                  {device.models} model{device.models === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-600">
              <span>{device.minutes} min collected</span>
              <span>last seen {lastSeen(device.last_seen)}</span>
            </div>
          </article>
        ))}
        {!visibleRows.length && (
          <div className="col-span-full rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-700">
            {rows.length ? 'No devices match the current filters.' : 'No devices are registered yet.'}
          </div>
        )}
      </div>
    </div>
  );
}
