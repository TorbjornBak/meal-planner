/**
 * Reading text off a receipt photo (§7) — Tesseract, on our own box.
 *
 * This is OCR, not an API: `tesseract.js` is a WebAssembly build of Tesseract
 * that runs inside the Node process, and the Danish language model is vendored
 * in `tessdata/` and handed to the worker as bytes. Nothing is fetched at
 * runtime and there is no key to hold, which is the whole point — the app keeps
 * working on a home box behind Tailscale with no route to the outside world.
 *
 * The transcript this produces is sloppy by nature. Turning it into a number is
 * `receiptTotal.ts`'s job, and the number is a suggestion the human confirms.
 */

import { access } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createWorker, OEM, PSM, type Worker } from "tesseract.js";

/** Danish: receipts are full of "AT BETALE", "MOMS", "BYTTEPENGE". */
const LANG = "dan";

/**
 * Where the vendored language model lives. Overridable so the Docker image can
 * put it somewhere other than the working directory.
 */
const TESSDATA_DIR =
  process.env.TESSDATA_DIR ?? path.join(process.cwd(), "tessdata");

/**
 * The width band we hand to Tesseract, which reads best when letters are a few
 * tens of pixels tall. A phone photo comes in several times wider than the top
 * of this band and costs seconds of CPU for no extra accuracy; a small scan
 * comes in under the bottom of it and reads better enlarged.
 */
const OCR_MIN_WIDTH = 1400;
const OCR_MAX_WIDTH = 2000;

export interface ReceiptScan {
  /** The raw transcript, newline-separated in reading order. */
  text: string;
  /** Tesseract's own confidence in the page, 0–100. */
  confidence: number;
}

let workerPromise: Promise<Worker> | null = null;

/**
 * The Tesseract worker, started once and kept.
 *
 * Loading the language model takes a second or two, which is worth paying on
 * the first receipt of the evening and not on the second.
 *
 * `langPath` points at our own directory rather than the jsDelivr CDN that
 * `tesseract.js` defaults to, `gzip: false` because we vendor the model
 * uncompressed, and `cacheMethod: "none"` so the worker neither looks for a
 * cached copy nor writes one into the working directory — the vendored file is
 * the only source, and if it's missing we want to hear about it rather than
 * have a download quietly substituted.
 */
function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const model = path.join(TESSDATA_DIR, `${LANG}.traineddata`);
      try {
        await access(model);
      } catch {
        throw new Error(`Tesseract language model missing at ${model}`);
      }
      const worker = await createWorker(LANG, OEM.LSTM_ONLY, {
        langPath: TESSDATA_DIR,
        gzip: false,
        cacheMethod: "none",
      });
      await worker.setParameters({
        // A receipt is one narrow column of text.
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        // Keep the run of spaces between a label and its right-aligned amount,
        // so "AT BETALE" and "342,75" stay on one line for the parser.
        preserve_interword_spaces: "1",
        // Phone photos carry no meaningful DPI; saying so silences Tesseract's
        // guesswork about text size.
        user_defined_dpi: "300",
      });
      return worker;
    })();
    // A failed start (missing model, bad wasm) must not poison every later
    // call — drop the promise so the next receipt tries again.
    workerPromise.catch(() => {
      workerPromise = null;
    });
  }
  return workerPromise;
}

/**
 * One worker handles one page at a time, so overlapping uploads queue rather
 * than interleave inside it. A household generates one receipt at a time; a
 * queue is the right amount of machinery for that.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Clean a photo up before Tesseract sees it.
 *
 * Honour the phone's orientation flag, drop to grey, and bring the width into
 * the band above. Then the two steps that decide whether a real kitchen-table
 * snapshot reads at all: a median filter, which takes out sensor speckle and
 * JPEG mush that Tesseract otherwise reads as punctuation, and a contrast
 * stretch, so dim grey-on-grey thermal paper comes back as black on white.
 */
async function prepare(photo: Buffer): Promise<Buffer> {
  const image = sharp(photo, { failOn: "none" }).rotate().grayscale();
  // `autoOrient` because a portrait phone photo is stored landscape plus a flag,
  // and it's the width after that flag is applied that we're scaling.
  const { autoOrient } = await image.metadata();
  const width = autoOrient?.width || OCR_MAX_WIDTH;

  return image
    .resize({
      width: Math.min(OCR_MAX_WIDTH, Math.max(OCR_MIN_WIDTH, width)),
      fit: "inside",
    })
    .median(3)
    .normalise()
    .sharpen()
    .png()
    .toBuffer();
}

/** Transcribe a receipt photo. Throws if the bytes aren't a readable image. */
export async function scanReceipt(photo: Buffer): Promise<ReceiptScan> {
  const prepared = await prepare(photo);

  const run = queue.then(async () => {
    const worker = await getWorker();
    const { data } = await worker.recognize(prepared);
    return { text: data.text, confidence: data.confidence };
  });

  // Keep the chain going whether this job succeeded or not.
  queue = run.catch(() => {});
  return run;
}
