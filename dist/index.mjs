// src/main.ts
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// ../gate/dist/gate.js
var WAIT_DEFAULT_S = 1800;
var USAGE = `intentic-gate \u2014 run an intentic release gate and exit on its verdict

usage: intentic-gate [options] [request...]

The request \u2014 what this pipeline knows: commit, branch, preview URL \u2014 is the arguments joined,
or stdin when none are given (so \`git log -1 | intentic-gate\` works).

options:
  --url <url>       the gate's webhook URL, token and all (or env INTENTIC_GATE_URL)
  --wait <seconds>  how long the gate holds the connection (default ${WAIT_DEFAULT_S}; the server caps at 3h)
  --blocked <code>  exit code for a blocked verdict (default 0 \u2014 "could not judge" is not a failed build)
  -h, --help        this text

exit codes:  0 pass (and blocked, unless --blocked says otherwise) \xB7 1 fail \xB7 2 the exchange itself
failed \u2014 wrong token, no such gate, daily ceiling reached, network. 2 is never a verdict: it means
the pipeline's wiring needs a person, not that the product does.`;
var targetOf = (url, waitS) => {
  const target = new URL(url);
  target.searchParams.set("wait", String(waitS));
  return target.toString();
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
var parseInputs = (env) => {
  const url = env["INPUT_URL"] ?? "";
  if (url === "") {
    return { kind: "error", message: "no url: point `with: url` at a door URL from your sandbox, stored as a repository secret" };
  }
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return { kind: "error", message: "the url input is not a URL \u2014 paste the door URL exactly as the sandbox hands it out" };
  }
  const door = doorOf(path);
  if (door === void 0) {
    return {
      kind: "error",
      message: "the url is neither a release gate (\u2026/workflows/<id>/gate) nor an automation webhook (\u2026/automations/<id>/fire)"
    };
  }
  const rawWait = env["INPUT_WAIT"] ?? "";
  const waitS = rawWait === "" ? WAIT_DEFAULT_S : Number(rawWait);
  if (!Number.isInteger(waitS) || waitS <= 0) {
    return { kind: "error", message: `wait needs a whole number of seconds, not "${rawWait}"` };
  }
  const blockedAs = env["INPUT_BLOCKED-AS"] ?? "";
  if (blockedAs !== "" && blockedAs !== "success" && blockedAs !== "failure") {
    return { kind: "error", message: `blocked-as is "success" or "failure", not "${blockedAs}"` };
  }
  return {
    kind: "inputs",
    inputs: { url, door, request: env["INPUT_REQUEST"] ?? "", waitS, blockedAsFailure: blockedAs === "failure" }
  };
};
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
var detailOf = (text2) => {
  try {
    const body2 = JSON.parse(text2);
    return typeof body2.error === "string" ? body2.error : text2;
  } catch {
    return text2;
  }
};
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
if (inputs.door === "fire") {
  const body2 = inputs.request !== "" ? inputs.request : eventText;
  let response2;
  try {
    response2 = await fetch(inputs.url, { method: "POST", body: body2, signal: AbortSignal.timeout(6e4) });
  } catch (error) {
    wiring(`the automation could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response2.ok) {
    wiring(`the automation answered ${response2.status}: ${detailOf(await response2.text())}`);
  }
  console.log("woke the agent \u2014 the automation accepted the payload and the run continues without this workflow");
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
  response = await fetch(targetOf(inputs.url, inputs.waitS), {
    method: "POST",
    body: request,
    signal: AbortSignal.timeout(clientTimeoutMs(inputs.waitS))
  });
} catch (error) {
  wiring(`the gate could not be reached: ${error instanceof Error ? error.message : String(error)}`);
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
