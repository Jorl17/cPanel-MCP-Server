import https from "node:https";
import http from "node:http";
import { URL } from "node:url";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface CpanelApiResponse {
  status: number;
  errors: string[] | null;
  messages: string[] | null;
  data: unknown;
  metadata?: Record<string, unknown>;
}

export interface CpanelApi2Response {
  cpanelresult: {
    apiversion: number;
    func: string;
    module: string;
    data: unknown;
    error?: string;
    event?: { result?: number | string; reason?: string };
  };
}

export class CpanelApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly apiErrors?: string[]
  ) {
    super(message);
    this.name = "CpanelApiError";
  }
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;

  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255)
  );
}

function parseServerUrl(serverUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new CpanelApiError("Invalid CPANEL_SERVER_URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new CpanelApiError("CPANEL_SERVER_URL must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new CpanelApiError("CPANEL_SERVER_URL must not contain credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new CpanelApiError("CPANEL_SERVER_URL must not contain a query or fragment");
  }

  return parsed;
}

export class CpanelClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly apiToken: string;
  private readonly httpsAgent: https.Agent;
  private readonly httpAgent: http.Agent;
  private readonly timeoutMs: number;

  constructor() {
    const username = process.env.CPANEL_USERNAME;
    const apiToken = process.env.CPANEL_API_TOKEN;
    const serverUrl = process.env.CPANEL_SERVER_URL;

    if (!username || !apiToken || !serverUrl) {
      throw new CpanelApiError(
        "Missing required environment variables: CPANEL_USERNAME, CPANEL_API_TOKEN, CPANEL_SERVER_URL"
      );
    }

    const parsedServerUrl = parseServerUrl(serverUrl);
    if (parsedServerUrl.protocol === "http:") {
      const allowInsecureHttp =
        process.env.CPANEL_ALLOW_INSECURE_HTTP === "true";
      if (!allowInsecureHttp || !isLoopbackHostname(parsedServerUrl.hostname)) {
        throw new CpanelApiError(
          "CPANEL_SERVER_URL must use HTTPS. Plain HTTP is only allowed for loopback hosts when CPANEL_ALLOW_INSECURE_HTTP=true."
        );
      }
      console.warn(
        "[Security Warning] CPANEL_SERVER_URL is using explicitly enabled loopback HTTP. Credentials are not encrypted."
      );
    }

    this.username = username;
    this.apiToken = apiToken;
    this.baseUrl = parsedServerUrl.href.replace(/\/+$/, "");
    this.timeoutMs = Number(process.env.CPANEL_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

    const rejectUnauthorized = process.env.CPANEL_VERIFY_SSL !== "false";

    this.httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 5,
      rejectUnauthorized,
    });

    this.httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 5,
    });
  }

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `cpanel ${this.username}:${this.apiToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };
  }

  /* Send `params` in a form-encoded POST body, so that values such as
   * passwords are not in the URL. We send every request once, because
   * cPanel also changes the account through these endpoints, and after a
   * timeout or a dropped connection we cannot tell whether a change was
   * made. */
  private post(path: string, params: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(this.baseUrl + path);
      const isHttps = parsed.protocol === "https:";
      const transport = isHttps ? https : http;
      const body = new URLSearchParams(params).toString();

      const options: https.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          ...this.buildHeaders(),
          "Content-Length": Buffer.byteLength(body).toString(),
        },
        agent: isHttps ? this.httpsAgent : this.httpAgent,
        timeout: this.timeoutMs,
      };

      const req = transport.request(options, (res) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        res.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            req.destroy();
            reject(
              new CpanelApiError(
                `Response exceeded ${MAX_RESPONSE_BYTES} bytes limit`
              )
            );
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          // The body of an error page can repeat request values, so we
          // leave it out of the error message.
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new CpanelApiError(`HTTP ${res.statusCode}`, res.statusCode)
            );
          } else {
            resolve(Buffer.concat(chunks).toString("utf-8"));
          }
        });

        res.on("error", (err) =>
          reject(new CpanelApiError(`Response error: ${err.message}`))
        );
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new CpanelApiError(`Request timed out after ${this.timeoutMs}ms`));
      });

      req.on("error", (err) =>
        reject(new CpanelApiError(`Request failed: ${err.message}`))
      );

      req.end(body);
    });
  }

  /* Call a UAPI function and return its result. Throw unless the result
   * has status 1. */
  async uapi(
    module: string,
    func: string,
    params: Record<string, string> = {}
  ): Promise<CpanelApiResponse> {
    const name = `UAPI ${module}::${func}`;
    console.error(`[API] ${name}`);

    const raw = await this.post(
      `/execute/${encodeURIComponent(module)}/${encodeURIComponent(func)}`,
      params
    );
    const result = parseJsonObject(raw, name).result;
    if (!isObject(result) || typeof result.status !== "number") {
      throw new CpanelApiError(`${name} returned no result status`);
    }

    const response = result as unknown as CpanelApiResponse;
    if (response.status !== 1) {
      const errors = response.errors?.length ? response.errors : undefined;
      throw new CpanelApiError(
        `${name} failed: ${errors ? errors.join(", ") : "no error message"}`,
        undefined,
        errors
      );
    }

    return response;
  }

  /* Call a cPanel API 2 function and return cpanelresult.data. API 2
   * reports a failure in cpanelresult.error, in cpanelresult.event.result
   * or in the result field of an item in data, so we throw for any of
   * them. */
  async api2(
    module: string,
    func: string,
    params: Record<string, string> = {}
  ): Promise<unknown> {
    const name = `API2 ${module}::${func}`;
    console.error(`[API] ${name}`);

    const raw = await this.post("/json-api/cpanel", {
      cpanel_jsonapi_user: this.username,
      cpanel_jsonapi_apiversion: "2",
      cpanel_jsonapi_module: module,
      cpanel_jsonapi_func: func,
      ...params,
    });
    const cpanelresult = parseJsonObject(raw, name).cpanelresult;
    if (!isObject(cpanelresult)) {
      throw new CpanelApiError(`${name} returned no cpanelresult`);
    }

    const { error, event, data } = cpanelresult as CpanelApi2Response["cpanelresult"];
    if (error) {
      throw new CpanelApiError(`${name} failed: ${error}`);
    }
    if (event?.result !== undefined && Number(event.result) !== 1) {
      throw new CpanelApiError(`${name} failed: ${event.reason ?? "no error message"}`);
    }
    for (const item of Array.isArray(data) ? data : []) {
      const failure = api2ItemFailure(item);
      if (failure !== undefined) {
        throw new CpanelApiError(`${name} failed: ${failure}`);
      }
    }

    return data;
  }

  destroy(): void {
    this.httpsAgent.destroy();
    this.httpAgent.destroy();
  }
}


function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(raw: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CpanelApiError(`Invalid JSON response from ${name}`);
  }
  if (!isObject(parsed)) {
    throw new CpanelApiError(`Unexpected response from ${name}`);
  }
  return parsed;
}

/* Return the failure message of one item in API 2 data, or undefined when
 * the item reports no failure. ZoneEdit functions put
 * { result: { status, statusmsg } } in an item. Other functions, such as
 * Park::park, put a numeric result and a reason. */
function api2ItemFailure(item: unknown): string | undefined {
  if (!isObject(item) || !("result" in item)) return undefined;

  const { result, reason } = item;
  if (isObject(result)) {
    if (result.status === undefined || Number(result.status) === 1) return undefined;
    return String(result.statusmsg ?? result.reason ?? "no error message");
  }
  if (Number(result) === 0) {
    return String(reason ?? "no error message");
  }
  return undefined;
}
