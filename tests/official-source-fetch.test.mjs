import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchResource, fetchOfficialRotationPages, fetchOfficialRotationData,
  parseOfficialAnnouncements, parsePrimeResurgencePages
} from "../scripts/lib/prime-resurgence-sync.mjs";

const url = "https://www.warframe.com/source?token=not-for-logs";
const brokenConnection = () => new TypeError("secret upstream detail", { cause: Object.assign(new Error("interrupted"), { code: "ECONNRESET" }) });
const response = (status = 200, headers = {}, body = "official") => new Response(body, { status, headers });

function harness(overrides = {}) {
  let time = 0;
  const timers = new Set();
  const events = [];
  const waits = [];
  const advance = ms => {
    time += ms;
    for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
      if (timers.has(timer) && timer.at <= time) { timers.delete(timer); timer.fn(); }
    }
  };
  const options = {
    finalHosts: ["www.warframe.com"], maximumBytes: 100, random: () => 0,
    now: () => time, wallNow: () => Date.parse("2026-09-26T00:00:00Z") + time,
    logger: event => events.push(event),
    setTimer(fn, ms) { const timer = { fn, at: time + ms }; timers.add(timer); return timer; },
    clearTimer(timer) { timers.delete(timer); },
    async sleep(ms, { signal }) { signal.throwIfAborted(); waits.push(ms); advance(ms); },
    ...overrides
  };
  return { options, timers, events, waits, advance };
}

async function sequence(sequence, h = harness()) {
  let calls = 0;
  const value = await fetchResource(async (_url, options) => {
    assert.equal(options.method, "GET");
    const entry = sequence[calls++];
    if (entry instanceof Error) throw entry;
    return entry;
  }, url, h.options);
  assert.equal(h.timers.size, 0);
  return { value, calls, ...h };
}

test("503 then success uses bounded backoff and safe source/attempt/type logs", async () => {
  let cancelled = false;
  const failed = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
  const h = harness({ random: () => 0.5 });
  h.options.sleep = async ms => { assert.ok(cancelled); h.waits.push(ms); h.advance(ms); };
  const result = await sequence([failed, response()], h);
  assert.equal(result.value, "official");
  assert.equal(result.calls, 2);
  assert.deepEqual(result.waits, [550]);
  assert.deepEqual(result.events.map(e => [e.source, e.attempt, e.kind, e.action]), [
    ["https://www.warframe.com", 1, "http-503", "retry"],
    ["https://www.warframe.com", 2, "success", "complete"]
  ]);
  assert.equal(JSON.stringify(result.events).includes("token"), false);
});

test("429 honors Retry-After delay-seconds and HTTP date", async () => {
  for (const value of ["2", "Sat, 26 Sep 2026 00:00:02 GMT", "Saturday, 26-Sep-26 00:00:02 GMT", "Sat Sep 26 00:00:02 2026"]) {
    const result = await sequence([response(429, { "Retry-After": value }), response()]);
    assert.deepEqual(result.waits, [2000]);
  }
});

test("Retry-After past date and malformed values use exponential delay", async () => {
  for (const value of ["Fri, 25 Sep 2026 00:00:00 GMT", "nonsense", "-1", "0.5"]) {
    const result = await sequence([response(429, { "Retry-After": value }), response()]);
    assert.deepEqual(result.waits, [500]);
  }
});

test("Retry-After beyond total budget stops without waiting or an early retry", async () => {
  const h = harness({ totalTimeoutMs: 1000 });
  let calls = 0;
  await assert.rejects(fetchResource(async () => { calls++; return response(429, { "Retry-After": "2" }); }, url, h.options), /required retry wait exceeds.*attempts: 1\/3.*retry-budget/);
  assert.equal(calls, 1);
  assert.deepEqual(h.waits, []);
  assert.equal(h.timers.size, 0);
});

test("explicit interrupted connection succeeds on a later attempt", async () => {
  const result = await sequence([brokenConnection(), response()]);
  assert.equal(result.calls, 2);
  assert.equal(result.events[0].kind, "network-ECONNRESET");
});

test("response reader is cancelled and unlocked before retrying interrupted body", async () => {
  let cancelled = false;
  let released = false;
  const failed = { ok: true, headers: new Headers(), body: { getReader: () => ({
    read: async () => { throw brokenConnection(); },
    cancel: async () => { cancelled = true; },
    releaseLock: () => { released = true; }
  }) } };
  const h = harness();
  h.options.sleep = async ms => { assert.ok(cancelled && released); h.advance(ms); };
  assert.equal((await sequence([failed, response()], h)).calls, 2);
});

