import { NextResponse } from "next/server";
import { z } from "zod";
import { publicRoute } from "@/server/api/http";
import { countUsers, createUser } from "@/server/services/auth";
import { ValidationError } from "@/server/services/errors";

const setupBody = z.object({
  handle: z.string().min(2).max(39),
  name: z.string().min(1).max(200),
  email: z.string().min(3).max(200),
  password: z.string().min(10).max(1024),
});

/** Whether this instance still needs its first account. */
export const GET = publicRoute(async ({ db }) => NextResponse.json({ needsSetup: (await countUsers(db)) === 0 }));

/**
 * Create the first administrator. Only works while the instance has no users, so it cannot be
 * used to add accounts later.
 */
export const POST = publicRoute(async ({ req, db }) => {
  if ((await countUsers(db)) > 0) throw new ValidationError("This instance is already set up");
  const body = setupBody.parse(await req.json());
  const user = await createUser(db, { ...body, role: "admin" });
  return NextResponse.json({ user: { id: user.id, handle: user.handle, name: user.name } }, { status: 201 });
});
