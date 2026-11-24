#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Replay the real channel delivery callback with an in-memory OneBot transport.
// AST extraction keeps this check independent of OpenClaw SDK versions and auth.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src/channel.ts"), "utf8");
const parsed = ts.createSourceFile("channel.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "isInternalNoticeLine", "stripInternalNoticeText", "escapeRegExpText",
  "shortenVisibleModelRefs", "normalizeQQVisibleText",
]);
const functions = [];
let deliver;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) {
    functions.push(node.getText(parsed));
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === "deliver") {
    assert.equal(deliver, undefined, "expected one channel delivery callback");
    deliver = node.initializer.getText(parsed);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.equal(functions.length, names.size, "all production text helpers must exist");
assert.ok(deliver, "production delivery callback must exist");
const production = ts.transpileModule(
  `${functions.join("\n")}\nconst deliver = ${deliver};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;

function createReplay() {
  return vm.runInNewContext(`
    const sent = [], buffered = [], media = [];
    let dispatcherError = null, deliveredAnything = false, sawReplyContent = false;
    let bufferedFinalTotalChars = 0;
    const currentRunState = { isStale: () => false };
    const config = { debugLayerTrace: false, rateLimitMs: 0 };
    const resolveReplyPayloadPhase = (payload) => payload.phase;
    const flushBufferedFinalTexts = async () => false;
    const flushBufferedUnknownTexts = async () => false;
    const bufferUnknownBlockText = async (text) => buffered.push(text);
    const canUseMergedForward = false, bufferedFinalTexts = [];
    const pendingReplySessionSourcePrefix = "";
    const sendProcessedText = async (text) => { sent.push(text); return true; };
    const prepareOutgoingText = async (text) => normalizeQQVisibleText(text);
    const collectOutboundMediaItemsFromPayload = (payload) =>
      payload.mediaUrl ? [{ url: payload.mediaUrl, kind: "image" }] : [];
    const sendQQMediaMessage = async (params) => { media.push(params.mediaUrl); return { messageId: "replay" }; };
    const account = { accountId: "replay" }, client = {}, deliveryTo = "private:1";
    const rememberBotConversationReply = () => {};
    const extractOutboundMessageId = () => "replay";
    const maybeDispatchAutoReactAfterReply = () => {};
    const sleep = async () => {};
    ${production}
    ({ deliver, state: () => ({
      sent: [...sent], buffered: [...buffered], media: [...media],
      deliveredAnything, sawReplyContent, error: dispatcherError?.message,
    }) });
  `, { console });
}

const notice = "Thinking level clamped to xhigh for sub2api/deepseek-v4.1-flash (requested max; preference retained).";
let checks = 0;
for (const [kind, text] of [
  ["final", notice], ["block", notice], ["final", notice.slice(0, -1)],
  ["final", `  ${notice}  `],
]) {
  const replay = createReplay();
  await replay.deliver({ text }, { kind });
  assert.equal(replay.state().sent.length + replay.state().buffered.length, 0,
    `thinking clamp leaked through ${kind} delivery`);
  assert.equal(replay.state().sawReplyContent, false, "notice consumed the assistant reply slot");
  assert.equal(replay.state().deliveredAnything, false, "notice counted as a delivered answer");
  checks += 1;
}
const replay = createReplay();
await replay.deliver({ text: notice }, { kind: "final" });
await replay.deliver({ text: "正常回复" }, { kind: "final" });
assert.equal(replay.state().sent.join("\n"), "正常回复");
checks += 1;

const mixed = createReplay();
await mixed.deliver({ text: `第一段\r\n${notice}\r\n第二段` }, { kind: "final" });
assert.equal(mixed.state().sent.join("\n"), "第一段\n第二段");
checks += 1;

const quoted = createReplay();
await quoted.deliver({ text: `用户引用了“${notice}”` }, { kind: "final" });
assert.equal(quoted.state().sent.join("\n"), `用户引用了“${notice}”`);
checks += 1;

const failure = createReplay();
await failure.deliver({ text: "请求失败 HTTP 401", isError: true }, { kind: "final" });
assert.equal(failure.state().error, "请求失败 HTTP 401", "API errors must still reach the retry/error path");
checks += 1;

const attachment = createReplay();
await attachment.deliver({ text: notice, mediaUrl: "https://example.invalid/replay.png" }, { kind: "final" });
assert.equal(attachment.state().sent.length, 0, "attachment caption leaked the notice");
assert.equal(attachment.state().media.join("\n"), "https://example.invalid/replay.png", "notice filtering dropped media");
checks += 1;
console.log(`PASS ${checks} real QQ delivery replays: clamp hidden, replies/errors/media retained`);
