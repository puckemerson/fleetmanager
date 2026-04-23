// 11ty config with SEO helpers.
export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "src/static": "static" });
  eleventyConfig.addPassthroughCopy({ "src/images": "images" });
  eleventyConfig.addPassthroughCopy({ "src/_theme.css": "_theme.css" });

  eleventyConfig.addFilter("date", (value, format) => {
    if (!value) return "";
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d)) return "";
    if (format === "iso") return d.toISOString().slice(0, 10);
    if (format === "isoFull") return d.toISOString();
    const opts = { year: "numeric", month: "long", day: "numeric" };
    return d.toLocaleDateString("en-US", opts);
  });

  eleventyConfig.addFilter("round", (n) => Math.round(Number(n) || 0));

  // Round to N decimals
  eleventyConfig.addFilter("roundTo", (n, places) => {
    const p = Math.pow(10, Number(places) || 0);
    return Math.round((Number(n) || 0) * p) / p;
  });

  // Strip markdown/HTML -> plain text
  eleventyConfig.addFilter("plainText", (s) => {
    if (!s) return "";
    return String(s)
      // remove fenced code blocks
      .replace(/```[\s\S]*?```/g, " ")
      // inline code
      .replace(/`[^`]*`/g, " ")
      // images
      .replace(/!\[[^\]]*\]\([^\)]*\)/g, " ")
      // links -> text only
      .replace(/\[([^\]]+)\]\([^\)]*\)/g, "$1")
      // headings / emphasis / blockquote markers
      .replace(/^[#>\-\*\s]+/gm, " ")
      .replace(/[*_~]+/g, "")
      // html tags
      .replace(/<[^>]+>/g, " ")
      // entities
      .replace(/&[a-z]+;/gi, " ")
      // whitespace
      .replace(/\s+/g, " ")
      .trim();
  });

  // Truncate to N chars (word-safe)
  eleventyConfig.addFilter("truncate", (s, n) => {
    const limit = Number(n) || 150;
    const str = String(s || "").trim();
    if (str.length <= limit) return str;
    const cut = str.slice(0, limit);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim() + "…";
  });

  // Escape text for inclusion in an HTML attribute value.
  eleventyConfig.addFilter("htmlAttr", (s) => {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  });

  // Escape for JSON context (safe inside <script type="application/ld+json">).
  eleventyConfig.addFilter("jsonStringify", (val) => {
    return JSON.stringify(val).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  });

  // Build an absolute URL from the site.url base + a path. Avoids double slashes.
  eleventyConfig.addFilter("absoluteUrl", function (pathOrUrl, base) {
    const b = String(base || "").replace(/\/+$/, "");
    const p = String(pathOrUrl || "");
    if (/^https?:\/\//i.test(p)) return p;
    if (!p) return b + "/";
    return b + (p.startsWith("/") ? p : "/" + p);
  });

  // Extract a brand guess from a product name. Heuristic: take the first 1-2
  // words, skipping obvious non-brand tokens. Returns a best-effort string.
  eleventyConfig.addFilter("guessBrand", (name) => {
    const s = String(name || "").trim();
    if (!s) return "";
    const stop = new Set(["de", "du", "la", "le", "les", "of", "the", "and", "&"]);
    const parts = s.split(/\s+/);
    if (parts.length === 1) return parts[0];
    const next = parts[1].toLowerCase();
    // Second word is a stopword/connector: take 3 words (e.g. "Viktor & Rolf", "Bleu de Chanel").
    if (parts.length >= 3 && stop.has(next)) {
      return `${parts[0]} ${parts[1]} ${parts[2]}`;
    }
    // Very short first word: include the second.
    if (parts[0].length <= 3) return `${parts[0]} ${parts[1]}`;
    return parts[0];
  });

  eleventyConfig.addCollection("reviews", (c) =>
    c.getFilteredByGlob("src/posts/*.md").sort((a, b) => b.date - a.date)
  );

  eleventyConfig.addCollection("reviewsByScore", (c) =>
    c.getFilteredByGlob("src/posts/*.md")
      .sort((a, b) => (Number(b.data.final_score) || 0) - (Number(a.data.final_score) || 0))
  );

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data",
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    pathPrefix: process.env.ELEVENTY_PATH_PREFIX || "/",
  };
}
