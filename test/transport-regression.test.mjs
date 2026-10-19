import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { CpanelApiError, CpanelClient } from "../build/cpanel-api.js";

const ENV_KEYS = [
  "CPANEL_USERNAME",
  "CPANEL_API_TOKEN",
  "CPANEL_SERVER_URL",
  "CPANEL_ALLOW_INSECURE_HTTP",
];

// Start a loopback HTTP server that records every request and answers with
// `respond(request, response)`.
async function startFixture(respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const request = {
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks).toString("utf-8"),
      };
      requests.push(request);
      respond(request, res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

// Run `fn(client, fixture)` against a fixture that answers with `respond`.
async function withClient(respond, fn) {
  const fixture = await startFixture(respond);
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const originalWarn = console.warn;
  const originalError = console.error;
  process.env.CPANEL_USERNAME = "test-user";
  process.env.CPANEL_API_TOKEN = "test-token";
  process.env.CPANEL_SERVER_URL = fixture.url;
  process.env.CPANEL_ALLOW_INSECURE_HTTP = "true";
  console.warn = () => {};
  console.error = () => {};

  const client = new CpanelClient();
  try {
    await fn(client, fixture);
  } finally {
    client.destroy();
    console.warn = originalWarn;
    console.error = originalError;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fixture.close();
  }
}

// The shape of a reply from /execute, with the fields at the top level.
const UAPI_OK = { status: 1, errors: null, messages: null, warnings: null, metadata: {}, data: [] };

test("UAPI parameters, including passwords, go in the POST body and not in the URL", async () => {
  await withClient((req, res) => json(res, 200, UAPI_OK), async (client, fixture) => {
    await client.uapi("Email", "add_pop", { email: "box", password: "s3cret-pass" });

    assert.equal(fixture.requests.length, 1);
    const [request] = fixture.requests;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/execute/Email/add_pop");
    assert.equal(new URLSearchParams(request.body).get("password"), "s3cret-pass");
  });
});

test("API 2 parameters go in the POST body and not in the URL", async () => {
  const api2Ok = { cpanelresult: { data: [], event: { result: 1 } } };
  await withClient((req, res) => json(res, 200, api2Ok), async (client, fixture) => {
    await client.api2("ZoneEdit", "fetchzone_records", { domain: "example.com" });

    const [request] = fixture.requests;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/json-api/cpanel");
    const body = new URLSearchParams(request.body);
    assert.equal(body.get("cpanel_jsonapi_module"), "ZoneEdit");
    assert.equal(body.get("cpanel_jsonapi_func"), "fetchzone_records");
    assert.equal(body.get("domain"), "example.com");
  });
});

test("a 5xx response is sent once and not repeated", async () => {
  await withClient((req, res) => json(res, 503, {}), async (client, fixture) => {
    await assert.rejects(
      client.uapi("Email", "add_forwarder", { domain: "example.com" }),
      CpanelApiError
    );
    assert.equal(fixture.requests.length, 1);
  });
});

test("a dropped connection is sent once and not repeated", async () => {
  await withClient((req, res) => res.socket.destroy(), async (client, fixture) => {
    await assert.rejects(
      client.api2("ZoneEdit", "remove_zone_record", { domain: "example.com", line: "12" }),
      CpanelApiError
    );
    assert.equal(fixture.requests.length, 1);
  });
});

test("HTTP error messages leave out the response body", async () => {
  const respond = (req, res) => {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("body-with-secret-value");
  };
  await withClient(respond, async (client) => {
    await assert.rejects(client.uapi("Email", "list_pops"), (err) => {
      assert.ok(err instanceof CpanelApiError);
      assert.equal(err.statusCode, 500);
      assert.doesNotMatch(err.message, /body-with-secret-value/);
      return true;
    });
  });
});

test("UAPI failures without error messages and malformed results are errors", async () => {
  const replies = [
    { status: 0, errors: [], messages: null, data: null },
    { status: 0, errors: null, messages: null, data: null },
    { errors: null, data: [] },
    { unexpected: true },
    [],
  ];
  for (const reply of replies) {
    await withClient((req, res) => json(res, 200, reply), async (client) => {
      await assert.rejects(client.uapi("Email", "add_pop"), CpanelApiError, JSON.stringify(reply));
    });
  }
});

test("API 2 failures inside event or data results are errors", async () => {
  const replies = [
    { cpanelresult: { data: [], event: { result: 0, reason: "denied" } } },
    {
      cpanelresult: {
        data: [{ result: { status: 0, statusmsg: "Invalid record" } }],
        event: { result: 1 },
      },
    },
    { cpanelresult: { data: [{ result: 0, reason: "No such line" }], event: { result: 1 } } },
    { unexpected: true },
  ];
  for (const reply of replies) {
    await withClient((req, res) => json(res, 200, reply), async (client) => {
      await assert.rejects(client.api2("ZoneEdit", "add_zone_record"), CpanelApiError, JSON.stringify(reply));
    });
  }
});

test("successful API 2 results return their data", async () => {
  const records = [{ line: 3, type: "A", name: "example.com.", address: "192.0.2.1" }];
  const zoneOk = {
    cpanelresult: {
      data: [{ result: { status: 1, statusmsg: "Bind reloading", newserial: 2026101901 } }],
      event: { result: 1 },
    },
  };
  await withClient((req, res) => json(res, 200, { cpanelresult: { data: records, event: { result: 1 } } }), async (client) => {
    assert.deepEqual(await client.api2("ZoneEdit", "fetchzone_records"), records);
  });
  await withClient((req, res) => json(res, 200, zoneOk), async (client) => {
    assert.deepEqual(await client.api2("ZoneEdit", "add_zone_record"), zoneOk.cpanelresult.data);
  });
});

test("a successful UAPI reply returns its fields", async () => {
  const reply = { ...UAPI_OK, data: [{ dest: "info@example.com", forward: "me@example.net" }] };
  await withClient((req, res) => json(res, 200, reply), async (client) => {
    assert.deepEqual(await client.uapi("Email", "list_forwarders"), reply);
  });
});
