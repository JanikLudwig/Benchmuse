import { parseBody, route } from "@/server/api/http";
import { addFeaturesBody, setFeaturesBody } from "@/server/api/sequenceBodies";
import { updateEntity } from "@/server/services/entities";
import { addFeatures } from "@/server/services/sequenceTools";

/** Add features, keeping the existing ones. */
export const POST = route(
  async ({ req, ctx, params }) => addFeatures(ctx.db, ctx.actor, params.id!, (await parseBody(req, addFeaturesBody)).features),
  { status: 201 },
);

/** Replace the whole feature list, for the feature table editor. */
export const PUT = route(async ({ req, ctx, params }) =>
  updateEntity(ctx.db, ctx.actor, params.id!, { features: (await parseBody(req, setFeaturesBody)).features }),
);
