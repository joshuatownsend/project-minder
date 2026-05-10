import { CommandsBrowser } from "@/components/CommandsBrowser";

export const dynamic = "force-dynamic";

export default function CommandsPage() {
  return (
    <div className="shell-content wide">
      <CommandsBrowser />
    </div>
  );
}
