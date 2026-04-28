"use client";

import { X } from "lucide-react";

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
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
            <div className="space-y-1 flex-1 min-w-0">
              <p className="text-sm font-medium">{msg.title}</p>
              {msg.description && (
                <p className="text-xs text-[var(--muted-foreground)]">
                  {msg.description}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {msg.action && (
                <button
                  onClick={() => { msg.action!.onClick(); onDismiss(msg.id); }}
                  className="text-xs font-medium text-[var(--info)] hover:underline"
                >
                  {msg.action.label}
                </button>
              )}
              <button
                onClick={() => onDismiss(msg.id)}
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
