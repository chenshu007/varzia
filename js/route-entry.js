const routeLocale = document.documentElement.dataset.routeLocale || "en";
const routeCopy = {
  zh: {
    lang: "zh-CN",
    title: "Varzia - Warframe Prime 重生规划器",
    description: "围绕阿耶精华、Prime 重生与联合蒙地卡罗规划，估算完成 Warframe Prime 目标所需的预算。",
    locale: "zh_CN"
  },
  en: {
    lang: "en",
    title: "Varzia - Warframe Prime Resurgence Aya Planner",
    description: "Estimate how much Aya you need for Warframe Prime Resurgence using Monte Carlo simulation.",
    locale: "en_US"
  }
};

function setMeta(documentNode, selector, value, attribute = "content") {
  const element = documentNode.querySelector(selector);
  if (element) element.setAttribute(attribute, value);
}

async function boot() {
  const copy = routeCopy[routeLocale] || routeCopy.en;
  const response = await fetch("/index.html", { cache: "no-store" });
  if (!response.ok) throw new Error(`App shell HTTP ${response.status}`);
  const html = await response.text();
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.documentElement.lang = copy.lang;
  setMeta(parsed, 'meta[name="description"]', copy.description);
  setMeta(parsed, 'meta[property="og:locale"]', copy.locale);
  setMeta(parsed, 'meta[property="og:title"]', copy.title);
  setMeta(parsed, 'meta[property="og:description"]', copy.description);
  setMeta(parsed, 'meta[name="twitter:title"]', copy.title);
  setMeta(parsed, 'meta[name="twitter:description"]', copy.description);
  const title = parsed.querySelector("title");
  if (title) title.textContent = copy.title;
  const canonical = parsed.querySelector('link[rel="canonical"]');
  if (canonical) canonical.href = `https://varzia.starport1116.com/${routeLocale}/`;
  const appScript = parsed.querySelector('script[type="module"][src*="app.js"]');
  appScript?.remove();
  document.documentElement.replaceWith(parsed.documentElement);
  await import("/js/app.js");
}

boot().catch((error) => {
  document.body.innerHTML = `<main style="padding:2rem;font-family:system-ui;color:#f1eee5;background:#07141e;min-height:100vh"><h1>Varzia</h1><p>${String(error.message || "Unable to load Varzia")}</p></main>`;
});
