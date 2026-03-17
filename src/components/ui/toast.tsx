"use client";

import { X } from "lucide-react";

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
}

export function ToastContainer({
  messages,
  onDismiss,
}: {
  messages: ToastMessage[];
  onDismiss: (id: string) => void;
}) {
  if (messages.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className="animate-slide-in-right rounded-lg border bg-[var(--card)] p-4 shadow-lg"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1">
              <p className="text-sm font-medium">{msg.title}</p>
              {msg.description && (
                <p className="text-xs text-[var(--muted-foreground)]">
                  {msg.description}
                </p>
              )}
            </div>
            <button
              onClick={() => onDismiss(msg.id)}
              className="shrink-0 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
