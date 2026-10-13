'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import {
  ArrowLeft,
  Box as BoxIcon,
  BrainCircuit,
  Camera,
  Cpu,
  GitBranch,
  ListTree,
  Loader2,
  Radio,
} from 'lucide-react';
import { DeviceContextPanel } from '@/components/context/DeviceContextPanel';
import { useToast } from '@/contexts/ToastContext';
import { useApi } from '@/hooks/useApi';
import {
  MetadataDoc,
  NodeSensor,
  NodeStatus,
  RoomDoc,
  roomOptions,
  roomView,
  SensorTail,
  brainJson,
  nodeGet,
} from '@/lib/node-api';
import {
  AutomationsTab,
  CapturesTab,
  MetadataFields,
  ModelsTab,
  SensorTailPanel,
  StatusTab,
} from '@/components/device/tabs';
import { LayoutTab } from '@/components/device/LayoutTab';
import { contextApi, type CtxSnapshot } from '@/lib/context-api';
import type { RoomPerson } from '@/components/device/RoomScene';

const RoomScene = dynamic(() => import('@/components/device/RoomScene'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[420px] items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-500">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading 3D scene…
    </div>
  ),
});

type TabId = 'status' | 'live' | 'layout' | 'captures' | 'models' | 'automations' | 'context';
type DeviceRegistryInfo = { device_uuid: string; device_name?: string; device_type?: string; hardware_info?: Record<string, unknown>; last_seen?: string; };

function roomPeople(snapshot: CtxSnapshot, doc: RoomDoc, roomId: string): RoomPerson[] {
  const candidates = snapshot.entities.filter((entity) =>
    ['place', 'space', 'building'].includes(entity.kind));
  const place = candidates.find((entity) => entity.id === roomId || entity.id === `place:${roomId}`)
    ?? candidates.find((entity) => entity.attributes?.room_id === roomId);
  if (!place) return [];
  const now = Date.now() / 1000;
  const currentLocationEdges = snapshot.relationships.filter((relation) =>
    relation.predicate === 'located_in' && relation.object === place.id
    && relation.valid_from != null && now - relation.valid_from <= 120
    && relation.valid_from <= now + 5 && (relation.valid_until == null || relation.valid_until > now)
    && relation.confidence >= 0.8);
  const people = snapshot.entities.filter((entity) => entity.kind === 'person'
    && currentLocationEdges.some((relation) => relation.subject === entity.id));
  return people.map((person) => {
    const associated = snapshot.relationships.filter((relation) =>
      relation.subject === person.id && ['associated_devices', 'carries'].includes(relation.predicate)
      && relation.valid_from != null && now - relation.valid_from <= 120
      && relation.valid_from <= now + 5 && (relation.valid_until == null || relation.valid_until > now)
      && relation.confidence >= 0.8)
      .map((relation) => relation.object);
    const attrs = person.attributes?.associated_devices;
    if (Array.isArray(attrs)) associated.push(...attrs.map(String));
    const worn = snapshot.states.find((state) =>
      state.key === 'watch.worn.v1' && associated.includes(state.entity_id)
      && state.since != null && now - state.since <= 120
      && state.since <= now + 5 && (state.valid_until == null || state.valid_until > now)
      && state.confidence >= 0.8);
    const wornValue = typeof worn?.value === 'object' && worn.value !== null
      ? (worn.value as Record<string, unknown>).worn : worn?.value;
    return { id: person.id, name: person.name || person.id,
      wearingWatch: typeof wornValue === 'boolean' ? wornValue : null,
      live: true };
  });
}

const TABS: Array<{ id: TabId; label: string; icon: typeof Radio }> = [
  { id: 'status', label: 'Status', icon: Radio },
  { id: 'live', label: 'Live', icon: Camera },
  { id: 'layout', label: 'Layout', icon: BoxIcon },
  { id: 'captures', label: 'Collected', icon: ListTree },
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'automations', label: 'Automations', icon: GitBranch },
  { id: 'context', label: 'Context', icon: BrainCircuit },
];

/** viewer=portal — hides local-token display, unpair, LAN links (§5). */
const VIEWER = 'portal' as const;

