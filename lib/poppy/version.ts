// Poppy-Version handling (Poppy 1.0 section 3.4). Versions are "major.minor"; from
// 1.0 on, two versions are compatible when the major matches.
export const POPPY_VERSION = "1.0";
const MAJOR = 1;

export function versionCompatible(value: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})$/.exec(value.trim());
  return m !== null && Number(m[1]) === MAJOR;
}

// Slice A endpoints answer the same for every caller, so a missing header is
// accepted; a header naming an incompatible version is refused (FR42).
export function versionProblem(request: Request): Response | null {
  const value = request.headers.get("poppy-version");
  if (value === null || versionCompatible(value)) return null;
  return poppyError("version_unsupported", 400);
}

// Poppy error bodies are {"error": "<code>"} (sections 5.3, 8.13).
export function poppyError(error: string, status: number, headers: HeadersInit = {}): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export const notFound = () => new Response("Not found", { status: 404 });
