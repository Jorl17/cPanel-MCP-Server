import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CpanelClient } from "../cpanel-api.js";
import { handleToolCall, formatData, formatSuccess } from "../tool-helpers.js";
import { CpanelApiError } from "../cpanel-api.js";
import { validateDomain } from "../validation.js";

/* The record types that ZoneEdit::add_zone_record and edit_zone_record
 * accept, with the parameters that each type requires. */
const ZONE_RECORD_FIELDS = {
  A: ["address"],
  AAAA: ["address"],
  CNAME: ["cname"],
  TXT: ["txtdata"],
  SRV: ["target", "priority", "weight", "port"],
  CAA: ["flag", "tag", "value"],
} as const;

type ZoneRecordType = keyof typeof ZONE_RECORD_FIELDS;
type ZoneRecordField = (typeof ZONE_RECORD_FIELDS)[ZoneRecordType][number];

const zoneRecordSchema = {
  domain: z.string().describe("Domain/zone name"),
  name: z.string().describe("Record name (e.g. subdomain or subdomain.domain.com.)"),
  type: z
    .enum(Object.keys(ZONE_RECORD_FIELDS) as [ZoneRecordType, ...ZoneRecordType[]])
    .describe("Record type"),
  ttl: z.string().default("14400").describe("TTL in seconds"),
  class: z.string().default("IN").describe("Record class"),
  address: z.string().optional().describe("IPv4 or IPv6 address (A and AAAA)"),
  cname: z.string().optional().describe("Canonical name (CNAME)"),
  txtdata: z.string().optional().describe("Text data (TXT)"),
  target: z.string().optional().describe("Target host name, which must not be a CNAME (SRV)"),
  priority: z.string().optional().describe("Priority (SRV)"),
  weight: z.string().optional().describe("Weight (SRV)"),
  port: z.string().optional().describe("Port (SRV)"),
  flag: z.enum(["0", "1"]).optional().describe("0 for non-critical or 1 for critical (CAA)"),
  tag: z.enum(["issue", "issuewild", "iodef"]).optional().describe("Property tag (CAA)"),
  value: z.string().optional().describe("Certificate authority domain, or a reporting URL for iodef (CAA)"),
};

type ZoneRecordArgs = {
  domain: string;
  name: string;
  type: string;
  ttl: string;
  class: string;
} & Partial<Record<ZoneRecordField, string>>;

function isZoneRecordType(type: string): type is ZoneRecordType {
  return Object.hasOwn(ZONE_RECORD_FIELDS, type);
}

/* Return the ZoneEdit parameters for a record, with the fields that its
 * type requires. Throw before any API call when the type is not a ZoneEdit
 * type or a required field is missing. */
function zoneRecordParams(args: ZoneRecordArgs): Record<string, string> {
  const { type } = args;
  if (!isZoneRecordType(type)) {
    throw new CpanelApiError(
      `ZoneEdit does not accept ${type} records${type === "MX" ? ". Use add_mx_record." : "."}`
    );
  }

  const params: Record<string, string> = {
    domain: validateDomain(args.domain),
    name: args.name,
    type,
    ttl: args.ttl,
    class: args.class,
  };
  const missing: string[] = [];
  for (const field of ZONE_RECORD_FIELDS[type]) {
    const value = args[field];
    if (value === undefined || value === "") missing.push(field);
    else params[field] = value;
  }
  if (missing.length) {
    throw new CpanelApiError(`${type} records require ${missing.join(", ")}`);
  }
  return params;
}

export function registerDnsTools(server: McpServer, client: CpanelClient) {
  server.tool(
    "get_dns_records",
    "Get all DNS records for a zone/domain",
    { domain: z.string().describe("Domain name to get records for") },
    async ({ domain }) =>
      handleToolCall(async () => {
        const zone = validateDomain(domain);
        const data = await client.api2("ZoneEdit", "fetchzone_records", { domain: zone });
        return formatData(data);
      })
  );

  server.tool(
    "add_dns_record",
    "Add a DNS zone record (A, AAAA, CNAME, TXT, SRV, CAA). Use add_mx_record for MX records.",
    zoneRecordSchema,
    async (args) =>
      handleToolCall(async () => {
        const params = zoneRecordParams(args);
        const data = await client.api2("ZoneEdit", "add_zone_record", params);
        return formatSuccess(`DNS ${args.type} record added: ${args.name}`, data);
      })
  );

  server.tool(
    "edit_dns_record",
    "Edit an existing DNS zone record (A, AAAA, CNAME, TXT, SRV, CAA). Line numbers change when the zone changes, so read the zone with get_dns_records first and check that the line is the intended record.",
    {
      line: z.string().describe("Line number of the record to edit (from get_dns_records)"),
      ...zoneRecordSchema,
    },
    async ({ line, ...args }) =>
      handleToolCall(async () => {
        const params = { ...zoneRecordParams(args), line };
        const data = await client.api2("ZoneEdit", "edit_zone_record", params);
        return formatSuccess(`DNS record updated on line ${line}`, data);
      })
  );

  server.tool(
    "delete_dns_record",
    "Delete a DNS zone record by line number. Line numbers change when the zone changes, so read the zone with get_dns_records first and check that the line is the intended record.",
    {
      domain: z.string().describe("Domain/zone name"),
      line: z.string().describe("Line number of the record to delete (from get_dns_records)"),
    },
    async ({ domain, line }) =>
      handleToolCall(async () => {
        const zone = validateDomain(domain);
        const data = await client.api2("ZoneEdit", "remove_zone_record", {
          domain: zone,
          line,
        });
        return formatSuccess(`DNS record on line ${line} deleted from ${zone}`, data);
      })
  );

  server.tool(
    "list_mx_records",
    "List the MX records of a domain",
    { domain: z.string().describe("Domain name") },
    async ({ domain }) =>
      handleToolCall(async () => {
        const result = await client.uapi("Email", "list_mxs", { domain: validateDomain(domain) });
        return formatData(result.data);
      })
  );

  server.tool(
    "add_mx_record",
    "Add an MX record to a domain",
    {
      domain: z.string().describe("Domain name"),
      exchanger: z.string().describe("Mail server host name, e.g. mail.example.com"),
      priority: z.string().describe("Priority, e.g. 10. A lower value is tried first."),
    },
    async ({ domain, exchanger, priority }) =>
      handleToolCall(async () => {
        const result = await client.uapi("Email", "add_mx", {
          domain: validateDomain(domain),
          exchanger,
          priority,
        });
        return formatSuccess(`MX record added: ${domain} → ${exchanger} (${priority})`, result.data);
      })
  );

  server.tool(
    "delete_mx_record",
    "Delete an MX record from a domain",
    {
      domain: z.string().describe("Domain name"),
      exchanger: z.string().describe("Mail server host name of the record"),
      priority: z.string().describe("Priority of the record"),
    },
    async ({ domain, exchanger, priority }) =>
      handleToolCall(async () => {
        const result = await client.uapi("Email", "delete_mx", {
          domain: validateDomain(domain),
          exchanger,
          priority,
        });
        return formatSuccess(`MX record deleted: ${domain} → ${exchanger} (${priority})`, result.data);
      })
  );
}