export default function DeviceDashboardPage() {
  const params = useParams<{ deviceId: string }>();
  const router = useRouter();
  const toast = useToast();
  const { get } = useApi();
  const deviceId = decodeURIComponent(String(params?.deviceId || ''));

  const [tab, setTab] = useState<TabId>('status');
  const [status, setStatus] = useState<NodeStatus | null>(null);
  const [sensors, setSensors] = useState<NodeSensor[]>([]);
  const [room, setRoom] = useState<RoomDoc | null>(null);
  const [selRoom, setSelRoom] = useState('');
  const [meta, setMeta] = useState<MetadataDoc | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [err, setErr] = useState('');
  const [selectedSensor, setSelectedSensor] = useState<string | null>(null);
  const [registryInfo, setRegistryInfo] = useState<DeviceRegistryInfo | null>(null);
  const [roomPeopleNow, setRoomPeopleNow] = useState<RoomPerson[]>([]);

  const loadBasics = useCallback(async () => {
    void get('/device/list?include_offline=true').then((res) => {
      const rows = Array.isArray(res?.devices) ? res.devices as DeviceRegistryInfo[] : [];
      setRegistryInfo(rows.find((row) => row.device_uuid === deviceId) ?? null);
    }).catch(() => {});
    try {
      const [st, ss] = await Promise.all([
        nodeGet<NodeStatus>(deviceId, '/api/status'),
        nodeGet<{ sensors?: NodeSensor[] }>(deviceId, '/api/sensors'),
      ]);
      setStatus(st);
      setSensors(ss.sensors || []);
      setOnline(true);
      setErr('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unreachable';
      setOnline(false);
      setErr(msg);
    }
    let roomDoc: RoomDoc | null = null;
    try {
      const nodeRoom = await nodeGet<RoomDoc | { room?: RoomDoc | null }>(deviceId, '/api/v1/room');
      roomDoc = (nodeRoom as { room?: RoomDoc | null })?.room ?? nodeRoom as RoomDoc;
    } catch { /* node may be offline; use Brain's last synchronized room */ }
    if (!roomDoc?.name && !roomDoc?.dims && !roomDoc?.rooms?.length) {
      try {
        const cached = await brainJson<RoomDoc | { room?: RoomDoc | null }>(
          `/nodes/${encodeURIComponent(deviceId)}/room`);
        roomDoc = (cached as { room?: RoomDoc | null })?.room ?? cached as RoomDoc;
      } catch { /* cached room is optional */ }
    }
    if (roomDoc && (roomDoc.name || roomDoc.dims || roomDoc.rooms?.length)) {
      setRoom(roomDoc);
      setSelRoom((prev) => prev || roomDoc!.room_id || '');
    }
    try {
      const m = await nodeGet<MetadataDoc>(deviceId, '/api/v1/metadata');
      setMeta(m);
      if (m.manual?.room_id || m.manual?.room_name) {
        setRoom((prev) => prev || {
          room_id: m.manual?.room_id,
          name: m.manual?.room_name,
        });
      }
    } catch { /* metadata is optional on older nodes */ }
  }, [deviceId, get]);

  useEffect(() => {
    loadBasics();
    const t = setInterval(loadBasics, 10000);
    return () => clearInterval(t);
  }, [loadBasics]);

  useEffect(() => {
    if (!room) { setRoomPeopleNow([]); return; }
    let live = true;
    contextApi.snapshot().then((snapshot) => {
      if (live) setRoomPeopleNow(roomPeople(snapshot, room, selRoom || room.room_id || ''));
    }).catch(() => { if (live) setRoomPeopleNow([]); });
    const timer = window.setInterval(() => {
      contextApi.snapshot().then((snapshot) => {
        if (live) setRoomPeopleNow(roomPeople(snapshot, room, selRoom || room.room_id || ''));
      }).catch(() => {});
    }, 10000);
    return () => { live = false; window.clearInterval(timer); };
  }, [room, selRoom]);

  // Event stream → toasts (poll Brain /v1/events; mobile polls the same).
  const lastEventId = useRef(0);
  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const res = await brainJson<{ events?: Array<{ id: string; kind: string; data: Record<string, unknown> }> }>(
          `/events?device_id=${encodeURIComponent(deviceId)}&limit=20&since=${lastEventId.current || ''}`);
        if (!live) return;
        for (const ev of res.events || []) {
          const idNum = Number(ev.id);
          if (idNum > lastEventId.current) lastEventId.current = idNum;
          if (ev.kind === 'trigger_fired') {
            toast.info(
              'Automation fired',
              String(ev.data?.automation || ev.data?.name || 'trigger'),
            );
          } else if (ev.kind === 'room_changed') {
            toast.info('Room updated', 'node pushed a new room document');
          }
        }
      } catch { /* events are best-effort */ }
    };
    poll();
    const t = setInterval(poll, 15000);
    return () => { live = false; clearInterval(t); };
  }, [deviceId, toast]);

  const liveSensors = useMemo(
    () => sensors.filter((s) => s.online !== false).slice(0, 4),
    [sensors],
  );

  // Live radar frames → 3D scene: latest observation per radar sensor
  // (~1 Hz while the Live tab is open; payloads are full xy_map frames).
  const [radarFrames, setRadarFrames] = useState<
    Record<string, import('@/components/device/RoomScene').RadarFrame | null>
  >({});
  const radarSensorIds = useMemo(
    () =>
      sensors
        .filter(
          (s) =>
            s.type === 'radar' ||
            (typeof s.id === 'string' && s.id.startsWith('radar')),
        )
        .map((s) => s.id),
    [sensors],
  );
  useEffect(() => {
    if (!radarSensorIds.length || tab !== 'live') return;
    let live = true;
    const poll = async () => {
      const next: Record<
        string,
        import('@/components/device/RoomScene').RadarFrame | null
      > = {};
      try {
        const sid = radarSensorIds[0];
        const res = await nodeGet<SensorTail>(
          deviceId,
          `/api/v1/sources/${encodeURIComponent(sid)}/observations?latest=1`,
        );
        const sample = res?.samples?.[0] as
          | { payload?: Record<string, unknown> }
          | undefined;
        next[deviceId] =
          (sample?.payload as
            import('@/components/device/RoomScene').RadarFrame) ?? null;
      } catch {
        next[deviceId] = null;
      }
      if (live) setRadarFrames((prev) => ({ ...prev, ...next }));
    };
    void poll();
    const t = setInterval(poll, 1500);
    return () => { live = false; clearInterval(t); };
  }, [deviceId, radarSensorIds, tab]);

  const title = status?.name || meta?.manual?.friendly_name || deviceId;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => router.push('/devices')}
            className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50"
            title="Back to devices"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-900">
              {title}
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full ${
                  online === null ? 'bg-slate-300' : online ? 'bg-emerald-500' : 'bg-slate-300'
                }`}
                title={online ? 'tunnel connected' : online === false ? 'offline' : 'checking'}
              />
            </h1>
            <p className="font-mono text-xs text-slate-500">{deviceId}</p>
          </div>
        </div>
        <a
          href={`/api/node/${encodeURIComponent(deviceId)}/`}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        >
          Node root JSON
        </a>
      </div>

      {err && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          {online === false
            ? `Node is not reachable through the WS tunnel (${err}). Cached data may still render below.`
            : err}
        </div>
      )}

      <nav className="flex gap-1 border-b border-slate-200">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === id
                ? 'border-slate-900 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </nav>

      {tab === 'status' && (
        <StatusTab deviceId={deviceId} viewer={VIEWER} status={status} sensors={sensors} registryInfo={registryInfo} />
      )}

      {tab === 'live' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">
                Room layout {room?.name ? `— ${room.name}` : ''}
              </h3>
              <span className="text-xs text-slate-500">
                {room ? `room/v1 · ${roomPeopleNow.length ? `${roomPeopleNow.length} person placement${roomPeopleNow.length === 1 ? '' : 's'}` : 'no person placement'}${roomPeopleNow.length ? ' · marker positions illustrative' : ' · occupancy unknown'}` : 'awaiting first room_changed push'}
              </span>
            </div>
            {room && roomOptions(room).length > 1 && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {roomOptions(room).map((r) => (
                  <button
                    key={r.room_id || 'primary'}
                    onClick={() => setSelRoom(r.room_id)}
                    className={`rounded-md border px-2.5 py-1 text-xs transition ${
                      r.room_id === selRoom
                        ? 'border-blue-500 bg-blue-50 text-blue-700'
                        : 'border-slate-200 text-slate-500 hover:border-slate-300'
                    }`}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            )}
            <RoomScene
              room={room ? roomView(room, selRoom || (room.room_id ?? '')) : room}
              selectedSensor={selectedSensor}
              radarFrames={radarFrames}
              people={roomPeopleNow}
              onSelectSensor={(dev, type) =>
                setSelectedSensor((cur) =>
                  cur === `${dev}:${type}:0` ? null : `${dev}:${type}:0`)}
            />
          </div>
          <MetadataFields deviceId={deviceId} onSaved={loadBasics} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {liveSensors.map((s) => (
              <SensorTailPanel key={s.id} deviceId={deviceId} sensor={s} />
            ))}
            {liveSensors.length === 0 && (
              <p className="text-sm text-slate-500">
                No online sensors to tail — the node must be connected for live data.
              </p>
            )}
          </div>
        </div>
      )}

      {tab === 'layout' && (
        <LayoutTab
          deviceId={deviceId}
          cachedRoom={room}
          onSaved={(doc) => setRoom(doc)}
        />
      )}
      {tab === 'captures' && <CapturesTab deviceId={deviceId} viewer={VIEWER} />}
      {tab === 'models' && <ModelsTab deviceId={deviceId} viewer={VIEWER} />}
      {tab === 'automations' && <AutomationsTab deviceId={deviceId} viewer={VIEWER} />}

      <p className="text-xs text-slate-400">
        Viewer: {VIEWER} — LAN-only details (raw token, unpair, local links) are
        intentionally hidden. All traffic flows through Brain&apos;s node relay.
      </p>
    </div>
  );
}
