// import type { Request, Response } from "express";
import express, { Request, Response } from "express";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { GoogleGenAI } from "@google/genai";
import mime from "mime";
import { writeFile } from "fs";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();

interface WavConversionOptions {
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
}
type AudioGenInput = {
  script: string;
};
class GoogleAudioGen {
  private input = null;
  constructor(input: AudioGenInput) {
    this.input = input;
  }
  convertToWav(rawData: string, mimeType: string) {
    const options = this.parseMimeType(mimeType);
    const wavHeader = this.createWavHeader(rawData.length, options);
    const buffer = Buffer.from(rawData, "base64");

    return Buffer.concat([wavHeader, buffer]);
  }

  private parseMimeType(mimeType: string) {
    const [fileType, ...params] = mimeType.split(";").map((s) => s.trim());
    const [_, format] = fileType.split("/");

    const options: Partial<WavConversionOptions> = {
      numChannels: 1,
    };

    if (format && format.startsWith("L")) {
      const bits = parseInt(format.slice(1), 10);
      if (!isNaN(bits)) {
        options.bitsPerSample = bits;
      }
    }

    for (const param of params) {
      const [key, value] = param.split("=").map((s) => s.trim());
      if (key === "rate") {
        options.sampleRate = parseInt(value, 10);
      }
    }

    return options as WavConversionOptions;
  }

  private createWavHeader(dataLength: number, options: WavConversionOptions) {
    const { numChannels, sampleRate, bitsPerSample } = options;

    // http://soundfile.sapp.org/doc/WaveFormat

    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const buffer = Buffer.alloc(44);

    buffer.write("RIFF", 0); // ChunkID
    buffer.writeUInt32LE(36 + dataLength, 4); // ChunkSize
    buffer.write("WAVE", 8); // Format
    buffer.write("fmt ", 12); // Subchunk1ID
    buffer.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
    buffer.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
    buffer.writeUInt16LE(numChannels, 22); // NumChannels
    buffer.writeUInt32LE(sampleRate, 24); // SampleRate
    buffer.writeUInt32LE(byteRate, 28); // ByteRate
    buffer.writeUInt16LE(blockAlign, 32); // BlockAlign
    buffer.writeUInt16LE(bitsPerSample, 34); // BitsPerSample
    buffer.write("data", 36); // Subchunk2ID
    buffer.writeUInt32LE(dataLength, 40); // Subchunk2Size

    return buffer;
  }
  private saveBinaryFile(fileName: string, content: Buffer) {
    writeFile(fileName, content, "utf8", (err) => {
      if (err) {
        console.error(`Error writing file ${fileName}:`, err);
        return;
      }
      console.log(`File ${fileName} saved to file system.`);
    });
  }

  public async render() {
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });
    const config = {
      temperature: 1.5,
      responseModalities: ["audio"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: "Autonoe",
          },
        },
      },
    };
    const model = "gemini-2.5-pro-preview-tts";
    const contents = [
      {
        role: "user",
        parts: [
          {
            text: this.input.script,
          },
        ],
      },
    ];

    const response = await ai.models.generateContentStream({
      model,
      config,
      contents,
    });
    let fileIndex = 0;
    for await (const chunk of response) {
      if (
        !chunk.candidates ||
        !chunk.candidates[0].content ||
        !chunk.candidates[0].content.parts
      ) {
        continue;
      }
      if (chunk.candidates?.[0]?.content?.parts?.[0]?.inlineData) {
        const fileName = `ENTER_FILE_NAME_${fileIndex++}`;
        const inlineData = chunk.candidates[0].content.parts[0].inlineData;
        let fileExtension = mime.getExtension(inlineData.mimeType || "");
        let buffer = Buffer.from(inlineData.data || "", "base64");
        if (!fileExtension) {
          fileExtension = "wav";
          buffer = this.convertToWav(
            inlineData.data || "",
            inlineData.mimeType || ""
          );
        }
        this.saveBinaryFile(`${fileName}.${fileExtension}`, buffer);
      } else {
        console.log(chunk.text);
      }
    }
  }
}
const PORT = process.env.PORT || 8080;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
const FPS = 60;
const DURATION_SECONDS = 15;
const WIDTH = 1280;
const HEIGHT = 720;

const FRAME_COUNT = FPS * DURATION_SECONDS;
const FRAME_DIR = path.join(__dirname, "frames");

async function generateFullVideoHook() {
  if (!fs.existsSync(FRAME_DIR)) fs.mkdirSync(FRAME_DIR);

  const browser = await puppeteer.launch({
    headless: true,
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

app.get("/generate/voiceover", async (req, res) => {
  try {
    console.log("Receieved voiceover req");
    await generateAudioVoiceover();
    return res.status(200).send("Audio voiceover generated successfully");
  } catch (error) {
    console.error(`Error generating audio voiceover:`, error.message);
    return res.status(500).send("Error generating audio voiceover");
  }
});

async function generateAudioVoiceover() {
  try {
    const script = "This is a sample script for the video hook.";
    const audioGen = new GoogleAudioGen({ script });
    await audioGen.render();
    console.log("✅ Audio voiceover generated successfully.");
  } catch (error) {
    console.error(`generateAudioVoiceover() error -->`, error.message);
    throw error.message;
  }
}
async function generateTextOverlay() {
  try {
  } catch (error) {
    console.error(`generateTextOverlay() error -->`, error.message);
  }
}
async function generateHTML(params) {
  try {
  } catch (error) {
    console.error(`generateHTML() error -->`, error.message);
  }
}
async function generateHookScript(params) {
  try {
  } catch (error) {
    console.error(`generateHookScript() error -->`, error.message);
  }
}
