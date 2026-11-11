import assert from "node:assert/strict";
import test from "node:test";
import { OPENVIKING_GUIDANCE, SECTION_NAME, SECTION_ORDER } from "./guidance.mjs";
import { ANNOUNCED_TOOLS, isAnnounced, withoutWithdrawn } from "./tool-surface.mjs";

test("the announced set is the eleven tools that were actually called", () => {
  // Measured over 400 of 656 local sessions on 2026-11-11: 130 calls, all of
  // them to these eleven. The other sixteen were called zero times and are
  // named in the guidance instead of being announced.
  assert.deepEqual([...ANNOUNCED_TOOLS].sort(), [
    "edit", "find", "forget", "glob", "grep", "health",
    "list", "read", "remember", "search", "write",
  ]);
  for (const raw of ["add_resource", "add_skill", "set_acl", "get_acl", "tree", "download", "privacy_tree", "privacy_resolve", "privacy_upsert", "list_users", "list_groups", "list_watches", "cancel_watch", "rule_search", "find_mcp_tools", "invoke_mcp_tool"]) {
    assert.equal(isAnnounced(raw), false, `${raw} is withdrawn`);
  }
});

test("withoutWithdrawn removes only this server's withdrawn tools", () => {
  const foreign = { name: "mcp__stitch__list_projects", description: "", parameters: {} };
  const kept = { name: "mcp__openviking__read", description: "", parameters: {} };
  const withdrawn = { name: "mcp__openviking__set_acl", description: "", parameters: {} };
  const untouched = [foreign, kept];

  // Nothing withdrawn: the same array comes back, so the assembly is not copied
  // on every step of every session.
  assert.equal(withoutWithdrawn(untouched), untouched);
  assert.deepEqual(withoutWithdrawn([...untouched, withdrawn]), untouched);
  // A non-array passes through: the hook runs on assemblies that may not carry
  // tools at all.
  assert.equal(withoutWithdrawn(undefined), undefined);
});

test("the guidance names every withdrawn tool and its arguments", () => {
  for (const raw of ["add_resource", "add_skill", "tree", "download", "set_acl", "get_acl", "list_users", "list_groups", "privacy_tree", "privacy_resolve", "privacy_upsert", "rule_search", "find_mcp_tools", "invoke_mcp_tool", "list_watches", "cancel_watch"]) {
    assert.match(OPENVIKING_GUIDANCE, new RegExp(`mcp__openviking__${raw}\\b`), `${raw} must be named`);
  }
  // The eleven that keep their schema are listed too, so a model reading only
  // the section still knows which half it should consult the schema for.
  for (const raw of ["read", "write", "search", "remember"]) {
    assert.match(OPENVIKING_GUIDANCE, new RegExp(`\`${raw}\``), `${raw} must be listed`);
  }
  assert.equal(SECTION_NAME, "plugin:dsh-openviking");
  assert.equal(typeof SECTION_ORDER, "number");
});