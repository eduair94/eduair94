/**
 * Renders the profile SVG cards from live GitHub data.
 *
 * Everything is committed to the repo and served from raw.githubusercontent,
 * so no third-party rendering service can take the profile down.
 *
 * Run: node scripts/render-cards.mjs   (GH_TOKEN optional: enables byte-accurate languages)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const USER = "eduair94";
const NAME = "Eduardo Airaudo";

// Featured repos are the top-starred ones, picked at render time — no hand-maintained list.
const FEATURED_COUNT = 4;

// Fallback copy for repos with no description set on GitHub.
const BLURBS = {
  "whatsapp-scrapping-tool": "Bulk WhatsApp number verification, as a desktop app",
  "ci-validation": "Uruguayan national ID validation API",
  "no-llamar-uy": "Do-not-call registry lookup for Uruguay",
  "cambio-uruguay": "Live FX rates across every Uruguayan exchange",
  "gastos-gub-uy": "Uruguayan public spending, scraped and queryable",
  "recaptcha-solver-api": "reCAPTCHA solving as an HTTP API",
};

const IGNORED_LANGS = new Set([
  "HTML",
  "CSS",
  "SCSS",
  "Vue",
  "Handlebars",
  "Blade",
  "EJS",
  "Jupyter Notebook",
]);
const MIN_LANG_PCT = 0.3;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";

// Cards render on a transparent canvas so they sit flush on GitHub's own
// page background instead of showing a seam of near-but-not-quite #0d1117.
const THEMES = {
  dark: {
    surface: "#0F161D",
    chrome: "#141E28",
    border: "#22303C",
    text: "#C6D2DC",
    dim: "#5C7080",
    amber: "#F0A02B",
    cyan: "#4FC3D9",
    ok: "#4FD68A",
    okBg: "#12281D",
    string: "#8FD98F",
    track: "#1B2731",
  },
  light: {
    surface: "#FFFFFF",
    chrome: "#F2F5F7",
    border: "#D7DFE5",
    text: "#16232D",
    dim: "#61798A",
    amber: "#B45309",
    cyan: "#0B6E88",
    ok: "#12703F",
    okBg: "#E4F4EA",
    string: "#1F6E3C",
    track: "#E8EDF1",
  },
};

// Octicons — inline paths beat glyphs, which depend on whatever font the viewer has.
const ICON_STAR =
  "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z";
const ICON_FORK =
  "M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z";

const LANG_COLORS = {
  TypeScript: "#3178C6",
  JavaScript: "#F1E05A",
  Python: "#3572A5",
  Go: "#00ADD8",
  Shell: "#89E051",
  PHP: "#4F5D95",
  Java: "#B07219",
  Rust: "#DEA584",
  Ruby: "#701516",
  "C#": "#178600",
  C: "#555555",
  "C++": "#F34B7D",
  Dockerfile: "#384D54",
  Dart: "#00B4AB",
  Kotlin: "#A97BFF",
  Swift: "#F05138",
  Lua: "#000080",
  Makefile: "#427819",
  PowerShell: "#012456",
  Batchfile: "#C1F12E",
  Nix: "#7E7EFF",
};
const langColor = (name) => LANG_COLORS[name] || "#8B98A5";

const MONO = 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace';

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": `${USER}-profile-cards`,
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function collect() {
  const user = await gh(`/users/${USER}`);

  const repos = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh(`/users/${USER}/repos?per_page=100&type=owner&sort=pushed&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }

  const own = repos.filter((r) => !r.fork && !r.archived);
  const stars = own.reduce((n, r) => n + r.stargazers_count, 0);
  const forks = own.reduce((n, r) => n + r.forks_count, 0);

  const bytes = new Map();
  const add = (lang, n) => lang && !IGNORED_LANGS.has(lang) && bytes.set(lang, (bytes.get(lang) || 0) + n);

  // Language bytes cost one call per repo. A token buys all of them; unauthenticated
  // we spend what the 60/hr limit allows on the most recently pushed repos, then fall
  // back to size-weighting each remaining repo's primary language.
  const sized = own.filter((r) => r.size > 0);
  const budget = TOKEN ? sized.length : 45;

  for (const [i, r] of sized.entries()) {
    if (i < budget) {
      try {
        const langs = await gh(`/repos/${USER}/${r.name}/languages`);
        for (const [lang, n] of Object.entries(langs)) add(lang, n);
        continue;
      } catch (err) {
        console.warn(`languages: falling back for ${r.name} (${err.message.slice(0, 60)})`);
      }
    }
    add(r.language, r.size || 1);
  }

  const total = [...bytes.values()].reduce((a, b) => a + b, 0) || 1;
  const languages = [...bytes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => ({ name, pct: (n / total) * 100 }))
    .filter((l) => l.pct >= MIN_LANG_PCT)
    .slice(0, 5);

  const featured = [...own]
    .sort((a, b) => b.stargazers_count - a.stargazers_count || b.forks_count - a.forks_count)
    .slice(0, FEATURED_COUNT)
    .map((r) => ({ ...r, description: r.description || BLURBS[r.name] || "" }));

  return {
    user,
    stats: {
      repos: own.length,
      stars,
      forks,
      followers: user.followers,
      since: user.created_at.slice(0, 10),
    },
    languages,
    featured,
  };
}

/* ---------- SVG primitives: every card is an HTTP exchange ---------- */

