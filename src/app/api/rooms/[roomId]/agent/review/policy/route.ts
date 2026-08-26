import { handleReviewPolicy } from "@/lib/server/review-http";

type Context = { params: Promise<{ roomId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return handleReviewPolicy(request, context, "agent");
}
