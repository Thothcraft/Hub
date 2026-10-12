'use client';

import { ReactNode, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import Sidebar from '@/components/Sidebar';
import { KeyboardShortcuts } from '@/components/KeyboardShortcuts';
import MobileNavigation from '@/components/MobileNavigation';
import PWAStatus from '@/components/PWAStatus';

export default function ProtectedLayout({
  children,
}: {
  children: ReactNode;
}) {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();
  const [isClient, setIsClient] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Show shortcuts on "?" key
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setShowShortcuts(prev => !prev);
      }
      // Close on Escape
      if (e.key === 'Escape') {
        setShowShortcuts(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!isLoading && !isAuthenticated && isClient) {
      router.push('/auth');
    }
  }, [isAuthenticated, isLoading, router, isClient]);

  if (isLoading || !isClient) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-primary)' }}>
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2" style={{ borderColor: 'var(--accent)' }}></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <div className="hidden md:block"><Sidebar /></div>
      <header className="sticky top-0 z-30 flex h-14 items-center border-b border-slate-200 bg-white/95 px-4 backdrop-blur md:hidden">
        <span className="rounded-lg bg-slate-950 px-2 py-1 text-sm font-bold text-white">T</span>
        <span className="ml-2 font-semibold text-slate-950">thothHUB</span>
      </header>
      <main className="portal-main min-h-screen px-3 pb-24 pt-3 transition-all sm:px-4 md:ml-64 md:p-8">
        {children}
      </main>
      <MobileNavigation />
      <PWAStatus />
      <KeyboardShortcuts isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />
    </div>
  );
}