test("three attempts maximum with capped exponential jitter", async () => {
  const h = harness({ random: () => 1, maxDelayMs: 800 });
  let calls = 0;
  await assert.rejects(fetchResource(async () => { calls++; throw brokenConnection(); }, url, h.options), /attempts: 3\/3.*network-ECONNRESET/);
  assert.equal(calls, 3);
  assert.deepEqual(h.waits, [600, 800]);
  assert.equal(h.timers.size, 0);
});

test("all selected recoverable HTTP statuses retry", async () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal((await sequence([response(status), response()])).calls, 2);
  }
});

test("request timeout can retry within total budget, without real timers", async () => {
  const h = harness({ requestTimeoutMs: 20, totalTimeoutMs: 1000, baseDelayMs: 10 });
  let calls = 0;
  assert.equal(await fetchResource(async () => {
    if (++calls === 1) { queueMicrotask(() => h.advance(20)); return new Promise(() => {}); }
    return response();
  }, url, h.options), "official");
  assert.equal(calls, 2);
  assert.equal(h.events[0].kind, "request-timeout");
  assert.equal(h.timers.size, 0);
});

test("whole-resource budget bounds even an abort-ignoring fetch", async () => {
  const h = harness({ requestTimeoutMs: 100, totalTimeoutMs: 40 });
  let calls = 0;
  await assert.rejects(fetchResource(() => {
    calls++; queueMicrotask(() => h.advance(40)); return new Promise(() => {});
  }, url, h.options), /total fetch budget exhausted.*attempts: 1\/3/);
  assert.equal(calls, 1);
  assert.equal(h.timers.size, 0);
});

test("budget consumed by backoff never starts another request", async () => {
  const h = harness({ totalTimeoutMs: 1000 });
  h.options.sleep = async () => { h.advance(1000); };
  let calls = 0;
  await assert.rejects(fetchResource(async () => { calls++; return response(503); }, url, h.options), /total-budget/);
  assert.equal(calls, 1);
  assert.equal(h.timers.size, 0);
});

test("caller cancellation before fetch, during fetch, body and backoff stops immediately", async () => {
  for (const stage of ["before", "fetch", "body", "backoff"]) {
    const caller = new AbortController();
    const h = harness({ signal: caller.signal });
    let calls = 0;
    let cancelled = false;
    let released = false;
    if (stage === "before") caller.abort(new Error("secret reason"));
    if (stage === "backoff") h.options.sleep = async () => { caller.abort(); return new Promise(() => {}); };
    await assert.rejects(fetchResource(async () => {
      calls++;
      if (stage === "fetch") { caller.abort(); return new Promise(() => {}); }
      if (stage === "body") return { ok: true, body: { getReader: () => ({
        read() { caller.abort(); return new Promise(() => {}); },
        cancel() { cancelled = true; }, releaseLock() { released = true; }
      }) } };
      return response(503);
    }, url, h.options), /caller-cancelled/);
    assert.equal(calls, stage === "before" ? 0 : 1);
    assert.equal(h.events.at(-1).attempt, calls);
    if (stage === "body") assert.ok(cancelled && released);
    assert.equal(h.timers.size, 0);
  }
});

test("cancellation reaches official acquisition helpers and prevents subsequent GETs", async () => {
  const caller = new AbortController();
  let calls = 0;
  await assert.rejects(fetchOfficialRotationPages({ signal: caller.signal, fetchImpl: async () => {
    calls++; caller.abort(); return response();
  } }), /caller-cancelled/);
  assert.equal(calls, 1);
});

test("403 and other permanent HTTP faults never retry; bodies are released", async () => {
  for (const status of [400, 401, 403, 404, 408, 422, 501]) {
    const h = harness();
    let calls = 0;
    let cancelled = false;
    await assert.rejects(fetchResource(async () => {
      calls++; return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status });
    }, url, h.options), new RegExp(`HTTP ${status}.*attempts: 1/3`));
    assert.equal(calls, 1);
    assert.ok(cancelled);
    assert.equal(h.timers.size, 0);
  }
});

