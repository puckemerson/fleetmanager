#!/usr/bin/env node
// Backfill image_style_prompt for existing sites (ids 1, 2, 3).
// Generates a style prompt via LLM and saves to D1.
// Does NOT re-generate existing review images.

import { CONFIG, loadSecrets } from '../orchestrator/config.js';
import { d1All, d1Run } from '../orchestrator/d1.js';
import { generateImageStylePrompt } from '../orchestrator/llm.js';

loadSecrets();

async function main() {
  if (!CONFIG.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const sites = await d1All(
    'SELECT id, slug, product_category, image_style_prompt FROM sites ORDER BY id'
  );

  console.log(`Found ${sites.length} sites to process\n`);

  for (const site of sites) {
    if (site.image_style_prompt) {
      console.log(`Site ${site.id} (${site.slug}): already has prompt — skipping`);
      console.log(`  Existing: ${site.image_style_prompt}\n`);
      continue;
    }

    console.log(`Site ${site.id} (${site.slug}): generating prompt for category "${site.product_category}"...`);
    try {
      const prompt = await generateImageStylePrompt(site.product_category);
      console.log(`  Generated: ${prompt}`);
      await d1Run(
        'UPDATE sites SET image_style_prompt = ? WHERE id = ?',
        [prompt, site.id]
      );
      console.log(`  Saved to D1.\n`);
    } catch (err) {
      console.error(`  ERROR: ${err.message}\n`);
    }
  }

  // Final verification
  const updated = await d1All(
    'SELECT id, slug, product_category, image_style_prompt FROM sites ORDER BY id'
  );
  console.log('=== Final state ===');
  for (const s of updated) {
    console.log(`Site ${s.id} (${s.slug} / ${s.product_category}):`);
    console.log(`  image_style_prompt: ${s.image_style_prompt || '(none)'}`);
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
