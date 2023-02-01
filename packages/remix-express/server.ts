import type * as express from "express";
import type { MiddlewareContext } from "@remix-run/router";
import { UNSAFE_createMiddlewareStore as createMiddlewareStore } from "@remix-run/router";
import type {
  AppLoadContext,
  ServerBuild,
  RequestInit as NodeRequestInit,
  Response as NodeResponse,
} from "@remix-run/node";
import {
  AbortController as NodeAbortController,
  createRequestHandler as createRemixRequestHandler,
  Headers as NodeHeaders,
  Request as NodeRequest,
  writeReadableStreamToWritable,
} from "@remix-run/node";

/**
 * A function that returns the value to use as `context` in route `loader` and
 * `action` functions.
 *
 * You can think of this as an escape hatch that allows you to pass
 * environment/platform-specific values through to your loader/action, such as
 * values that are generated by Express middleware like `req.session`.
 */
export type GetLoadContextFunction = (
  req: express.Request,
  res: express.Response
) => AppLoadContext;

export type ServerMiddlewareFunction = ({
  request,
  response,
  context,
}: {
  request: express.Request;
  response: express.Response;
  context: MiddlewareContext;
}) => Promise<Response>;

export type RequestHandler = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => Promise<void>;

/**
 * Returns a request handler for Express that serves the response using Remix.
 */
export function createRequestHandler({
  build,
  getLoadContext,
  serverMiddleware,
  mode = process.env.NODE_ENV,
}: {
  build: ServerBuild;
  getLoadContext?: GetLoadContextFunction;
  serverMiddleware?: ServerMiddlewareFunction;
  mode?: string;
}): RequestHandler {
  let handleRequest = createRemixRequestHandler(build, mode);

  if (build.future.unstable_middleware && serverMiddleware) {
    return async (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      let response: NodeResponse | undefined;
      let context = createMiddlewareStore();
      let callRemix = async () => {
        let request = createRemixRequest(req, res);
        response = (await handleRequest(
          request,
          undefined,
          context
        )) as NodeResponse;
        return response;
      };
      context.next = callRemix;

      try {
        await serverMiddleware({ request: req, response: res, context });
        if (!response) {
          // User never called next(), so doesn't need to do any post-processing
          response = await callRemix();
        }
        if (!res.headersSent) {
          await sendRemixResponse(res, response);
        }
      } catch (error: unknown) {
        // Express doesn't support async functions, so we have to pass along the
        // error manually using next().
        next(error);
      }
    };
  }

  return async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    try {
      let request = createRemixRequest(req, res);
      let loadContext = build.future.unstable_middleware
        ? undefined
        : getLoadContext?.(req, res);

      let response = (await handleRequest(
        request,
        loadContext
      )) as NodeResponse;

      await sendRemixResponse(res, response);
    } catch (error: unknown) {
      // Express doesn't support async functions, so we have to pass along the
      // error manually using next().
      next(error);
    }
  };
}

export function createRemixHeaders(
  requestHeaders: express.Request["headers"]
): NodeHeaders {
  let headers = new NodeHeaders();

  for (let [key, values] of Object.entries(requestHeaders)) {
    if (values) {
      if (Array.isArray(values)) {
        for (let value of values) {
          headers.append(key, value);
        }
      } else {
        headers.set(key, values);
      }
    }
  }

  return headers;
}

export function createRemixRequest(
  req: express.Request,
  res: express.Response
): NodeRequest {
  let origin = `${req.protocol}://${req.get("host")}`;
  let url = new URL(req.url, origin);

  // Abort action/loaders once we can no longer write a response
  let controller = new NodeAbortController();
  res.on("close", () => controller.abort());

  let init: NodeRequestInit = {
    method: req.method,
    headers: createRemixHeaders(req.headers),
    // Cast until reason/throwIfAborted added
    // https://github.com/mysticatea/abort-controller/issues/36
    signal: controller.signal as NodeRequestInit["signal"],
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req;
  }

  return new NodeRequest(url.href, init);
}

export async function sendRemixResponse(
  res: express.Response,
  nodeResponse: NodeResponse
): Promise<void> {
  res.statusMessage = nodeResponse.statusText;
  res.status(nodeResponse.status);

  for (let [key, values] of Object.entries(nodeResponse.headers.raw())) {
    for (let value of values) {
      res.append(key, value);
    }
  }

  if (nodeResponse.body) {
    await writeReadableStreamToWritable(nodeResponse.body, res);
  } else {
    res.end();
  }
}
