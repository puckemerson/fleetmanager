// Theme generator: pick a color palette + font pair per site.

const PALETTES = [
  { name: 'warm-clay',  bg: '#faf7f2', fg: '#1e1c1a', muted: '#706a60', accent: '#8a3b2e', accentSoft: '#f1e1da', border: '#e4ded0', card: '#ffffff' },
  { name: 'sage',       bg: '#f5f7f3', fg: '#1a2420', muted: '#5e6a5f', accent: '#4a7057', accentSoft: '#dfe8da', border: '#d8e0d0', card: '#ffffff' },
  { name: 'indigo',     bg: '#f7f7fb', fg: '#15172a', muted: '#626680', accent: '#3d4edc', accentSoft: '#e2e4fb', border: '#dadaee', card: '#ffffff' },
  { name: 'slate',      bg: '#f4f5f7', fg: '#111418', muted: '#5e6572', accent: '#1f2d3d', accentSoft: '#d9dee5', border: '#d6d9df', card: '#ffffff' },
  { name: 'rose',       bg: '#fbf5f5', fg: '#24171a', muted: '#766466', accent: '#b44464', accentSoft: '#f5dadf', border: '#ebd9dc', card: '#ffffff' },
  { name: 'forest',     bg: '#f3f6f0', fg: '#0f1c0e', muted: '#4e5f4b', accent: '#2f5e3d', accentSoft: '#d4e2cf', border: '#ccd8c7', card: '#ffffff' },
  { name: 'ocean',      bg: '#f0f6f8', fg: '#0f2027', muted: '#4c6874', accent: '#236073', accentSoft: '#cfe4eb', border: '#c8dde3', card: '#ffffff' },
  { name: 'sand',       bg: '#fcf8ec', fg: '#26220f', muted: '#746c53', accent: '#a0791a', accentSoft: '#efe6c9', border: '#e4dac2', card: '#ffffff' },
];

const FONT_PAIRS = [
  { sans: 'Inter',       serif: 'Lora',                sansQs: 'Inter:wght@400;600;700',                serifQs: 'Lora:wght@500;700' },
  { sans: 'IBM Plex Sans', serif: 'Crimson Pro',       sansQs: 'IBM+Plex+Sans:wght@400;600',            serifQs: 'Crimson+Pro:wght@500;700' },
  { sans: 'Work Sans',   serif: 'Playfair Display',    sansQs: 'Work+Sans:wght@400;600',                serifQs: 'Playfair+Display:wght@600;800' },
  { sans: 'Source Sans 3', serif: 'Spectral',          sansQs: 'Source+Sans+3:wght@400;600',            serifQs: 'Spectral:wght@500;700' },
  { sans: 'Nunito Sans', serif: 'Libre Caslon Text',   sansQs: 'Nunito+Sans:wght@400;600',              serifQs: 'Libre+Caslon+Text:wght@400;700' },
  { sans: 'DM Sans',     serif: 'DM Serif Display',    sansQs: 'DM+Sans:wght@400;600',                  serifQs: 'DM+Serif+Display' },
  { sans: 'Karla',       serif: 'Fraunces',            sansQs: 'Karla:wght@400;600',                    serifQs: 'Fraunces:wght@500;700' },
  { sans: 'Manrope',     serif: 'Cormorant Garamond', sansQs: 'Manrope:wght@400;600',                  serifQs: 'Cormorant+Garamond:wght@500;700' },
];

export function randomTheme() {
  const palette = PALETTES[Math.floor(Math.random() * PALETTES.length)];
  const fonts = FONT_PAIRS[Math.floor(Math.random() * FONT_PAIRS.length)];
  return { palette, fonts };
}

export function themeCss(theme) {
  const p = theme.palette;
  const f = theme.fonts;
  return `/* theme: ${p.name} + ${f.sans}/${f.serif} */
:root {
  --bg: ${p.bg};
  --fg: ${p.fg};
  --muted: ${p.muted};
  --accent: ${p.accent};
  --accent-soft: ${p.accentSoft};
  --border: ${p.border};
  --card: ${p.card};
  --font-sans: "${f.sans}", system-ui, -apple-system, sans-serif;
  --font-serif: "${f.serif}", Georgia, serif;
}
`;
}
