import { route } from "@/server/api/http";
import { registerEntity } from "@/server/services/entities";

export const POST = route(async ({ ctx, params }) => registerEntity(ctx.db, ctx.actor, params.id!));
