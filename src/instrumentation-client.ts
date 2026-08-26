import {
  disposeLandingWebMcpBootstrap,
  ensureLandingWebMcpBootstrap,
} from "@/lib/webmcp/landing-bootstrap";

// Next executes this module after the initial HTML is loaded and before React
// hydration. Calling registerTool is synchronous even though its completion is
// promise-based, so discovery does not depend on a component effect.
try {
  if (window.location.pathname === "/") {
    void ensureLandingWebMcpBootstrap().catch(() => undefined);
  }
} catch {
  // WebMCP is a progressive enhancement. Unsupported browsers continue with
  // the fully functional visual landing experience.
}

export function onRouterTransitionStart(url: string): void {
  try {
    const destination = new URL(url, window.location.href);
    if (destination.pathname !== "/") disposeLandingWebMcpBootstrap();
  } catch {
    disposeLandingWebMcpBootstrap();
  }
}