const style = (t) => `
  <style>
    .m { font-family: ${MONO}; }
    .dim { fill: ${t.dim}; }
    .txt { fill: ${t.text}; }
    .key { fill: ${t.cyan}; }
    .num { fill: ${t.amber}; }
    .str { fill: ${t.string}; }
    .acc { fill: ${t.amber}; }
    @keyframes blink { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }
    .caret { animation: blink 1.06s step-end infinite; }
    @media (prefers-reduced-motion: reduce) { .caret { animation: none } }
  </style>`;

/** Window chrome: request line on the left, status pill on the right. */
function frame(t, { w, h, method = "GET", path, status = "200 OK", meta = "" }) {
  const barH = 30;
  const pillW = 8 * status.length + 16;
  const pillX = w - 12 - pillW;
  const metaX = pillX - 10;
  return `
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="7" fill="${t.surface}" stroke="${t.border}"/>
  <path d="M0.5 7.5a7 7 0 0 1 7-7h${w - 15}a7 7 0 0 1 7 7v${barH - 7}H0.5z" fill="${t.chrome}"/>
  <line x1="0.5" y1="${barH}.5" x2="${w - 0.5}" y2="${barH}.5" stroke="${t.border}"/>
  <text class="m" x="12" y="20" font-size="11" letter-spacing="0.4">
    <tspan class="acc" font-weight="700">${method}</tspan><tspan class="dim" dx="6">${esc(path)}</tspan>
  </text>
  <rect x="${pillX}" y="8" width="${pillW}" height="15" rx="7.5" fill="${t.okBg}"/>
  <text class="m" x="${pillX + pillW / 2}" y="19" font-size="10" font-weight="700" fill="${t.ok}" text-anchor="middle">${esc(status)}</text>
  ${meta ? `<text class="m dim" x="${metaX}" y="20" font-size="10" text-anchor="end">${esc(meta)}</text>` : ""}`;
}

