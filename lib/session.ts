import { cookies } from "next/headers";

const ACCESS_COOKIE = "wise_access";
const REFRESH_COOKIE = "wise_refresh";

type JwtIdentity = {
  user_id?: string | number;
  tenant_id?: string;
  company_code?: string;
  username?: string;
  user_name?: string;
};

type JwtPayload = {
  exp?: number;
  data?: JwtIdentity;
};

export type AuthSession = {
  accessToken: string;
  refreshToken?: string;
  tenantId: string;
  userId: string;
  displayName: string;
  expiresAt?: number;
};

type OAuthResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status = 401,
  ) {
    super(message);
  }
}

function decodePayload(token: string): JwtPayload {
  const payload = token.split(".")[1];
  if (!payload) throw new AuthError("Your session could not be verified.");

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new AuthError("Your session could not be verified.");
  }
}

function toSession(accessToken: string, refreshToken?: string): AuthSession {
  const payload = decodePayload(accessToken);
  const identity = payload.data ?? {};
  const userId = String(identity.user_id ?? "");
  const tenantId = String(identity.tenant_id ?? identity.company_code ?? "");

  if (!/^\d+$/.test(userId) || !tenantId) {
    throw new AuthError("Warehouse access could not be loaded.", 403);
  }

  return {
    accessToken,
    refreshToken,
    tenantId,
    userId,
    displayName: String(identity.user_name ?? identity.username ?? "WISE user"),
    expiresAt: payload.exp,
  };
}

const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "none" as const,
  partitioned: true,
  path: "/",
  priority: "high" as const,
};

export async function storeOAuthTokens(tokens: OAuthResponse) {
  if (!tokens.access_token) {
    throw new AuthError("Sign-in did not return a valid session.", 502);
  }

  const session = toSession(tokens.access_token, tokens.refresh_token);
  const cookieStore = await cookies();
  cookieStore.set(ACCESS_COOKIE, tokens.access_token, {
    ...cookieOptions,
    maxAge: Math.max(60, Number(tokens.expires_in) || 3600),
  });

  if (tokens.refresh_token) {
    cookieStore.set(REFRESH_COOKIE, tokens.refresh_token, {
      ...cookieOptions,
      maxAge: 60 * 60 * 24 * 14,
    });
  }

  return session;
}

export async function clearSession() {
  const cookieStore = await cookies();
  cookieStore.set(ACCESS_COOKIE, "", { ...cookieOptions, maxAge: 0 });
  cookieStore.set(REFRESH_COOKIE, "", { ...cookieOptions, maxAge: 0 });
}

async function refreshSession(refreshToken: string) {
  const baseUrl = process.env.ITEMGPT_BASE_URL?.replace(/\/$/, "");
  if (!baseUrl) throw new AuthError("Sign-in service is not configured.", 503);

  const response = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
    cache: "no-store",
  });
  const tokens = (await response.json().catch(() => null)) as OAuthResponse | null;

  if (!response.ok || !tokens?.access_token) {
    await clearSession();
    throw new AuthError("Your session has expired. Please sign in again.");
  }

  return storeOAuthTokens({
    ...tokens,
    refresh_token: tokens.refresh_token ?? refreshToken,
  });
}

export async function getSession(forceRefresh = false): Promise<AuthSession> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(ACCESS_COOKIE)?.value;
  const refreshToken = cookieStore.get(REFRESH_COOKIE)?.value;

  if (!accessToken) {
    if (refreshToken) return refreshSession(refreshToken);
    throw new AuthError("Please sign in to view assigned tasks.");
  }

  const session = toSession(accessToken, refreshToken);
  const expiresSoon = session.expiresAt
    ? session.expiresAt * 1000 <= Date.now() + 60_000
    : false;

  if ((forceRefresh || expiresSoon) && refreshToken) {
    return refreshSession(refreshToken);
  }

  return session;
}

export type { OAuthResponse };
