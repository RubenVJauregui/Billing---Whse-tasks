import { NextResponse } from "next/server";
import { AuthError, getSession } from "@/lib/session";

export async function GET() {
  try {
    const session = await getSession();
    return NextResponse.json({ authenticated: true, user: { name: session.displayName } });
  } catch (error) {
    return NextResponse.json(
      {
        authenticated: false,
        message: error instanceof Error ? error.message : "Please sign in.",
      },
      { status: error instanceof AuthError ? 200 : 500 },
    );
  }
}
