import { handleBridgeRequest } from "./routes.js";
import type { BridgeEnv } from "./sandboxes.js";

export { Sandbox } from "@cloudflare/sandbox";

async function fetch(request: Request, env: BridgeEnv): Promise<Response> {
  try {
    return await handleBridgeRequest(request, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      {
        error: "internal_error",
        message,
      },
      { status: 500 },
    );
  }
}

export default { fetch };
