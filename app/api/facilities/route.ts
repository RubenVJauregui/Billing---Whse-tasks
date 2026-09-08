import { NextResponse } from "next/server";
import { AuthError, getSession } from "@/lib/session";
import { loadFacilities, selectInitialFacility, WmsError } from "@/lib/wms";

export async function GET() {
  try {
    const session = await getSession();
    const facilities = await loadFacilities(session);
    return NextResponse.json({
      facilities,
      initialFacilityId: selectInitialFacility(facilities)?.id ?? null,
    });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof WmsError ? error.status : 500;
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Warehouses could not be loaded." },
      { status },
    );
  }
}
