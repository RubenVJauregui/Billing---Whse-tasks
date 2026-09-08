import { NextResponse } from "next/server";
import { AuthError, storeOAuthTokens, type OAuthResponse } from "@/lib/session";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      username?: unknown;
      password?: unknown;
    } | null;
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!username || !password) {
      return NextResponse.json(
        { message: "Enter both your username and password." },
        { status: 400 },
      );
    }

    const baseUrl = process.env.ITEMGPT_BASE_URL?.replace(/\/$/, "");
    if (!baseUrl) {
      return NextResponse.json(
        { message: "Sign-in is not configured for this site." },
        { status: 503 },
      );
    }
    const defaultTenantId = process.env.DEFAULT_WMS_TENANT_ID;
    if (!defaultTenantId) {
      return NextResponse.json(
        { message: "Sign-in is not configured for this site." },
        { status: 503 },
      );
    }

    const response = await fetch(`${baseUrl}/api/auth/password-grant`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        password,
        scope: "openid",
        tenantId: defaultTenantId,
      }),
      cache: "no-store",
    });
    const tokens = (await response.json().catch(() => null)) as OAuthResponse | null;

    if (!response.ok || !tokens?.access_token) {
      return NextResponse.json(
        { message: "That username or password was not recognized." },
        { status: 401 },
      );
    }

    const session = await storeOAuthTokens(tokens);
    return NextResponse.json({ user: { name: session.displayName } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Sign-in could not be completed." },
      { status },
    );
  }
}
