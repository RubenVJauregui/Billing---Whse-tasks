import { NextResponse } from "next/server";
import { AuthError, getSession } from "@/lib/session";
import { loadAssignedTasks, loadFacilities, WmsError } from "@/lib/wms";

export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const facilityId = searchParams.get("facilityId")?.trim();
    if (!facilityId) {
      return NextResponse.json({ message: "Choose a warehouse to view tasks." }, { status: 400 });
    }

    const session = await getSession();
    const facilities = await loadFacilities(session);
    const facility = facilities.find((candidate) => candidate.id === facilityId);
    if (!facility) {
      return NextResponse.json(
        { message: "That warehouse is not available to your account." },
        { status: 403 },
      );
    }

    const result = await loadAssignedTasks(session, facility, {
      date: searchParams.get("date") || undefined,
      month: searchParams.get("month") || undefined,
    });
    return NextResponse.json({ ...result, facility });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof WmsError ? error.status : 500;
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Assigned tasks could not be loaded." },
      { status },
    );
  }
}
