'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Home, Monitor, MoreHorizontal, Settings, UserRound, LogOut, Map, BrainCircuit, MessageSquare } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

export default function MobileNavigation() {
  const pathname = usePathname();
  const { logout } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);
  const items = [
    { href: '/home', label: 'Home', icon: Home },
    { href: '/devices', label: 'Devices', icon: Monitor },
    { href: '/context', label: 'Context', icon: BrainCircuit },
  ];
  return <>
    {moreOpen && <div className="fixed inset-x-3 bottom-20 z-50 rounded-2xl border border-slate-300 bg-white p-3 shadow-xl md:hidden">
      <Link href="/spaces" onClick={() => setMoreOpen(false)} className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold"><Map className="h-5 w-5"/>Spaces</Link>
      <Link href="/chat" onClick={() => setMoreOpen(false)} className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold"><MessageSquare className="h-5 w-5"/>Chat</Link>
      <Link href="/profile" onClick={() => setMoreOpen(false)} className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold"><UserRound className="h-5 w-5"/>Profile</Link>
      <Link href="/settings" onClick={() => setMoreOpen(false)} className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold"><Settings className="h-5 w-5"/>Settings</Link>
      <button onClick={logout} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold text-red-700"><LogOut className="h-5 w-5"/>Sign out</button>
    </div>}
    <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-slate-200 bg-white/95 px-2 pb-[max(.5rem,env(safe-area-inset-bottom))] pt-2 shadow-[0_-8px_30px_rgba(15,23,42,.08)] backdrop-blur md:hidden">
      {items.map((item) => {
        const Icon = item.icon;
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return <Link key={item.href} href={item.href} className={`flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-semibold ${active ? 'bg-cyan-50 text-cyan-800' : 'text-slate-500'}`}><Icon className="h-5 w-5"/><span>{item.label}</span></Link>;
      })}
      <button onClick={() => setMoreOpen((value) => !value)} className="flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-semibold text-slate-500"><MoreHorizontal className="h-5 w-5"/><span>More</span></button>
    </nav>
  </>;
}
