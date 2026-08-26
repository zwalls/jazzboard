import { handleReviewDecision, handleReviewRead } from "@/lib/server/review-http";

type Context = { params: Promise<{ roomId: string; proposalId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return handleReviewRead(request, context);
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return handleReviewDecision(request, context, "human");
}
