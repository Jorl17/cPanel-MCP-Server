import test from "node:test";
import assert from "node:assert/strict";

import { registerDnsTools } from "../build/tools/dns.js";

// Register the DNS tools against a client that records each call.
function dnsHarness() {
  const handlers = new Map();
  const calls = [];
  const server = {
    tool(name, ...args) {
      handlers.set(name, args.at(-1));
    },
  };
  const client = {
    async api2(...args) {
      calls.push(["api2", ...args]);
      return [{ result: { status: 1, statusmsg: "ok" } }];
    },
    async uapi(...args) {
      calls.push(["uapi", ...args]);
      return { status: 1, data: [] };
    },
  };
  registerDnsTools(server, client);
  return { calls, call: (name, args) => handlers.get(name)(args) };
}

const BASE = { domain: "example.com", name: "_sip._tcp", ttl: "14400", class: "IN" };

test("add_dns_record sends the SRV fields that ZoneEdit requires", async () => {
  const dns = dnsHarness();
  const result = await dns.call("add_dns_record", {
    ...BASE,
    type: "SRV",
    target: "sip.example.com",
    priority: "10",
    weight: "5",
    port: "5060",
  });

  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(dns.calls, [
    [
      "api2",
      "ZoneEdit",
      "add_zone_record",
      {
        ...BASE,
        type: "SRV",
        target: "sip.example.com",
        priority: "10",
        weight: "5",
        port: "5060",
      },
    ],
  ]);
});

test("add_dns_record sends the CAA fields that ZoneEdit requires", async () => {
  const dns = dnsHarness();
  const caa = { ...BASE, name: "example.com.", type: "CAA", flag: "0", tag: "issue", value: "letsencrypt.org" };
  const result = await dns.call("add_dns_record", caa);

  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(dns.calls, [["api2", "ZoneEdit", "add_zone_record", caa]]);
});

test("add_dns_record rejects SRV and CAA records with missing fields before calling cPanel", async () => {
  const dns = dnsHarness();
  const srv = await dns.call("add_dns_record", { ...BASE, type: "SRV", target: "sip.example.com", priority: "10" });
  const caa = await dns.call("add_dns_record", { ...BASE, type: "CAA", tag: "issue", value: "letsencrypt.org" });

  assert.equal(srv.isError, true);
  assert.match(srv.content[0].text, /weight/);
  assert.equal(caa.isError, true);
  assert.match(caa.content[0].text, /flag/);
  assert.equal(dns.calls.length, 0);
});

test("ZoneEdit tools reject MX records, which go through the MX tools", async () => {
  const dns = dnsHarness();
  const add = await dns.call("add_dns_record", { ...BASE, type: "MX", address: "mail.example.com" });
  const edit = await dns.call("edit_dns_record", { ...BASE, line: "7", type: "MX", address: "mail.example.com" });

  assert.equal(add.isError, true);
  assert.equal(edit.isError, true);
  assert.equal(dns.calls.length, 0);
});

test("edit_dns_record sends the same per-type fields as add_dns_record", async () => {
  const dns = dnsHarness();
  const result = await dns.call("edit_dns_record", {
    ...BASE,
    line: "7",
    name: "www",
    type: "CNAME",
    cname: "example.com.",
  });

  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(dns.calls, [
    [
      "api2",
      "ZoneEdit",
      "edit_zone_record",
      { ...BASE, name: "www", type: "CNAME", cname: "example.com.", line: "7" },
    ],
  ]);
});

test("MX tools call the UAPI Email MX functions", async () => {
  const dns = dnsHarness();
  await dns.call("list_mx_records", { domain: "example.com" });
  await dns.call("add_mx_record", { domain: "example.com", exchanger: "mail.example.com", priority: "10" });
  await dns.call("delete_mx_record", { domain: "example.com", exchanger: "mail.example.com", priority: "10" });

  assert.deepEqual(dns.calls, [
    ["uapi", "Email", "list_mxs", { domain: "example.com" }],
    ["uapi", "Email", "add_mx", { domain: "example.com", exchanger: "mail.example.com", priority: "10" }],
    ["uapi", "Email", "delete_mx", { domain: "example.com", exchanger: "mail.example.com", priority: "10" }],
  ]);
});
