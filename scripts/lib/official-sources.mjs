// Official resource acquisition: bounded GETs, manifests and decompression.
// Domain parsing, candidate construction and persistence stay in the sync module.
import { spawn } from "node:child_process";
import { setTimeout as timerSleep } from "node:timers/promises";
import { WORLD_STATE_URL } from "./prime-vault-inventory.mjs";

export const OFFICIAL_SOURCES = Object.freeze({
  worldState: WORLD_STATE_URL,
  rotationEn: "https://www.warframe.com/en/prime-resurgence",
  rotationZh: "https://www.warframe.com/zh-hans/prime-resurgence",
  announcementFeed: "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=warframe.com&limit=100&filter=posts_no_replies",
  dropTables: "https://www.warframe.com/droptables",
  publicExportIndex: "https://content.warframe.com/PublicExport/index_en.txt.lzma"
});

export class PrimeResurgenceSyncError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrimeResurgenceSyncError";
  }
}

export function invariant(condition, message) {
  if (!condition) throw new PrimeResurgenceSyncError(message);
}

export function parsePublicExportIndex(text) {
  const matches = String(text || "").split(/\r?\n/).filter((line) => /^ExportRecipes_en\.json![A-Za-z0-9_+-]+$/.test(line));
  invariant(matches.length === 1, `Expected one ExportRecipes_en.json manifest entry; found ${matches.length}.`);
  return `https://content.warframe.com/PublicExport/Manifest/${matches[0]}`;
}

export async function decompressLzma(buffer, { timeoutMs = 10_000, maximumBytes = 2_000_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn("xz", ["--format=lzma", "--decompress", "--stdout"], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let terminalError = null;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      terminalError = new PrimeResurgenceSyncError(`Public Export index decompression exceeded ${timeoutMs}ms.`);
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        terminalError = new PrimeResurgenceSyncError(`Public Export index decompressed size exceeds ${maximumBytes} bytes.`);
        child.kill("SIGKILL");
      }
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => finish(reject, new PrimeResurgenceSyncError(`Unable to run xz: ${error.message}`)));
    child.on("close", (code) => {
      if (terminalError) finish(reject, terminalError);
      else if (code !== 0) finish(reject, new PrimeResurgenceSyncError(`Public Export index decompression failed: ${Buffer.concat(stderr).toString("utf8").trim() || `xz exit ${code}`}`));
      else finish(resolve, Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.on("error", (error) => {
      if (!terminalError) terminalError = new PrimeResurgenceSyncError(`Unable to stream Public Export index to xz: ${error.message}`);
    });
    child.stdin.end(buffer);
  });
}

const RETRY_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENETRESET",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"
]);

