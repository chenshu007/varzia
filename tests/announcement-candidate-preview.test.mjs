import test from "node:test";
import assert from "node:assert/strict";
import { loadAnnouncementCandidates } from "../js/announcement-candidate-preview.js";

const rotationData = { rotations: [] };
const candidateData = {
  schemaVersion: 1,
  candidates: [{
    id: "banshee-mirage-2026-09",
    status: "announced",
    primeWarframes: ["Banshee Prime", "Mirage Prime"],
    effectiveAt: "2026-09-03T18:00:00Z",
    effectiveDate: "2026-09-03",
    source: {
      type: "digital-extremes-official-announcement",
      url: "https://bsky.app/profile/warframe.com/post/3fixture",
      publishedAt: "2026-08-20T18:00:00.000Z",
      discoveredAt: "2026-08-20T18:01:00.000Z",
      rawPrimeWarframes: ["Banshee Prime", "Mirage Prime"],
      rawEffectiveText: "September 3 at 2 p.m. ET"
    },
    relicDataStatus: "pending",
    verified: false,
    statusHistory: [{ status: "announced", at: "2026-08-20T18:01:00.000Z" }],
    reviewReason: "Officially announced by Digital Extremes; awaiting official relic and reward data."
  }]
};

test("announcement candidate preview 404 不影响正式 rotation 数据", async () => {
  const warnings = [];
  const result = await loadAnnouncementCandidates({
    rotationData,
    fetchImpl: async () => new Response("missing", { status: 404 }),
    warn: (...args) => warnings.push(args)
  });
  assert.deepEqual(result, []);
  assert.equal(warnings.length, 1);
});

test("announcement candidate preview malformed 或 schema 不兼容时 fail closed", async () => {
  const malformed = await loadAnnouncementCandidates({
    rotationData,
    fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError("bad JSON"); } }),
    warn: () => {}
  });
  const incompatible = await loadAnnouncementCandidates({
    rotationData,
    fetchImpl: async () => new Response(JSON.stringify({ ...candidateData, schemaVersion: 2 }), { status: 200 }),
    warn: () => {}
  });
  assert.deepEqual(malformed, []);
  assert.deepEqual(incompatible, []);
});

test("合法 announcement candidate preview 仍可独立加载", async () => {
  const result = await loadAnnouncementCandidates({
    rotationData,
    fetchImpl: async () => new Response(JSON.stringify(candidateData), { status: 200 }),
    warn: () => {}
  });
  assert.deepEqual(result, candidateData.candidates);
});
