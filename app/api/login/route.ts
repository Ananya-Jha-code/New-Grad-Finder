import { NextResponse } from "next/server";
import { safeEqual, sessionToken } from "@/lib/session";

export async function POST(request: Request) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.json({ ok: true });
  const body = (await request.json().catch(() => ({}))) as { password?: string };
  const given = await sessionToken(String(body.password ?? ""));
  const expected = await sessionToken(password);
  if (!safeEqual(given, expected)) return NextResponse.json({ error: "wrong password" }, { status: 401 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set("if_session", given, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
