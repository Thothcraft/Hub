'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, Cpu, Map, Monitor, Radio } from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/contexts/AuthContext';

type Device = {
  device_uuid: string;
  device_name: string;
  online: boolean;
  last_seen?: string;
  hardware_info?: { hostname?: string };
};

export default function HomePage() {
  const { get } = useApi();
  const { user } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await get('/device/list?include_offline=true');
      setDevices(Array.isArray(response?.devices) ? response.devices : []);
    } catch {
      setDevices([]);
    } finally {
      setLoading(false);
    }
  }, [get]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  const online = devices.filter((device) => device.online).length;

  return <div className="ai-home ai-home-overview">
    <section className="ai-home-stage">
      <div className="ai-home-kicker"><Activity/> thothHUB · system overview</div>
      <h1>Overview</h1>
      <p className="ai-home-intro">
        Your connected devices, spaces, and live context in one place.
      </p>
      <div className="ai-stack">
        <div className="ai-home-kicker">Workspace</div>
        <h2>Explore your system</h2>
        <ol>
          <li><div className="ai-stack-head"><b>DEVICES</b><span>Inspect status, sensors, and node settings.</span></div><div className="ai-stack-actions"><Link className="ai-stack-cmd" href="/devices"><Monitor/> Open devices</Link></div></li>
          <li><div className="ai-stack-head"><b>SPACES</b><span>View room layouts and occupancy.</span></div><div className="ai-stack-actions"><Link className="ai-stack-cmd" href="/spaces"><Map/> Open spaces</Link></div></li>
          <li><div className="ai-stack-head"><b>LIVE CONTEXT</b><span>Review entities, evidence, and inferred state.</span></div><div className="ai-stack-actions"><Link className="ai-stack-cmd" href="/context"><Radio/> Open context</Link></div></li>
          <li><div className="ai-stack-head"><b>MODELS</b><span>Manage available models and deployments.</span></div><div className="ai-stack-actions"><Link className="ai-stack-cmd" href="/models"><Cpu/> Open models</Link></div></li>
        </ol>
      </div>
    </section>
    <aside className="ai-home-rail">
      <section>
        <span>Connected system</span>
        <strong>{loading ? 'Loading…' : `${online}/${devices.length} online`}</strong>
        <div className="ai-device-list">{devices.map((device) => <Link href={`/devices/${device.device_uuid}`} key={device.device_uuid}>
          <i className={device.online ? 'online' : ''}/><div><b>{device.device_name}</b><small>{device.hardware_info?.hostname || device.device_uuid}</small></div>
        </Link>)}</div>
        {!loading && devices.length === 0 && <p className="mt-3 text-sm text-slate-500">No devices are registered yet.</p>}
      </section>
      <section><span>Account</span><strong>{user?.username || 'Account'}</strong><div className="ai-home-links"><Link href="/profile">Open profile</Link><Link href="/settings">Settings & billing</Link></div></section>
    </aside>
  </div>;
}
