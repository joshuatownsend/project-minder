"use client";

import { useSessionDetail } from "@/hooks/useSessions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import { StatCard } from "./stats/StatCard";
import { BarChart } from "./stats/BarChart";
import { SessionTimeline } from "./SessionTimeline";
import { SessionFileOps } from "./SessionFileOps";
import { SessionSubagents } from "./SessionSubagents";
import {
  ArrowLeft,
  Clock,
  MessageSquare,
  Cpu,
  DollarSign,
  AlertCircle,
  GitBranch,
  Bot,
  File,
} from "lucide-react";
import Link from "next/link";

function formatDuration(ms?: number): string {
  if (!ms) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function SessionDetailView({ sessionId }: { sessionId: string }) {
  const { data, loading } = useSessionDetail(sessionId);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-96 rounded-lg" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <Link href="/sessions">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
        </Link>
        <p className="text-[var(--muted-foreground)] text-center py-12">
          Session not found.
        </p>
      </div>
    );
  }

  const totalTools = Object.values(data.toolUsage).reduce((s, c) => s + c, 0);

  return (
    <div className="space-y-6">
      <Link href="/sessions">
        <Button variant="ghost" size="sm">
          <ArrowLeft className="h-4 w-4 mr-1" /> Back to Sessions
        </Button>
      </Link>

      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          {data.isActive && (
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
            </span>
          )}
          <h1 className="text-xl font-bold">{data.projectName}</h1>
          {data.gitBranch && (
            <Badge variant="outline" className="text-xs">
              <GitBranch className="h-3 w-3 mr-1" />
              {data.gitBranch}
            </Badge>
          )}
        </div>
        {data.initialPrompt && (
          <p className="text-sm text-[var(--muted-foreground)]">
            {data.initialPrompt}
          </p>
        )}
        <p className="text-xs text-[var(--muted-foreground)] font-mono">
          {formatDate(data.startTime)} &middot; {formatDuration(data.durationMs)} &middot; {data.sessionId.slice(0, 8)}
        </p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <StatCard
          label="Messages"
          value={data.messageCount}
          icon={<MessageSquare className="h-4 w-4" />}
          detail={`${data.userMessageCount} user / ${data.assistantMessageCount} assistant`}
        />
        <StatCard
          label="Duration"
          value={formatDuration(data.durationMs)}
          icon={<Clock className="h-4 w-4" />}
        />
        <StatCard
          label="Tokens"
          value={formatTokens(data.inputTokens + data.outputTokens)}
          icon={<Cpu className="h-4 w-4" />}
          detail={`${formatTokens(data.inputTokens)} in / ${formatTokens(data.outputTokens)} out`}
        />
        <StatCard
          label="Cost"
          value={formatCost(data.costEstimate)}
          icon={<DollarSign className="h-4 w-4" />}
        />
        <StatCard
          label="Tool Calls"
          value={totalTools}
          detail={`${Object.keys(data.toolUsage).length} unique tools`}
        />
        <StatCard
          label="Errors"
          value={data.errorCount}
          icon={<AlertCircle className="h-4 w-4" />}
        />
      </div>

      {/* Models */}
      <div className="flex flex-wrap gap-1">
        {data.modelsUsed.map((m) => (
          <Badge key={m} variant="outline">
            {m}
          </Badge>
        ))}
      </div>

      {/* Tabs */}
      <Tabs defaultValue="timeline">
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="files">
            Files ({data.fileOperations.length})
          </TabsTrigger>
          {data.subagents.length > 0 && (
            <TabsTrigger value="subagents">
              <Bot className="h-3 w-3 mr-1" />
              Subagents ({data.subagents.length})
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="timeline">
          <div className="rounded-lg border p-4 max-h-[600px] overflow-y-auto">
            <SessionTimeline timeline={data.timeline} sessionStart={data.startTime} />
          </div>
        </TabsContent>

        <TabsContent value="tools">
          <div className="rounded-lg border p-4">
            <BarChart data={data.toolUsage} colorClass="bg-violet-500" />
          </div>
        </TabsContent>

        <TabsContent value="files">
          <div className="rounded-lg border p-4">
            <SessionFileOps operations={data.fileOperations} />
          </div>
        </TabsContent>

        {data.subagents.length > 0 && (
          <TabsContent value="subagents">
            <SessionSubagents subagents={data.subagents} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
