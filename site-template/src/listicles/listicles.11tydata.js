// Per-directory data for /src/listicles/*.md
export default {
  layout: "layouts/listicle.njk",
  permalink: "/listicles/{{ slug or page.fileSlug }}/",
  tags: ["listicle"],
};
