import assert from "node:assert/strict";
import { isDirectEmailCheck, requestedEmailCount } from "./directGmail.js";

assert.equal(isDirectEmailCheck("check 30 emails recent"), true);
assert.equal(isDirectEmailCheck("list latest emails"), true);
assert.equal(isDirectEmailCheck("check past 100 emails and write me here all upcoming events that u think about adding"), false);
assert.equal(isDirectEmailCheck("read emails and analyze important action items"), false);
assert.equal(requestedEmailCount("check past 100 emails"), 100);
assert.equal(requestedEmailCount("check 200 emails"), 5);

console.log("directGmail tests passed");
