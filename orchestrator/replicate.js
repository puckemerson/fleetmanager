// Replicate img2img image restyling via flux-dev.
// Converts a scraped product image into a styled product photo.

const REPLICATE_API = 'https://api.replicate.com/v1';
// flux-dev supports img2img via the `image` input parameter
const MODEL_VERSION = 'black-forest-labs/flux-dev';

// Rate limit handling
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

/**
 * Restyle a product image using Replicate's flux-dev img2img.
 * @param {object} opts
 * @param {Buffer} opts.imageBuffer - Raw image bytes from scraping
 * @param {string} opts.productName - Product name for the prompt
 * @param {string} opts.stylePrompt - Site-specific style prompt
 * @param {string} opts.apiKey - Replicate API key
 * @returns {Promise<Buffer>} Restyled image bytes
 */
export async function restyleImage({ imageBuffer, productName, stylePrompt, apiKey, retryCount = 0 }) {
  // 1. Convert imageBuffer to base64 data URI
  const b64 = imageBuffer.toString('base64');
  const mimeType = detectMimeType(imageBuffer);
  const dataUri = `data:${mimeType};base64,${b64}`;

  const prompt = `Product photography of ${productName}, ${stylePrompt}, centered composition, clean background, no text, no watermarks`;

  // 2. POST to Replicate predictions API with retry logic
  let createRes;
  let retryAfter = INITIAL_BACKOFF_MS;
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      createRes = await fetch(`${REPLICATE_API}/models/${MODEL_VERSION}/predictions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Prefer: 'wait',
        },
        body: JSON.stringify({
          input: {
            image: dataUri,
            prompt,
            prompt_strength: 0.6,
            num_inference_steps: 28,
            guidance: 3.5,
            output_format: 'webp',
            output_quality: 90,
          },
        }),
        signal: AbortSignal.timeout(90000),
      });

      // Handle rate limiting (429) with exponential backoff
      if (createRes.status === 429) {
        const retryAfterHeader = createRes.headers.get('retry-after');
        if (retryAfterHeader) {
          retryAfter = Math.min(parseInt(retryAfterHeader) * 1000 + 1000, MAX_BACKOFF_MS);
        } else {
          retryAfter = Math.min(retryAfter * 2, MAX_BACKOFF_MS);
        }

        if (attempt < MAX_RETRIES) {
          console.log(`[restyleImage] rate limited (429), retrying after ${retryAfter}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise((r) => setTimeout(r, retryAfter));
          continue;
        } else {
          const txt = await createRes.text().catch(() => '');
          throw new Error(`Rate limited (429): ${txt.slice(0, 200)}`);
        }
      }

      // Other errors: fail immediately
      if (!createRes.ok) {
        const txt = await createRes.text().catch(() => '');
        throw new Error(`Replicate create prediction ${createRes.status}: ${txt.slice(0, 300)}`);
      }

      // Success!
      break;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        console.log(`[restyleImage] attempt ${attempt + 1} failed: ${err.message}, retrying...`);
        await new Promise((r) => setTimeout(r, Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS)));
      }
    }
  }

  if (!createRes) {
    throw lastError || new Error('Replicate predictions API failed after all retries');
  }

  let prediction = await createRes.json();
  const predictionId = prediction.id;

  if (!predictionId) {
    throw new Error('Replicate: no prediction id returned');
  }

  // 3. Poll until status=succeeded or failed (if Prefer:wait didn't complete it)
  const maxWaitMs = 60000;
  const pollIntervalMs = 2000;
  const startTime = Date.now();

  while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && prediction.status !== 'canceled') {
    if (Date.now() - startTime > maxWaitMs) {
      throw new Error(`Replicate prediction ${predictionId} timed out after ${maxWaitMs}ms (status: ${prediction.status})`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const pollRes = await fetch(`${REPLICATE_API}/predictions/${predictionId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!pollRes.ok) {
      const txt = await pollRes.text().catch(() => '');
      throw new Error(`Replicate poll ${pollRes.status}: ${txt.slice(0, 300)}`);
    }
    prediction = await pollRes.json();
  }

  if (prediction.status !== 'succeeded') {
    throw new Error(`Replicate prediction failed: ${JSON.stringify(prediction.error || prediction.status).slice(0, 200)}`);
  }

  // 4. Fetch output image
  const outputUrls = Array.isArray(prediction.output) ? prediction.output : [prediction.output];
  const outputUrl = outputUrls[0];
  if (!outputUrl) {
    throw new Error('Replicate: no output URL in succeeded prediction');
  }

  const imgRes = await fetch(outputUrl, { signal: AbortSignal.timeout(30000) });
  if (!imgRes.ok) {
    throw new Error(`Replicate output fetch ${imgRes.status}: ${outputUrl}`);
  }

  const arrayBuf = await imgRes.arrayBuffer();
  return Buffer.from(arrayBuf);
}

function detectMimeType(buf) {
  if (!buf || buf.length < 4) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}
