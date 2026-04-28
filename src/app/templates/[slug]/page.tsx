import { TemplateDetail } from "@/components/TemplateDetail";

export const dynamic = "force-dynamic";

export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <TemplateDetail slug={slug} />;
}
