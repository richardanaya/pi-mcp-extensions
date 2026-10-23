/** What the user must see before a URL elicitation can be opened. Parsing does not fetch the URL. */

export interface UrlPresentation {
  /** The URL string the server sent, unchanged. */
  url: string;
  /** Host, including the port when it is not the default. This is the domain to highlight. */
  host: string;
  warnings: string[];
}

export function presentUrl(raw: string): UrlPresentation | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const warnings: string[] = [];
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !local) warnings.push("This URL is not https.");
  if (parsed.hostname.split(".").some((label) => label.toLowerCase().startsWith("xn--"))) {
    warnings.push("This host uses Punycode. Check the domain carefully.");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) warnings.push("This URL contains a username or password.");
  return { url: raw, host: parsed.host, warnings };
}

export function urlDialogText(server: string, message: string, presentation: UrlPresentation): string {
  return [
    `Host: ${presentation.host}`,
    `Server: ${server}`,
    presentation.url,
    "",
    message,
    ...presentation.warnings,
    "",
    "Opening this URL leaves pi. The page is not fetched or shown here.",
  ].join("\n");
}
