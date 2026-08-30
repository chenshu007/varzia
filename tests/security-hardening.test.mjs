import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("Pages 静态响应使用严格的全站安全头", () => {
  const headers = read("../_headers");
  assert.match(headers, /^\/\*$/m);
  assert.match(headers, /Content-Security-Policy: [^\n]*default-src 'self';[^\n]*frame-ancestors 'none';[^\n]*script-src 'self';[^\n]*style-src 'self'/);
  assert.match(headers, /X-Frame-Options: DENY/);
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /Referrer-Policy: strict-origin-when-cross-origin/);
  assert.match(headers, /Permissions-Policy: camera=\(\), geolocation=\(\), microphone=\(\), payment=\(\), usb=\(\)/);
  assert.match(headers, /Strict-Transport-Security: max-age=31536000/);
  assert.doesNotMatch(headers, /unsafe-inline/);
});

test("路由错误和结果文案不会把动态文本直接插入 HTML", () => {
  const routeEntry = read("../js/route-entry.js");
  const app = read("../js/app.js");
  assert.doesNotMatch(routeEntry, /document\.body\.innerHTML/);
  assert.match(routeEntry, /message\.textContent = error instanceof Error/);
  assert.match(app, /verdict-status">\$\{escapeHtml\(outcome\.label\)\}<\/strong><span>\$\{escapeHtml\(outcome\.message\)\}/);
});

test("严格 CSP 前不再依赖 HTML 内联样式", () => {
  for (const route of ["../en/index.html", "../zh/index.html"]) {
    assert.doesNotMatch(read(route), /style=/);
  }
  const app = read("../js/app.js");
  assert.match(app, /data-completion=/);
  assert.match(app, /meter\.style\.width/);
});
