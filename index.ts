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
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const aiModel = "gemini-2.0-flash";

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
    let audioBuffer: Buffer | null = null;
    let fileExtension: string | null = null;

    for await (const chunk of response) {
      if (
        !chunk.candidates ||
        !chunk.candidates[0].content ||
        !chunk.candidates[0].content.parts
      ) {
        continue;
      }
      if (chunk.candidates?.[0]?.content?.parts?.[0]?.inlineData) {
        const inlineData = chunk.candidates[0].content.parts[0].inlineData;
        fileExtension = mime.getExtension(inlineData.mimeType || "");
        let buffer = Buffer.from(inlineData.data || "", "base64");
        if (!fileExtension) {
          fileExtension = "wav";
          buffer = this.convertToWav(
            inlineData.data || "",
            inlineData.mimeType || ""
          );
        }
        audioBuffer = buffer;
        // Optionally save to file if needed:
        this.saveBinaryFile(`audio_output.${fileExtension}`, buffer);
      } else {
        // console.log(chunk.text);
      }
    }
    return { audioBuffer, fileExtension };
  }
}
const PORT = process.env.PORT || 8080;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
const FPS = 30;
const DURATION_SECONDS = 7;
const WIDTH = 1080;
const HEIGHT = 1920;

const FRAME_COUNT = FPS * DURATION_SECONDS;
const FRAME_DIR = path.join(__dirname, "frames");

async function generateFullVideoHook() {
  if (!fs.existsSync(FRAME_DIR)) fs.mkdirSync(FRAME_DIR);
  const t1 = performance.now();
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: WIDTH, height: HEIGHT },
    args: ["--autoplay-policy=no-user-gesture-required"],
  });

  const page = await browser.newPage();
  await page.goto(`file://${__dirname}/index.html`);

  // Wait for video to load
  await page.waitForSelector("video");

  // Get video duration
  const videoDuration = await page.evaluate(() => {
    const vid = document.querySelector("video");
    return new Promise((resolve) => {
      if (vid.readyState >= 1) {
        resolve(vid.duration);
      } else {
        vid.addEventListener("loadedmetadata", () => resolve(vid.duration));
      }
    });
  });

  console.log(`📹 Video duration: ${videoDuration} seconds`);

  // Calculate time per frame
  const timePerFrame = Number(videoDuration) / FRAME_COUNT;

  for (let i = 0; i < FRAME_COUNT; i++) {
    const frameNum = String(i).padStart(4, "0");
    const currentTime = i * timePerFrame;

    // Set video to specific time
    await page.evaluate((time) => {
      const vid = document.querySelector("video");
      vid.currentTime = time;
    }, currentTime);

    // Wait for the video to seek to the correct time
    await page.evaluate(() => {
      const vid = document.querySelector("video");
      return new Promise((resolve) => {
        if (vid.readyState >= 2) {
          resolve("");
        } else {
          vid.addEventListener("canplay", resolve, { once: true });
        }
      });
    });

    // Small delay to ensure frame is rendered
    await new Promise((resolve) => {
      setTimeout(() => {
        resolve("");
      }, 50);
    });

    await page.screenshot({ path: `${FRAME_DIR}/frame_${frameNum}.png` });

    console.log(
      `📸 Captured frame ${i + 1}/${FRAME_COUNT} at ${currentTime.toFixed(2)}s`
    );
  }

  await browser.close();
  console.log("✅ Captured frames. Now encoding video...");

  execSync(
    `ffmpeg -y -framerate ${FPS} -i ${FRAME_DIR}/frame_%04d.png -pix_fmt yuv420p output.mp4`,
    {
      stdio: "inherit",
    }
  );

  // Clean up: delete frames directory and its contents
  try {
    fs.readdirSync(FRAME_DIR).forEach((file) => {
      fs.unlinkSync(path.join(FRAME_DIR, file));
    });
    fs.rmdirSync(FRAME_DIR);
    console.log("🧹 Cleaned up frames directory.");
  } catch (cleanupErr) {
    console.error("Error cleaning up frames directory:", cleanupErr);
  }

  console.log("🎬 Video created: output.mp4");
  const t2 = performance.now();
  console.log("Render time: ", t2 - t1, "ms");
}

