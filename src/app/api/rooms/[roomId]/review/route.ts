import { handleReviewList } from "@/lib/server/review-http";

type Context = { params: Promise<{ roomId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return handleReviewList(request, context);
}
