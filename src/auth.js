import { jwtVerify, SignJWT } from "jose";

async function verifyTelegramLogin(data, botToken) {
  const { hash, ...fields } = data;
  const checkString = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join("\n");
  const secret = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(botToken));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(checkString));
  const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  if (expected !== hash) throw new Error("Invalid hash");
  if (Date.now() / 1000 - Number(fields.auth_date) > 86400) throw new Error("Auth expired");
  return fields;
}

export async function handleTelegramAuth(request, env) {
  const data = await request.json();
  try {
    const user = await verifyTelegramLogin(data, env.TELEGRAM_BOT_TOKEN);
    const secret = new TextEncoder().encode(env.JWT_SECRET || env.TELEGRAM_BOT_TOKEN);
    const token = await new SignJWT({ userId: user.id })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(secret);
    return Response.json({ token });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 401 });
  }
}