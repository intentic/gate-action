// src/main.ts
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// ../../_tools/base/dist/errors.js
var errorMessage = (error) => error instanceof Error ? error.message : String(error);

// ../gate/dist/run.js
var RUN_WAIT_DEFAULT_S = 1800;
var RUN_POLL_MS = 5e3;
var runRequestBody = (call) => ({
  prompt: call.prompt,
  conversationId: call.conversationId,
  isolated: true,
  ...call.agent === void 0 ? {} : { agent: call.agent }
});
var conversationIdFor = (env, random) => {
  const runId = env["GITHUB_RUN_ID"] ?? "";
  if (runId === "") {
    return `ci-${random().replaceAll(/[^a-zA-Z0-9_-]/g, "").slice(0, 24)}`;
  }
  const attempt = env["GITHUB_RUN_ATTEMPT"] ?? "1";
  return `ci-${runId}-${attempt}`.replaceAll(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
};
var readCard = (body2) => {
  if (typeof body2 !== "object" || body2 === null) {
    return void 0;
  }
  const { status, title, failure, branch, attention } = body2;
  if (typeof status !== "string") {
    return void 0;
  }
  return {
    status,
    ...typeof title === "string" ? { title } : {},
    ...typeof failure === "string" ? { failure } : {},
    ...typeof branch === "string" ? { branch } : {},
    ...typeof attention === "object" && attention !== null ? { attention } : {}
  };
};
var IN_FLIGHT = /* @__PURE__ */ new Set(["running", "stopping", "dismissing", "resuming"]);
var settledOf = (card) => {
  if (IN_FLIGHT.has(card.status)) {
    return void 0;
  }
  if (card.status === "awaiting") {
    return "parked";
  }
  return card.status === "error" || card.status === "interrupted" || card.status === "conflict" ? "failed" : "completed";
};
var PARKED_ON = [
  ["plan", "a plan waiting for approval"],
  ["question", "a question"],
  ["permission", "a permission request"],
  ["capability", "something to be connected"],
  ["credential", "a gated credential"]
];
var summaryOfCard = (card, status) => {
  if (status === "parked") {
    const on = PARKED_ON.find(([key]) => card.attention?.[key] === true)?.[1] ?? "a card only a person can answer";
    return `The agent is parked on ${on}: open the conversation in the sandbox to answer it.`;
  }
  if (status === "failed") {
    return card.failure ?? `The turn ended with status "${card.status}".`;
  }
  return card.title ?? "The agent finished.";
};
var exitOfRun = (status) => status === "completed" ? 0 : status === "timeout" ? 2 : 1;
var RUN_USAGE = `intentic-gate run: start an agent turn in your sandbox and exit on how it ended

usage: intentic-gate run [options] [prompt...]

The prompt is the arguments joined, or stdin when none are given.

options:
  --url <origin>       the sandbox's own address (or env INTENTIC_URL)
  --token <ict_\u2026>      a control token minted on Sandbox \u2192 Access (or env INTENTIC_TOKEN); drive scope, or
                       land scope with --land
  --agent <name>       which agent runs it (claude, codex, \u2026); default: the sandbox's own
  --conversation <id>  the conversation to open or continue; default: one per CI run
  --wait <seconds>     how long to wait for the turn to settle (default ${RUN_WAIT_DEFAULT_S})
  --land               merge the branch into the main tree once the turn completes
  -h, --help           this text

exit codes:  0 completed \xB7 1 parked on a person, or failed \xB7 2 the exchange itself failed, or the turn
was still running at the deadline (it keeps working in the sandbox).`;
var RunExchangeError = class extends Error {
};
var detailOf = (text2) => {
  try {
    const body2 = JSON.parse(text2);
    return typeof body2.error === "string" ? body2.error : text2;
  } catch {
    return text2;
  }
};
var headersFor = (call) => ({ "x-intentic-control": call.token, "content-type": "application/json" });
var answerOf = async (deps, what, url, init) => {
  const response2 = await deps.fetch(url, init).catch((error) => {
    throw new RunExchangeError(`${what} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  });
  const text2 = await response2.text();
  if (!response2.ok) {
    const hint = response2.status === 403 && what === "the land" ? " (the token needs land scope)" : "";
    throw new RunExchangeError(`${what} answered ${response2.status}: ${detailOf(text2)}${hint}`);
  }
  try {
    return JSON.parse(text2);
  } catch {
    throw new RunExchangeError(`${what}'s answer was not JSON: ${text2.slice(0, 200)}`);
  }
};
var runExchange = async (call, deps) => {
  const cardUrl = `${call.origin}/agents/${encodeURIComponent(call.conversationId)}`;
  await answerOf(deps, "the agent", `${call.origin}/agent`, {
    method: "POST",
    headers: headersFor(call),
    body: JSON.stringify(runRequestBody(call))
  });
  const deadline = deps.now() + call.waitS * 1e3;
  let card;
  let status;
  while (status === void 0) {
    await deps.sleep(RUN_POLL_MS);
    card = readCard(await answerOf(deps, "the agent card", cardUrl, { method: "GET", headers: headersFor(call) }));
    if (card === void 0) {
      throw new RunExchangeError("the agent card could not be read");
    }
    status = settledOf(card);
    if (status === void 0 && deps.now() >= deadline) {
      status = "timeout";
    }
  }
  const branch = card?.branch ?? `agent/${call.conversationId}`;
  const outcome = {
    status,
    conversationId: call.conversationId,
    branch,
    summary: status === "timeout" ? `Still running after ${call.waitS}s; it keeps working in the sandbox.` : summaryOfCard(card, status)
  };
  if (!call.land || status !== "completed") {
    return outcome;
  }
  const landed = await answerOf(deps, "the land", `${cardUrl}/land`, { method: "POST", headers: headersFor(call), body: "{}" });
  return { ...outcome, landed: landed.landed === true };
};

// ../gate/dist/gate.js
var WAIT_DEFAULT_S = 1800;
var USAGE = `intentic-gate: run an intentic release gate and exit on its verdict

usage: intentic-gate [options] [request...]

The request, what this pipeline knows: commit, branch, preview URL, is the arguments joined,
or stdin when none are given (so \`git log -1 | intentic-gate\` works).

options:
  --url <url>       the gate's webhook URL, token and all (or env INTENTIC_GATE_URL)
  --wait <seconds>  how long the gate holds the connection (default ${WAIT_DEFAULT_S}; the server caps at 3h)
  --blocked <code>  exit code for a blocked verdict (default 0: "could not judge" is not a failed build)
  -h, --help        this text

exit codes:  0 pass (and blocked, unless --blocked says otherwise) \xB7 1 fail \xB7 2 the exchange itself
failed, wrong token, no such gate, daily ceiling reached, network. 2 is never a verdict: it means
the pipeline's wiring needs a person, not that the product does.`;
var dialOf = (url, waitS) => {
  const target = new URL(url);
  const token = target.searchParams.get("token");
  target.searchParams.delete("token");
  if (waitS !== void 0) {
    target.searchParams.set("wait", String(waitS));
  }
  return { url: target.toString(), headers: token === null || token === "" ? {} : { authorization: `Bearer ${token}` } };
};
var clientTimeoutMs = (waitS) => (waitS + 60) * 1e3;
var OUTCOMES = /* @__PURE__ */ new Set(["pass", "fail", "blocked"]);
var readVerdict = (body2) => {
  if (typeof body2 !== "object" || body2 === null) {
    return void 0;
  }
  const { outcome, reason, runId, value } = body2;
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome) || typeof reason !== "string" || typeof runId !== "string") {
    return void 0;
  }
  return {
    outcome,
    reason,
    runId,
    ...typeof value === "string" ? { value } : {}
  };
};
var exitOf = (verdict2, blockedExit) => {
  if (verdict2.outcome === "pass") {
    return 0;
  }
  return verdict2.outcome === "fail" ? 1 : blockedExit;
};

// src/action.ts
var doorOf = (path) => {
  const segments = path.split("/").filter((segment) => segment !== "");
  const [route, , tail] = segments.slice(-3);
  if (route === "workflows" && tail === "gate") {
    return "gate";
  }
  return route === "automations" && tail === "fire" ? "fire" : void 0;
};
var roadOf = (url, token) => {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return { error: "the url input is not a URL, paste the door URL exactly as the sandbox hands it out" };
  }
  const door = doorOf(path);
  if (token === "") {
    return door === void 0 ? { error: "the url is neither a release gate (\u2026/workflows/<id>/gate) nor an automation webhook (\u2026/automations/<id>/fire); to drive the agent directly, add `with: token`" } : { door };
  }
  return door === void 0 ? { door: "run", token } : { error: "a door URL carries its own token: use `with: url` alone for a gate or a webhook, or point `url` at the sandbox's own address to drive the agent with `token`" };
};
var landOf = (raw) => raw === "" || raw === "false" ? false : raw === "true" ? true : { error: `land is "true" or "false", not "${raw}"` };
var settingsOf = (env, door) => {
  const request2 = door === "run" ? env["INPUT_PROMPT"] ?? "" : env["INPUT_REQUEST"] ?? "";
  if (door === "run" && request2 === "") {
    return { error: "nothing to tell the agent: set `with: prompt` for a run" };
  }
  const land = landOf(env["INPUT_LAND"] ?? "");
  if (typeof land !== "boolean") {
    return land;
  }
  const agent = env["INPUT_AGENT"] ?? "";
  return { request: request2, ...agent === "" ? {} : { agent }, land };
};
var parseInputs = (env) => {
  const url = env["INPUT_URL"] ?? "";
  if (url === "") {
    return { kind: "error", message: "no url: point `with: url` at a door URL from your sandbox (stored as a repository secret), or at the sandbox's address with `token`" };
  }
  const road = roadOf(url, env["INPUT_TOKEN"] ?? "");
  if ("error" in road) {
    return { kind: "error", message: road.error };
  }
  const waitS = waitOf(env["INPUT_WAIT"] ?? "");
  if (typeof waitS !== "number") {
    return { kind: "error", message: waitS.error };
  }
  const blockedAsFailure = blockedOf(env["INPUT_BLOCKED-AS"] ?? "");
  if (typeof blockedAsFailure !== "boolean") {
    return { kind: "error", message: blockedAsFailure.error };
  }
  const settings = settingsOf(env, road.door);
  if ("error" in settings) {
    return { kind: "error", message: settings.error };
  }
  return { kind: "inputs", inputs: { url, ...road, waitS, blockedAsFailure, ...settings } };
};
var waitOf = (raw) => {
  const waitS = raw === "" ? WAIT_DEFAULT_S : Number(raw);
  return Number.isInteger(waitS) && waitS > 0 ? waitS : { error: `wait needs a whole number of seconds, not "${raw}"` };
};
var blockedOf = (raw) => raw === "" || raw === "success" ? false : raw === "failure" ? true : { error: `blocked-as is "success" or "failure", not "${raw}"` };
var defaultRequest = (env, event2) => {
  const sha = env["GITHUB_SHA"] ?? "";
  if (sha === "") {
    return "";
  }
  const parts = [`commit ${sha}`];
  const branch = env["GITHUB_REF_NAME"] ?? "";
  if (branch !== "") {
    parts.push(`on ${branch}`);
  }
  const pullRequest = event2?.pull_request?.html_url;
  const repository = env["GITHUB_REPOSITORY"] ?? "";
  const server = env["GITHUB_SERVER_URL"] ?? "";
  if (typeof pullRequest === "string") {
    parts.push(`\u2014 ${pullRequest}`);
  } else if (repository !== "" && server !== "") {
    parts.push(`\u2014 ${server}/${repository}/commit/${sha}`);
  }
  return parts.join(" ");
};
var outputLines = (verdict2, delimiter) => {
  const entries = [
    ["outcome", verdict2.outcome],
    ["reason", verdict2.reason],
    ["run-id", verdict2.runId],
    ...verdict2.value === void 0 ? [] : [["value", verdict2.value]]
  ];
  return entries.map(([key, value]) => `${key}<<${delimiter}
${value}
${delimiter}
`).join("");
};
var summaryOf = (verdict2) => `### Intentic gate: ${verdict2.outcome}

${verdict2.reason}

Run \`${verdict2.runId}\` holds the full transcript in the sandbox.
`;
var escapeData = (value) => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
var annotationOf = (verdict2, blockedAsFailure) => {
  if (verdict2.outcome === "pass") {
    return void 0;
  }
  const severity = verdict2.outcome === "fail" || blockedAsFailure ? "error" : "warning";
  return `::${severity}::${escapeData(`${verdict2.outcome}: ${verdict2.reason}`)}`;
};
var stepExitOf = (verdict2, blockedAsFailure) => exitOf(verdict2, blockedAsFailure ? 1 : 0);
var runOutputLines = (outcome, delimiter) => {
  const entries = [
    ["status", outcome.status],
    ["conversation-id", outcome.conversationId],
    ...outcome.branch === void 0 ? [] : [["branch", outcome.branch]],
    ["summary", outcome.summary],
    ...outcome.landed === void 0 ? [] : [["landed", String(outcome.landed)]]
  ];
  return entries.map(([key, value]) => `${key}<<${delimiter}
${value}
${delimiter}
`).join("");
};
var runSummaryOf = (outcome) => `### Intentic agent: ${outcome.status}

${outcome.summary}

Conversation \`${outcome.conversationId}\`${outcome.branch === void 0 ? "" : ` on branch \`${outcome.branch}\``}${outcome.landed === void 0 ? "" : outcome.landed ? ", landed into the main tree." : ", not landed."}
`;
var runAnnotationOf = (outcome) => {
  if (outcome.status === "completed") {
    return void 0;
  }
  const severity = outcome.status === "parked" ? "warning" : "error";
  return `::${severity}::${escapeData(`${outcome.status}: ${outcome.summary}`)}`;
};
var runStepExitOf = (outcome) => exitOfRun(outcome.status);

// src/main.ts
var appendTo = (file, content) => {
  if (file !== void 0 && file !== "") {
    appendFileSync(file, content);
  }
};
function wiring(message) {
  console.error(`::error::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
  process.exit(2);
}
var parsed = parseInputs(process.env);
if (parsed.kind === "error") {
  wiring(parsed.message);
}
var { inputs } = parsed;
var eventText = (() => {
  const path = process.env["GITHUB_EVENT_PATH"];
  if (path === void 0 || path === "") {
    return "";
  }
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
})();
if (inputs.door === "run") {
  const call = {
    origin: new URL(inputs.url).origin,
    token: inputs.token ?? "",
    prompt: inputs.request,
    conversationId: conversationIdFor(process.env, randomUUID),
    ...inputs.agent === void 0 ? {} : { agent: inputs.agent },
    waitS: inputs.waitS,
    land: inputs.land
  };
  let outcome;
  try {
    outcome = await runExchange(call, { fetch, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: Date.now });
  } catch (error) {
    wiring(error instanceof RunExchangeError ? error.message : `the agent could not be run: ${errorMessage(error)}`);
  }
  appendTo(process.env["GITHUB_OUTPUT"], runOutputLines(outcome, randomUUID()));
  appendTo(process.env["GITHUB_STEP_SUMMARY"], runSummaryOf(outcome));
  console.log(`${outcome.status}: ${outcome.summary}`);
  console.log(`conversation ${outcome.conversationId}${outcome.branch === void 0 ? "" : ` on ${outcome.branch}`}`);
  const runAnnotation = runAnnotationOf(outcome);
  if (runAnnotation !== void 0) {
    console.log(runAnnotation);
  }
  process.exit(runStepExitOf(outcome));
}
if (inputs.door === "fire") {
  const body2 = inputs.request !== "" ? inputs.request : eventText;
  let response2;
  try {
    const dial = dialOf(inputs.url);
    response2 = await fetch(dial.url, { method: "POST", headers: dial.headers, body: body2, signal: AbortSignal.timeout(6e4) });
  } catch (error) {
    wiring(`the automation could not be reached: ${errorMessage(error)}`);
  }
  if (!response2.ok) {
    wiring(`the automation answered ${response2.status}: ${detailOf(await response2.text())}`);
  }
  console.log("woke the agent: the automation accepted the payload and the run continues without this workflow");
  process.exit(0);
}
var event = (() => {
  try {
    return eventText === "" ? void 0 : JSON.parse(eventText);
  } catch {
    return void 0;
  }
})();
var request = inputs.request !== "" ? inputs.request : defaultRequest(process.env, event);
if (request === "") {
  wiring("nothing to tell the agent: set `with: request` (no workflow context to compose one from)");
}
var response;
try {
  const dial = dialOf(inputs.url, inputs.waitS);
  response = await fetch(dial.url, {
    method: "POST",
    headers: dial.headers,
    body: request,
    signal: AbortSignal.timeout(clientTimeoutMs(inputs.waitS))
  });
} catch (error) {
  wiring(`the gate could not be reached: ${errorMessage(error)}`);
}
var text = await response.text();
if (!response.ok) {
  wiring(`the gate answered ${response.status}: ${detailOf(text)}`);
}
var body;
try {
  body = JSON.parse(text);
} catch {
  body = void 0;
}
var verdict = readVerdict(body);
if (verdict === void 0) {
  wiring(`the gate's answer was not a verdict: ${text.slice(0, 200)}`);
}
appendTo(process.env["GITHUB_OUTPUT"], outputLines(verdict, randomUUID()));
appendTo(process.env["GITHUB_STEP_SUMMARY"], summaryOf(verdict));
console.log(`${verdict.outcome}: ${verdict.reason}`);
console.log(`run ${verdict.runId}`);
var annotation = annotationOf(verdict, inputs.blockedAsFailure);
if (annotation !== void 0) {
  console.log(annotation);
}
process.exit(stepExitOf(verdict, inputs.blockedAsFailure));
