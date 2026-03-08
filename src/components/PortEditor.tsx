"use client";

import { useState } from "react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Pencil, Check, X } from "lucide-react";

interface PortEditorProps {
  slug: string;
  currentPort?: number;
  onPortChange: (port: number | null) => void;
  compact?: boolean;
}

export function PortEditor({
  slug,
  currentPort,
  onPortChange,
  compact = false,
}: PortEditorProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(currentPort || ""));

  const save = async () => {
    const port = parseInt(value, 10);
    if (!value || isNaN(port)) {
      // Clear override
      await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, port: null }),
      });
      onPortChange(null);
    } else if (port > 0 && port <= 65535) {
      await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, port }),
      });
      onPortChange(port);
    }
    setEditing(false);
  };

  const cancel = () => {
    setValue(String(currentPort || ""));
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setEditing(true);
          setValue(String(currentPort || ""));
        }}
        className={`inline-flex items-center gap-1 hover:text-[var(--foreground)] transition-colors ${
          compact ? "text-xs" : "text-sm"
        }`}
        title="Edit port"
      >
        <span className="font-mono">{currentPort ? `:${currentPort}` : "No port"}</span>
        <Pencil className={compact ? "h-2.5 w-2.5 opacity-0 group-hover:opacity-50" : "h-3 w-3 opacity-50"} />
      </button>
    );
  }

  return (
    <div
      className="flex items-center gap-1"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <Input
        type="number"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") cancel();
        }}
        className={compact ? "h-6 w-20 text-xs px-1" : "h-8 w-24 text-sm px-2"}
        min={1}
        max={65535}
        placeholder="Port"
        autoFocus
      />
      <Button
        variant="ghost"
        size="sm"
        className={compact ? "h-6 w-6 p-0" : "h-8 w-8 p-0"}
        onClick={save}
      >
        <Check className={compact ? "h-3 w-3" : "h-4 w-4"} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={compact ? "h-6 w-6 p-0" : "h-8 w-8 p-0"}
        onClick={cancel}
      >
        <X className={compact ? "h-3 w-3" : "h-4 w-4"} />
      </Button>
    </div>
  );
}
