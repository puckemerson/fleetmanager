// Minimal 11ty config
export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "src/static": "static" });
  eleventyConfig.addPassthroughCopy({ "src/images": "images" });
  eleventyConfig.addPassthroughCopy({ "src/_theme.css": "_theme.css" });

  eleventyConfig.addFilter("date", (value, format) => {
    if (!value) return "";
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d)) return "";
    if (format === "iso") return d.toISOString().slice(0, 10);
    const opts = { year: "numeric", month: "long", day: "numeric" };
    return d.toLocaleDateString("en-US", opts);
  });

  eleventyConfig.addFilter("round", (n) => Math.round(Number(n) || 0));

  eleventyConfig.addCollection("reviews", (c) =>
    c.getFilteredByGlob("src/posts/*.md").sort((a, b) => b.date - a.date)
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
