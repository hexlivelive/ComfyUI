import WebSocket from "ws";
import axios from "axios";
import { Buffer } from "buffer";
import * as uuid from "uuid";
import * as fs from "fs";
import { MongoClient, Db } from "mongodb"; // MongoDB client
import generate_prompt_images from "./workflows/generate_prompt_images.json";
import CloudflareImageService from "./cloudlfare.service";
import { promptImageGeneration } from "./generate_prompt_images";
import { upscalePromptImage } from "./upscale_prompt_image";
import { retakePromptImage } from "./retake_prompt_images";

const serverAddress = "http://127.0.0.1:8188";
const clientId = uuid.v4();
const mongoUrl = "";
const dbName = "AIv1";

let db: Db;

async function connectToMongo() {
  const client = new MongoClient(mongoUrl);
  await client.connect();
  console.log("Connected to MongoDB");
  db = client.db(dbName);
}

async function pollForTasks() {
  const task = await db.collection("task").findOneAndUpdate(
    {
      processingStatus: "none",
      taskType: {
        $in: [
          "promptImageGeneration",
          "promptImageUpscale",
          "promptImageRetake",
        ],
      },
    },
    {
      $set: {
        processingStatus: "inProgress",
      },
    }
  );

  if (task) {
    console.log(`Found new task: ${task._id}`);
    await processTask(task);
    await db
      .collection("task")
      .updateOne(
        { _id: task._id },
        { $set: { processingStatus: "completed" } }
      );
  } else {
    console.log("No new tasks found.");
  }
}

async function processTask(task: any) {
  if (task.taskType === "promptImageGeneration") {
    return await promptImageGeneration(task, db);
  }

  if (task.taskType === "promptImageUpscale") {
    return await upscalePromptImage(task, db);
  }

  if (task.taskType === "promptImageRetake") {
    return await retakePromptImage(task, db);
  }
}

async function startPolling() {
  await connectToMongo();

  while (true) {
    await pollForTasks();

    await sleep(5000);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

startPolling().catch((error) => {
  console.error("Error starting polling:", error);
});
