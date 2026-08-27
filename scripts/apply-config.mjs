import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_START,
  injectConfig,
  normaliseValues,
} from "../wizard/snippet.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Load and validate project.config.json, returning the config plus derived URLs.
 */
export async function loadConfig() {
  const configPath = join(ROOT, "project.config.json");
  const raw = JSON.parse(await readFile(configPath, "utf8"));

  const required = ["name", "title", "org", "repo"];
  for (const key of required) {
    if (!raw[key] || typeof raw[key] !== "string") {
      throw new Error(
        `project.config.json: "${key}" is required and must be a non-empty string.`,
      );
    }
  }

  const pagesBaseUrl = `https://${raw.org}.github.io/${raw.repo}`;

  // The macro's own settings share the CONFIG block with the derived values, so
  // normalise them here against the same rules the wizard applies.
  const { warningMinutes, alertDurationSeconds, alertTitle } = normaliseValues({
    ...(raw.macro ?? {}),
    name: raw.name,
  });

  return {
    ...raw,
    author: raw.author ?? "",
    description: raw.description ?? "",
    macro: { warningMinutes, alertDurationSeconds, alertTitle },
    pagesBaseUrl,
    wizardUrl: `${pagesBaseUrl}/wizard/`,
    repoUrl: `https://github.com/${raw.org}/${raw.repo}`,
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Replace the text between two markers (markers preserved). Idempotent.
 */
function replaceBetween(content, startMarker, endMarker, inner) {
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { content, replaced: false };
  }
  const before = content.slice(0, startIdx + startMarker.length);
  const after = content.slice(endIdx);
  return { content: `${before}\n${inner}\n${after}`, replaced: true };
}

/**
 * Recursively list every *.js file under a directory (returns absolute paths).
 */
async function listJsFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listJsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

async function updateFile(relPath, transform) {
  const filePath = join(ROOT, relPath);
  if (!existsSync(filePath)) return false;
  const original = await readFile(filePath, "utf8");
  const updated = transform(original);
  if (updated !== original) {
    await writeFile(filePath, updated);
    console.log(`  updated ${relPath}`);
    return true;
  }
  return false;
}

function appConfigFile(cfg) {
  const value = {
    name: cfg.name,
    title: cfg.title,
    pagesBaseUrl: cfg.pagesBaseUrl,
    wizardUrl: cfg.wizardUrl,
    repoUrl: cfg.repoUrl,
    macro: cfg.macro,
  };
  // A standalone, prettier-ignored file so generated JSON never fights the
  // formatter over key quoting or indentation inside index.html.
  return [
    "// Generated from project.config.json by scripts/apply-config.mjs - do not edit.",
    `window.APP_CONFIG = ${JSON.stringify(value, null, 2)};`,
    "",
  ].join("\n");
}

async function writeGenerated(relPath, content) {
  const filePath = join(ROOT, relPath);
  let original = null;
  try {
    original = await readFile(filePath, "utf8");
  } catch {
    // File does not exist yet; it will be created below.
  }
  if (original !== content) {
    await writeFile(filePath, content);
    console.log(`  wrote ${relPath}`);
  }
}

export async function applyConfig() {
  const cfg = await loadConfig();
  console.log(`Applying project.config.json (${cfg.name})`);

  // package.json
  await updateFile("package.json", (content) => {
    const pkg = JSON.parse(content);
    pkg.name = cfg.name;
    pkg.description = cfg.description;
    pkg.author = cfg.author;
    return JSON.stringify(pkg, null, 2) + "\n";
  });

  // Wizard: rewrite <title> in place and (re)generate app-config.js. The HTML
  // stays formatter-owned; only the generated JS carries derived values.
  if (existsSync(join(ROOT, "wizard"))) {
    await updateFile("wizard/index.html", (content) =>
      content.replace(
        /<title>[\s\S]*?<\/title>/,
        `<title>${escapeHtml(cfg.title)}</title>`,
      ),
    );
    await writeGenerated("wizard/app-config.js", appConfigFile(cfg));
  }

  // Macros: every *.js under macros/ that carries the CONFIG markers. The block
  // itself is built by wizard/snippet.js so the wizard's "Copy config" output
  // and this script stay byte-identical.
  const macroValues = { name: cfg.name, ...cfg.macro };
  for (const filePath of await listJsFiles(join(ROOT, "macros"))) {
    await updateFile(relative(ROOT, filePath), (content) => {
      if (!content.includes(CONFIG_START)) return content;
      return injectConfig(content, macroValues);
    });
  }

  // README: title, description, and URLs. The inner content is padded with the
  // blank lines Prettier expects around Markdown headings/lists so the result
  // is a fixed point of both `apply-config` and `prettier`.
  await updateFile("README.md", (content) => {
    let next = replaceBetween(
      content,
      "<!-- title:start -->",
      "<!-- title:end -->",
      `\n# ${cfg.title}\n`,
    ).content;
    next = replaceBetween(
      next,
      "<!-- description:start -->",
      "<!-- description:end -->",
      `\n${cfg.description}`,
    ).content;
    next = replaceBetween(
      next,
      "<!-- urls:start -->",
      "<!-- urls:end -->",
      `\n- Wizard: ${cfg.wizardUrl}\n`,
    ).content;
    // Set the repo name in the Questions section mailto subject. Matches the
    // current value so it stays re-runnable if the repo is renamed later.
    next = next.replace(
      /(mailto:wxsd@external\.cisco\.com\?subject=)[^")\s]*/g,
      `$1${encodeURIComponent(cfg.repo)}`,
    );
    return next;
  });

  console.log("Done.");
  return cfg;
}

const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  applyConfig().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