const doc = (t, w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">${style(t)}${body}</svg>`;

/* ---------- Cards ---------- */

function banner(t) {
  const w = 840;
  const h = 196;
  const x = 26;
  const col2 = 448;
  const headers = [
    ["x-role", "scrapers · bots · data-driven APIs", x],
    ["x-stack", "TypeScript · Cloudflare · Python · Go", col2],
    ["x-location", "Montevideo, Uruguay", x],
    ["x-building", "shellix.xyz · checkleaked.cc", col2],
  ];
  const rows = headers
    .map(
      ([k, v, cx], i) => `
    <text class="m" x="${cx}" y="${138 + Math.floor(i / 2) * 21}" font-size="12.5">
      <tspan class="key">${k}:</tspan><tspan class="txt" x="${cx + 92}">${esc(v)}</tspan>
    </text>`,
    )
    .join("");

  return doc(
    t,
    w,
    h,
    `${frame(t, { w, h, path: `/${USER}`, meta: "HTTP/2 · 12ms" })}
    <text class="m dim" x="${x}" y="64" font-size="12">$ curl -sS https://api.github.com/users/${USER}</text>
    <text class="m" x="${x}" y="99" font-size="29" font-weight="700" letter-spacing="-0.5">
      <tspan class="acc">${esc(NAME)}</tspan><tspan class="acc caret" dx="4">▌</tspan>
    </text>
    ${rows}`,
  );
}

function statsCard(t, { stats }) {
  const w = 412;
  const h = 214;
  const x = 18;
  const gut = 30;
  const val = 148;
  const lines = [
    ["repos", stats.repos, "num"],
    ["stars", stats.stars, "num"],
    ["forks", stats.forks, "num"],
    ["followers", stats.followers, "num"],
    ["coding_since", `"${stats.since}"`, "str"],
  ];
  const body = lines
    .map(([k, v, kind], i) => {
      const y = 78 + i * 21;
      const comma = i < lines.length - 1 ? "," : "";
      return `
    <text class="m dim" x="${x}" y="${y}" font-size="11">${i + 2}</text>
    <text class="m" x="${gut}" y="${y}" font-size="12.5">
      <tspan class="key">"${k}"</tspan><tspan class="dim">:</tspan><tspan class="${kind}" x="${val}">${esc(v)}</tspan><tspan class="dim">${comma}</tspan>
    </text>`;
    })
    .join("");

  return doc(
    t,
    w,
    h,
    `${frame(t, { w, h, path: "/api/stats", meta: "41ms" })}
    <text class="m dim" x="${x}" y="57" font-size="11">1</text>
    <text class="m dim" x="${gut}" y="57" font-size="12.5">{</text>
    ${body}
    <text class="m dim" x="${x}" y="${78 + lines.length * 21}" font-size="11">${lines.length + 2}</text>
    <text class="m dim" x="${gut}" y="${78 + lines.length * 21}" font-size="12.5">}</text>`,
  );
}

function langsCard(t, { languages }) {
  const w = 412;
  const h = 214;
  const x = 18;
  const barW = w - x * 2;
  const shown = languages.slice(0, 5);
  const sum = shown.reduce((n, l) => n + l.pct, 0);

  let cursor = x;
  const stacked = shown
    .map((l) => {
      const seg = (l.pct / sum) * barW;
      const r = `<rect x="${cursor.toFixed(1)}" y="52" width="${Math.max(seg - 1.5, 1).toFixed(1)}" height="9" rx="2" fill="${langColor(l.name)}"/>`;
      cursor += seg;
      return r;
    })
    .join("");

  // Rows share the body evenly, so a 3-language card fills the same height as a 5-language one.
  const top = 76;
  const bottom = h - 16;
  const step = (bottom - top) / shown.length;

  const rows = shown
    .map((l, i) => {
      const y = top + step * (i + 0.5) + 4;
      const pct = ((l.pct / sum) * 100).toFixed(1);
      const bw = Math.max((l.pct / sum) * 96, 1.5).toFixed(1);
      return `
    <circle cx="${x + 4}" cy="${y - 4}" r="4.5" fill="${langColor(l.name)}"/>
    <text class="m txt" x="${x + 17}" y="${y}" font-size="12.5">${esc(clip(l.name, 14))}</text>
    <rect x="${w - 176}" y="${y - 8}" width="96" height="6" rx="3" fill="${t.track}"/>
    <rect x="${w - 176}" y="${y - 8}" width="${bw}" height="6" rx="3" fill="${langColor(l.name)}"/>
    <text class="m num" x="${w - x}" y="${y}" font-size="12" text-anchor="end">${pct}%</text>`;
    })
    .join("");

  return doc(
    t,
    w,
    h,
    `${frame(t, { w, h, path: "/api/languages", meta: "content-type" })}
    ${stacked}
    ${rows}`,
  );
}

const icon = (t, path, x, y, size = 12) =>
  `<path d="${path}" fill="${t.dim}" transform="translate(${x} ${y}) scale(${size / 16})"/>`;

function repoCard(t, repo) {
  const w = 412;
  const h = 132;
  const x = 18;
  const y = h - 22;
  const lang = repo.language || "—";

  return doc(
    t,
    w,
    h,
    `${frame(t, { w, h, path: `/${esc(repo.name)}` })}
    <text class="m acc" x="${x}" y="62" font-size="15" font-weight="700">${esc(clip(repo.name, 30))}</text>
    <text class="m dim" x="${x}" y="84" font-size="11.5">${esc(clip(repo.description, 54))}</text>
    <circle cx="${x + 5}" cy="${y + 5}" r="4.5" fill="${langColor(lang)}"/>
    <text class="m txt" x="${x + 18}" y="${y + 9}" font-size="11.5">${esc(lang)}</text>
    ${icon(t, ICON_STAR, x + 150, y)}
    <text class="m dim" x="${x + 168}" y="${y + 9}" font-size="11.5">${repo.stargazers_count}</text>
    ${icon(t, ICON_FORK, x + 200, y)}
    <text class="m dim" x="${x + 218}" y="${y + 9}" font-size="11.5">${repo.forks_count}</text>`,
  );
}

/* ---------- Emit ---------- */

/**
 * Repo cards are written to rank-stable paths (repo-1..N) because the featured set is
 * ranked by stars and can reorder. The README's link targets have to move with them, so
 * the script owns that block rather than leaving a hand-written link pointing at the
 * wrong card.
 */
async function patchReadme(featured) {
  const path = join(OUT, "..", "README.md");
  const md = await readFile(path, "utf8");

  const cards = featured
    .map(
      (repo, i) => `  <a href="${repo.html_url}">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="./assets/repo-${i + 1}-dark.svg" />
      <img alt="${esc(repo.name)} — ${esc(repo.description || "repository")}" src="./assets/repo-${i + 1}-light.svg" width="412" />
    </picture>
  </a>`,
    )
    .join("\n");

  const block = (marker, body) =>
    new RegExp(`(<!-- ${marker}:start -->)[\\s\\S]*?(<!-- ${marker}:end -->)`).exec(md) &&
    md.replace(
      new RegExp(`(<!-- ${marker}:start -->)[\\s\\S]*?(<!-- ${marker}:end -->)`),
      `$1\n${body}\n$2`,
    );

  let next = block("PROJECTS", `<p align="center">\n${cards}\n</p>`) || md;
  next = next.replace(
    /(<!-- LAST_UPDATED -->)[\s\S]*?(<!-- \/LAST_UPDATED -->)/,
    `$1${new Date().toISOString().slice(0, 10)}$2`,
  );

  if (next !== md) {
    await writeFile(path, next, "utf8");
    console.log("patched README.md");
  }
}

const data = await collect();
await mkdir(OUT, { recursive: true });

const cards = [
  ["banner", banner],
  ["stats", statsCard],
  ["langs", langsCard],
  ...data.featured.map((repo, i) => [`repo-${i + 1}`, (t) => repoCard(t, repo)]),
];

for (const [name, render] of cards) {
  for (const [theme, tokens] of Object.entries(THEMES)) {
    await writeFile(join(OUT, `${name}-${theme}.svg`), render(tokens, data), "utf8");
  }
}

await patchReadme(data.featured);

console.log(
  `${cards.length * 2} SVGs · ${data.stats.repos} repos · ${data.stats.stars} stars · ` +
    `${data.languages.length} languages (${TOKEN ? "byte-accurate" : "size-weighted"})\n` +
    `featured: ${data.featured.map((r) => `${r.name} (${r.stargazers_count}★)`).join(", ")}`,
);
