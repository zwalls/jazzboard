import { JAZZBOARD_ORIGIN } from "./content";

const PUBLIC_CACHE = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

function headers(contentType: string, canonicalPath: string): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": PUBLIC_CACHE,
    "Content-Type": contentType,
    Link: `<${JAZZBOARD_ORIGIN}${canonicalPath}>; rel="canonical", <${JAZZBOARD_ORIGIN}/llms.txt>; rel="describedby"`,
    "X-Content-Type-Options": "nosniff",
  });
}

export function markdownResponse(body: string, canonicalPath: string): Response {
  return new Response(body, {
    headers: headers("text/markdown; charset=utf-8", canonicalPath),
  });
}

export function markdownHeadResponse(canonicalPath: string): Response {
  return new Response(null, {
    headers: headers("text/markdown; charset=utf-8", canonicalPath),
  });
}

export function textResponse(body: string, canonicalPath: string): Response {
  return new Response(body, {
    headers: headers("text/plain; charset=utf-8", canonicalPath),
  });
}

export function textHeadResponse(canonicalPath: string): Response {
  return new Response(null, {
    headers: headers("text/plain; charset=utf-8", canonicalPath),
  });
}

export function jsonResponse(body: unknown, canonicalPath: string): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    headers: headers("application/json; charset=utf-8", canonicalPath),
  });
}

export function jsonHeadResponse(canonicalPath: string): Response {
  return new Response(null, {
    headers: headers("application/json; charset=utf-8", canonicalPath),
  });
}
