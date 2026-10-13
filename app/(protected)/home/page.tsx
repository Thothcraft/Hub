'use client';

import Link from 'next/link';
import { Activity, Map, Monitor, Radio } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

export default function HomePage() {
  const { user } = useAuth();

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
        </ol>
      </div>
    </section>
    <aside className="ai-home-rail">
      <section><span>Account</span><strong>{user?.username || 'Account'}</strong><div className="ai-home-links"><Link href="/profile">Open profile</Link><Link href="/settings">Settings & billing</Link></div></section>
    </aside>
  </div>;
}