app.get("/generate/voiceover", async (req, res) => {
  try {
    console.log("Received voiceover req");
    const { audioBuffer, fileExtension } = await generateAudioVoiceover({
      script: "This is a sample script for the video hook.",
    });
    if (!audioBuffer) {
      return res.status(500).send("Failed to generate audio");
    }
    res.setHeader("Content-Type", `audio/${fileExtension || "wav"}`);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="voiceover.${fileExtension || "wav"}"`
    );
    return res.send(audioBuffer);
  } catch (error) {
    console.error(`Error generating audio voiceover:`, error.message);
    return res.status(500).send("Error generating audio voiceover");
  }
});
app.get("/generate/script", async (req, res) => {
  try {
    const script = await generateHookScript();
    res.json({ script }).status(200);
  } catch (error) {
    console.error(error.message);
    res.sendStatus(500).send(error.message);
  }
});
app.get("/generate/video", async (req, res) => {
  try {
    console.log("Received video generation request");
    await generateFullVideoHook();
    res.sendStatus(200);
  } catch (error) {
    console.error(error.message);
    res.sendStatus(500);
  }
});

async function generateAudioVoiceover({ script }: { script?: string }) {
  try {
    const audioGen = new GoogleAudioGen({ script });
    return await audioGen.render();
  } catch (error) {
    console.error(`generateAudioVoiceover() error -->`, error.message);
    throw error.message;
  }
}

async function generateHTML({ overlay }) {
  try {
  } catch (error) {
    console.error(`generateHTML() error -->`, error.message);
  }
}
async function generateHookScript() {
  try {
    const prompt = `
      Looca is a Pinterest automation tool built specifically for food bloogers to help them create pins for their food blofg much faster. 
      All they have to do is paste in the URL of their blog post, 
      select a couple of templates and upload a couple of photos of their recipe 
      (any photo that they want to be in the finale design). 
      Looca will then use the selected templates to create new ones based on that specific recipe blog post. 
      Now I want you to generate me a script that I can ue for my tiktok videos.
      Here's the format am goign for/ The video will consist of two part the hook which is what you'll be gnerating.
      Thi is the intro and whay viewsers will hear when they first see the video. 
      Now I want you to generate this initial hook script to keep viewers watching until we to the second part fo the 
      video where we show the screen recording of how yo use Looca.
      Also our video consists of an overlay of text to acompany the 
      hook and have something that will keep the users watcihng
      this text overlay is ussually derivative or summary of the actually script
      
      - For example
      Hook =  I don’t design my pins manually anymore like a wild animal, let me show you my new workflow.
      Overlay = I don’t design my pins anymore 

      Hook = If you’re still making pins from scratch, you’re wasting time. Here’s how I do it
      Overlay = Stop making pins from scratch (see it doesnt alway have to be exact summary)


      --------------------------- Here are a few examples of hooks I have already written------------------------

     ### 🧠 Curiosity / Personal Story Hooks

      1. Here’s how I make 20 Pinterest pins from just one blog post.
      2. I don’t design pins manually anymore. I just do this now—watch.
      3. I don’t design my pins manually anymore like a wild animal, let me show you my new workflow.
      4. This tool makes all my food blog pins for me. Let me show you.
      5. I used to spend 2 hours making pins… now it takes me 10 minutes.
      7. If you have a food blog and you hate making pins… try this instead.
      8. This is how I automate all my Pinterest content in minutes.
      9. I didn’t expect much from this Pinterest tool, but here’s what happened…
      10. Let me show you how I generate 20 Pinterest pins in one go.

      ---

      ### ⚡ Efficiency & Time-Saving Hooks

      1. How I batch all my Pinterest pins in less than 10 minutes.
      2. No more dragging templates around in Canva… I just do this now.
      3. I used to hate pin design days. Now I actually look forward to it.
      4. I automsted my entire Pin creation process with just this one tool. I’ll show you.
      5. "I automated my whole Pin creation process with just one tool—let me show you how."
      6. "I used one tool to automate everything about creating Pins. Here’s how it works."
      7. "This one tool completely took over my Pin creation process. I’ll walk you through it."
      8. "I don’t make Pins manually anymore—this tool does it all. Let me show you."
      9. "I found one tool that does all my Pin creation for me. Wanna see how?"

      ---

      ### 👀 Audience-Direct Hooks

      1. If you’re a food blogger, you *need* to see this workflow.
      2. Still making Pinterest pins manually? Let me show you a faster way.
      3. You’re doing Pinterest the hard way—this is how I do it now.
      4. Here’s the tool I wish I knew about earlier in my Pinterest journey…
      5. Stop wasting time on desiging pins in Canva. Try this instead.

      ---

      ### 💬 Casual / Social Style Hooks

      1. I don’t even open Canva anymore. This tool crates all my pins for me.
      2. This tool made 18 pins for me in like… 3 minutes. No joke. Let me show you how
      3. My whole Pinterest process? Just this tool and a few clicks.

      ---

      ### 🔄 Before/After & Transformation Hooks

      1. Here’s how I went from 3 to 20 pins a day using Looca.
      2. I used to get stuck making pins all day. Now I just do this.
      3. My pins actually look better *and* take less time now. Here’s how.
      4. From stressed-out to streamlined—this is how I do pins now.
      5. This changed how I run my food blog completely. Let me show you.

      ---

     

      ### 🔥 Bold & Vague

      1. This Pinterest hack should honestly be illegal.
      2. This is going to change how you blog forever.
      3. The tool that just made Canva feel ancient.
      4. This is how I’ve been creating 20 pins a day on Pinterest, If I get banned for sharing this, so be it.
      5. What you’re about to see should not be free.
      6. I can’t believe this actually works.
      7. Pinterest just got way too easy.
      8. This broke my entire Pinterest workflow—in a good way.
      9. This is NOT how you’re supposed to do Pinterest… but it works.
      10. I probably shouldn’t show you this secret Pinterest tool, but here we go…

      ---

      ### 💣 Disruptive / Stirring the Pot

      1. If you’re still making pins from scratch, you’re wasting time. Here’s how I do it
      2. I used to spend hours making pins each day… until I found this tool.

      ---

      ### 😲 Shock / Hyperbole

      1. This made 18 beautiful pins in 3 minutes. I’m still in shock.
      2. This is the wildest thing I’ve ever used as a food blogger.

      ### 🔥 Frustration-to-Solution Hooks

      1. Creating pins on Pinterest used to stress me out. Util I tried this tool.
      2. I don’t even touch Photoshop or Canva anymore—this is I create my Pins today.

      ---

      ### 👀 Viewer-Pull Hooks (direct address)

      1. If you’re posting recipes,on Pinterest you *need* this tool.
      2. You’re wasting too much time on pins—here’s what I use instead.
      3. Let me walk you through how I create dozens of pins in minutes.

      ---

      ### 🗣️ Conversational / Casual Hooks

      1. Okay so here’s how I make all my Pinterest pins now—super fast.
      2. This might be the most underrated tool for food bloggers right now.
    `;
    const response = await ai.models.generateContent({
      model: aiModel,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            hook: {
              type: "string",
            },
            overlay: {
              type: "string",
            },
          },
          propertyOrdering: ["hook", "overlay"],
          required: ["hook", "overlay"],
        },
      },
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
    });
    const rawContent = response.candidates[0].content.parts[0].text;
    const content = JSON.parse(rawContent);
    return content;
  } catch (error) {
    console.error(`generateHookScript() error -->`, error.message);
  }
}
