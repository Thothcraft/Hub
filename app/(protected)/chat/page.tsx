'use client';

import AssistantChat from '@/components/AssistantChat';

export default function ChatPage() {
  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-4">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#627447]">Thoth assistant</p>
        <h1 className="mt-1 text-3xl font-semibold text-[#20231b]">Chat</h1>
        <p className="mt-1 text-sm text-[#55594f]">Ask about your devices, spaces, and current context.</p>
      </header>
      <AssistantChat page />
    </section>
  );
}
