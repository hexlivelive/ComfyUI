import WebSocket from "ws";
import axios from "axios";
import { Buffer } from "buffer";
import * as uuid from "uuid";
import * as fs from "fs";
import { MongoClient, Db } from "mongodb"; // MongoDB client
import generate_prompt_images from "./workflows/generate_prompt_images.json";
import CloudflareImageService, {
  BucketName,
  CloudflareR2Service,
  ContentType,
} from "./cloudlfare.service";
import { buffer } from "stream/consumers";

export enum AspectRatioEnum {
  SQUARE = "square",
  VERTICAL_STORY = "verticalStory",
  VERTICAL_PORTRAIT = "verticalPortrait",
  LANDSCAPE = "landscape",
}

export const ASPECT_RATIOS = [
  {
    width: 1024,
    height: 1024,
    title: "square",
    ratio: "1024x1024 (1.0)",
    id: AspectRatioEnum.SQUARE,
  },
  {
    width: 832,
    height: 1152,
    title: "vertical story",
    ratio: "832x1152 (0.72)",
    id: AspectRatioEnum.VERTICAL_STORY,
  },
  {
    width: 768,
    height: 1280,
    title: "vertical portrait",
    ratio: "768x1280 (0.6)",
    id: AspectRatioEnum.VERTICAL_PORTRAIT,
  },
  {
    width: 1280,
    height: 768,
    title: "landscape",
    ratio: "1280x768 (1.67)",
    id: AspectRatioEnum.LANDSCAPE,
  },
];

const serverAddress = "http://127.0.0.1:8188";
const clientId = uuid.v4();

export async function promptImageGeneration(task: any, db: Db) {
  console.log(`Processing task: ${task._id}`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:8188/ws?clientId=${clientId}`);
    const start = new Date().getTime();
    ws.on("open", async () => {
      try {
        const prompt = generate_prompt_images;

        const resolution = ASPECT_RATIOS.find(
          (r) => r.id === task.metaData.aspectRatio
        )?.ratio;

        // Customize the prompt based on the task
        const randomSeed =
          task.metaData.seed === 0
            ? Math.floor(Math.random() * 1000000000)
            : task.metaData.seed;
        prompt["RandomNoise"]["inputs"]["noise_seed"] = randomSeed;
        prompt["SDXLEmptyLatentSizePicker"]["inputs"]["resolution"] =
          resolution ?? "768x1280 (0.6)";
        prompt["SDXLEmptyLatentSizePicker"]["inputs"]["batch_size"] =
          task.metaData.numberOfImages || 4;
        prompt["BasicScheduler"]["inputs"]["steps"] = 25;
        prompt["Prompt"]["inputs"]["prompt"] =
          task.metaData.prompt ||
          "a ka123tty a woman in a cafe photorealistic photo, upper body";

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
        const uploadedKeys: string[] = [];
        const datasetLocationPrefix = task._id.toString();
        const bucketName = BucketName.MEDIA;

        // Save images to disk
        for (const [index, imageData] of images["PreviewImage"].entries()) {
          imageIncrement += 1;
          const key = `${datasetLocationPrefix}/${imageIncrement}.png`;

          await new CloudflareR2Service(db).storeFile({
            buffer: imageData,
            contentType: ContentType.IMAGE,
            bucketName: BucketName.MEDIA,
            key,
          });

          uploadedKeys.push(key);

          console.log(`Saved image ${index + 1} for task ${task._id}`);
        }

        await db.collection("tasks").updateOne(
          { _id: task._id },
          {
            $set: {
              processingStatus: "completed",
              result: {
                completedIn: new Date().getTime() - start,
                imageUrls: uploadedKeys.map(
                  (k) => `https://media.reflect-ai.us/${k}`
                ),
                r2LocationInfo: {
                  bucketName,
                  keys: uploadedKeys,
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
