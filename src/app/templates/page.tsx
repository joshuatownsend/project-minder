import { TemplatesBrowser } from "@/components/TemplatesBrowser";

export const dynamic = "force-dynamic";

export default function TemplatesPage() {
  return (
    <div className="shell-content wide">
      <TemplatesBrowser />
    </div>
  );
}
