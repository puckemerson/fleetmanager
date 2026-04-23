// Adds `excerpt` (plain-text first ~300 chars of the review body)
// and `metaDescription` (first ~155 chars) to each review post.
import fs from "node:fs";

function plainText(s) {
  if (!s) return "";
  return String(s)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^\)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^\)]*\)/g, "$1")
    .replace(/^[#>\-\*\s]+/gm, " ")
    .replace(/[*_~]+/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s, n) {
  const str = String(s || "").trim();
  if (str.length <= n) return str;
  const cut = str.slice(0, n);
  const last = cut.lastIndexOf(" ");
  return (last > 40 ? cut.slice(0, last) : cut).trim() + "…";
}

function stripFrontMatter(raw) {
  if (!raw) return "";
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  return m ? m[2] : raw;
}

export default {
  layout: "review.njk",
  permalink: "/posts/{{ page.fileSlug }}/",
  tags: ["review"],
  eleventyComputed: {
    excerpt: (data) => {
      try {
        const raw = fs.readFileSync(data.page.inputPath, "utf8");
        const body = stripFrontMatter(raw);
        return truncate(plainText(body), 300);
      } catch {
        return "";
      }
    },
    metaDescription: (data) => {
      try {
        const raw = fs.readFileSync(data.page.inputPath, "utf8");
        const body = stripFrontMatter(raw);
        return truncate(plainText(body), 155);
      } catch {
        return "";
      }
    },
  },
};
