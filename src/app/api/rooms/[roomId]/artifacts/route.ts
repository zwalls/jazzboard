import {
  handleAuthorizedArtifactExport,
  handleAuthorizedTemplateInstantiation,
} from "@/lib/server/interchange-http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ roomId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return handleAuthorizedArtifactExport(request, context, "human");
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return handleAuthorizedTemplateInstantiation(request, context, "human");
}
