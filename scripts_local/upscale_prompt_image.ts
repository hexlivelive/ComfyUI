import WebSocket from "ws";
import axios from "axios";
import { Buffer } from "buffer";
import * as uuid from "uuid";
import * as fs from "fs";
import { MongoClient, Db } from "mongodb"; // MongoDB client
import upscale_prompt_image from "./workflows/upscale_prompt_image.json";
import CloudflareImageService, {
  BucketName,
  CloudflareR2Service,
  ContentType,
} from "./cloudlfare.service";
import sharp from "sharp";

const serverAddress = "http://127.0.0.1:8188";
const clientId = uuid.v4();

export async function upscalePromptImage(task: any, db: Db) {
  console.log(`Processing task: ${task._id}`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:8188/ws?clientId=${clientId}`);
    const start = new Date().getTime();
    ws.on("open", async () => {
      try {
        const prompt = upscale_prompt_image;

        // Customize the prompt based on the task
        const randomSeed = Math.floor(Math.random() * 1000000000);
        prompt["UltimateSDUpscale"]["inputs"]["seed"] = randomSeed;
        prompt["UltimateSDUpscale"]["inputs"]["steps"] = 10;
        prompt["LoadImageFromUrl"]["inputs"]["image"] =
          task.metaData.originalImageUrl;
        prompt["Prompt"]["inputs"]["prompt"] = task.metaData.prompt;

        const updateTaskProgress = async (progress: number) => {
          await db.collection("tasks").updateOne(
            { _id: task._id },
            {
              $set: {
                progress,
              },
            }
          );
        };

        const images = (await getImages(ws, prompt, updateTaskProgress)) as {
          PreviewImage: Buffer[];
        };

        let imageIncrement = 0;
        const uploadedOriginalKeys: string[] = [];
        const uploadedOptimizedKeys: string[] = [];
        const datasetLocationPrefix = task._id.toString();
        const bucketName = BucketName.MEDIA;

        // Save images to disk
        for (const [index, imageData] of images["PreviewImage"].entries()) {
          imageIncrement += 1;
          const originalKey = `${datasetLocationPrefix}/${imageIncrement}.png`;

          await new CloudflareR2Service(db).storeFile({
            buffer: imageData,
            contentType: ContentType.IMAGE,
            bucketName: BucketName.MEDIA,
            key: originalKey,
          });

          uploadedOriginalKeys.push(originalKey);

          const optimizedKey = `${datasetLocationPrefix}/${imageIncrement}.webp`;

          const optimizedImage = await sharp(imageData).webp().toBuffer();

          await new CloudflareR2Service(db).storeFile({
            buffer: optimizedImage,
            contentType: ContentType.IMAGE,
            bucketName: BucketName.MEDIA,
            key: optimizedKey,
          });

          uploadedOptimizedKeys.push(optimizedKey);

          console.log(`Saved image ${index + 1} for task ${task._id}`);
        }

        await db.collection("tasks").updateOne(
          { _id: task._id },
          {
            $set: {
              processingStatus: "completed",
              result: {
                completedIn: new Date().getTime() - start,
                imageUrls: {
                  original: uploadedOriginalKeys.map(
                    (k) => `https://media.reflect-ai.us/${k}`
                  ),
                  optimized: uploadedOptimizedKeys.map(
                    (k) => `https://media.reflect-ai.us/${k}`
                  ),
                },
                r2LocationInfo: {
                  bucketName,
                  originalKeys: uploadedOriginalKeys,
                  optimizedKeys: uploadedOptimizedKeys,
                },
              },
            },
          }
        );

        ws.close(); // Close the WebSocket connection
        resolve(undefined); // Resolve the promise when task is done
      } catch (error) {
        ws.close(); // Ensure the WebSocket is closed on error
        reject(`Error processing task ${task._id}: ${error}`);
      }
    });

    ws.on("error", (error) => {
      reject(`WebSocket error for task ${task._id}: ${error}`);
    });
  });
}

async function queuePrompt(prompt: any) {
  const requestBody = { prompt, client_id: clientId };
  const response = await axios.post(`${serverAddress}/prompt`, requestBody, {
    headers: { "Content-Type": "application/json" },
  });
  return response.data;
}

async function getImage(
  filename: string,
  subfolder: string,
  folderType: string
) {
  const url = `${serverAddress}/view?filename=${filename}&subfolder=${subfolder}&type=${folderType}`;
  const response = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(response.data);
}

async function getHistory(promptId: string) {
  const response = await axios.get(`${serverAddress}/history/${promptId}`);
  return response.data;
}

async function getImages(
  ws: WebSocket,
  prompt: any,
  updateTaskProgress: (progress: number) => Promise<void>
) {
  const { prompt_id } = await queuePrompt(prompt);
  const outputImages: { [key: string]: Buffer[] } = {};

  return new Promise((resolve) => {
    ws.on("message", async (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "progress") {
        const { value, max } = message.data;

        const progress = (value / max) * 100;

        await updateTaskProgress(+progress.toFixed());
      }

      if (message.type === "executing") {
        const { node, prompt_id: currentPromptId } = message.data;
        if (node === null && currentPromptId === prompt_id) {
          const history = await getHistory(prompt_id);
          const outputs = history[prompt_id]?.outputs || {};

          for (const nodeId in outputs) {
            const nodeOutput = outputs[nodeId];
            const imagesOutput: Buffer[] = [];

            if (nodeOutput.images) {
              for (const image of nodeOutput.images) {
                const imageData = await getImage(
                  image.filename,
                  image.subfolder,
                  image.type
                );
                imagesOutput.push(imageData);
              }
            }
            outputImages[nodeId] = imagesOutput;
          }
          resolve(outputImages);
        }
      }
    });
  });
}

const task = {
  _id: {
    $oid: "6700ffb75a526d9bc6c5ab66",
  },
  taskType: "promptImageUpscale",
  userId: {
    $oid: "66fe095b474ae40962b3ff74",
  },
  metaData: {
    modelId: "",
    prompt:
      " ka123tty a woman at a pop-up food market at night, combining the love for street food with nightlife, close shot, reality",
    imageUrl:
      "https://imagedelivery.net/hUZkA7QQ8hV1UxYbRNOnKw/30698b02-3fd7-4c5a-00ab-f4d241aa2100/original",
    numberOfImages: 1,
    aspectRatio: "verticalPortrait",
  },
  processingStatus: "none",
  server: null,
  completed: false,
  result: null,
  trainingLog: null,
  progress: null,
  timeLeft: null,
  createdAt: {
    $date: "2024-10-05T08:58:31.434Z",
  },
  updatedAt: {
    $date: "2024-10-05T08:58:31.434Z",
  },
  __v: 0,
};
