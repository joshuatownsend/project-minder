import { Badge } from "./ui/badge";
import { ProjectData } from "@/lib/types";

const frameworkColors: Record<string, string> = {
  "Next.js": "bg-[var(--bg-surface)] text-[var(--text-primary)] border border-[var(--border-default)]",
  Vite: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  Express: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  Remix: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  Astro: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  Hono: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  SvelteKit: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

export function TechStackBadges({ project }: { project: ProjectData }) {
  const badges: { label: string; className?: string }[] = [];

  if (project.framework) {
    const version = project.frameworkVersion ? ` ${project.frameworkVersion}` : "";
    badges.push({
      label: `${project.framework}${version}`,
      className: frameworkColors[project.framework],
    });
  }

  if (project.orm) badges.push({ label: project.orm });
  if (project.styling) badges.push({ label: project.styling });
  if (project.monorepoType) badges.push({ label: project.monorepoType });

  if (project.database) {
    badges.push({ label: project.database.type });
  }

  if (project.dockerPorts.length > 0) {
    badges.push({ label: "Docker" });
  }

  return (
    <div className="flex flex-wrap gap-1">
      {badges.map((b, i) => (
        <Badge key={i} variant="secondary" className={`text-[10px] ${b.className || ""}`}>
          {b.label}
        </Badge>
      ))}
    </div>
  );
}
