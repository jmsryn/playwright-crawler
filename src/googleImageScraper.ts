import path from 'path';
import fs from 'fs/promises';
import { chromium, Page } from 'playwright';


const QUERY = process.argv[2] ?? 'tattered jeans';
const OUTPUT_DIR = path.resolve(process.argv[3] ?? 'downloads');
const HEADLESS = process.argv[4] !== 'false';

const SEARCH_BOX = 'textarea[name="q"]';
const THUMBNAIL_SELECTOR = 'div.q1MG4e.mNsIhb img';
const PREVIEW_SELECTOR = 'img[jsname="kn3ccd"]';
const LIMIT = Number(process.argv[5] ?? '0'); 
async function acceptConsent(page: Page) {
  const consentButton =
    (await page.$('button:has-text("I agree")')) ??
    (await page.$('button:has-text("Accept all")'));
  if (consentButton) {
    await consentButton.click();
    await page.waitForTimeout(500);
  }
}

async function waitForPreviewUrl(page: Page, previousUrl?: string) {
  const handle = await page.waitForFunction(
    ({ selector, prev }) => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLImageElement>(selector)
      );
      const httpImage = candidates.find(
        (img) => img.src.startsWith('http') && img.src !== prev
      );
      return httpImage?.src ?? null;
    },
    { selector: PREVIEW_SELECTOR, prev: previousUrl ?? null },
    { timeout: 20000 }
  );
  const url = (await handle.jsonValue()) as string | null;
  if (!url) {
    throw new Error('Could not locate preview image URL');
  }
  return url;
}

function pickExtension(imageUrl: string) {
  try {
    const { pathname } = new URL(imageUrl);
    const filename = pathname.split('/').pop() ?? '';
    const match = filename.match(/\.([a-zA-Z0-9]{2,5})$/);
    return match ? match[1].toLowerCase() : 'jpg';
  } catch {
    return 'jpg';
  }
}

function safeSuffix(idx: number) {
  return String(idx).padStart(2, '0');
}

async function run() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage();

  try {
    await page.goto('https://www.google.com/imghp?hl=en', {
      waitUntil: 'domcontentloaded'
    });

    await acceptConsent(page);
    await page.fill(SEARCH_BOX, QUERY);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.keyboard.press('Enter')
    ]);

    await page.waitForSelector(THUMBNAIL_SELECTOR, { timeout: 20000 });
    const thumbnails = await page.$$(THUMBNAIL_SELECTOR);
    if (!thumbnails.length) {
      throw new Error('No thumbnails found.');
    }

    const count = LIMIT > 0 ? Math.min(LIMIT, thumbnails.length) : thumbnails.length;
    console.log(`Found ${thumbnails.length} thumbnails, downloading ${count}`);

    const safeName = QUERY.trim().replace(/\s+/g, '_').toLowerCase();
    const seen = new Set<string>();
    let previousUrl: string | undefined;

    for (let index = 0; index < count; index++) {
      const thumb = thumbnails[index];
      if (!thumb) {
        continue;
      }

      try {
        await thumb.scrollIntoViewIfNeeded();
      } catch {
        // element might already be visible; ignore errors
      }

      await thumb.click({ delay: 50 });
      const imageUrl = await waitForPreviewUrl(page, previousUrl);
      previousUrl = imageUrl;

      if (seen.has(imageUrl)) {
        console.log(`Skipping duplicate image ${imageUrl}`);
        continue;
      }
      seen.add(imageUrl);

      const response = await page.request.get(imageUrl);
      if (!response.ok()) {
        console.warn(`Failed to fetch ${imageUrl}: ${response.status()}`);
        continue;
      }

      const buffer = await response.body();
      const extension = pickExtension(imageUrl);
      const suffix = safeSuffix(seen.size);
      const filePath = path.join(OUTPUT_DIR, `${safeName}_${suffix}.${extension}`);
      await fs.writeFile(filePath, buffer);
      console.log(`Saved image ${seen.size}: ${filePath}`);

      await page.waitForTimeout(500);
    }
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

