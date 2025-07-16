const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const express = require("express");
const app = express();

const FPS = 30;
const DURATION_SECONDS = 5;
const WIDTH = 1280;
const HEIGHT = 720;

const FRAME_COUNT = FPS * DURATION_SECONDS;
const FRAME_DIR = path.join(__dirname, "frames");

async function generateHook() {
  if (!fs.existsSync(FRAME_DIR)) fs.mkdirSync(FRAME_DIR);

  const browser = await puppeteer.launch({
    headless: "new",
    defaultViewport: { width: WIDTH, height: HEIGHT },
    args: ["--autoplay-policy=no-user-gesture-required"],
  });

  const page = await browser.newPage();
  await page.goto(`file://${__dirname}/index.html`);

  // Wait for video to load and play
  await page.waitForSelector("video");
  await page.evaluate(() => {
    const vid = document.querySelector("video");
    vid.currentTime = 0;
  });

  for (let i = 0; i < FRAME_COUNT; i++) {
    const frameNum = String(i).padStart(4, "0");
    await page.screenshot({ path: `${FRAME_DIR}/frame_${frameNum}.png` });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  }

  await browser.close();

  console.log("✅ Captured frames. Now encoding video...");

  execSync(
    `ffmpeg -y -framerate ${FPS} -i ${FRAME_DIR}/frame_%04d.png -pix_fmt yuv420p output.mp4`,
    {
      stdio: "inherit",
    }
  );

  console.log("🎬 Video created: output.mp4");
}

app.get("/generate", (req, res) => {
  try {
  } catch (error) {}
});
