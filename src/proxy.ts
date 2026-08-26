import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

function acceptsMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  return accept.split(",").some((range) => {
    const [mediaType, ...parameters] = range.trim().toLowerCase().split(";");
    if (mediaType !== "text/markdown" && mediaType !== "text/x-markdown") return false;
    const quality = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("q="));
    return quality === undefined || Number.parseFloat(quality.slice(2)) > 0;
  });
}

export function proxy(request: NextRequest) {
  if (acceptsMarkdown(request.headers.get("accept"))) {
    const markdownUrl = request.nextUrl.clone();
    markdownUrl.pathname = "/index.md";
    return NextResponse.rewrite(markdownUrl);
  }

  const response = NextResponse.next();
  response.headers.append("Vary", "Accept");
  return response;
}

export const config = {
  matcher: "/",
};