class OfficialFetchError extends PrimeResurgenceSyncError {
  constructor(message, kind, { retryable = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.kind = kind;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function fetchFailure(error) {
  if (error instanceof OfficialFetchError) return error;
  // A generic TypeError/AbortError is not enough evidence of a recoverable fault.
  for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth += 1) {
    if (RETRY_NETWORK_CODES.has(cause.code)) {
      return new OfficialFetchError("Official source connection interrupted.", `network-${cause.code}`, { retryable: true });
    }
  }
  return new OfficialFetchError("Official source request failed.", "non-recoverable-transport");
}

function waitForSignal(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function retryAfterMilliseconds(value, wallNow) {
  if (!value) return 0;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1_000;
  // RFC 9110 sections 5.6.7 / 10.2.3 require all three HTTP-date forms.
  const current = wallNow();
  let date = text;
  if (/^[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT$/.test(text)) {
    const currentYear = new Date(current).getUTCFullYear();
    const shortYear = Number(/-(\d{2}) /.exec(text)[1]);
    let year = Math.floor(currentYear / 100) * 100 + shortYear;
    if (year > currentYear + 50) year -= 100;
    date = text.replace(/-\d{2} /, `-${year} `);
  } else if (/^[A-Za-z]{3} [A-Za-z]{3} (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4}$/.test(text)) {
    date += " GMT";
  } else if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return 0;
  const timestamp = Date.parse(date);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - current) : 0;
}

/** One idempotent GET resource; parsing and evidence validation stay outside retries. */
export async function fetchResource(fetchImpl, url, {
  binary = false, finalHosts, maximumBytes, signal,
  maxAttempts = 3, requestTimeoutMs = 30_000, totalTimeoutMs = 75_000,
  baseDelayMs = 500, maxDelayMs = 4_000,
  sleep = (ms, options) => timerSleep(ms, undefined, options),
  random = Math.random, now = () => performance.now(), wallNow = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
  logger = event => console.warn(`[official-fetch] source=${event.source} attempt=${event.attempt}/${event.maxAttempts} type=${event.kind} action=${event.action}${event.delayMs === undefined ? "" : ` waitMs=${event.delayMs}`}`)
}) {
  invariant(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 3, "Official fetch allows one to three attempts.");
  invariant([requestTimeoutMs, totalTimeoutMs, baseDelayMs, maxDelayMs, maximumBytes].every(value => Number.isFinite(value) && value > 0), "Invalid official fetch limits.");
  const initialUrl = new URL(url);
  invariant(initialUrl.protocol === "https:" && !initialUrl.username && !initialUrl.password && finalHosts.includes(initialUrl.hostname), "Official source must use HTTPS and an approved host.");
  const source = initialUrl.origin; // Exclude query strings, credentials and upstream error text.
  const budget = new AbortController();
  const cancel = () => budget.abort(new OfficialFetchError("Official source request cancelled by caller.", "caller-cancelled"));
  const exhausted = () => new OfficialFetchError("Official source total fetch budget exhausted.", "total-budget");
  const deadline = now() + totalTimeoutMs;
  const totalTimer = setTimer(() => budget.abort(exhausted()), totalTimeoutMs);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const remaining = () => deadline - now();
  const checkBudget = () => {
    if (budget.signal.aborted) throw budget.signal.reason;
    if (remaining() <= 0) throw exhausted();
  };
  let attempt = 0;
  try {
    while (attempt < maxAttempts) {
      checkBudget();
      attempt += 1;
      const request = new AbortController();
      const abortRequest = () => request.abort(budget.signal.reason);
      budget.signal.addEventListener("abort", abortRequest, { once: true });
      const requestTimer = setTimer(() => request.abort(new OfficialFetchError(
        "Official source single request timed out.", "request-timeout", { retryable: true }
      )), Math.min(requestTimeoutMs, remaining()));
      let response;
      let reader;
      let failure;
      try {
        const pending = Promise.resolve(fetchImpl(url, {
          method: "GET", redirect: "follow", signal: request.signal,
          headers: { Accept: binary ? "application/octet-stream,*/*;q=0.8" : "text/html,application/json;q=0.9,*/*;q=0.8", "User-Agent": "Varzia-Prime-Resurgence-Sync/1.0" }
        }));
        // Dispose of a late response even if a fetch implementation ignores abort.
        pending.then(late => {
          if (request.signal.aborted && !response) Promise.resolve(late.body?.cancel?.()).catch(() => {});
        }, () => {});
        response = await waitForSignal(pending, request.signal);
        const finalUrl = new URL(response.url || url);
        if (finalUrl.protocol !== "https:" || finalUrl.username || finalUrl.password || !finalHosts.includes(finalUrl.hostname)) {
          throw new OfficialFetchError("Official source redirected to an unapproved host.", "unapproved-host");
        }
        const declaredLength = Number(response.headers?.get?.("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
          throw new OfficialFetchError("Official source declared an unsafe size.", "unsafe-size");
        }
        if (!response.ok) throw new OfficialFetchError(`Official source returned HTTP ${response.status}.`, `http-${response.status}`, {
          retryable: RETRY_HTTP_STATUSES.has(response.status),
          retryAfterMs: retryAfterMilliseconds(response.headers?.get?.("retry-after"), wallNow)
        });
        const chunks = [];
        let size = 0;
        if (response.body?.getReader) {
          reader = response.body.getReader();
          while (true) {
            const { done, value } = await waitForSignal(reader.read(), request.signal);
            if (done) break;
            size += value.byteLength;
            if (size > maximumBytes) throw new OfficialFetchError(`Official source size is unsafe (more than ${maximumBytes} bytes).`, "unsafe-size");
            chunks.push(Buffer.from(value));
          }
        } else {
          const fallback = Buffer.from(await waitForSignal(response.arrayBuffer(), request.signal));
          size = fallback.length;
          chunks.push(fallback);
        }
        if (!size || size > maximumBytes) throw new OfficialFetchError("Official source size is unsafe or empty.", "unsafe-size");
        checkBudget();
        const buffer = Buffer.concat(chunks, size);
        if (attempt > 1) logger({ source, attempt, maxAttempts, kind: "success", action: "complete" });
        return binary ? buffer : buffer.toString("utf8");
      } catch (error) {
        failure = budget.signal.aborted ? budget.signal.reason : request.signal.aborted ? request.signal.reason : fetchFailure(error);
      } finally {
        clearTimer(requestTimer);
        budget.signal.removeEventListener("abort", abortRequest);
        if (failure) {
          request.abort(failure);
          try {
            // Cleanup consumes the same total budget; a stuck cancel cannot launch another GET.
            const cleanup = reader ? reader.cancel() : response?.body?.cancel?.();
            await waitForSignal(cleanup, budget.signal);
          } catch {
            if (budget.signal.aborted && failure.retryable) failure = budget.signal.reason;
          }
        }
        reader?.releaseLock();
      }
      if (!failure.retryable) throw failure;
      checkBudget();
      if (attempt === maxAttempts) throw failure;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jittered = Math.min(maxDelayMs, backoff * (1 + Math.max(0, Math.min(1, random())) * 0.2));
      const delayMs = Math.max(Math.ceil(jittered), failure.retryAfterMs);
      if (delayMs >= remaining()) throw new OfficialFetchError(
        `Official source ${failure.kind}: required retry wait exceeds remaining total budget.`, "retry-budget"
      );
      logger({ source, attempt, maxAttempts, kind: failure.kind, action: "retry", delayMs });
      await waitForSignal(sleep(delayMs, { signal: budget.signal }), budget.signal);
    }
  } catch (error) {
    const original = fetchFailure(error);
    const failure = budget.signal.aborted && original.retryable ? budget.signal.reason : original;
    const attempts = Math.min(attempt, maxAttempts);
    logger({ source, attempt: attempts, maxAttempts, kind: failure.kind, action: "stop" });
    throw new OfficialFetchError(`${failure.message} Source: ${source}; attempts: ${attempts}/${maxAttempts}; type: ${failure.kind}.`, failure.kind);
  } finally {
    clearTimer(totalTimer);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function fetchOfficialRotationPages({ fetchImpl = globalThis.fetch, signal } = {}) {
  const [englishHtml, chineseHtml] = await Promise.all([
    fetchResource(fetchImpl, OFFICIAL_SOURCES.rotationEn, { signal, finalHosts: ["www.warframe.com"], maximumBytes: 1_000_000 }),
    fetchResource(fetchImpl, OFFICIAL_SOURCES.rotationZh, { signal, finalHosts: ["www.warframe.com"], maximumBytes: 1_000_000 })
  ]);
  return { englishHtml, chineseHtml };
}

export async function fetchOfficialRotationData({ fetchImpl = globalThis.fetch, decompress = decompressLzma, signal } = {}) {
  const content = (url, options = {}) => fetchResource(fetchImpl, url, { signal, finalHosts: ["content.warframe.com"], maximumBytes: 20_000_000, ...options });
  const [dropTablesHtml, ...indexes] = await Promise.all([
    fetchResource(fetchImpl, OFFICIAL_SOURCES.dropTables, {
      signal, finalHosts: ["www.warframe.com", "warframe-web-assets.nyc3.cdn.digitaloceanspaces.com"], maximumBytes: 10_000_000
    }),
    ...["en", "zh"].map(async locale => decompress(await content(`https://content.warframe.com/PublicExport/index_${locale}.txt.lzma`, { binary: true, maximumBytes: 1_000_000 })))
  ]);
  const exportUrls = {};
  const readExport = async (type, locale) => {
    const prefix = `Export${type}_${locale}.json!`;
    const matches = indexes[locale === "en" ? 0 : 1].split(/\r?\n/).filter(line => line.startsWith(prefix));
    invariant(matches.length === 1 && /^[A-Za-z0-9_.!+-]+$/.test(matches[0]), `Missing or ambiguous Public Export manifest: ${prefix}`);
    const url = `https://content.warframe.com/PublicExport/Manifest/${matches[0]}`;
    exportUrls[`${type}_${locale}`] = url;
    const text = await content(url);
    const records = JSON.parse(text)[`Export${type}`];
    invariant(Array.isArray(records) && records.length > 0, `Malformed Public Export: ${url}`);
    return { text, records };
  };
  const [recipes, relics, en, zh] = await Promise.all([
    readExport("Recipes", "en"), readExport("RelicArcane", "en"),
    Promise.all(["Warframes", "Weapons", "Sentinels"].map(type => readExport(type, "en"))),
    Promise.all(["Warframes", "Weapons", "Sentinels"].map(type => readExport(type, "zh")))
  ]);
  return { dropTablesHtml, recipesText: recipes.text, recipeUrl: exportUrls.Recipes_en,
    relicExport: relics.records, equipmentEn: en.flatMap(item => item.records), equipmentZh: zh.flatMap(item => item.records), exportUrls };
}

export async function fetchWorldState(fetchImpl, signal) {
  return fetchResource(fetchImpl, OFFICIAL_SOURCES.worldState, { signal, finalHosts: ["api.warframe.com"], maximumBytes: 10_000_000 });
}
