const COOKIE = "session";
const YEAR_S = 365 * 24 * 3600;

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, (c) => (c === "+" ? "-" : c === "/" ? "_" : ""));
}

export function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export async function makeSessionCookie(secret: string, secure: boolean): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + YEAR_S;
  const value = `${exp}.${await hmac(secret, String(exp))}`;
  return `${COOKIE}=${value}; Path=/; Max-Age=${YEAR_S}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

export async function hasValidSession(cookieHeader: string | null | undefined, secret: string): Promise<boolean> {
  const match = cookieHeader?.match(/(?:^|;\s*)session=([^;]+)/);
  if (!match) return false;
  const [exp, sig] = match[1].split(".");
  if (!exp || !sig || Number(exp) * 1000 < Date.now()) return false;
  return safeEqual(sig, await hmac(secret, exp));
}
