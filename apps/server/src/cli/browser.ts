export function browserCommand(platform: NodeJS.Platform, url: string): string[] {
  if (platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler", url];
  if (platform === "darwin") return ["open", url];
  return ["xdg-open", url];
}

/** Best effort: failing to open a browser must not stop the server. */
export function openBrowser(url: string): void {
  try {
    Bun.spawn(browserCommand(process.platform, url), {
      stdio: ["ignore", "ignore", "ignore"],
    }).unref();
  } catch {
    console.warn(`Could not open a browser. Open this URL manually:\n  ${url}`);
  }
}