test("generic transport errors and certificate errors are not assumed transient", async () => {
  for (const error of [new TypeError("fetch failed"), Object.assign(new Error("certificate"), { code: "CERT_HAS_EXPIRED" })]) {
    const h = harness();
    let calls = 0;
    await assert.rejects(fetchResource(async () => { calls++; throw error; }, url, h.options), /non-recoverable-transport/);
    assert.equal(calls, 1);
    assert.equal(h.timers.size, 0);
  }
});

test("unapproved host, non-HTTPS, excessive body and empty body never retry", async () => {
  for (const kind of ["host", "https", "declared-size", "stream-size", "empty"]) {
    const h = harness();
    let calls = 0;
    const result = response(kind === "host" ? 503 : 200,
      kind === "declared-size" ? { "Content-Length": "101" } : {},
      kind === "empty" ? "" : kind === "stream-size" ? "x".repeat(101) : "ok");
    if (kind === "host" || kind === "https") Object.defineProperty(result, "url", { value: kind === "host" ? "https://evil.example/" : "http://www.warframe.com/" });
    await assert.rejects(fetchResource(async () => { calls++; return result; }, url, h.options), /unapproved-host|unsafe-size/);
    assert.equal(calls, 1);
    assert.equal(h.timers.size, 0);
    assert.equal(result.body.locked, false);
  }
});

test("input URL is restricted before making a GET", async () => {
  let calls = 0;
  for (const address of ["http://www.warframe.com/", "https://evil.example/", "https://user:secret@www.warframe.com/"]) {
    await assert.rejects(fetchResource(async () => { calls++; }, address, harness().options), /HTTPS and an approved host/);
  }
  assert.equal(calls, 0);
});

test("JSON, HTML and official identity validation stay outside transport retry", async () => {
  for (const [body, parse] of [
    ["{bad json", JSON.parse],
    ["<html>wrong</html>", text => parsePrimeResurgencePages(text, text)],
    [JSON.stringify({ feed: [{ post: { author: { handle: "impostor.example" }, record: { text: "Banshee Prime and Mirage Prime return with the next Prime Resurgence rotation on September 26!" } } }] }), text => parseOfficialAnnouncements(JSON.parse(text))]
  ]) {
    const h = harness();
    let calls = 0;
    await assert.rejects(async () => parse(await fetchResource(async () => { calls++; return response(200, {}, body); }, url, { ...h.options, maximumBytes: 10_000 })));
    assert.equal(calls, 1);
    assert.deepEqual(h.waits, []);
  }
});

test("malformed Public Export JSON/schema never restarts acquisition pipeline", async () => {
  for (const payload of ["{broken", '{"ExportRecipes":[]}']) {
    const calls = new Map();
    await assert.rejects(fetchOfficialRotationData({
      decompress: async () => ["Recipes_en", "RelicArcane_en", "Warframes_en", "Weapons_en", "Sentinels_en", "Warframes_zh", "Weapons_zh", "Sentinels_zh"].map(name => `Export${name}.json!fixture`).join("\n"),
      fetchImpl: async address => {
        calls.set(address, (calls.get(address) || 0) + 1);
        return response(200, {}, address.includes("ExportRecipes_en") ? payload : address.includes("Manifest") ? JSON.stringify({ [`Export${/Export(\w+)_/.exec(address)[1]}`]: [{}] }) : "fixture");
      }
    }), /JSON|Malformed Public Export/);
    assert.ok([...calls.values()].every(count => count === 1));
  }
});


test("cleanup cannot hide a terminal size/host validation error or start a retry", async () => {
  for (const kind of ["size", "host"]) {
    const h = harness({ totalTimeoutMs: 1000 });
    let calls = 0;
    let released = false;
    const cancel = () => { queueMicrotask(() => h.advance(1000)); return new Promise(() => {}); };
    const mock = kind === "host"
      ? { url: "https://evil.example/", body: { cancel } }
      : { ok: true, body: { getReader: () => ({ read: async () => ({ value: new Uint8Array(101), done: false }), cancel, releaseLock: () => { released = true; } }) } };
    await assert.rejects(fetchResource(async () => { calls++; return mock; }, url, h.options), kind === "host" ? /unapproved-host/ : /unsafe-size/);
    assert.equal(calls, 1);
    assert.equal(h.timers.size, 0);
    if (kind === "size") assert.ok(released);
  }
});
