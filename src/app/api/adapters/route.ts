import { listAdapters } from "@/lib/adapters";

export async function GET() {
  const adapters = listAdapters().map((a) => ({
    id: a.id,
    displayName: a.displayName,
  }));
  return Response.json(adapters);
}
